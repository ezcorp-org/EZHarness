/**
 * query-core db-audit fix: upsertSetting must be a single race-free
 * ON CONFLICT DO UPDATE against the `settings.key` primary key, NOT a
 * select-then-insert that 500s the loser under concurrent first-writes.
 *
 * On PGlite (single connection) the true two-connection race can't interleave,
 * so these tests assert the fix STRUCTURALLY: the ON CONFLICT clause actually
 * fires (a pre-existing row is UPDATED, not duplicate-key-rejected), and a
 * batch of concurrent first-writes resolves without throwing.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../../__tests__/helpers/test-pglite";
import { sql, eq } from "drizzle-orm";

mockDbConnection();

const { upsertSetting, getSetting } = await import("../settings");
const { settings } = await import("../../schema");

describe("upsertSetting ON CONFLICT DO UPDATE", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("inserts a fresh key", async () => {
    await upsertSetting("k:new", { a: 1 });
    expect(await getSetting("k:new")).toEqual({ a: 1 });
  });

  test("a pre-existing row is UPDATED via the conflict clause, not rejected", async () => {
    // Seed the row directly (simulates the race winner's committed insert).
    const db = getTestDb();
    await db
      .insert(settings)
      .values({ key: "k:conflict", value: sql`'"old"'::jsonb`, updatedAt: new Date() });

    // The loser's write must hit ON CONFLICT and update — NOT throw a
    // duplicate-key 23505 (the old select-then-insert had no such handling).
    await upsertSetting("k:conflict", "new");
    expect(await getSetting("k:conflict")).toBe("new");

    // Exactly one row for the key (upsert, not a second insert).
    const rows = await db.select().from(settings).where(eq(settings.key, "k:conflict"));
    expect(rows).toHaveLength(1);
  });

  test("concurrent first-writes of a not-yet-existing key all resolve", async () => {
    // Two simultaneous PUTs writing the same new key: with select-then-insert
    // and no 23505 retry, the loser would surface an unhandled duplicate-key
    // 500 on external Postgres. The single ON CONFLICT statement is race-free.
    await Promise.all([
      upsertSetting("k:race", true),
      upsertSetting("k:race", true),
    ]);
    expect(await getSetting("k:race")).toBe(true);

    // Stored jsonb type is a real boolean (encoding preserved through the fix).
    const { rows } = await getTestDb().execute(
      sql`SELECT jsonb_typeof(value) AS t FROM settings WHERE key = ${"k:race"}`,
    );
    expect((rows as Array<{ t: string }>)[0]!.t).toBe("boolean");
  });
});
