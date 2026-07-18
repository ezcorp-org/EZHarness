import { getDbPath } from "./connection";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  cpSync,
  chmodSync,
  renameSync,
  existsSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { logger } from "../logger";
import { getReadiness } from "../readiness";
const log = logger.child("db");

// Retention defaults. All three are operator-overridable via env so a
// long-running container can widen its restore horizon without a rebuild.
//
//   interval tier — half-hourly, short horizon (default 12 → ~6h back)
//   daily tier    — one snapshot per UTC day, sparse long horizon (default 7d)
//   pre-boot tier — taken only before migrate() at boot (the *trusted* series)
//
// The interval + daily split fixes the old ~2.5h-only window (5 * 30min): a
// data loss noticed hours or days later (including one caused by an LLM tool
// action mutating data) now has a daily restore point going back a week,
// while the frequent interval tier still gives fine-grained recent points.
const DEFAULT_MAX_INTERVAL_BACKUPS = 12;
const DEFAULT_MAX_DAILY_BACKUPS = 7;
const DEFAULT_BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_PRE_BOOT_SNAPSHOTS = 3;
// Interval backup filename prefixes. New snapshots are written with the
// first entry; any entry is counted for pruning (so the total — old + new —
// stays ≤ the interval cap across a rename boundary).
const INTERVAL_PREFIXES = ["ezcorp-db-", "pi-db-"] as const;
const INTERVAL_PREFIX = INTERVAL_PREFIXES[0];
const DAILY_PREFIX = "daily-";
const PRE_BOOT_PREFIX = "pre-boot-";
// Staging prefix for in-progress copies. Dotted so it never matches a real
// tier prefix in listByMtimeDesc — a partial copy can therefore never be
// selected for restore or counted against a retention cap.
const TEMP_PREFIX = ".tmp-";
const MARKER_FILENAME = ".migration-failed";
const RECOVERY_MARKER_FILENAME = ".ezcorp-recovery-needed.json";

/** Positive-integer env override, falling back to `def` when unset/invalid. */
function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function maxIntervalBackups(): number {
  return envInt("EZCORP_BACKUP_INTERVAL_KEEP", DEFAULT_MAX_INTERVAL_BACKUPS);
}
function maxDailyBackups(): number {
  return envInt("EZCORP_BACKUP_DAILY_KEEP", DEFAULT_MAX_DAILY_BACKUPS);
}
function backupIntervalMs(): number {
  return envInt("EZCORP_BACKUP_INTERVAL_MS", DEFAULT_BACKUP_INTERVAL_MS);
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Backup directory. Default colocates with the DB dir so a single mount
 * (`/app/data` in Docker) covers both; `EZCORP_BACKUP_DIR` overrides for
 * callers who want the backups on a separate volume.
 */
export function getBackupDir(): string {
  const override = process.env.EZCORP_BACKUP_DIR;
  if (override) return override;
  const dbPath = getDbPath();
  if (dbPath === "external" || dbPath === ":memory:") {
    return `${process.env.HOME}/ez-corp/.data/backups`;
  }
  return join(dirname(dbPath), "backups");
}

function markerPath(): string {
  const dbPath = getDbPath();
  const base = dbPath === "external" || dbPath === ":memory:"
    ? `${process.env.HOME}/ez-corp/.data`
    : dirname(dbPath);
  return join(base, MARKER_FILENAME);
}

function recoveryMarkerPath(): string {
  const dbPath = getDbPath();
  const base = dbPath === "external" || dbPath === ":memory:"
    ? `${process.env.HOME}/ez-corp/.data`
    : dirname(dbPath);
  return join(base, RECOVERY_MARKER_FILENAME);
}

/**
 * Copy `src` to `finalPath` atomically. The copy is staged into a sibling
 * dotted `.tmp-*` dir on the SAME filesystem, then `renameSync`d into place
 * only after it fully succeeds. A crash mid-copy (throw / SIGKILL / OOM) can
 * therefore only ever leave a `.tmp-*` dir — never a partially-populated
 * final-named dir — so listByMtimeDesc (which matches only the real tier
 * prefixes) can never hand a torn copy to the restore path in
 * connection.ts's rollbackMigration. On any failure the temp dir is removed
 * so partial copies never accumulate.
 *
 * The copy is deliberately synchronous (cpSync). PGlite runs on the same
 * thread as request serving, so a sync copy is a point-in-time, crash-
 * consistent view of the data dir; a naive switch to async `fs.cp` would let
 * the engine write mid-copy and produce a torn WAL/heap snapshot. The cost is
 * an event-loop stall proportional to data-dir size — acceptable for the
 * best-effort interval/daily tiers, and irrelevant for the pre-boot tier
 * (taken before the engine opens), which is the trusted restore series.
 */
function atomicCopyDir(src: string, finalPath: string): void {
  const tmpPath = join(dirname(finalPath), `${TEMP_PREFIX}${basename(finalPath)}.${process.pid}`);
  rmSync(tmpPath, { recursive: true, force: true });
  try {
    cpSync(src, tmpPath, { recursive: true });
    chmodSync(tmpPath, 0o700);
    // Replace any same-named prior copy (e.g. a re-backup within the same
    // millisecond-resolution timestamp): renameSync onto a NON-EMPTY dir
    // fails with ENOTEMPTY, so drop it first. The staged temp is already a
    // complete copy, so the brief gap can only ever lose a duplicate of an
    // existing point — never expose a partial final-named dir to restore.
    rmSync(finalPath, { recursive: true, force: true });
    renameSync(tmpPath, finalPath);
  } catch (err) {
    rmSync(tmpPath, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Remove leftover `.tmp-*` staging dirs from a prior crashed copy. Callers
 * always `mkdirSync(dir)` immediately before, so `dir` is guaranteed to exist.
 */
function sweepStaleTemp(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(TEMP_PREFIX)) {
      rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
}

export function performBackup(): void {
  const dbPath = getDbPath();
  if (dbPath === ":memory:" || dbPath === "external") return;
  // In circuit-breaker mode the DB is the pre-failure snapshot already —
  // don't overwrite the interval series with a snapshot we can't trust.
  if (getReadiness().state === "degraded") return;

  const dir = getBackupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepStaleTemp(dir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(dir, `${INTERVAL_PREFIX}${timestamp}`);

  try {
    atomicCopyDir(dbPath, backupPath);
  } catch (err) {
    log.error("Backup failed", { error: String(err) });
    return;
  }

  pruneBackups(dir, INTERVAL_PREFIXES, maxIntervalBackups());
  promoteDaily(dir, backupPath);
}

/**
 * Sparse long-horizon tier: keep one snapshot per UTC day so a data loss
 * noticed hours or days later still has a restore point (the half-hourly
 * interval series only reaches back `maxIntervalBackups()` copies). The daily
 * copy is promoted from the freshly written, verified interval backup, so it
 * costs one extra dir-copy per day — not per interval.
 */
function promoteDaily(dir: string, sourceBackupPath: string): void {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const alreadyToday = readdirSync(dir).some((f) => f.startsWith(`${DAILY_PREFIX}${day}`));
  if (alreadyToday) return;

  try {
    atomicCopyDir(sourceBackupPath, join(dir, `${DAILY_PREFIX}${day}`));
  } catch (err) {
    log.error("Daily backup promotion failed", { error: String(err) });
    return;
  }
  pruneBackups(dir, DAILY_PREFIX, maxDailyBackups());
}

function listByMtimeDesc(dir: string, prefixes: readonly string[]): string[] {
  // Sort by mtime instead of lex-on-name because names embed the image SHA
  // (pre-boot-<sha>-<ts>) or a legacy prefix (pi-db- vs ezcorp-db-), either
  // of which dominates a naive lex-sort and scrambles newest-first order
  // across rename/image-tag boundaries.
  return readdirSync(dir)
    .filter((f) => prefixes.some((p) => f.startsWith(p)))
    .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => e.name);
}

function pruneBackups(dir: string, prefixes: readonly string[] | string, keep: number): void {
  const prefixList = typeof prefixes === "string" ? [prefixes] : prefixes;
  const backups = listByMtimeDesc(dir, prefixList);
  for (const old of backups.slice(keep)) {
    rmSync(join(dir, old), { recursive: true, force: true });
  }
}

/**
 * Copy the current DB directory to `$BACKUP_DIR/pre-boot-<sha>-<iso>/` before
 * migrate() runs. Keeps at most MAX_PRE_BOOT_SNAPSHOTS so repeated restarts
 * don't balloon disk usage. Returns the snapshot path, or null if there was
 * nothing to snapshot (memory DB, external Postgres, missing/empty data dir).
 */
export function snapshotPreBoot(): string | null {
  const dbPath = getDbPath();
  if (dbPath === ":memory:" || dbPath === "external") return null;
  if (!existsSync(dbPath)) return null;
  try {
    const contents = readdirSync(dbPath);
    if (contents.length === 0) return null;
  } catch {
    return null;
  }

  const dir = getBackupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepStaleTemp(dir);

  const sha = (process.env.EZCORP_IMAGE_SHA ?? "dev").slice(0, 12);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = join(dir, `${PRE_BOOT_PREFIX}${sha}-${timestamp}`);

  try {
    atomicCopyDir(dbPath, snapshotPath);
  } catch (err) {
    log.error("Pre-boot snapshot failed", { error: String(err) });
    return null;
  }

  pruneBackups(dir, PRE_BOOT_PREFIX, MAX_PRE_BOOT_SNAPSHOTS);
  log.info("Pre-boot snapshot taken", { path: snapshotPath });
  return snapshotPath;
}

/** Newest pre-boot snapshot path, or null if none exist. */
export function latestPreBootSnapshot(): string | null {
  const dir = getBackupDir();
  if (!existsSync(dir)) return null;
  const snapshots = listByMtimeDesc(dir, [PRE_BOOT_PREFIX]);
  const newest = snapshots[0];
  return newest ? join(dir, newest) : null;
}

export interface MigrationFailureMarker {
  imageSha: string;
  error: string;
  ts: string;
}

export function readMarker(): MigrationFailureMarker | null {
  const path = markerPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.imageSha === "string" && typeof parsed?.error === "string" && typeof parsed?.ts === "string") {
      return parsed as MigrationFailureMarker;
    }
    return null;
  } catch (err) {
    log.warn("Could not parse migration marker", { error: String(err) });
    return null;
  }
}

export function writeMarker(marker: MigrationFailureMarker): void {
  const path = markerPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(marker, null, 2), { mode: 0o600 });
}

export function clearMarker(): void {
  const path = markerPath();
  if (existsSync(path)) {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      log.warn("Could not clear migration marker", { error: String(err) });
    }
  }
}

/**
 * Recovery-needed marker. Written by `initPglite()` when `openPglite()` throws
 * and `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE` is NOT set. Distinct from the
 * migration-failed marker (`.migration-failed`) — that one is a circuit
 * breaker for migrate() failures with a pre-boot snapshot; this one signals
 * "the DB dir itself couldn't be opened; operator must intervene."
 *
 * The default policy on open failure is "do nothing destructive": leave the
 * data dir intact, drop this marker so /api/ready can surface it, throw so
 * the boot path stays unhealthy. Two production incidents on 2026-05-10
 * destroyed user data when the old catch branch auto-renamed the dir.
 */
export interface RecoveryNeededMarker {
  /** ISO timestamp when the marker was written. */
  ts: string;
  /** EZCORP_IMAGE_SHA, or "dev" for unbuilt local runs. */
  imageSha: string;
  /** String form of the open error (truncated to 2000 chars). */
  error: string;
  /** The DB path that failed to open — operators may need it for recovery. */
  dbPath: string;
}

export function readRecoveryMarker(): RecoveryNeededMarker | null {
  const path = recoveryMarkerPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.ts === "string" &&
      typeof parsed?.imageSha === "string" &&
      typeof parsed?.error === "string" &&
      typeof parsed?.dbPath === "string"
    ) {
      return parsed as RecoveryNeededMarker;
    }
    return null;
  } catch (err) {
    log.warn("Could not parse recovery-needed marker", { error: String(err) });
    return null;
  }
}

export function writeRecoveryMarker(marker: RecoveryNeededMarker): void {
  const path = recoveryMarkerPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(marker, null, 2), { mode: 0o600 });
}

export function clearRecoveryMarker(): void {
  const path = recoveryMarkerPath();
  if (existsSync(path)) {
    try {
      rmSync(path, { force: true });
    } catch (err) {
      log.warn("Could not clear recovery-needed marker", { error: String(err) });
    }
  }
}

export function startBackups(): void {
  if (timer) return;
  timer = setInterval(performBackup, backupIntervalMs());
}

export function stopBackups(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  performBackup(); // Final backup on shutdown (no-op in degraded mode)
}

