import { getDbPath } from "./connection";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  cpSync,
  chmodSync,
  existsSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logger";
import { getReadiness } from "../readiness";
const log = logger.child("db");

const MAX_INTERVAL_BACKUPS = 5;
const MAX_PRE_BOOT_SNAPSHOTS = 3;
const BACKUP_INTERVAL = 30 * 60 * 1000; // 30 minutes
// Interval backup filename prefixes. New snapshots are written with the
// first entry; any entry is counted for pruning (so the total — old + new —
// stays ≤ MAX_INTERVAL_BACKUPS across a rename boundary).
const INTERVAL_PREFIXES = ["ezcorp-db-", "pi-db-"] as const;
const INTERVAL_PREFIX = INTERVAL_PREFIXES[0];
const PRE_BOOT_PREFIX = "pre-boot-";
const MARKER_FILENAME = ".migration-failed";
const RECOVERY_MARKER_FILENAME = ".ezcorp-recovery-needed.json";

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

function performBackup(): void {
  const dbPath = getDbPath();
  if (dbPath === ":memory:" || dbPath === "external") return;
  // In circuit-breaker mode the DB is the pre-failure snapshot already —
  // don't overwrite the interval series with a snapshot we can't trust.
  if (getReadiness().state === "degraded") return;

  const dir = getBackupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(dir, `${INTERVAL_PREFIX}${timestamp}`);

  try {
    cpSync(dbPath, backupPath, { recursive: true });
    chmodSync(backupPath, 0o700);
  } catch (err) {
    log.error("Backup failed", { error: String(err) });
    return;
  }

  pruneBackups(dir, INTERVAL_PREFIXES, MAX_INTERVAL_BACKUPS);
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

  const sha = (process.env.EZCORP_IMAGE_SHA ?? "dev").slice(0, 12);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotPath = join(dir, `${PRE_BOOT_PREFIX}${sha}-${timestamp}`);

  try {
    cpSync(dbPath, snapshotPath, { recursive: true });
    chmodSync(snapshotPath, 0o700);
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
  timer = setInterval(performBackup, BACKUP_INTERVAL);
}

export function stopBackups(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  performBackup(); // Final backup on shutdown (no-op in degraded mode)
}

