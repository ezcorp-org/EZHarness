/**
 * The `{rows}` invariant, PGlite side.
 *
 * connection.ts's `initPglite()` assigns `_db = drizzle(_pglite, { schema })`
 * directly — no wrapper, unlike `initPostgres()`'s `applyExecuteNormalization`
 * (see connection.ts). That's safe ONLY because drizzle-pglite's own session
 * (`drizzle-orm/pglite/session.js`) calls PGlite's native `.query()`, which
 * already resolves to `{rows: [...], fields, affectedRows}` — for `execute()`
 * at the top level AND for `execute()` on the `tx` a `db.transaction(...)`
 * callback receives, since both route through the same `PgliteSession`/
 * `PgliteTransaction` machinery.
 *
 * This pins that native behavior directly against the real PGlite driver
 * (not the mocked connection module), so a drizzle-pglite upgrade that
 * changed it would fail HERE instead of silently agreeing with query code
 * that assumes `{rows}` unconditionally (`src/db/queries/marketplace.ts`,
 * `src/db/queries/memories.ts`, `src/db/queries/audit-merge.ts`).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb } from "../../__tests__/helpers/test-pglite";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe("PGlite execute() shape", () => {
  test("db.execute() at the top level resolves to { rows }, not a bare array", async () => {
    const res = (await getTestDb().execute(sql`SELECT 1 AS one`)) as { rows: unknown[] };
    expect(Array.isArray(res)).toBe(false);
    expect(res.rows).toEqual([{ one: 1 }]);
  });

  test("tx.execute() inside db.transaction() also resolves to { rows }", async () => {
    const returned = await getTestDb().transaction(async (tx) => {
      const res = (await tx.execute(sql`SELECT 2 AS two`)) as { rows: unknown[] };
      expect(Array.isArray(res)).toBe(false);
      expect(res.rows).toEqual([{ two: 2 }]);
      return "tx-return-value";
    });
    expect(returned).toBe("tx-return-value");
  });

  test("a nested tx.transaction() (savepoint) handle's execute() is { rows } too", async () => {
    await getTestDb().transaction(async (tx) => {
      await tx.transaction(async (nested) => {
        const res = (await nested.execute(sql`SELECT 3 AS three`)) as { rows: unknown[] };
        expect(Array.isArray(res)).toBe(false);
        expect(res.rows).toEqual([{ three: 3 }]);
      });
    });
  });
});
