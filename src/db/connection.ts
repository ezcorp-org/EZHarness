import * as schema from "./schema";
import { migrate } from "./migrate";
import { mkdirSync, renameSync, existsSync, cpSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger";
import { setReadiness } from "../readiness";
import {
  snapshotPreBoot,
  latestPreBootSnapshot,
  readMarker,
  writeMarker,
  clearMarker,
  writeRecoveryMarker,
  clearRecoveryMarker,
} from "./backup";
const log = logger.child("db");

const DEFAULT_DB_DIR = `${process.env.HOME}/ez-corp/.data`;
const DB_PATH = process.env.EZCORP_DB_PATH ?? `${DEFAULT_DB_DIR}/ez-corp-db`;
const IS_MEMORY = DB_PATH === ":memory:";
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Drizzle adapter handle. Either a `PgliteDatabase` or a `BunSQLDatabase` at
 * runtime — the two drivers report incompatible HKT result types for
 * `execute()`, so merging them into a common type rejects the concrete
 * subclass assignment. We intentionally hold the type as broadly-typed `any`
 * here; callers consume it through typed helpers (`getDb()`) whose drizzle
 * DSL methods return concrete types via the drizzle schema.
 */
// biome rule `suspicious/noExplicitAny` is off repo-wide; `any` kept by design
// per the comment above, not an oversight.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Database = any;

let _db: Database = null;
let _pglite: import("@electric-sql/pglite").PGlite | null = null;
let _initPromise: Promise<void> | null = null;

async function initPglite(): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  // pg_trgm MUST register at construction. Late `CREATE EXTENSION pg_trgm`
  // SQL succeeds against a stub but `SELECT similarity(...)` fails with
  // "function does not exist." The contrib module loads the C functions
  // alongside the vector extension; the SQL `CREATE EXTENSION` step in
  // migrate.ts then registers the catalog entry. UX-02 (Phase 57-04).
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { drizzle } = await import("drizzle-orm/pglite");

  if (!IS_MEMORY) mkdirSync(DB_PATH, { recursive: true });
  // PGlite uses the URI-style `memory://` scheme for in-memory mode;
  // passing the SQLite-style `:memory:` literal creates a directory of
  // that exact name on disk and uses it as the data dir. Test sentinels
  // still use `:memory:` (IS_MEMORY boolean detects intent), but the
  // value handed to PGlite must be the URI form.
  const dbArg = IS_MEMORY ? "memory://" : DB_PATH;

  const openPglite = async (path: string) => {
    const pg = new PGlite(path, { extensions: { vector, pg_trgm } });
    await pg.waitReady;
    return pg;
  };

  // Circuit breaker: if migrate() failed on the prior boot of THIS exact
  // image, don't re-run migrate. The DB dir is the restored snapshot, so
  // pre-failure features still work. /api/ready reports 503 so orchestrators
  // know the container is in a bad state, and the UI can display recovery
  // instructions. Disabled when running outside a built image (no SHA).
  const imageSha = process.env.EZCORP_IMAGE_SHA;
  if (!IS_MEMORY && imageSha) {
    const marker = readMarker();
    if (marker && marker.imageSha === imageSha) {
      log.error("Migration failed on previous boot — skipping migrate (circuit breaker)", {
        imageSha,
        markerTs: marker.ts,
      });
      _pglite = await openPglite(dbArg);
      _db = drizzle(_pglite, { schema });
      setReadiness({
        state: "degraded",
        reason: "migration-blocked",
        detail: {
          message: "Previous migration failed for this image; boot continued without running migrate().",
          imageSha: marker.imageSha,
          error: marker.error,
          markerTs: marker.ts,
          recovery: [
            "Roll back to a working image tag, or",
            "Fix the failing migration and rebuild the image, then remove /app/data/.migration-failed",
          ],
        },
      });
      return;
    }
  }

  // Snapshot before open+migrate so we have a rollback target. Always-on:
  // the DB is small, `cpSync` is cheap, and rotation (3) bounds disk use.
  if (!IS_MEMORY) snapshotPreBoot();

  // Pre-flight: clear stale lock files left by an unclean shutdown.
  // PGlite is single-process — the only writer is the previous instance
  // of THIS container, which is dead by the time initDb() runs. A
  // `postmaster.pid`/`postmaster.opts` left behind from a SIGKILL
  // (e.g. `docker compose up -d --force-recreate` killing the old
  // container before pglite.close() flushed) causes openPglite to abort
  // with a WASM-level "Aborted()" — which the old catch branch below
  // misinterpreted as data corruption and renamed the dir aside,
  // destroying user data on every recreate. Removing the stale locks
  // here fixes the false positive without weakening the corrupted-data
  // fallback for genuinely unreadable directories. See
  // `tasks/incident-2026-05-10-stale-pid.md` for the full timeline.
  if (!IS_MEMORY && existsSync(DB_PATH)) {
    for (const lockfile of ["postmaster.pid", "postmaster.opts"]) {
      const path = join(DB_PATH, lockfile);
      if (existsSync(path)) {
        try {
          unlinkSync(path);
          log.info("Removed stale PGlite lock file", { path });
        } catch (rmErr) {
          log.warn("Failed to remove stale PGlite lock file", {
            path,
            error: String(rmErr),
          });
        }
      }
    }
  }

  try {
    _pglite = await openPglite(dbArg);
  } catch (e) {
    if (IS_MEMORY || !existsSync(DB_PATH)) throw e;

    // Two production incidents on 2026-05-10 lost user data because the
    // old catch branch interpreted ANY openPglite() failure as corruption
    // and renamed the data dir aside (`${DB_PATH}.corrupted.${Date.now()}`).
    // The stale-`postmaster.pid` pre-flight in this same function (above)
    // removed the most common false positive, but partial WAL writes,
    // transient FS issues, kernel page-cache pressure, or a future PGlite
    // regression could still throw — and "destroy the data" is the wrong
    // default for any of those.
    //
    // New default: fail loud. Write a recovery-needed marker so operators
    // see the state via /api/ready, log the error with recovery hints, and
    // re-throw so initDb() propagates and the boot path stays unhealthy.
    // Docker's restart loop + the healthcheck failing surfaces the issue
    // without us touching the data.
    //
    // Legacy opt-in: EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1 (or "true")
    // restores the rename-and-restart-fresh path for fresh installs / CI /
    // self-hosters who explicitly want auto-recovery.
    const autoDestroyFlag = process.env.EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE;
    const autoDestroy = autoDestroyFlag === "1" || autoDestroyFlag === "true";

    if (autoDestroy) {
      const backup = `${DB_PATH}.corrupted.${Date.now()}`;
      log.error("PGlite failed to open — EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1; backing up data and starting fresh", { backup });
      renameSync(DB_PATH, backup);
      mkdirSync(DB_PATH, { recursive: true });
      _pglite = await openPglite(dbArg);
    } else {
      const imageSha = process.env.EZCORP_IMAGE_SHA ?? "dev";
      const errorStr = (e instanceof Error ? (e.stack ?? e.message) : String(e)).slice(0, 2000);
      const recovery = [
        `Inspect snapshots under ${join(DB_PATH, "..", "backups")} (pre-boot-* and ezcorp-db-*) for a clean copy.`,
        `Stop the container, replace ${DB_PATH} with a snapshot, then restart.`,
        `See docs/production-guide.md "Recovering from data-recovery-needed state" for the full recipe.`,
        `Only set EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1 if you understand the data loss tradeoff.`,
      ];
      try {
        writeRecoveryMarker({
          ts: new Date().toISOString(),
          imageSha,
          error: errorStr,
          dbPath: DB_PATH,
        });
      } catch (markerErr) {
        // Marker write is best-effort — if the volume is read-only we still
        // want the error/log/readiness to surface.
        log.warn("Could not write recovery-needed marker", { error: String(markerErr) });
      }
      log.error(
        "PGlite failed to open — data preserved (auto-destroy disabled)",
        { error: errorStr, dbPath: DB_PATH, recovery },
      );
      setReadiness({
        state: "degraded",
        reason: "data-recovery-needed",
        detail: {
          message: "PGlite open() failed and auto-destroy is disabled. Data dir left intact; operator intervention required.",
          imageSha,
          dbPath: DB_PATH,
          error: errorStr.slice(0, 500),
          recovery,
        },
      });
      throw e;
    }
  }

  _db = drizzle(_pglite, { schema });
  // Successful open: clear any stale recovery-needed marker from a prior
  // failed boot. Mirrors clearMarker() for the migration-failed circuit
  // breaker further down.
  clearRecoveryMarker();
  log.info("Database mode: embedded PGlite", { path: DB_PATH });

  try {
    await migrate(_db);
  } catch (err) {
    log.error("Migration failed — rolling back to pre-boot snapshot", { error: String(err) });
    await rollbackMigration(err);
    // Unreachable: rollbackMigration calls process.exit(1).
    throw err;
  }

  clearMarker();
  setReadiness({ state: "ready" });
}

/**
 * Close PGlite, rename the failed DB dir aside, restore from the latest
 * pre-boot snapshot, write a circuit-breaker marker, and exit(1) so Docker
 * restarts us. On the next boot, the circuit breaker skips migrate().
 *
 * `renameSync`-then-`cpSync` (not rmSync-then-cp) is deliberate: rename is
 * atomic on a single FS, so a SIGKILL between the two leaves `.failed.<ts>`
 * intact for forensics instead of an empty DB dir.
 */
async function rollbackMigration(err: unknown): Promise<never> {
  try {
    if (_pglite) await _pglite.close();
  } catch (closeErr) {
    log.warn("PGlite close during rollback failed", { error: String(closeErr) });
  }
  _pglite = null;
  _db = null;
  // Clear the cached init promise so a caller that catches the rollback
  // error (e.g. a test with EZCORP_NO_EXIT=1) can re-call initDb() and
  // have the circuit breaker run fresh on the next boot attempt.
  _initPromise = null;

  const snapshot = latestPreBootSnapshot();
  if (snapshot && existsSync(DB_PATH)) {
    const failedPath = `${DB_PATH}.failed.${Date.now()}`;
    try {
      renameSync(DB_PATH, failedPath);
      cpSync(snapshot, DB_PATH, { recursive: true });
      log.info("Restored pre-boot snapshot", { snapshot, failedPath });
    } catch (restoreErr) {
      log.error("Rollback failed — data dir may be inconsistent", {
        error: String(restoreErr),
        failedPath,
      });
    }
  } else if (!snapshot) {
    log.error("No pre-boot snapshot available — cannot roll back");
  }

  const imageSha = process.env.EZCORP_IMAGE_SHA;
  if (imageSha) {
    writeMarker({
      imageSha,
      error: String(err).slice(0, 2000),
      ts: new Date().toISOString(),
    });
  }

  setReadiness({
    state: "degraded",
    reason: "migration-failed",
    detail: { error: String(err).slice(0, 500) },
  });

  // In test environments, process.exit short-circuits suites. Callers in
  // production rely on Docker's restart policy.
  if (process.env.NODE_ENV === "test" || process.env.EZCORP_NO_EXIT === "1") {
    throw err;
  }
  process.exit(1);
}

// Exported for tests
export const __test = {
  rollbackMigration,
  /**
   * Directly override module DB state so rawQuery's two code paths (PGlite
   * bind-params vs Bun.sql `$client.unsafe` bind-params) are unit-testable
   * without booting initDb()'s full PGlite/Postgres init sequence.
   */
  setState(db: Database, pglite: import("@electric-sql/pglite").PGlite | null): void {
    _db = db;
    _pglite = pglite;
  },
};

async function initPostgres(): Promise<void> {
  const { drizzle } = await import("drizzle-orm/bun-sql");
  const { sql } = await import("drizzle-orm");

  // Drizzle's default jsonb/json `mapToDriverValue = JSON.stringify` double-encodes
  // under Bun.sql: drizzle stringifies the object → Bun.sql sees a JS string and
  // binds it as a text value, which Postgres then stores as a jsonb STRING scalar
  // ({"x":1} becomes "{\"x\":1}"). That breaks every `col->>'key'` access and
  // produces the empty Token Usage chart. Bun.sql serializes JS objects to jsonb
  // correctly on its own, so we swap drizzle's mapper for identity and let the
  // driver handle it. This only matters under bun-sql; PGlite is unaffected.
  const [{ PgJsonb }, { PgJson }] = await Promise.all([
    import("drizzle-orm/pg-core/columns/jsonb"),
    import("drizzle-orm/pg-core/columns/json"),
  ]);
  const identity = (value: unknown) => value;
  // `any` cast is deliberate: monkey-patching drizzle's private
  // `mapToDriverValue` on the column-type prototype; there's no public type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (PgJsonb.prototype as any).mapToDriverValue = identity;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (PgJson.prototype as any).mapToDriverValue = identity;

  // Pool size for the Bun.sql client. Bun's default is 10, which is too small
  // for endpoints that fan out several queries per request: the admin
  // analytics route issued ~11 concurrent queries via Promise.all and could
  // deadlock the whole shared pool at just two concurrent requests (every
  // route shares this client). That fan-out is now serialised at the call
  // site, but a modestly larger pool gives realistic dashboard bursts
  // headroom without relying on a single endpoint's internals. Overridable
  // via DB_POOL_MAX; clamped to a sane [1, 100] range.
  const poolMax = (() => {
    const raw = Number(process.env.DB_POOL_MAX);
    if (!Number.isFinite(raw)) return 20;
    return Math.max(1, Math.min(100, Math.floor(raw)));
  })();
  const db = drizzle({ connection: { url: DATABASE_URL!, max: poolMax }, schema });
  _pglite = null;

  // Wrap execute() so raw SQL results always return { rows: [...] }
  // bun-sql returns arrays directly, but PGlite returns { rows: [...] }.
  // All query code expects the { rows } shape.
  const origExecute = db.execute.bind(db) as (...a: unknown[]) => Promise<unknown>;
  // `any` cast is deliberate: we replace `execute` in-place on the drizzle
  // instance, and its overloaded signature can't be expressed here without
  // rebuilding the full generic surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).execute = async (...args: unknown[]) => {
    const result = await origExecute(...args);
    if (Array.isArray(result)) return { rows: result };
    return result;
  };
  _db = db;

  // Ensure pgvector extension is available
  await _db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

  log.info("Database mode: external Postgres");
  try {
    await migrate(_db);
  } catch (err) {
    log.error("Migration failed on external Postgres — manual intervention required", { error: String(err) });
    setReadiness({
      state: "degraded",
      reason: "migration-failed",
      detail: { error: String(err).slice(0, 500) },
    });
    throw err;
  }
  await repairDoubleEncodedJsonb(sql);
  setReadiness({ state: "ready" });
}

// Historical rows written before the jsonb-double-encoding fix are stored as
// JSON string scalars ({"x":1} → "{\"x\":1}"). Converting `jsonb::text::jsonb`
// unwraps the string back into its original object form. Idempotent — once
// every row is an object/array, subsequent runs are a no-op.
async function repairDoubleEncodedJsonb(sqlTag: typeof import("drizzle-orm")["sql"]): Promise<void> {
  if (!_db) throw new Error("Database not initialized");
  const cols = await _db.execute(sqlTag`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'jsonb'
  `);
  // bun-sql returns arrays, PGlite returns { rows }; normalize both shapes.
  const rawRows = (cols as { rows?: unknown }).rows ?? cols;
  const rows = rawRows as Array<{ table_name: string; column_name: string }>;
  for (const row of rows) {
    const table = row.table_name;
    const column = row.column_name;
    if (!/^[a-z_][a-z0-9_]*$/i.test(table) || !/^[a-z_][a-z0-9_]*$/i.test(column)) continue;
    const qTable = `"${table}"`;
    const qColumn = `"${column}"`;
    try {
      // Only unwrap rows whose inner text is a JSON object or array — scalar
      // JSON strings ("yolo", ISO timestamps, encrypted blobs stored in
      // settings.value) are legitimate and must not be touched.
      const result = await _db.execute(sqlTag.raw(
        `UPDATE ${qTable} SET ${qColumn} = (${qColumn} #>> '{}')::jsonb
         WHERE ${qColumn} IS NOT NULL
           AND jsonb_typeof(${qColumn}) = 'string'
           AND LEFT(LTRIM(${qColumn} #>> '{}'), 1) IN ('{', '[')`,
      )) as { count?: number; rowCount?: number } | undefined;
      const affected = result?.count ?? result?.rowCount ?? 0;
      if (affected > 0) log.info("Repaired double-encoded jsonb", { table, column, rows: affected });
    } catch (err) {
      log.warn("jsonb repair skipped", { table, column, error: String(err).slice(0, 200) });
    }
  }
}

async function init(): Promise<void> {
  if (DATABASE_URL) {
    await initPostgres();
  } else {
    await initPglite();
  }
}

export async function initDb(): Promise<void> {
  if (!_initPromise) {
    // Reset the promise on failure so callers can retry. Without this, a
    // transient init error (e.g. migrate throws, is rolled back) would leave
    // a cached rejected promise and every subsequent initDb() would re-throw
    // the same error instead of re-running the boot sequence.
    _initPromise = init().catch((err) => {
      _initPromise = null;
      throw err;
    });
  }
  await _initPromise;
}

export function getDb(): Database {
  if (!_db) throw new Error("Database not initialized — call initDb() first");
  return _db;
}

export function getPglite(): import("@electric-sql/pglite").PGlite | null {
  return _pglite;
}

/** Execute a raw SQL string with positional $1/$2 params. Works with both PGlite and external Postgres. */
export async function rawQuery(sql: string, params: (string | null)[] = []): Promise<{ rows: unknown[] }> {
  if (_pglite) return _pglite.query(sql, params);
  // External Postgres via Bun.sql — `sql.unsafe(query, params)` sends the
  // query text and values separately ($1-style server-side parameter
  // binding), exactly like the PGlite path above. Never string-inline the
  // values here: the old quote-doubling rewrite was injectable (backslash /
  // E'…'-style payloads survive `'' `-escaping) and corrupted non-string
  // values. drizzle's bun-sql driver exposes the underlying Bun SQL client
  // as `$client`.
  const rows = (await getDb().$client.unsafe(sql, params)) as unknown[];
  return { rows };
}

export function getDbPath(): string {
  if (DATABASE_URL) return "external";
  return DB_PATH;
}

export async function closeDb(): Promise<void> {
  if (_pglite) {
    await _pglite.close();
  }
  _pglite = null;
  _db = null;
  _initPromise = null;
}
