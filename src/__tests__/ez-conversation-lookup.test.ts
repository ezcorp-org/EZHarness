/**
 * Phase 48 Wave 1 — getOrCreateEzConversation idempotency + DB-level
 * uniqueness via the partial index conversations_user_ez_unique.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { getOrCreateEzConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");
const { conversations } = await import("../db/schema");

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "ez-lookup@test.com", passwordHash: "h", name: "EZ" });
  userId = u.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("getOrCreateEzConversation", () => {
  test("creates a row on first call and tags it kind='ez', modeId='builtin-ez', projectId='global'", async () => {
    const conv = await getOrCreateEzConversation(userId);
    expect(conv).toBeDefined();
    expect(conv.userId).toBe(userId);
    expect(conv.kind).toBe("ez");
    expect(conv.modeId).toBe("builtin-ez");
    expect(conv.projectId).toBe("global");
    expect(conv.title).toBe("Ez");
  });

  test("second call returns the same conversation row (idempotent)", async () => {
    const a = await getOrCreateEzConversation(userId);
    const b = await getOrCreateEzConversation(userId);
    expect(a.id).toBe(b.id);
  });

  test("requires a userId — empty string throws", async () => {
    expect(getOrCreateEzConversation("")).rejects.toThrow();
  });

  test("unique partial index rejects a second direct INSERT of kind='ez' for the same user", async () => {
    // First call seeds the row.
    await getOrCreateEzConversation(userId);

    // Bypass the helper and try a raw INSERT — the unique partial index
    // conversations_user_ez_unique must refuse it. This is the DB-level
    // safety net behind the application-layer guard. drizzle's insert
    // builder is lazily executed; wrap it in an async fn so toThrow()
    // sees the actual rejection.
    let caught: unknown;
    try {
      await getDb()
        .insert(conversations)
        .values({
          projectId: "global",
          title: "Pretender",
          userId,
          kind: "ez",
        });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // The drizzle wrapper hides the underlying postgres detail in `cause`.
    // We assert on the index name to make sure the rejection is the
    // partial unique index — not some other FK / NOT NULL constraint we
    // accidentally tripped.
    const cause = (caught as { cause?: unknown }).cause;
    const detail = `${String(caught)} ${String(cause)} ${(cause as { message?: string })?.message ?? ""}`;
    expect(detail).toContain("conversations_user_ez_unique");
  });

  test("two different users each get their own ez conversation", async () => {
    const u2 = await createUser({ email: "ez-lookup-2@test.com", passwordHash: "h", name: "EZ2" });
    const a = await getOrCreateEzConversation(userId);
    const b = await getOrCreateEzConversation(u2.id);
    expect(a.id).not.toBe(b.id);
    expect(a.userId).toBe(userId);
    expect(b.userId).toBe(u2.id);
  });

  test("regular conversations don't trigger the unique-ez constraint", async () => {
    // The unique partial index only fires WHERE kind='ez'. A regular
    // conversation insert for the same userId must succeed.
    await getOrCreateEzConversation(userId); // ensure ez exists
    const rows = await getDb()
      .insert(conversations)
      .values({
        projectId: "global",
        title: "Regular thread",
        userId,
        kind: "regular",
      })
      .returning();
    expect(rows[0]).toBeDefined();
    expect(rows[0]!.kind).toBe("regular");
  });
});
