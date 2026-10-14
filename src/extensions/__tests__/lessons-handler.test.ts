/**
 * Coverage for `handlePiLessons` (Phase 51.3).
 *
 * Critical-path tests:
 *   - authorExtensionId stamped from host (spoof defense).
 *   - visibility clamp: extension cannot grant itself "global".
 *   - slug collision returns existing row with `created: false`.
 *   - composite slug uniqueness allows two extensions to share a
 *     slug for the same user.
 *   - update of non-owned lesson → -32001 reason "not-author".
 *   - lessons_audit_log row written with full body diff.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import { handlePiLessons, _resetLessonsWriteQuotaForTests } from "../lessons-handler";
import { createUser } from "../../db/queries/users";
import {
  extensions, conversations, projects,
  sdkCapabilityCalls, messages, errorLogs, auditLog,
  lessons, lessonsAuditLog,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import type { ExtensionPermissions } from "../types";

let userId: string;
let extensionId: string;
let extensionId2: string;
let projectId: string;
let conversationId: string;

async function ensureExtension(name: string): Promise<string> {
  const [row] = await getTestDb().insert(extensions).values({
    name, version: "0.0.1", description: "",
    manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as any,
    source: "test", enabled: true, grantedPermissions: {} as any,
  }).returning({ id: extensions.id });
  return row!.id;
}

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "less-h@example.com", passwordHash: "h", name: "U", role: "admin", status: "active" });
  userId = u.id;
  extensionId = await ensureExtension("less-h-ext-1");
  extensionId2 = await ensureExtension("less-h-ext-2");
  const [proj] = await getTestDb().insert(projects).values({ name: "less-proj", path: "/tmp/less" }).returning({ id: projects.id });
  projectId = proj!.id;
  const [conv] = await getTestDb().insert(conversations).values({ projectId, userId, title: "t", kind: "regular" }).returning({ id: conversations.id });
  conversationId = conv!.id;
});

beforeEach(async () => {
  await getTestDb().delete(messages);
  await getTestDb().delete(lessonsAuditLog);
  await getTestDb().delete(lessons);
  await getTestDb().delete(sdkCapabilityCalls);
  await getTestDb().delete(errorLogs);
  await getTestDb().delete(auditLog);
  _resetLessonsWriteQuotaForTests();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function grantedWrite(overrides: Partial<NonNullable<ExtensionPermissions["lessons"]>> = {}): ExtensionPermissions {
  return {
    grantedAt: { lessons: Date.now() },
    lessons: { access: "write", maxWritesPerDay: 50, maxVisibility: "user", ...overrides },
  };
}

function rpcMeta(): Record<string, unknown> {
  return { ezOnBehalfOf: userId, ezConversationId: conversationId };
}

describe("lessons: write", () => {
  test("stamps authorExtensionId from host (NOT RPC meta)", async () => {
    const resp = await handlePiLessons(
      {
        jsonrpc: "2.0", id: 1, method: "ezcorp/lessons",
        params: { action: "write", input: { slug: "test-1", title: "T", body: "B", projectId } },
      },
      { granted: grantedWrite(), registeredTool: { extensionId } },
      { ...rpcMeta(), actorExtensionId: "evil-ext" },
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { lesson: { id: string; authorExtensionId: string }; created: boolean };
    expect(result.created).toBe(true);
    expect(result.lesson.authorExtensionId).toBe(extensionId);
  });

  test("invalid slug → -32001 'invalid-slug'", async () => {
    const resp = await handlePiLessons(
      {
        jsonrpc: "2.0", id: 2, method: "ezcorp/lessons",
        params: { action: "write", input: { slug: "Bad Slug!", title: "T", body: "B", projectId } },
      },
      { granted: grantedWrite(), registeredTool: { extensionId } },
      rpcMeta(),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.data).toMatchObject({ reason: "invalid-slug" });
  });

  test("requested visibility=global clamped down to maxVisibility", async () => {
    const resp = await handlePiLessons(
      {
        jsonrpc: "2.0", id: 3, method: "ezcorp/lessons",
        params: { action: "write", input: { slug: "vis-test", title: "T", body: "B", visibility: "global", projectId } },
      },
      { granted: grantedWrite({ maxVisibility: "user" }), registeredTool: { extensionId } },
      rpcMeta(),
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as { lesson: { visibility: string } };
    expect(result.lesson.visibility).toBe("user");
    // Phase 51.3.5: visibility-clamped audit warning (S2).
    const audits = await getTestDb().select().from(auditLog).where(eq(auditLog.action, "ext:sdk-lessons-visibility-clamped"));
    expect(audits.length).toBe(1);
    expect(audits[0]!.target).toBe(extensionId);
    const meta = audits[0]!.metadata as { oldValue?: string; newValue?: string };
    expect(meta.oldValue).toBe("global");
    expect(meta.newValue).toBe("user");
  });

  test("slug collision returns existing row with created=false", async () => {
    const ctx = { granted: grantedWrite(), registeredTool: { extensionId } };
    const params = { action: "write" as const, input: { slug: "dup", title: "T1", body: "B1", projectId } };

    const first = await handlePiLessons({ jsonrpc: "2.0", id: 10, method: "ezcorp/lessons", params }, ctx, rpcMeta());
    const second = await handlePiLessons({ jsonrpc: "2.0", id: 11, method: "ezcorp/lessons", params }, ctx, rpcMeta());
    const r1 = first.result as { lesson: { id: string }; created: boolean };
    const r2 = second.result as { lesson: { id: string } | null; created: boolean };
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.lesson?.id).toBe(r1.lesson.id);
  });

  test("composite slug uniqueness — two extensions share slug for same user", async () => {
    const params = { action: "write" as const, input: { slug: "shared-slug", title: "T", body: "B", projectId } };
    const r1 = await handlePiLessons(
      { jsonrpc: "2.0", id: 20, method: "ezcorp/lessons", params },
      { granted: grantedWrite(), registeredTool: { extensionId } },
      rpcMeta(),
    );
    const r2 = await handlePiLessons(
      { jsonrpc: "2.0", id: 21, method: "ezcorp/lessons", params },
      { granted: grantedWrite(), registeredTool: { extensionId: extensionId2 } },
      rpcMeta(),
    );
    expect((r1.result as { created: boolean }).created).toBe(true);
    expect((r2.result as { created: boolean }).created).toBe(true);
    // Both rows live in the DB.
    const rows = await getTestDb().select().from(lessons).where(eq(lessons.slug, "shared-slug"));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.authorExtensionId).sort()).toEqual([extensionId, extensionId2].sort());
  });

  test("update of non-owned lesson → -32001 'not-author'", async () => {
    const written = await handlePiLessons(
      {
        jsonrpc: "2.0", id: 30, method: "ezcorp/lessons",
        params: { action: "write", input: { slug: "owned", title: "T", body: "B", projectId } },
      },
      { granted: grantedWrite(), registeredTool: { extensionId } },
      rpcMeta(),
    );
    const lessonId = (written.result as { lesson: { id: string } }).lesson.id;
    const denied = await handlePiLessons(
      {
        jsonrpc: "2.0", id: 31, method: "ezcorp/lessons",
        params: { action: "update", id: lessonId, patch: { body: "hacked" } },
      },
      { granted: grantedWrite(), registeredTool: { extensionId: extensionId2 } },
      rpcMeta(),
    );
    expect(denied.error?.code).toBe(-32001);
    expect(denied.error?.data).toMatchObject({ reason: "not-author" });
  });

  test("lessons_audit_log row captures body diff on update", async () => {
    const written = await handlePiLessons(
      {
        jsonrpc: "2.0", id: 40, method: "ezcorp/lessons",
        params: { action: "write", input: { slug: "diff", title: "T", body: "v1", projectId } },
      },
      { granted: grantedWrite(), registeredTool: { extensionId } },
      rpcMeta(),
    );
    const lessonId = (written.result as { lesson: { id: string } }).lesson.id;
    await handlePiLessons(
      {
        jsonrpc: "2.0", id: 41, method: "ezcorp/lessons",
        params: { action: "update", id: lessonId, patch: { body: "v2" } },
      },
      { granted: grantedWrite(), registeredTool: { extensionId } },
      rpcMeta(),
    );
    const audits = await getTestDb().select().from(lessonsAuditLog).where(eq(lessonsAuditLog.lessonId, lessonId));
    // 2 rows: created + updated.
    expect(audits.length).toBe(2);
    const created = audits.find((a) => a.action === "created");
    const updated = audits.find((a) => a.action === "updated");
    expect(created!.newBody).toBe("v1");
    expect(updated!.previousBody).toBe("v1");
    expect(updated!.newBody).toBe("v2");
  });

  test("write without grant → -32001", async () => {
    const resp = await handlePiLessons(
      {
        jsonrpc: "2.0", id: 50, method: "ezcorp/lessons",
        params: { action: "write", input: { slug: "x", title: "T", body: "B", projectId } },
      },
      { granted: { grantedAt: {} }, registeredTool: { extensionId } },
      rpcMeta(),
    );
    expect(resp.error?.code).toBe(-32001);
  });

  test("daily quota exceeded → -32103", async () => {
    const ctx = { granted: grantedWrite({ maxWritesPerDay: 1 }), registeredTool: { extensionId } };
    await handlePiLessons(
      { jsonrpc: "2.0", id: 60, method: "ezcorp/lessons",
        params: { action: "write", input: { slug: "q1", title: "T", body: "B", projectId } } },
      ctx, rpcMeta(),
    );
    const denied = await handlePiLessons(
      { jsonrpc: "2.0", id: 61, method: "ezcorp/lessons",
        params: { action: "write", input: { slug: "q2", title: "T", body: "B", projectId } } },
      ctx, rpcMeta(),
    );
    expect(denied.error?.code).toBe(-32103);
  });
});

/** Run one `ezcorp/lessons` action as `actorExtId` acting for `onBehalfOf`. */
function call(
  params: Record<string, unknown>,
  opts: { ext?: string; user?: string; granted?: ExtensionPermissions } = {},
) {
  return handlePiLessons(
    { jsonrpc: "2.0", id: 1, method: "ezcorp/lessons", params: params as never },
    { granted: opts.granted ?? grantedWrite(), registeredTool: { extensionId: opts.ext ?? extensionId } },
    { ezOnBehalfOf: opts.user ?? userId, ezConversationId: conversationId },
  );
}

async function writeLesson(slug: string, opts: { ext?: string; user?: string } = {}): Promise<string> {
  const resp = await call({ action: "write", input: { slug, title: `T-${slug}`, body: `B-${slug}`, projectId } }, opts);
  return (resp.result as { lesson: { id: string } }).lesson.id;
}

function lessonRow(id: string) {
  return getTestDb().select().from(lessons).where(eq(lessons.id, id)).then((r) => r[0]);
}

describe("lessons: read access", () => {
  const readOnly: ExtensionPermissions = {
    grantedAt: { lessons: Date.now() },
    lessons: { access: "read", maxWritesPerDay: 50, maxVisibility: "user" },
  };

  test("list returns only the caller's own lessons, filtered by project and capped by limit", async () => {
    await writeLesson("a-one");
    await writeLesson("a-two");
    await writeLesson("b-one", { ext: extensionId2 });

    const all = await call({ action: "list" });
    expect((all.result as { lessons: { slug: string }[] }).lessons.map((l) => l.slug).sort()).toEqual(["a-one", "a-two"]);

    const limited = await call({ action: "list", projectId, limit: 1 });
    expect((limited.result as { lessons: unknown[] }).lessons).toHaveLength(1);

    const otherProject = await call({ action: "list", projectId: "no-such-project" });
    expect((otherProject.result as { lessons: unknown[] }).lessons).toHaveLength(0);
  });

  test("get finds a lesson by id or by slug+projectId, and needs one of them", async () => {
    const id = await writeLesson("by-key");

    const byId = await call({ action: "get", id }, { granted: readOnly });
    expect((byId.result as { lesson: { slug: string } }).lesson.slug).toBe("by-key");

    const bySlug = await call({ action: "get", slug: "by-key", projectId }, { granted: readOnly });
    expect((bySlug.result as { lesson: { id: string } }).lesson.id).toBe(id);

    const missing = await call({ action: "get", slug: "by-key" }, { granted: readOnly });
    expect(missing.error?.data).toMatchObject({ reason: "id or (slug+projectId) required" });
  });

  test("read access cannot write, update or archive", async () => {
    for (const action of ["write", "update", "archive"]) {
      const resp = await call({ action, id: "x" }, { granted: readOnly });
      expect(resp.error?.data).toMatchObject({ reason: "lessons write access not granted" });
    }
  });

  test("an unknown action is a soft failure", async () => {
    const resp = await call({ action: "explode" });
    expect(resp.error?.data).toMatchObject({ reason: "unknown-action" });
  });
});

describe("lessons: cross-user and cross-extension isolation", () => {
  let otherUserId: string;

  beforeAll(async () => {
    const u = await createUser({ email: "less-h-other@example.com", passwordHash: "h", name: "O", role: "member", status: "active" });
    otherUserId = u.id;
  });

  test("get by id does not return a lesson another extension wrote", async () => {
    const id = await writeLesson("ext2-secret", { ext: extensionId2 });
    const resp = await call({ action: "get", id });
    expect((resp.result as { lesson: unknown }).lesson).toBeNull();
  });

  test("acting for another user, the same extension cannot read the first user's lessons", async () => {
    const id = await writeLesson("private-note");

    const list = await call({ action: "list" }, { user: otherUserId });
    expect((list.result as { lessons: unknown[] }).lessons).toHaveLength(0);
    const byId = await call({ action: "get", id }, { user: otherUserId });
    expect((byId.result as { lesson: unknown }).lesson).toBeNull();
    const bySlug = await call({ action: "get", slug: "private-note", projectId }, { user: otherUserId });
    expect((bySlug.result as { lesson: unknown }).lesson).toBeNull();
  });

  test("acting for another user, the same extension cannot change the first user's lessons", async () => {
    const id = await writeLesson("keep-me");

    for (const action of ["update", "archive", "recordFired", "recordDismissed"]) {
      const resp = await call({ action, id, patch: { body: "hijacked" } }, { user: otherUserId });
      expect(resp.error?.data).toMatchObject({ reason: "not-found" });
    }
    const row = await lessonRow(id);
    expect(row).toMatchObject({ body: "B-keep-me", firedCount: 0, dismissedCount: 0 });
  });
});

describe("lessons: update, archive and counters", () => {
  test("update changes title, body, frontmatter and clamps visibility", async () => {
    const id = await writeLesson("edit-me");
    const resp = await call({
      action: "update", id,
      patch: { title: "New", body: "New body", frontmatter: { tag: "x" }, visibility: "global" },
    });
    expect(resp.result).toEqual({ ok: true });
    expect(await lessonRow(id)).toMatchObject({ title: "New", body: "New body", frontmatter: { tag: "x" }, visibility: "user" });
  });

  test("update to project visibility is kept when the grant allows it", async () => {
    const id = await writeLesson("share-me");
    await call({ action: "update", id, patch: { visibility: "project" } }, { granted: grantedWrite({ maxVisibility: "project" }) });
    expect((await lessonRow(id))?.visibility).toBe("project");
  });

  test("archive deletes the lesson; only the author may archive it", async () => {
    const id = await writeLesson("old");
    const denied = await call({ action: "archive", id }, { ext: extensionId2 });
    expect(denied.error?.data).toMatchObject({ reason: "not-author" });

    expect((await call({ action: "archive", id })).result).toEqual({ ok: true });
    expect(await lessonRow(id)).toBeUndefined();
    const again = await call({ action: "archive", id });
    expect(again.error?.data).toMatchObject({ reason: "not-found" });
  });

  test("recordFired and recordDismissed count up for the author", async () => {
    const id = await writeLesson("counted");
    await Promise.all([call({ action: "recordFired", id }), call({ action: "recordFired", id })]);
    await call({ action: "recordDismissed", id });

    const row = await lessonRow(id);
    expect(row?.firedCount).toBe(2);
    expect(row?.lastFiredAt).toBeInstanceOf(Date);
    expect(row?.dismissedCount).toBe(1);

    const denied = await call({ action: "recordDismissed", id }, { ext: extensionId2 });
    expect(denied.error?.data).toMatchObject({ reason: "not-author" });
  });

  test("id-based actions require an id", async () => {
    for (const action of ["update", "archive", "recordFired", "recordDismissed"]) {
      const resp = await call({ action });
      expect(resp.error?.data).toMatchObject({ reason: "id required" });
    }
  });
});
