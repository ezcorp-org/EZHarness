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
let migrateCalls = 0;

interface FakePool {
  execute: (...a: unknown[]) => Promise<unknown[]>;
  $client: {
    (strings: TemplateStringsArray, ...v: unknown[]): Promise<unknown[]>;
    close: () => Promise<void>;
  };
  /** How many times THIS pool was drained. */
  closed: number;
}

/**
 * A fresh fake pool per `drizzle()` call. Distinct instances (rather than one
 * shared singleton) are what make the stale-pool reclaim observable: the guard
 * must close the pool opened by the PREVIOUS boot, not the current one.
 *
 * `$client` is a callable tagged template (advisory lock/unlock) that also
 * exposes .close() for the pool-drain branch. No `reserve` → the lock is taken
 * on this bare client (the reserve-absent fallback).
 */
function createFakePool(): FakePool {
  const pool: FakePool = {
    // Returns an array so initPostgres's execute() wrapper normalizes it to
    // { rows: [] } — enough for CREATE EXTENSION + repairDoubleEncodedJsonb's
    // marker/column scans to no-op.
    execute: async (..._a: unknown[]): Promise<unknown[]> => [],
    $client: Object.assign(
      (strings: TemplateStringsArray, ..._v: unknown[]): Promise<unknown[]> => {
        sqlCalls.push(strings.join("?"));
        return Promise.resolve([]);
      },
      {
        close: async (): Promise<void> => {
          pool.closed += 1;
        },
      },
    ),
    closed: 0,
  };
  return pool;
}

/** Every pool the driver has handed out, in open order. */
const openedPools: FakePool[] = [];

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
mock.module("drizzle-orm/bun-sql", () => ({
  drizzle: () => {
    const pool = createFakePool();
    openedPools.push(pool);
    return pool;
  },
}));
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
    const only = openedPools[0];
    await conn.closeDb();
    expect(only.closed).toBe(1);
    // State cleared: getDb() now throws.
    expect(() => conn.getDb()).toThrow("Database not initialized");
  });
});

/**
 * Regression: the external-Postgres pool must not survive a module
 * re-instantiation.
 *
 * A vite dev-server SSR reload rebuilds `connection.ts` with fresh
 * `let _db`/`_initPromise` bindings while the previous Bun.sql pool is still
 * open in the same process. Nothing references that pool afterwards, but
 * Bun.sql keeps its sockets open, so every reload strands another `DB_POOL_MAX`
 * backends in state `idle` until Postgres answers new clients with "sorry, too
 * many clients already". Measured on the dev stack: ~97 idle backends against
 * `max_connections = 100`.
 *
 * Calling `initPostgres()` again without an intervening `closeDb()` reproduces
 * exactly that state — the globalThis-anchored holder registry is the only
 * thing that spans the two boots, which is why the guard has to live there
 * (`initPglite()` has used it for the same reason since the double-open fix).
 */
describe("initPostgres — stale pool reclaim across a module re-instantiation", () => {
  test("re-booting without closeDb() drains the previous pool, not the new one", async () => {
    // Boot #1 — the pool a subsequent reload must reclaim.
    await conn.__test.initPostgres();
    const first = openedPools.at(-1)!;
    expect(first.closed).toBe(0);

    // Boot #2 — stands in for the re-instantiated module. No closeDb() between:
    // that is precisely the path that leaked.
    await conn.__test.initPostgres();
    const second = openedPools.at(-1)!;

    expect(second).not.toBe(first);
    // The stranded pool from boot #1 was drained...
    expect(first.closed).toBe(1);
    // ...and the live one was left alone.
    expect(second.closed).toBe(0);
    // The live handle is boot #2's pool.
    expect(conn.getDb()).toBe(second);
  });

  test("closeDb() clears the in-process claim so the next boot can't double-close", async () => {
    // Continues from the test above: boot #2's pool is live and unclosed.
    const previous = openedPools.at(-1)!;
    await conn.closeDb();
    expect(previous.closed).toBe(1);

    // A later boot must NOT re-close the pool closeDb() already drained — a
    // stale registry entry would hand it a callback onto a dead pool.
    await conn.__test.initPostgres();
    expect(previous.closed).toBe(1);

    // Clean up so the registry is empty for any later file in this process.
    const live = openedPools.at(-1)!;
    await conn.closeDb();
    expect(live.closed).toBe(1);
  });
});
