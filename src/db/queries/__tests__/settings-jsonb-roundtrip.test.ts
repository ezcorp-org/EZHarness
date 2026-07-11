/**
 * upsertSetting jsonb-encoding regression (live finding, 2026-07-10).
 *
 * On external Postgres (Bun.sql driver) a bare boolean/number param bound to
 * the jsonb `settings.value` column 500s ("column is of type jsonb but
 * expression is of type boolean"), and a param cast straight to ::jsonb gets
 * double-encoded by the driver (`false` → jsonb STRING "false"). The fix
 * routes every value through JSON.stringify + `::text::jsonb`.
 *
 * PGlite tolerates the bare values (which is why no test caught the live
 * failure), but it executes the SAME encoded SQL — this suite pins the
 * roundtrip semantics of the encoded path for every JSON scalar/shape so a
 * regression to bare binding (or a re-introduced double-encode) fails here.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "../../../__tests__/helpers/test-pglite";
import { sql } from "drizzle-orm";

mockDbConnection();

const { upsertSetting, getSetting, deleteSetting } = await import("../settings");

describe("upsertSetting jsonb roundtrip", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  const CASES: Array<[string, unknown, string]> = [
    ["boolean false", false, "boolean"],
    ["boolean true", true, "boolean"],
    ["number", 42, "number"],
    ["string", "hello", "string"],
    ["object", { a: 1, b: ["x"] }, "object"],
    ["null", null, "null"],
  ];

  for (const [label, value, jsonbType] of CASES) {
    test(`${label} roundtrips with correct jsonb type`, async () => {
      await upsertSetting("test:roundtrip", value);
      expect(await getSetting("test:roundtrip")).toEqual(value);
      // Not just the JS roundtrip: the STORED type must be the real jsonb
      // type, not a double-encoded string ("false" ≠ false).
      const { rows } = await getTestDb().execute(
        sql`SELECT jsonb_typeof(value) AS t FROM settings WHERE key = ${"test:roundtrip"}`,
      );
      expect((rows as Array<{ t: string }>)[0]!.t).toBe(jsonbType);
    });
  }

  test("update path re-encodes too (false → true on existing row)", async () => {
    await upsertSetting("test:flip", false);
    await upsertSetting("test:flip", true);
    expect(await getSetting("test:flip")).toBe(true);
    const { rows } = await getTestDb().execute(
      sql`SELECT jsonb_typeof(value) AS t FROM settings WHERE key = ${"test:flip"}`,
    );
    expect((rows as Array<{ t: string }>)[0]!.t).toBe("boolean");
    expect(await deleteSetting("test:flip")).toBe(true);
  });
});
