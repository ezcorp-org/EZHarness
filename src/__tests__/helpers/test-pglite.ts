import { mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
// Mirror production connection.ts — pg_trgm must register at construction.
// UX-02 (Phase 57-04 Task 1): SQL `CREATE EXTENSION pg_trgm` is no-op
// without this contrib import, so `similarity(...)` would 42883.
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../../db/schema";
import { migrate } from "../../db/migrate";
import { applyPgliteNulPatches } from "../../db/nul-column-patch";
import {
  readCachedSnapshot,
  schemaFingerprint,
  writeCachedSnapshot,
} from "./pglite-snapshot-cache";

// Use the pristine globals snapshot saved by preload.ts (captured before any test file loads).
// Falls back to current globals at import time if preload didn't run.
const _pristineFetch: typeof fetch = (globalThis as any).__pristineFetch ?? globalThis.fetch;
const _pristineWebSocket: typeof WebSocket =
  (globalThis as any).__pristineWebSocket ?? globalThis.WebSocket;

// Extensions must be registered at construction (see the pg_trgm note above);
// this same set is passed both to the one-time snapshot build and to every
// per-test restore so `vector`/`pg_trgm` are live on the restored instance too.
const EXTENSIONS = { vector, pg_trgm } as const;

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

// Migrated datadir snapshot, built lazily ONCE per process on the first
// setupTestDb() call. Migrating a fresh PGlite replays the entire migrate.ts
// (267 DDL statements) on every call; instead we run it once, dump the datadir,
// and let each subsequent setupTestDb() restore that binary blob via
// `loadDataDir` — far cheaper than re-running the DDL, while still yielding a
// genuinely fresh, independent DB per test.
//
// Isolation: a Blob is immutable, so the cached snapshot is read-only and each
// `new PGlite({ loadDataDir })` materializes it into a private WASM FS — a write
// in one test cannot leak into the next. (Every beforeEach-per-test suite that
// mutates then asserts, e.g. queries-lessons, would fail if it did.)
let migratedSnapshot: Blob | File | undefined;

/**
 * In-flight handle for the ONE-TIME snapshot build, so it can be started at
 * module scope and merely AWAITED from a hook.
 *
 * WHY: the build is a process-global cost (267 DDL statements, measured at
 * 3340ms on an idle box against 426ms for a warm restore) and it used to be
 * triggered lazily by whichever `beforeAll`/`beforeEach` called setupTestDb()
 * first. That charged 3.3s of a one-time migration to a per-TEST budget it has
 * nothing to do with — bun's default is 5s, so the first test in every
 * DB-touching file started 67% of the way through its own timeout, and under
 * load it is always the first test that dies. The reported symptom is useless
 * too: bun names the victim ("a workflow created with no ownership is …" or
 * just "(unnamed)"), never the migration.
 *
 * `primeMigratedSnapshot()` is called from `mockDbConnection()`, which every
 * DB-using suite already calls at MODULE level, before any hook exists. The
 * build then overlaps the rest of module load instead of starting inside a
 * hook, and `setupTestDb()` awaits whatever is left.
 *
 * NOT a timeout change. The budget is untouched; the work simply stops being
 * charged to a test that never asked for it.
 */
let snapshotBuild: Promise<Blob | File> | undefined;

function primeMigratedSnapshot(): Promise<Blob | File> {
  snapshotBuild ??= buildMigratedSnapshot();
  return snapshotBuild;
}

async function buildMigratedSnapshot(): Promise<Blob | File> {
  // Cross-process cache. The build below is identical in every one of the 399
  // processes that import this helper, so the pool pays for it once per RUN
  // instead of once per FILE. The key is a content hash of everything that can
  // change the resulting datadir — see pglite-snapshot-cache.ts, which is where
  // the real work of this optimization is, because a stale entry would be a
  // silent false green on schema. A miss (or any read failure) falls through to
  // the real migrate below, so the cache is never load-bearing for correctness.
  const key = schemaFingerprint();
  const cached = await readCachedSnapshot(key);
  if (cached) return cached;

  const seed = new PGlite({ extensions: EXTENSIONS });
  await seed.waitReady;
  await migrate(drizzle(seed, { schema }));
  // Dump BEFORE any test mutates the seed instance so the snapshot is a clean,
  // representative post-migrate state. "none" (uncompressed) → fastest restore;
  // the blob is cached once per process, so per-test decompression cost would
  // outweigh the one-time memory saving of gzip.
  const snapshot = await seed.dumpDataDir("none");
  await seed.close();
  await writeCachedSnapshot(key, snapshot);
  return snapshot;
}

export async function setupTestDb() {
  // Mirror production's PGlite boot: install the NUL (U+0000) scrubbers on the
  // drizzle column prototypes. Without this the test DB would accept writes
  // production rejects — the exact blind spot that let the dropped-tool_error
  // bug ship. Calls the REAL production patch so the two stay in lockstep; it
  // is idempotent, so re-running it per test is free.
  await applyPgliteNulPatches();

  if (pglite) await pglite.close().catch(() => {});
  // Awaits the build primed at module scope by mockDbConnection(); starts it
  // here if this caller never mocked the connection.
  migratedSnapshot ??= await primeMigratedSnapshot();
  pglite = new PGlite({ loadDataDir: migratedSnapshot, extensions: EXTENSIONS });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  return { pglite, db };
}

export function getTestDb() {
  if (!db) throw new Error("Test DB not initialized — call setupTestDb() first");
  return db;
}

export function getTestPglite() {
  return pglite;
}

export async function closeTestDb() {
  if (pglite) await pglite.close().catch(() => {});
}

// Must be called at module level BEFORE importing any modules that use db/connection
export function mockDbConnection() {
  // This call is the suite DECLARING it needs the test DB, and it happens at
  // module scope — so start the one-time migration now rather than letting the
  // first hook trigger and pay for it. See `primeMigratedSnapshot`. The stored
  // promise keeps its rejection for setupTestDb() to surface; this detached
  // handler only stops an early failure from being an unhandled rejection.
  primeMigratedSnapshot().catch(() => undefined);
  mock.module("../../db/connection", () => ({
    getDb: () => {
      if (!db) throw new Error("Test DB not initialized — call setupTestDb() first");
      return db;
    },
    getPglite: () => pglite,
    getDbPath: () => ":memory:",
    initDb: async () => {},
    closeDb: async () => {},
    // Route rawQuery to the test PGlite with real bind params. Without this,
    // the REAL rawQuery runs against the mocked getDb() and takes the
    // external-Postgres branch (`$client.unsafe`), which drizzle-pglite
    // doesn't expose.
    rawQuery: async (sql: string, params: (string | null)[] = []) => {
      if (!pglite) throw new Error("Test DB not initialized — call setupTestDb() first");
      return pglite.query(sql, params);
    },
  }));
}

// Restore pristine globalThis.fetch and globalThis.WebSocket (guards against test
// files that replace them at module level and fail to clean up).
export function restoreFetch() {
  globalThis.fetch = _pristineFetch;
  globalThis.WebSocket = _pristineWebSocket;
}

// Re-establish real settings implementation backed by the test DB.
// Call at module level alongside mockDbConnection() to override any leaked
// settings mock from a previous test file (Bun mock.module leaks across files).
export function mockRealSettings() {
  mock.module("../../db/queries/settings", () => {
    const { eq, sql } = require("drizzle-orm");
    const { settings: tbl } = require("../../db/schema");
    return {
      async getAllSettings() {
        const rows = await db.select().from(tbl);
        return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
      },
      async getSetting(key: string) {
        const rows = await db.select().from(tbl).where(eq(tbl.key, key));
        return rows[0]?.value;
      },
      async upsertSetting(key: string, value: unknown) {
        // Mirror the REAL upsertSetting's explicit jsonb encoding (see
        // src/db/queries/settings.ts — the ::text hop defeats the Bun.sql
        // driver's double-encode) so suites that leak this mock across
        // files observe identical semantics, null included.
        const encoded = sql`${JSON.stringify(value) ?? "null"}::text::jsonb`;
        const rows = await db.select().from(tbl).where(eq(tbl.key, key));
        if (rows[0]) {
          await db
            .update(tbl)
            .set({ value: encoded, updatedAt: new Date() })
            .where(eq(tbl.key, key));
        } else {
          await db.insert(tbl).values({ key, value: encoded, updatedAt: new Date() });
        }
      },
      async deleteSetting(key: string) {
        const rows = await db.select().from(tbl).where(eq(tbl.key, key));
        if (!rows[0]) return false;
        await db.delete(tbl).where(eq(tbl.key, key));
        return true;
      },
      async isListingInstalled() {
        return false;
      },
    };
  });
}
