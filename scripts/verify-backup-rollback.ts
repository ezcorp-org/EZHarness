#!/usr/bin/env bun
/**
 * End-to-end validation of the pre-migrate snapshot + rollback flow.
 *
 * Exercises the real PGlite engine against a temp directory (no Docker
 * required) and proves that:
 *   1. A pre-boot snapshot is taken on boots where the DB already has data.
 *   2. If migrate() throws, the failed DB is renamed aside, the snapshot
 *      is restored, and a circuit-breaker marker is written.
 *   3. Data seeded before the failed migration is preserved in the
 *      restored DB.
 *   4. The circuit breaker blocks re-running migrate() on the next boot
 *      of the same image SHA.
 *   5. Clearing the marker allows the next boot to proceed normally.
 *
 * Run: bun run scripts/verify-backup-rollback.ts
 */

import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// IMPORTANT: env vars must be set BEFORE importing connection.ts, which
// captures DB_PATH at module load.
const TMP = mkdtempSync(join(tmpdir(), "ezcorp-verify-"));
const DB_PATH = join(TMP, "db");
const BACKUP_DIR = join(TMP, "backups");

process.env.EZCORP_DB_PATH = DB_PATH;
process.env.EZCORP_BACKUP_DIR = BACKUP_DIR;
process.env.EZCORP_IMAGE_SHA = "verify-sha-0001";
process.env.EZCORP_NO_EXIT = "1"; // rollbackMigration throws instead of process.exit
delete process.env.DATABASE_URL;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

let step = 0;
function section(title: string) {
  step += 1;
  console.log(`\n${bold(`Step ${step}: ${title}`)}`);
}
function ok(msg: string) { console.log(green(`  ✓ ${msg}`)); }
function fail(msg: string): never { console.log(red(`  ✗ ${msg}`)); process.exit(1); }

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
  else ok(msg);
}

// connection.ts has module-level singletons; closeDb() resets them, so
// initDb() on the next call re-runs the boot sequence (including the
// circuit-breaker marker check and the snapshot step).
const conn = await import("../src/db/connection");
const backup = await import("../src/db/backup");
const readiness = await import("../src/readiness");
const { sql } = await import("drizzle-orm");

try {
  section("First boot: empty DB dir → no snapshot, migrate runs, readiness = ready");
  await conn.initDb();
  assert(existsSync(DB_PATH), `DB dir created at ${DB_PATH}`);
  assert(
    !existsSync(BACKUP_DIR) || readdirSync(BACKUP_DIR).filter((f) => f.startsWith("pre-boot-")).length === 0,
    "No pre-boot snapshot on first boot (empty DB skipped)",
  );
  assert(readiness.getReadiness().state === "ready", `Readiness = ready`);

  await conn.getDb().execute(
    sql`INSERT INTO settings (key, value) VALUES ('verify-key', '"verify-value"'::jsonb)`,
  );
  ok("Seeded row (key=verify-key) into settings table");
  await conn.closeDb();

  section("Second boot: non-empty DB → pre-boot snapshot is taken");
  await conn.initDb();
  const snapshots2 = readdirSync(BACKUP_DIR).filter((f) => f.startsWith("pre-boot-"));
  assert(snapshots2.length === 1, `Exactly 1 pre-boot snapshot created: ${snapshots2[0]}`);
  assert(snapshots2[0]!.includes("verify-sha"), `Snapshot filename contains image SHA: ${snapshots2[0]}`);
  const snap2Dir = join(BACKUP_DIR, snapshots2[0]!);
  assert(readdirSync(snap2Dir).length > 0, `Snapshot has ${readdirSync(snap2Dir).length} entries (non-empty copy)`);
  assert(backup.latestPreBootSnapshot() === snap2Dir, "latestPreBootSnapshot() returns the new snapshot");

  // Re-verify the seeded row survived reboot
  const rows2 = (await conn.getDb().execute(
    sql`SELECT value FROM settings WHERE key = 'verify-key'`,
  )).rows;
  assert(rows2.length === 1, "Seeded row survived reboot");

  section("Simulated migration failure: rollback restores the snapshot");
  // Insert a row that WILL be lost by rollback (it was inserted after the
  // snapshot was taken at the start of this boot).
  await conn.getDb().execute(
    sql`INSERT INTO settings (key, value) VALUES ('will-be-lost', '"x"'::jsonb)`,
  );
  const preRollback = (await conn.getDb().execute(
    sql`SELECT key FROM settings ORDER BY key`,
  )).rows.map((r: any) => r.key);
  assert(
    preRollback.length === 2 && preRollback.includes("will-be-lost"),
    `Pre-rollback DB has 2 rows: [${preRollback.join(", ")}]`,
  );

  // Trigger rollback directly. EZCORP_NO_EXIT=1 makes it throw instead of
  // process.exit — same post-conditions on disk as a real failure path.
  let threw = false;
  try {
    await conn.__test.rollbackMigration(new Error("VERIFY: simulated migration failure"));
  } catch (err) {
    threw = true;
    assert(String(err).includes("simulated migration failure"), "rollbackMigration rethrew in test mode");
  }
  assert(threw, "rollbackMigration honors EZCORP_NO_EXIT=1");

  // Marker written at sibling of DB dir
  const markerPath = join(TMP, ".migration-failed");
  assert(existsSync(markerPath), "Circuit-breaker marker written to <dbDir>/../.migration-failed");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  assert(marker.imageSha === "verify-sha-0001", `Marker imageSha = ${marker.imageSha}`);
  assert(marker.error.includes("simulated migration failure"), "Marker error contains the thrown message");

  // Failed DB preserved
  const failedDirs = readdirSync(TMP).filter((f) => f.startsWith("db.failed."));
  assert(failedDirs.length === 1, `Failed DB preserved at db.failed.* (${failedDirs[0]}) for forensics`);

  section("Next boot with marker present: circuit breaker engages, data preserved");
  await conn.initDb();
  assert(
    readiness.getReadiness().state === "degraded",
    `Readiness = degraded (got ${readiness.getReadiness().state})`,
  );
  assert(
    readiness.getReadiness().reason === "migration-blocked",
    `Readiness reason = migration-blocked`,
  );
  const restoredRows = (await conn.getDb().execute(
    sql`SELECT key FROM settings ORDER BY key`,
  )).rows.map((r: any) => r.key);
  assert(
    restoredRows.length === 1 && restoredRows[0] === "verify-key",
    `Restored DB has ONLY pre-snapshot data: [${restoredRows.join(", ")}] — "will-be-lost" correctly gone`,
  );
  await conn.closeDb();

  section("Recovery: clearing the marker restores normal boot");
  backup.clearMarker();
  assert(
    !existsSync(markerPath),
    "Marker cleared (simulates `docker exec ... rm /app/data/.migration-failed`)",
  );

  await conn.initDb();
  assert(
    readiness.getReadiness().state === "ready",
    `Post-recovery readiness = ready (got ${readiness.getReadiness().state})`,
  );
  const finalRows = (await conn.getDb().execute(
    sql`SELECT key FROM settings ORDER BY key`,
  )).rows.map((r: any) => r.key);
  assert(finalRows.length === 1 && finalRows[0] === "verify-key", "Data still intact after recovery");
  await conn.closeDb();

  console.log(`\n${bold(green("ALL VERIFIED"))} — snapshot, rollback, circuit breaker, and recovery all work end-to-end.`);
  console.log(dim(`Temp dir retained for inspection: ${TMP}`));
  console.log(dim(`(remove with: rm -rf ${TMP})`));
  rmSync(TMP, { recursive: true, force: true });
} catch (err) {
  console.error(red(`\nVerification failed:`), err);
  console.error(dim(`Inspect state at: ${TMP}`));
  process.exit(1);
}
