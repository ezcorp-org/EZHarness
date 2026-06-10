import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { PGlite } from "@electric-sql/pglite";

// This suite tests the REAL rawQuery from src/db/connection.ts — both the
// PGlite path and the external-Postgres (Bun.sql `$client.unsafe`) path.
// Parallel test files mock.module() ../db/connection globally; re-register
// the pristine snapshot (taken by preload.ts) before importing so we get the
// real implementation, not a leaked stub.
restoreModuleMocks();
const { rawQuery, __test } = await import("../db/connection");

describe("rawQuery — PGlite path (real bind params)", () => {
  let pglite: PGlite;

  beforeAll(async () => {
    // Bare PGlite (no migrations needed): rawQuery binding semantics are
    // engine-level, so a minimal probe table keeps this suite fast and
    // avoids the full-schema migrate + vector WASM load.
    pglite = new PGlite();
    await pglite.waitReady;
    await pglite.exec(
      "CREATE TABLE rq_probe (id TEXT PRIMARY KEY, name TEXT)",
    );
    await pglite.exec(
      "INSERT INTO rq_probe (id, name) VALUES ('p1', 'plain')",
    );
    __test.setState(null, pglite);
  }, 30_000);

  afterAll(async () => {
    __test.setState(null, null);
    await pglite.close().catch(() => {});
    restoreModuleMocks();
  });

  test("binds positional $1/$2 params", async () => {
    const result = await rawQuery("SELECT $1::text AS a, $2::text AS b", ["foo", "bar"]);
    expect(result.rows).toEqual([{ a: "foo", b: "bar" }]);
  });

  test("defaults to no params", async () => {
    const result = await rawQuery("SELECT 1 AS one");
    expect((result.rows as Array<{ one: number }>)[0]!.one).toBe(1);
  });

  test("null param binds as SQL NULL", async () => {
    const result = await rawQuery("SELECT $1::text AS val", [null]);
    expect((result.rows as Array<{ val: string | null }>)[0]!.val).toBeNull();
  });

  test("single quotes in params round-trip unaltered", async () => {
    const payload = "O'Brien'; DROP TABLE rq_probe;--";
    const result = await rawQuery("SELECT $1::text AS val", [payload]);
    expect((result.rows as Array<{ val: string }>)[0]!.val).toBe(payload);
  });

  test("backslash / E''-style payloads round-trip unaltered", async () => {
    const payloads = ["C:\\temp\\file", "\\' OR 1=1 --", "x', E'\\\\"];
    for (const payload of payloads) {
      const result = await rawQuery("SELECT $1::text AS val", [payload]);
      expect((result.rows as Array<{ val: string }>)[0]!.val).toBe(payload);
    }
  });

  test("injection probe stays data, never executes", async () => {
    const probe = await rawQuery("SELECT name FROM rq_probe WHERE name = $1", [
      "plain'; DROP TABLE rq_probe;--",
    ]);
    expect(probe.rows).toEqual([]);
    // Table must still exist and hold the seeded row.
    const intact = await rawQuery("SELECT name FROM rq_probe WHERE id = $1", ["p1"]);
    expect(intact.rows).toEqual([{ name: "plain" }]);
  });

  test("non-string params bind with their native type", async () => {
    // Public signature is (string | null)[]; the underlying drivers accept
    // any bindable value — verify a number survives as a real integer.
    const result = await rawQuery("SELECT $1::int + 1 AS n", [41 as unknown as string]);
    expect((result.rows as Array<{ n: number }>)[0]!.n).toBe(42);
  });
});

describe("rawQuery — external Postgres path (Bun.sql $client.unsafe binding)", () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fakeRows = [{ id: "r1", content: "hit" }];
  // Minimal stand-in for drizzle's bun-sql db: rawQuery only touches
  // `$client.unsafe`, which mirrors Bun.SQL's `unsafe(query, values)` API.
  const fakeDb = {
    $client: {
      unsafe: (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        return Promise.resolve(fakeRows);
      },
    },
  };

  beforeAll(() => {
    __test.setState(fakeDb, null);
  });

  afterAll(() => {
    __test.setState(null, null);
    restoreModuleMocks();
  });

  test("passes the query text verbatim and params as a bound array", async () => {
    const sql = "SELECT * FROM memories WHERE content = $1 AND project_id = $2";
    const result = await rawQuery(sql, ["a'b\\c", "proj-1"]);
    expect(result).toEqual({ rows: fakeRows });
    const call = calls.at(-1)!;
    expect(call.sql).toBe(sql); // placeholders intact — nothing inlined
    expect(call.params).toEqual(["a'b\\c", "proj-1"]);
  });

  test("quote/backslash payloads are never spliced into the SQL string", async () => {
    const payload = "x', E'\\\\'; DROP TABLE memories;--";
    await rawQuery("SELECT $1::text AS val", [payload]);
    const call = calls.at(-1)!;
    expect(call.sql).toBe("SELECT $1::text AS val");
    expect(call.sql).not.toContain("DROP TABLE");
    expect(call.params).toEqual([payload]);
  });

  test("null params are bound (not rewritten to a NULL keyword)", async () => {
    await rawQuery("SELECT $1::text AS val", [null]);
    const call = calls.at(-1)!;
    expect(call.sql).toBe("SELECT $1::text AS val");
    expect(call.params).toEqual([null]);
  });

  test("omitted params default to an empty bind array", async () => {
    await rawQuery("SELECT 1 AS one");
    expect(calls.at(-1)!.params).toEqual([]);
  });

  test("non-string params pass through unmangled", async () => {
    await rawQuery("SELECT $1::int AS n", [42 as unknown as string]);
    expect(calls.at(-1)!.params).toEqual([42]);
  });

  test("throws when the DB is not initialized", async () => {
    __test.setState(null, null);
    try {
      await expect(rawQuery("SELECT 1", [])).rejects.toThrow("Database not initialized");
    } finally {
      __test.setState(fakeDb, null);
    }
  });
});
