/**
 * Patch-coverage fix (db-audit/cov): the external-Postgres (Bun.sql) boot path
 * in src/db/connection.ts's `initPostgres()` — lines 511-515 (the driver +
 * jsonb-fix opening), 553 (the advisory-locked `migrate()`), and the Bun.sql
 * `closeDb()` pool drain (708).
 *
 * connection.ts captures `DATABASE_URL` in a module-load const, so `init()`
 * only routes to `initPostgres()` when the WHOLE process was booted with
 * DATABASE_URL set — the PGlite coverage shards never are (the real-server
 * suite in db-migration-postgres.test.ts is `skipIf(!DATABASE_URL)`). And a
 * re-import cache-bust to force external mode is defeated once any sibling file
 * `mock.module`s db/connection: Bun matches that mock for query-suffixed
 * imports too. So we call the opener DIRECTLY via the `__test` seam (mirroring
 * how withPostgresMigrateLock / applyBunSqlJsonbFix are already tested) against
 * a MOCKED Bun.sql driver — no real Postgres, no socket.
 *
 * Mock hygiene:
 *   - `drizzle-orm/bun-sql` and `../db/migrate` are NOT in MODULE_PATHS, so we
 *     use the in-file restore pattern (stub at load, re-register the REAL module
 *     in afterAll) — the mock-cleanup meta-test recognises a path mocked twice
 *     in one file as self-restoring.
 *   - `applyBunSqlJsonbFix()` monkey-patches drizzle's PgJsonb/PgJson column
 *     prototypes process-wide; we snapshot + restore `mapToDriverValue` so no
 *     later PGlite test observes the identity patch.
 *   - `restoreModuleMocks()` (top + afterAll) keeps the real connection module
 *     bound and undoes any leaked mock either way.
 */
import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setReadiness } from "../readiness";
// Capture the REAL modules BEFORE stubbing so afterAll can re-register them
// (the second mock.module call per path is what the meta-test treats as a
// self-contained restore).
import * as realBunSql from "drizzle-orm/bun-sql";
import * as realMigrate from "../db/migrate";
import { PgJsonb } from "drizzle-orm/pg-core/columns/jsonb";
import { PgJson } from "drizzle-orm/pg-core/columns/json";

// Bind the REAL connection module (undo any mock a prior test file leaked).
restoreModuleMocks();

// ── Fake Bun.sql driver ────────────────────────────────────────────────────
// Records the advisory-lock SQL the migrate guard issues and the pool close.
const sqlCalls: string[] = [];
let closeCalls = 0;
let migrateCalls = 0;

// `$client` is a callable tagged template (advisory lock/unlock) that also
// exposes .close() for the pool-drain branch. No `reserve` → the lock is taken
// on this bare client (the reserve-absent fallback).
const fakeClient: {
  (strings: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
  close: () => Promise<void>;
} = Object.assign(
  (strings: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => {
    sqlCalls.push(strings.join("?"));
    return Promise.resolve([]);
  },
  {
    close: async (): Promise<void> => {
      closeCalls += 1;
    },
  },
);

const fakeDb: { execute: (...a: unknown[]) => Promise<unknown[]>; $client: typeof fakeClient } = {
  // Returns an array so initPostgres's execute() wrapper normalizes it to
  // { rows: [] } — enough for CREATE EXTENSION + repairDoubleEncodedJsonb's
  // marker/column scans to no-op.
  execute: async (..._a: unknown[]): Promise<unknown[]> => [],
  $client: fakeClient,
};

// Snapshot the real jsonb mappers so afterAll can undo applyBunSqlJsonbFix's
// global identity patch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const origJsonbMapper = (PgJsonb.prototype as any).mapToDriverValue;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const origJsonMapper = (PgJson.prototype as any).mapToDriverValue;

// Stub the driver so `drizzle(...)` never opens a socket, and `migrate` so the
// advisory-locked call is an observable no-op. mock.module rebinds the already
// loaded connection module's `./migrate` import and its lazy
// `import("drizzle-orm/bun-sql")`.
mock.module("drizzle-orm/bun-sql", () => ({ drizzle: () => fakeDb }));
mock.module("../db/migrate", () => ({
  migrate: async (): Promise<void> => {
    migrateCalls += 1;
  },
}));

const conn = await import("../db/connection");

afterAll(() => {
  // Restore the real driver + migrate for any later test file.
  mock.module("drizzle-orm/bun-sql", () => realBunSql);
  mock.module("../db/migrate", () => realMigrate);
  // Undo the global jsonb identity patch.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (PgJsonb.prototype as any).mapToDriverValue = origJsonbMapper;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (PgJson.prototype as any).mapToDriverValue = origJsonMapper;
  conn.__test.setState(null, null);
  setReadiness({ state: "ready" });
  restoreModuleMocks();
});

describe("initPostgres — external Postgres boot path (unit, mocked driver)", () => {
  test("opens Bun.sql, applies the jsonb fix, and migrates under the advisory lock", async () => {
    await conn.__test.initPostgres();

    // External mode leaves the embedded PGlite handle null and wires _db to the
    // Bun.sql-backed drizzle handle (its execute() wrapper normalizes to {rows}).
    expect(conn.getPglite()).toBeNull();
    const res = (await conn.getDb().execute()) as { rows: unknown[] };
    expect(res.rows).toEqual([]);

    // migrate() ran exactly once, wrapped by withPostgresMigrateLock.
    expect(migrateCalls).toBe(1);

    // The advisory lock bracketed the migrate on the Bun.sql client.
    expect(sqlCalls.some((s) => s.includes("pg_advisory_lock"))).toBe(true);
    expect(sqlCalls.some((s) => s.includes("pg_advisory_unlock"))).toBe(true);

    // applyBunSqlJsonbFix() swapped drizzle's jsonb mapper for identity.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((PgJsonb.prototype as any).mapToDriverValue({ a: 1 })).toEqual({ a: 1 });
  });

  test("closeDb() drains the Bun.sql pool via $client.close()", async () => {
    // Continues from the initialized external db above (_pglite null, _db set).
    await conn.closeDb();
    expect(closeCalls).toBe(1);
    // State cleared: getDb() now throws.
    expect(() => conn.getDb()).toThrow("Database not initialized");
  });
});
