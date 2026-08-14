import * as schema from "./schema";
import { migrate } from "./migrate";
import { mkdirSync, renameSync, existsSync, cpSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
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
import {
  assertNoLiveHolder,
  claimHolder,
  releaseHolder,
  closeStaleProcessHolder,
  recordProcessHolder,
  clearProcessHolder,
} from "./live-holder-guard";
import { applyPgliteNulPatches, patchJsonColumns, patchTextColumns } from "./nul-column-patch";
import { APP_DATABASE, CURRENT_PG_MAJOR, assertDatadirCompatible, clearStaleLockFiles } from "./datadir-upgrade";
const log = logger.child("db");

const DEFAULT_DB_DIR = `${process.env.HOME}/ez-corp/.data`;
const DB_PATH = process.env.EZCORP_DB_PATH ?? `${DEFAULT_DB_DIR}/ez-corp-db`;
const IS_MEMORY = DB_PATH === ":memory:";
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Absolute paths the MCP sandbox must mask (private tmpfs) so untrusted
 * MCP processes can't read the platform's own database — and thus the
 * JWT secret stored in the `settings` table + DB snapshots — off disk.
 * Empty when there is no on-disk DB to protect (external Postgres or
 * in-memory).
 *
 * We mask the SPECIFIC sensitive dirs, NOT `dirname(DB_PATH)`: in
 * production `EZCORP_DB_PATH=/app/data/ezcorp`, so the parent `/app/data`
 * also contains `/app/data/extensions` (the MCP install base) — masking
 * the parent would hide every MCP's own code. `PGlite(DB_PATH)` uses
 * `DB_PATH` as the data dir itself, so masking `DB_PATH` covers the DB;
 * the backups dir (resolved like `src/db/backup.ts`) covers snapshots.
 * Both are siblings of `extensions/`, so masking them is safe.
 *
 * Residual (default posture only): encryption key files
 * (`.pi-secret`/`.pi-salt`) under the parent stay visible, but they're
 * low-value without the now-masked DB ciphertext. The strict
 * minimal-bind jail (`EZCORP_MCP_REQUIRE_SANDBOX=1`) binds nothing here.
 */
export function getDbMaskDirs(): string[] {
  if (DATABASE_URL) return [];
  if (IS_MEMORY) return [];
  const backups = process.env.EZCORP_BACKUP_DIR ?? join(dirname(DB_PATH), "backups");
  return [DB_PATH, backups];
}

/**
 * Drizzle adapter handle. Either a `PgliteDatabase` or a `BunSQLDatabase` at
 * runtime — the two drivers report incompatible HKT result types for
 * `execute()`, so merging them into a common type rejects the concrete
 * subclass assignment. We intentionally hold the type as broadly-typed `any`
 * here; callers consume it through typed helpers (`getDb()`) whose drizzle
 * DSL methods return concrete types via the drizzle schema.
 */
// biome-ignore lint/suspicious/noExplicitAny: the handle is a PgliteDatabase OR a BunSQLDatabase and the two report incompatible HKT result types for execute(), so any common supertype rejects the concrete subclass assignment — see the doc comment above. Callers get real types back from the drizzle DSL.
export type Database = any;

/**
 * What drizzle hands the callback of `db.transaction(...)`.
 *
 * Same story as `Database`, one level down: the transaction handle's type is
 * the active driver's, and the two drivers disagree. Because `Database` is
 * `any`, `db.transaction(async (tx) => …)` infers `tx` as an IMPLICIT any,
 * which `noImplicitAny` rejects — so all 11 call sites had to write `tx: any`
 * by hand. Naming it here means the concession is declared once, next to the
 * reason, instead of re-spelled per call site.
 */
export type DbTransaction = Database;

let _db: Database = null;
let _pglite: import("@electric-sql/pglite").PGlite | null = null;
let _initPromise: Promise<void> | null = null;

/** Register the just-opened PGlite instance in the process-local holder
 *  registry (globalThis-anchored) so a re-instantiated module — the vite
 *  dev-server force-reload case — closes this instance instead of opening a
 *  second WASM Postgres over the same live datadir. No-op for in-memory. */
function registerProcessHolder(): void {
  if (IS_MEMORY) return;
  const instance = _pglite;
  recordProcessHolder(DB_PATH, async () => {
    try {
      await instance?.close();
    } catch {
      /* already closing / half-torn-down */
    }
  });
}

// ── Interrupted-rollback marker ────────────────────────────────────────────
const ROLLBACK_MARKER_FILENAME = ".ezcorp-rollback-in-progress.json";

interface RollbackMarker {
  ts: string;
  snapshot?: string;
  failedPath?: string;
}

function rollbackMarkerPath(dbPath: string): string {
  return join(dirname(dbPath), ROLLBACK_MARKER_FILENAME);
}

function writeRollbackMarker(dbPath: string, info: RollbackMarker): void {
  try {
    writeFileSync(rollbackMarkerPath(dbPath), JSON.stringify(info));
  } catch (err) {
    log.warn("Could not write rollback-in-progress marker", { error: String(err) });
  }
}

function readRollbackMarker(dbPath: string): RollbackMarker | null {
  try {
    return JSON.parse(readFileSync(rollbackMarkerPath(dbPath), "utf8")) as RollbackMarker;
  } catch {
    return null;
  }
}

function clearRollbackMarker(dbPath: string): void {
  try {
    if (existsSync(rollbackMarkerPath(dbPath))) unlinkSync(rollbackMarkerPath(dbPath));
  } catch {
    /* nothing to clear / unwritable parent */
  }
}

/**
 * Detect and resolve a migration rollback that a prior boot began but did not
 * finish. `rollbackMigration()` renames the failed datadir aside then copies
 * the pre-boot snapshot back; a SIGKILL (docker stop timeout) or a `cpSync`
 * failure between those two steps leaves DB_PATH missing/empty. Booting then
 * would `mkdir` a fresh empty dir and — if no circuit-breaker marker matched —
 * run `migrate()` and come up READY looking completely wiped.
 *
 * We finish the restore from the snapshot the marker recorded (moving any
 * partial DB_PATH aside first), or — when no snapshot is available — refuse to
 * boot loudly instead of starting an empty cluster. `dbPath` is injectable for
 * tests; production always uses the module `DB_PATH`.
 */
function recoverInterruptedRollback(dbPath: string = DB_PATH): void {
  if (dbPath === ":memory:") return;
  const marker = readRollbackMarker(dbPath);
  if (!marker) return;

  if (marker.snapshot && existsSync(marker.snapshot)) {
    log.error("Completing interrupted migration rollback from a prior boot", { marker });
    if (existsSync(dbPath)) {
      renameSync(dbPath, `${dbPath}.rollback-partial.${Date.now()}`);
    }
    cpSync(marker.snapshot, dbPath, { recursive: true });
    clearRollbackMarker(dbPath);
    log.info("Interrupted rollback completed — snapshot restored", { snapshot: marker.snapshot });
    return;
  }

  const detail = {
    message:
      "A migration rollback was interrupted on a prior boot and no snapshot is available to complete it. Refusing to boot to avoid starting a fresh empty database over the half-finished rollback.",
    marker,
    dbPath,
  };
  log.error("Interrupted rollback with no snapshot — refusing to boot", detail);
  setReadiness({ state: "degraded", reason: "rollback-interrupted", detail });
  throw new Error("Interrupted migration rollback: snapshot unavailable, refusing to boot");
}

/**
 * Refuse to boot on a data directory written by a different PostgreSQL major,
 * and say so on `/api/ready` instead of crash-looping mute.
 *
 * The readiness call is the whole reason this is a function: the refusal is the
 * common path for an install stranded on an old datadir, and the sibling
 * failure paths (`rollback-interrupted`, `data-recovery-needed`) both report
 * themselves while this one used to propagate silently.
 *
 * `dbPath` is a parameter because the module-level `DB_PATH` is frozen from the
 * environment at import, so passing one in is the only way a test can exercise
 * this against a datadir of a chosen major.
 */
export async function guardDatadirMajor(dbPath: string): Promise<void> {
  try {
    await assertDatadirCompatible(dbPath);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const detail = { message, dbPath, expectedPgMajor: CURRENT_PG_MAJOR };
    log.error("Data directory is incompatible with this build — refusing to boot", detail);
    setReadiness({ state: "degraded", reason: "datadir-incompatible", detail });
    throw e;
  }
}

async function initPglite(): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  // pg_trgm MUST register at construction. Late `CREATE EXTENSION pg_trgm`
  // SQL succeeds against a stub but `SELECT similarity(...)` fails with
  // "function does not exist." The contrib module loads the C functions
  // alongside the vector extension; the SQL `CREATE EXTENSION` step in
  // migrate.ts then registers the catalog entry. UX-02 (Phase 57-04).
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { drizzle } = await import("drizzle-orm/pglite");

  // Postgres rejects U+0000 in text AND jsonb on BOTH drivers, so both driver
  // paths install the scrubbers before any write can happen.
  await applyPgliteNulPatches();

  if (!IS_MEMORY) {
    // Complete (or refuse) a rollback that a prior boot began but did not
    // finish — otherwise the crash window between renameSync and cpSync in
    // rollbackMigration() can leave DB_PATH empty and we would silently boot a
    // fresh, wiped-looking cluster over a half-finished restore.
    recoverInterruptedRollback();
    // Close a stale same-process PGlite handle first (vite dev-server restart
    // re-instantiates this module while the previous instance stays open). The
    // sidecar guard can't catch this — the recorded pid is our own — so doing
    // it here prevents the stale-lock sweep below from yanking postmaster.pid
    // out from under a still-live instance.
    await closeStaleProcessHolder(DB_PATH);
    mkdirSync(DB_PATH, { recursive: true });
    // Refuse to open a datadir another LIVE EZCorp process holds (e.g.
    // `ezcorp key mint` against a running server): PGlite is single-writer,
    // and the stale-lock cleanup below would otherwise steal the live
    // server's datadir. Dead-pid claims (SIGKILL) pass through as stale.
    assertNoLiveHolder(DB_PATH);
    claimHolder(DB_PATH);
    // Postgres MAJOR guard: prove the datadir was written by the engine this
    // build ships, and finish or unwind an interrupted upgrade an OLDER build
    // left mid-swap. No-op on a fresh install and on an already-current
    // datadir. Runs AFTER claimHolder so no other live EZCorp process can be
    // renaming underneath it — the holder pidfile is a SIBLING of DB_PATH
    // (`live-holder-guard.holderPidPath`), so it survives a datadir swap.
    //
    // STRICTLY BEFORE openPglite, and that ordering is the whole point. PGlite
    // 0.5.4 opening e.g. a PG 17 datadir throws a bare "PGlite failed to
    // initialize properly" that never names a version; that lands in the catch
    // further down, and with EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1 it would
    // rename the operator's database aside and boot EMPTY. Checked here it is a
    // refusal that says which major wrote the directory and touches nothing.
    await guardDatadirMajor(DB_PATH);
  }
  // PGlite uses the URI-style `memory://` scheme for in-memory mode;
  // passing the SQLite-style `:memory:` literal creates a directory of
  // that exact name on disk and uses it as the data dir. Test sentinels
  // still use `:memory:` (IS_MEMORY boolean detects intent), but the
  // value handed to PGlite must be the URI form.
  const dbArg = IS_MEMORY ? "memory://" : DB_PATH;

  const openPglite = async (path: string) => {
    // `database` is passed EXPLICITLY rather than left to the driver default.
    // PGlite moved that default (`template1` -> `postgres`) in 0.4.x, and the
    // datadir upgrade restores into APP_DATABASE — so the database the restore
    // WRITES and the one the app READS come from the same constant instead of
    // two independent defaults that happen to agree. See datadir-upgrade.ts.
    const pg = new PGlite({ dataDir: path, database: APP_DATABASE, extensions: { vector, pg_trgm } });
    await pg.waitReady;
    return pg;
  };

  // Circuit breaker: if migrate() failed on the prior boot of THIS exact
  // image, don't re-run migrate. The DB dir is the restored snapshot, so MOST
  // pre-failure features still work. /api/ready reports 503 so orchestrators
  // know the container is in a bad state, and the UI can display recovery
  // instructions. Disabled when running outside a built image (no SHA).
  //
  // NOT a clean degrade for everything, and the exception is worth knowing:
  // migrate() also carries the one-shot data backfills, so a feature whose
  // enforcement reads state a backfill was supposed to write behaves as if
  // that state is absent. Concretely, `kind:"mcp"` extensions installed
  // before the capability backfill NEED a grant this boot never issues, so
  // their tool calls deny until the migration is repaired.
  // `ExtensionRegistry.loadFromDb` logs one actionable error per such row
  // (see `reportUnhealedMcpRow`) rather than failing open.
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
      // (Circuit-breaker path is a degraded terminal boot; the normal path
      // below registers the process holder for the same-process guard.)
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
  // Shared with the datadir upgrade, which opens DB_PATH for the same reason
  // and needs the identical pre-flight (`datadir-upgrade.clearStaleLockFiles`).
  if (!IS_MEMORY) clearStaleLockFiles(DB_PATH);

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
  registerProcessHolder();
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
      // Mark the rollback in progress BEFORE the non-atomic rename→copy pair so
      // that if we crash between them, the next boot's recoverInterruptedRollback()
      // completes the restore instead of silently booting an empty DB. Cleared
      // only after cpSync succeeds.
      writeRollbackMarker(DB_PATH, { ts: new Date().toISOString(), snapshot, failedPath });
      renameSync(DB_PATH, failedPath);
      cpSync(snapshot, DB_PATH, { recursive: true });
      clearRollbackMarker(DB_PATH);
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

/**
 * Swap drizzle default jsonb/json `mapToDriverValue = JSON.stringify` for
 * identity on the PgJsonb/PgJson column prototypes, and scrub NULs (U+0000) on
 * the way through.
 *
 * Under Bun.sql, drizzle stringify double-encodes: drizzle stringifies the
 * object -> Bun.sql sees a JS string and binds it as a TEXT value, which
 * Postgres stores as a jsonb STRING scalar ({"x":1} becomes "{\\"x\\":1}"). That
 * breaks every `col->>key` access and produces the empty Token Usage chart.
 * Bun.sql serializes JS objects to jsonb correctly on its own, so identity is
 * the fix. This only matters under bun-sql; PGlite is unaffected.
 *
 * The NUL scrub composes in FRONT of that identity: Bun.sql own serializer
 * emits the same escape Postgres refuses, so the value must already be clean
 * when it reaches the driver.
 *
 * Exported via `__test` so the regression guard exercises THIS override, not a
 * re-declared local identity function that would stay green even if this were
 * deleted during a drizzle upgrade.
 */
async function applyBunSqlJsonbFix(): Promise<void> {
  await patchJsonColumns(true);
}

/** Advisory-lock key for serializing migrate() across instances on external
 *  Postgres. Arbitrary constant, unique to EZCorp's boot migrate. */
const MIGRATE_ADVISORY_LOCK_KEY = 40_172_026;

/**
 * Run `fn` (the migrate) while holding a cluster-wide advisory lock so two app
 * instances booting concurrently (rolling deploy / scaled replicas) can't
 * interleave migrate()'s non-idempotent statement pairs (DROP/CREATE TRIGGER,
 * DROP/ADD CONSTRAINT, racy CREATE TABLE) and fail one spuriously. A
 * session-level `pg_advisory_lock` must be acquired AND released on the SAME
 * connection, so we reserve a dedicated connection from the Bun.sql pool for
 * the lock's lifetime. PGlite is single-writer (live-holder guard) and needs no
 * equivalent, so this only runs on the external-Postgres path. Exposed via
 * `__test` for the ordering regression test.
 */
async function withPostgresMigrateLock<T>(fn: () => Promise<T>): Promise<T> {
  // `Database` is `any`, so `$client` — the Bun.sql instance, a callable
  // tagged template that also exposes reserve() — arrives untyped already and
  // the cast that used to be here was a no-op.
  const client = getDb().$client;
  const reserved = typeof client?.reserve === "function" ? await client.reserve() : null;
  const conn = reserved ?? client;
  await conn`SELECT pg_advisory_lock(${MIGRATE_ADVISORY_LOCK_KEY})`;
  try {
    return await fn();
  } finally {
    try {
      await conn`SELECT pg_advisory_unlock(${MIGRATE_ADVISORY_LOCK_KEY})`;
    } catch (err) {
      log.warn("advisory unlock failed", { error: String(err) });
    }
    if (reserved && typeof reserved.release === "function") {
      try {
        reserved.release();
      } catch {
        /* pool already closing */
      }
    }
  }
}

/** drizzle's bun-sql driver exposes the Bun.SQL client as `$client`; it closes
 *  via `.close()` (alias `.end()`). Hoisted to a module-level type so the casts
 *  below stay single executable lines (no multi-line type-annotation
 *  continuation that coverage tooling attributes a spurious uncovered record). */
type BunSqlPoolClient = { close?: () => Promise<void>; end?: () => Promise<void> };

/**
 * Drain a Bun.sql connection pool, tolerating a driver that exposes only one of
 * the two close aliases. Best-effort by design: a close failure must never
 * block a boot (stale-pool reclaim) or a shutdown (`closeDb`) — the worst case
 * is the sockets die with the process, which is where we started.
 *
 * Shared by `closeDb()` and the stale-pool reclaim in `initPostgres()` so the
 * two paths can never drift on which alias they try.
 */
async function closeBunSqlPool(client: BunSqlPoolClient | undefined): Promise<void> {
  try {
    if (typeof client?.close === "function") await client.close();
    else if (typeof client?.end === "function") await client.end();
  } catch (err) {
    log.warn("Bun.sql pool close failed", { error: String(err) });
  }
}

/**
 * bun-sql's `execute()` resolves to whatever `client.unsafe(...)` returns — a
 * raw array — while PGlite's resolves to `{ rows: [...] }` natively (PGlite's
 * own `.query()` already returns that shape; see `applyExecuteNormalization`
 * for why only the bun-sql path needs this). Query code uniformly expects
 * `{rows}`, so this is the one place that gap gets closed.
 */
function normalizeExecuteResult(result: unknown): unknown {
  return Array.isArray(result) ? { rows: result } : result;
}

/**
 * Patch a transaction handle's `execute` in place so it returns the
 * normalized `{rows}` shape, and recurse into `tx.transaction` so a nested
 * (savepoint) transaction's handle gets the same patch. Returns `tx` so it
 * can be used inline where `applyExecuteNormalization` wraps the callback
 * `db.transaction(...)` hands to the caller.
 */
function wrapTransactionExecute(tx: DbTransaction): DbTransaction {
  const origExecute = tx.execute.bind(tx) as (...a: unknown[]) => Promise<unknown>;
  tx.execute = async (...args: unknown[]) => normalizeExecuteResult(await origExecute(...args));
  if (typeof tx.transaction === "function") {
    const origNestedTransaction = tx.transaction.bind(tx) as (fn: (nested: DbTransaction) => unknown) => Promise<unknown>;
    tx.transaction = (fn: (nested: DbTransaction) => unknown) =>
      origNestedTransaction((nested: DbTransaction) => fn(wrapTransactionExecute(nested)));
  }
  return tx;
}

/**
 * Wrap `db.execute` AND `db.transaction` on a bun-sql drizzle instance so
 * `execute()` always returns `{rows}` — at the top level AND on the `tx`
 * handed to a `db.transaction(async (tx) => …)` callback.
 *
 * `tx` needs its OWN patch, separate from `db`'s: drizzle builds a brand-new
 * session — and a brand-new transaction object, fresh off the driver's class
 * prototype — per transaction (`BunSQLSession.transaction()` in
 * `drizzle-orm/bun-sql/session.js`). Patching only the `db` instance's
 * `execute` property, as a prior version of this function did, never touches
 * that fresh `tx` object, so `tx.execute()` kept returning a raw array on the
 * Postgres path with nothing pinning the difference. Wrapping `db.transaction`
 * itself to normalize the `tx` before the caller's callback sees it closes
 * that gap for every call site, present and future, instead of requiring each
 * one to normalize its own result.
 */
function applyExecuteNormalization(db: Database): void {
  const origExecute = db.execute.bind(db) as (...a: unknown[]) => Promise<unknown>;
  db.execute = async (...args: unknown[]) => normalizeExecuteResult(await origExecute(...args));

  // Single-line cast on purpose: bun's coverage emitter attributes a zero-hit
  // DA record to the CLOSING line of a multi-line type annotation, which no
  // test can ever reach — the trap documented in CLAUDE.md's coverage notes.
  type TxRunner = (fn: (tx: DbTransaction) => unknown, config?: unknown) => Promise<unknown>;
  const origTransaction = db.transaction.bind(db) as TxRunner;
  db.transaction = (fn: (tx: DbTransaction) => unknown, config?: unknown) =>
    origTransaction((tx: DbTransaction) => fn(wrapTransactionExecute(tx)), config);
}

/**
 * Registry key for the external-Postgres pool in the globalThis-anchored
 * process-holder registry. A constant rather than the URL because
 * `DATABASE_URL` is a module-load const — one process only ever holds one
 * external pool — and because a registry key must not carry the DB password.
 */
const EXTERNAL_PG_HOLDER_KEY = "external-postgres";

async function initPostgres(): Promise<void> {
  const { drizzle } = await import("drizzle-orm/bun-sql");
  const { sql } = await import("drizzle-orm");

  await applyBunSqlJsonbFix();
  await patchTextColumns();

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
  // Reclaim a pool stranded by a PRIOR instance of this module. A vite
  // dev-server SSR reload re-instantiates `connection.ts` with fresh
  // `let _db`/`_initPromise` bindings while the previous Bun.sql pool is still
  // open in the SAME process. Nothing references that pool any more, but
  // Bun.sql keeps its sockets open, so the server sees `DB_POOL_MAX` backends
  // stuck in state `idle` forever — one stranded pool per reload, until
  // Postgres refuses every new client with "sorry, too many clients already".
  //
  // `initPglite()` already closes its stale prior instance through the
  // globalThis-anchored holder registry (globalThis survives a vite reload,
  // module state does not); the external-Postgres path was simply never wired
  // to the same guard. Drain BEFORE opening the replacement so peak usage
  // stays at one pool rather than briefly two.
  await closeStaleProcessHolder(EXTERNAL_PG_HOLDER_KEY);

  const db = drizzle({ connection: { url: DATABASE_URL!, max: poolMax }, schema });
  _pglite = null;

  // Publish the just-opened pool so the NEXT module instance can find and drain
  // it. The callback closes THIS `db`'s client rather than reading `_db`, so a
  // later reassignment can never make it close the wrong pool.
  recordProcessHolder(EXTERNAL_PG_HOLDER_KEY, async () => {
    await closeBunSqlPool((db as { $client?: BunSqlPoolClient }).$client);
  });

  // Normalize execute() (top-level AND inside a transaction) to always
  // return { rows: [...] } — see the doc comment on applyExecuteNormalization.
  applyExecuteNormalization(db);
  _db = db;

  // Ensure pgvector extension is available
  await _db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

  log.info("Database mode: external Postgres");
  try {
    await withPostgresMigrateLock(() => migrate(_db));
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

/** Settings marker recording that the one-shot jsonb repair has completed, so
 *  the (non-indexable, full-table-seq-scan) sweep never runs again after the
 *  first clean boot. */
const JSONB_REPAIR_MARKER_KEY = "db:jsonb-repair:done";

// Historical rows written before the jsonb-double-encoding fix are stored as
// JSON string scalars ({"x":1} → "{\"x\":1}"). Converting `jsonb::text::jsonb`
// unwraps the string back into its original object form. Idempotent — once
// every row is an object/array, subsequent runs are a no-op.
//
// One-shot: the repair can never match a row again once every column is clean,
// so re-enumerating every public jsonb column and issuing a full seq-scan
// UPDATE per column on EVERY external-Postgres boot is pure waste (worst on the
// mature installs whose tables are largest). We record completion in a settings
// marker and skip the whole sweep on subsequent boots.
async function repairDoubleEncodedJsonb(sqlTag: typeof import("drizzle-orm")["sql"]): Promise<void> {
  if (!_db) throw new Error("Database not initialized");

  const marker = await _db.execute(
    sqlTag`SELECT 1 FROM settings WHERE key = ${JSONB_REPAIR_MARKER_KEY} LIMIT 1`,
  );
  const markerRows = ((marker as { rows?: unknown }).rows ?? marker) as unknown[];
  if (Array.isArray(markerRows) && markerRows.length > 0) {
    log.info("jsonb double-encode repair already completed — skipping scan", {
      marker: JSONB_REPAIR_MARKER_KEY,
    });
    return;
  }

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

  // Record completion so the sweep never runs again. `to_jsonb(...::text)`
  // stores a legitimate scalar string (a timestamp) that the repair predicate
  // above deliberately leaves untouched. Best-effort: a marker write failure
  // only costs a redundant (idempotent) sweep next boot.
  try {
    await _db.execute(sqlTag`
      INSERT INTO settings (key, value)
      VALUES (${JSONB_REPAIR_MARKER_KEY}, to_jsonb(now()::text))
      ON CONFLICT (key) DO NOTHING
    `);
  } catch (err) {
    log.warn("jsonb repair marker write failed", { error: String(err).slice(0, 200) });
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
    if (!IS_MEMORY) {
      releaseHolder(DB_PATH);
      clearProcessHolder(DB_PATH);
    }
  } else if (_db) {
    // External Postgres (Bun.sql pool): drain the connection pool so pooled
    // sockets and any in-flight statements close cleanly instead of being
    // severed at process exit ("connection reset" noise + server-side
    // transaction rollbacks), and so repeated closeDb()/initDb() cycles in one
    // process don't leak a full pool each time (exhausting max_connections).
    // drizzle's bun-sql driver exposes the Bun SQL client as `$client`; Bun.SQL
    // closes via `.close()` (alias `.end()`).
    await closeBunSqlPool((_db as { $client?: BunSqlPoolClient }).$client);
    // We just drained it ourselves, so drop the in-process claim WITHOUT
    // closing again — mirrors the PGlite branch's clearProcessHolder(). Leaving
    // it would hand the next initPostgres() a callback onto an already-dead
    // pool.
    clearProcessHolder(EXTERNAL_PG_HOLDER_KEY);
  }
  _pglite = null;
  _db = null;
  _initPromise = null;
}

// Exported for tests. Placed at the end of the module so its object literal
// (evaluated at module-load time) can reference every const/function above
// without hitting the temporal dead zone.
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
  // Real production functions, exposed so their regression tests exercise THIS
  // code (not a re-declared copy) against a real driver.
  applyBunSqlJsonbFix,
  repairDoubleEncodedJsonb,
  withPostgresMigrateLock,
  // The external-Postgres opener. `init()` only reaches it when the process
  // was booted with DATABASE_URL set (a module-load const), so the PGlite
  // coverage shards never do — exposed here so a unit test can drive the
  // Bun.sql branch directly with a mocked driver (no real server).
  initPostgres,
  recoverInterruptedRollback,
  registerProcessHolder,
  writeRollbackMarker,
  JSONB_REPAIR_MARKER_KEY,
  MIGRATE_ADVISORY_LOCK_KEY,
};
