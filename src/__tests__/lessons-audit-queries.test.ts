/**
 * Coverage for `lessons_audit_log` queries (Phase 50.4).
 *
 * Asserts:
 *   - insert 'created' / 'updated' / 'deleted' rows; nullability of
 *     previous_body / new_body matches action shape
 *   - cascade delete: removing the parent lesson removes its audit rows
 *   - actor_user_id and actor_extension_id can both be set (admin
 *     editing on behalf of an extension)
 *   - 64 KB body truncation produces sha256 marker prefix
 *   - listLessonAuditByActorExtension paginates by id cursor
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import {
  insertLessonAuditEntry,
  listLessonAuditByLessonId,
  listLessonAuditByActorExtension,
} from "../db/queries/lessons-audit";
import { createUser } from "../db/queries/users";
import { extensions, lessons, projects, lessonsAuditLog } from "../db/schema";
import { eq } from "drizzle-orm";

let userId: string;
let extensionId: string;
let projectId: string;

async function ensureExtension(name: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(extensions)
    .values({
      name,
      version: "0.0.1",
      description: "",
      manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as any,
      source: "test",
      enabled: true,
      grantedPermissions: {} as any,
    })
    .returning({ id: extensions.id });
  return row!.id;
}

async function ensureProject(): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(projects)
    .values({ name: "lesson-aud-proj", path: "/tmp/lap" })
    .returning({ id: projects.id });
  return row!.id;
}

async function ensureLesson(slug: string): Promise<string> {
  const db = getTestDb();
  const [row] = await db
    .insert(lessons)
    .values({
      projectId,
      ownerId: userId,
      visibility: "user",
      slug,
      title: `t-${slug}`,
      body: "body",
      source: "user",
    })
    .returning({ id: lessons.id });
  return row!.id;
}

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "lesson-aud-it@example.com",
    passwordHash: "h",
    name: "U",
    role: "admin",
    status: "active",
  });
  userId = u.id;
  extensionId = await ensureExtension("lesson-aud-ext");
  projectId = await ensureProject();
});

beforeEach(async () => {
  // Clean both child and parent so each test starts deterministic.
  await getTestDb().delete(lessonsAuditLog);
  await getTestDb().delete(lessons);
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("insertLessonAuditEntry — action shape", () => {
  test("created: previous_body NULL, new_body present", async () => {
    const lessonId = await ensureLesson("t-create");
    await insertLessonAuditEntry({
      lessonId,
      action: "created",
      previousBody: null,
      newBody: "fresh body",
      actorUserId: userId,
      reason: "init",
    });
    const rows = await listLessonAuditByLessonId(lessonId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe("created");
    expect(rows[0]!.previousBody).toBeNull();
    expect(rows[0]!.newBody).toBe("fresh body");
  });

  test("updated: previous_body and new_body both present", async () => {
    const lessonId = await ensureLesson("t-update");
    await insertLessonAuditEntry({
      lessonId,
      action: "updated",
      previousBody: "old",
      newBody: "new",
      actorUserId: userId,
    });
    const rows = await listLessonAuditByLessonId(lessonId);
    expect(rows[0]!.action).toBe("updated");
    expect(rows[0]!.previousBody).toBe("old");
    expect(rows[0]!.newBody).toBe("new");
  });

  test("deleted: previous_body present, new_body NULL", async () => {
    const lessonId = await ensureLesson("t-del");
    await insertLessonAuditEntry({
      lessonId,
      action: "deleted",
      previousBody: "doomed",
      newBody: null,
      actorUserId: userId,
    });
    const rows = await listLessonAuditByLessonId(lessonId);
    expect(rows[0]!.action).toBe("deleted");
    expect(rows[0]!.previousBody).toBe("doomed");
    expect(rows[0]!.newBody).toBeNull();
  });

  test("frontmatter persists as jsonb", async () => {
    const lessonId = await ensureLesson("t-fm");
    await insertLessonAuditEntry({
      lessonId,
      action: "updated",
      previousFrontmatter: { trigger: "old" },
      newFrontmatter: { trigger: "new", tags: ["a", "b"] },
      actorUserId: userId,
    });
    const rows = await listLessonAuditByLessonId(lessonId);
    expect(rows[0]!.newFrontmatter).toEqual({ trigger: "new", tags: ["a", "b"] });
    expect(rows[0]!.previousFrontmatter).toEqual({ trigger: "old" });
  });
});

describe("cascade and FK behavior", () => {
  test("cascade delete: removing parent lesson removes its audit rows", async () => {
    const lessonId = await ensureLesson("t-cascade");
    await insertLessonAuditEntry({
      lessonId,
      action: "created",
      newBody: "x",
      actorUserId: userId,
    });
    expect((await listLessonAuditByLessonId(lessonId)).length).toBe(1);
    await getTestDb().delete(lessons).where(eq(lessons.id, lessonId));
    expect((await listLessonAuditByLessonId(lessonId)).length).toBe(0);
  });

  test("both actor_user_id and actor_extension_id can be set on one row", async () => {
    const lessonId = await ensureLesson("t-both-actors");
    await insertLessonAuditEntry({
      lessonId,
      action: "updated",
      previousBody: "p",
      newBody: "q",
      actorUserId: userId,
      actorExtensionId: extensionId,
      reason: "admin promoting on behalf of ext",
    });
    const rows = await listLessonAuditByLessonId(lessonId);
    expect(rows[0]!.actorUserId).toBe(userId);
    expect(rows[0]!.actorExtensionId).toBe(extensionId);
  });
});

describe("body truncation at 64 KB", () => {
  test("oversized newBody is replaced with [truncated:<sha256>]<32KB>", async () => {
    const lessonId = await ensureLesson("t-trunc");
    const big = "A".repeat(64 * 1024 + 100); // 65,636 bytes
    await insertLessonAuditEntry({
      lessonId,
      action: "updated",
      previousBody: "p",
      newBody: big,
      actorUserId: userId,
    });
    const rows = await listLessonAuditByLessonId(lessonId);
    const stored = rows[0]!.newBody!;
    expect(stored.startsWith("[truncated:")).toBe(true);
    // The stored body should be ~32 KB + the truncation prefix.
    expect(stored.length).toBeLessThan(33 * 1024);
    // sha256 hex is 64 chars; prefix is "[truncated:" + 64 + "]"
    const match = stored.match(/^\[truncated:([0-9a-f]{64})\]/);
    expect(match).not.toBeNull();
  });

  test("sub-cap body persists as-is (no truncation prefix)", async () => {
    const lessonId = await ensureLesson("t-no-trunc");
    const ok = "B".repeat(1000);
    await insertLessonAuditEntry({
      lessonId,
      action: "updated",
      previousBody: ok,
      newBody: ok,
      actorUserId: userId,
    });
    const rows = await listLessonAuditByLessonId(lessonId);
    expect(rows[0]!.newBody).toBe(ok);
    expect(rows[0]!.previousBody).toBe(ok);
  });
});

describe("listLessonAuditByActorExtension — pagination", () => {
  test("filters by actorExtensionId; cursor descends by id", async () => {
    const lessonId = await ensureLesson("t-pag");
    for (let i = 0; i < 5; i++) {
      await insertLessonAuditEntry({
        lessonId,
        action: "updated",
        previousBody: `${i}`,
        newBody: `${i + 1}`,
        actorExtensionId: extensionId,
      });
    }
    // Also insert one row WITHOUT the extension actor — should NOT
    // appear in the per-extension list.
    await insertLessonAuditEntry({
      lessonId,
      action: "updated",
      previousBody: "n",
      newBody: "n+1",
      actorUserId: userId,
    });
    const page1 = await listLessonAuditByActorExtension(extensionId, { limit: 3 });
    expect(page1.length).toBe(3);
    for (const r of page1) expect(r.actorExtensionId).toBe(extensionId);
    // cursor = last id on page 1 — page 2 strictly less.
    const cursor = page1[page1.length - 1]!.id;
    const page2 = await listLessonAuditByActorExtension(extensionId, { limit: 3, cursor });
    expect(page2.length).toBe(2);
    for (const r of page2) expect(r.id).toBeLessThan(cursor);
  });
});
