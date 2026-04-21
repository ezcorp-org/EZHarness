import { getDbPath } from "./connection";
import { mkdirSync, readdirSync, rmSync, cpSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger";
const log = logger.child("db");

const BACKUP_DIR = `${process.env.HOME}/ez-corp/.data/backups`;
const MAX_BACKUPS = 5;
const BACKUP_INTERVAL = 30 * 60 * 1000; // 30 minutes

let timer: ReturnType<typeof setInterval> | null = null;

function performBackup(): void {
  const dbPath = getDbPath();
  if (dbPath === ":memory:") return;

  mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(BACKUP_DIR, `pi-db-${timestamp}`);

  try {
    // PGlite stores data as a directory — copy the entire directory
    cpSync(dbPath, backupPath, { recursive: true });
    // Restrict backup directory permissions to owner-only
    chmodSync(backupPath, 0o700);
  } catch (err) {
    log.error("Backup failed", { error: String(err) });
    return;
  }

  // Prune old backups
  const backups = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("pi-db-"))
    .sort()
    .reverse();

  for (const old of backups.slice(MAX_BACKUPS)) {
    rmSync(join(BACKUP_DIR, old), { recursive: true, force: true });
  }
}

export function startBackups(): void {
  timer = setInterval(performBackup, BACKUP_INTERVAL);
}

export function stopBackups(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  performBackup(); // Final backup on shutdown
}
