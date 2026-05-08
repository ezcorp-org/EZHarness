/**
 * Phase 51.3.5 migration coverage — lessons.author_extension_id +
 * composite slug uniqueness.
 *
 * Three locked invariants (spec § 51.3.5 test bullet):
 *   1. Migration backfills NULL `author_extension_id` for existing rows.
 *   2. Composite slug uniqueness allows extension-A and extension-B to
 *      BOTH have a `code-review-best-practices` slug for the same
 *      user (no constraint violation).
 *   3. A user-authored lesson with the same slug coexists with
 *      extension-authored lessons for the same project + user.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupTestDb, getTestDb, closeTestDb, mockDbConnection,
} from "./helpers/test-pglite";

mockDbConnection();

import {
  users, projects, extensions, lessons,
} from "../db/schema";
import { eq, and } from "drizzle-orm";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("lessons.author_extension_id migration", () => {
  test("existing pre-migration rows have NULL author_extension_id", async () => {
    const db = getTestDb();

    // Seed a baseline graph.
    const [u] = await db.insert(users).values({
      email: "less-mig-1@example.com", passwordHash: "x", name: "U", role: "member",
    }).returning();
    const [p] = await db.insert(projects).values({
      name: "less-mig-proj", path: "/tmp/less-mig",
    }).returning();

    // Insert a lesson using direct SQL to mimic the pre-migration shape
    // (no author_extension_id column at write time). The migration has
    // already added the column with NULL default, so a direct INSERT
    // omitting it should land NULL.
    await db.insert(lessons).values({
      projectId: p!.id,
      ownerId: u!.id,
      visibility: "user",
      slug: "pre-migration-lesson",
      title: "T",
      body: "B",
      source: "distiller",
    });

    const rows = await db.select().from(lessons).where(eq(lessons.slug, "pre-migration-lesson"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.authorExtensionId).toBeNull();
  });

  test("composite slug uniqueness — extension-A and extension-B share a slug for the same user", async () => {
    const db = getTestDb();
    const [u] = await db.insert(users).values({
      email: "less-mig-2@example.com", passwordHash: "x", name: "U2", role: "member",
    }).returning();
    const [p] = await db.insert(projects).values({
      name: "less-mig-proj-2", path: "/tmp/less-mig-2",
    }).returning();
    const [eA] = await db.insert(extensions).values({
      name: "lessons-mig-ext-A", version: "0.0.1", description: "",
      manifest: { schemaVersion: 2, name: "lessons-mig-ext-A", version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
      source: "test", enabled: true, grantedPermissions: {} as never,
    }).returning({ id: extensions.id });
    const [eB] = await db.insert(extensions).values({
      name: "lessons-mig-ext-B", version: "0.0.1", description: "",
      manifest: { schemaVersion: 2, name: "lessons-mig-ext-B", version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
      source: "test", enabled: true, grantedPermissions: {} as never,
    }).returning({ id: extensions.id });

    // Both extensions write a lesson with the SAME slug for the SAME user.
    await db.insert(lessons).values({
      projectId: p!.id, ownerId: u!.id, visibility: "user",
      slug: "code-review-best-practices", title: "T-A", body: "B-A",
      source: "extension" as never, authorExtensionId: eA!.id,
    });
    await db.insert(lessons).values({
      projectId: p!.id, ownerId: u!.id, visibility: "user",
      slug: "code-review-best-practices", title: "T-B", body: "B-B",
      source: "extension" as never, authorExtensionId: eB!.id,
    });

    const rows = await db.select().from(lessons).where(and(
      eq(lessons.slug, "code-review-best-practices"),
      eq(lessons.projectId, p!.id),
      eq(lessons.ownerId, u!.id),
    ));
    expect(rows.length).toBe(2);
    const authors = rows.map((r) => r.authorExtensionId).sort();
    expect(authors).toEqual([eA!.id, eB!.id].sort());
  });

  test("user-authored lesson coexists with extension-authored lessons sharing the same slug", async () => {
    const db = getTestDb();
    const [u] = await db.insert(users).values({
      email: "less-mig-3@example.com", passwordHash: "x", name: "U3", role: "member",
    }).returning();
    const [p] = await db.insert(projects).values({
      name: "less-mig-proj-3", path: "/tmp/less-mig-3",
    }).returning();
    const [eC] = await db.insert(extensions).values({
      name: "lessons-mig-ext-C", version: "0.0.1", description: "",
      manifest: { schemaVersion: 2, name: "lessons-mig-ext-C", version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
      source: "test", enabled: true, grantedPermissions: {} as never,
    }).returning({ id: extensions.id });

    // 1. User-authored row (NULL author_extension_id).
    await db.insert(lessons).values({
      projectId: p!.id, ownerId: u!.id, visibility: "user",
      slug: "shared-slug", title: "T-user", body: "B-user",
      source: "user",
    });
    // 2. Extension-authored row with SAME slug.
    await db.insert(lessons).values({
      projectId: p!.id, ownerId: u!.id, visibility: "user",
      slug: "shared-slug", title: "T-ext", body: "B-ext",
      source: "extension" as never, authorExtensionId: eC!.id,
    });

    const rows = await db.select().from(lessons).where(and(
      eq(lessons.slug, "shared-slug"),
      eq(lessons.projectId, p!.id),
      eq(lessons.ownerId, u!.id),
    ));
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.authorExtensionId === null)).toBeDefined();
    expect(rows.find((r) => r.authorExtensionId === eC!.id)).toBeDefined();
  });

  test("two user-authored rows with the same slug for the same user collide (sanity)", async () => {
    const db = getTestDb();
    const [u] = await db.insert(users).values({
      email: "less-mig-4@example.com", passwordHash: "x", name: "U4", role: "member",
    }).returning();
    const [p] = await db.insert(projects).values({
      name: "less-mig-proj-4", path: "/tmp/less-mig-4",
    }).returning();

    await db.insert(lessons).values({
      projectId: p!.id, ownerId: u!.id, visibility: "user",
      slug: "must-collide", title: "T1", body: "B1", source: "user",
    });
    let collided = false;
    try {
      await db.insert(lessons).values({
        projectId: p!.id, ownerId: u!.id, visibility: "user",
        slug: "must-collide", title: "T2", body: "B2", source: "user",
      });
    } catch (err) {
      // Drizzle wraps DB errors in a DrizzleQueryError with `cause`
      // pointing at the underlying PG error — walk the chain.
      let cur: unknown = err;
      for (let i = 0; i < 5 && cur != null; i++) {
        const code = (cur as { code?: string }).code;
        const msg = (cur as { message?: string }).message ?? "";
        if (code === "23505" || /duplicate key|unique constraint/i.test(msg)) {
          collided = true;
          break;
        }
        const next = (cur as { cause?: unknown }).cause;
        if (next === cur) break;
        cur = next;
      }
      if (!collided) throw err;
    }
    // The composite slug index INCLUDES author_extension_id via
    // COALESCE — two user-authored rows with NULL author both map to
    // '' under COALESCE, so they should collide.
    expect(collided).toBe(true);
  });
});
