import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let backupDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-backup-test-"));
  backupDir = join(tempDir, "backups");
  dbPath = join(tempDir, "test-pg");
  process.env.EZCORP_BACKUP_DIR = backupDir;
  delete process.env.EZCORP_IMAGE_SHA;
});

afterEach(async () => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.EZCORP_BACKUP_DIR;
  delete process.env.EZCORP_IMAGE_SHA;
  delete process.env.EZCORP_BACKUP_INTERVAL_KEEP;
  delete process.env.EZCORP_BACKUP_DAILY_KEEP;
  delete process.env.EZCORP_BACKUP_INTERVAL_MS;
  // Readiness is a process-wide singleton; a test that flips it to
  // "degraded" must not leak that into siblings or other files.
  const { resetReadiness } = await import("../readiness");
  resetReadiness();
});

mock.module("../db/connection", () => ({
  getPglite: () => null,
  getDbPath: () => dbPath,
  getDb: () => null,
  initDb: async () => {},
  closeDb: async () => {},
}));

afterAll(() => restoreModuleMocks());

describe("backup module lifecycle", () => {
  test("stopBackups writes a final shutdown backup when the DB dir has content", async () => {
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, "postgres.auto.conf"), "live");

    const backup = await import("../db/backup");
    backup.startBackups();
    backup.stopBackups(); // triggers the final performBackup on shutdown

    const intervals = readdirSync(backupDir).filter((f) => f.startsWith("ezcorp-db-"));
    expect(intervals).toHaveLength(1);
    expect(readFileSync(join(backupDir, intervals[0], "postgres.auto.conf"), "utf8")).toBe("live");
  });

  test("startBackups is a no-op while running; stopBackups is idempotent", async () => {
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, "marker"), "x");
    process.env.EZCORP_BACKUP_INTERVAL_MS = "60000"; // exercise the env override

    const backup = await import("../db/backup");
    backup.startBackups();
    backup.startBackups(); // second start must not double-schedule or throw
    backup.stopBackups(); // final backup
    expect(readdirSync(backupDir).filter((f) => f.startsWith("ezcorp-db-")).length).toBeGreaterThanOrEqual(1);
    backup.stopBackups(); // idempotent — safe to call again
  });
});

describe("getBackupDir", () => {
  test("honors EZCORP_BACKUP_DIR override", async () => {
    const backup = await import("../db/backup");
    expect(backup.getBackupDir()).toBe(backupDir);
  });

  test("defaults to <dbDir>/backups when override unset", async () => {
    delete process.env.EZCORP_BACKUP_DIR;
    const backup = await import("../db/backup");
    expect(backup.getBackupDir()).toBe(join(tempDir, "backups"));
  });
});

describe("snapshotPreBoot", () => {
  test("returns null when DB dir does not exist", async () => {
    const backup = await import("../db/backup");
    expect(backup.snapshotPreBoot()).toBeNull();
  });

  test("returns null when DB dir is empty", async () => {
    mkdirSync(dbPath, { recursive: true });
    const backup = await import("../db/backup");
    expect(backup.snapshotPreBoot()).toBeNull();
  });

  test("copies DB dir to pre-boot-<sha>-<ts>/ and returns the path", async () => {
    process.env.EZCORP_IMAGE_SHA = "abc123def456";
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, "postgres.auto.conf"), "dummy data");

    const backup = await import("../db/backup");
    const snapshot = backup.snapshotPreBoot();

    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatch(/pre-boot-abc123def456-/);
    expect(existsSync(snapshot!)).toBe(true);
    expect(readFileSync(join(snapshot!, "postgres.auto.conf"), "utf8")).toBe("dummy data");
  });

  test("prunes to MAX_PRE_BOOT_SNAPSHOTS (3)", async () => {
    mkdirSync(backupDir, { recursive: true });
    // Seed 4 existing snapshots then take one more — should end with 3.
    for (let i = 0; i < 4; i++) {
      mkdirSync(join(backupDir, `pre-boot-sha-2026-01-0${i + 1}T00-00-00-000Z`), { recursive: true });
    }
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, "marker"), "x");

    const backup = await import("../db/backup");
    backup.snapshotPreBoot();

    const remaining = readdirSync(backupDir).filter((f) => f.startsWith("pre-boot-"));
    expect(remaining).toHaveLength(3);
  });

  test("does not touch interval (pi-db-*) backups", async () => {
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(join(backupDir, "pi-db-2026-01-01T00-00-00-000Z"), { recursive: true });
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, "marker"), "x");

    const backup = await import("../db/backup");
    backup.snapshotPreBoot();

    expect(existsSync(join(backupDir, "pi-db-2026-01-01T00-00-00-000Z"))).toBe(true);
  });
});

describe("latestPreBootSnapshot", () => {
  test("returns null when no snapshots exist", async () => {
    const backup = await import("../db/backup");
    expect(backup.latestPreBootSnapshot()).toBeNull();
  });

  test("returns newest pre-boot-* by mtime (robust against SHA / prefix reordering)", async () => {
    mkdirSync(backupDir, { recursive: true });
    // Use different SHAs in names to prove mtime (not lex-on-name) drives
    // the answer — SHA `abc...` would lose to `xyz...` under lex sort, but
    // the `abc` snapshot is the newest by mtime so should win.
    const older = join(backupDir, "pre-boot-xyz999-2026-01-01T00-00-00-000Z");
    const mid   = join(backupDir, "pre-boot-mmm555-2026-02-01T00-00-00-000Z");
    const newer = join(backupDir, "pre-boot-abc123-2026-03-15T12-34-56-000Z");
    mkdirSync(older);
    mkdirSync(mid);
    mkdirSync(newer);
    // Set mtimes explicitly (seconds since epoch) so order is deterministic.
    utimesSync(older, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    utimesSync(mid,   new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
    utimesSync(newer, new Date("2026-03-15T12:34:56Z"), new Date("2026-03-15T12:34:56Z"));

    const backup = await import("../db/backup");
    expect(backup.latestPreBootSnapshot()).toBe(newer);
  });

  test("ignores non-snapshot entries", async () => {
    mkdirSync(backupDir, { recursive: true });
    mkdirSync(join(backupDir, "pi-db-2026-03-15T12-34-56-000Z"));

    const backup = await import("../db/backup");
    expect(backup.latestPreBootSnapshot()).toBeNull();
  });
});

describe("migration marker", () => {
  test("read/write/clear round-trip", async () => {
    mkdirSync(dbPath, { recursive: true });
    const backup = await import("../db/backup");

    expect(backup.readMarker()).toBeNull();

    backup.writeMarker({
      imageSha: "sha256:abc",
      error: "CREATE TABLE foo failed: syntax error",
      ts: "2026-04-21T10:00:00.000Z",
    });

    const read = backup.readMarker();
    expect(read).not.toBeNull();
    expect(read?.imageSha).toBe("sha256:abc");
    expect(read?.error).toBe("CREATE TABLE foo failed: syntax error");

    backup.clearMarker();
    expect(backup.readMarker()).toBeNull();
  });

  test("clearMarker is a no-op when marker does not exist", async () => {
    const backup = await import("../db/backup");
    expect(() => backup.clearMarker()).not.toThrow();
  });

  test("readMarker returns null for malformed json", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, ".migration-failed"), "not json");
    const backup = await import("../db/backup");
    expect(backup.readMarker()).toBeNull();
  });
});

describe("performBackup (real interval + daily tiers)", () => {
  function seedDb(): void {
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, "postgres.auto.conf"), "live-data");
  }
  const intervals = () =>
    readdirSync(backupDir).filter((f) => f.startsWith("ezcorp-db-") || f.startsWith("pi-db-"));
  const dailies = () => readdirSync(backupDir).filter((f) => f.startsWith("daily-"));
  const temps = () => readdirSync(backupDir).filter((f) => f.startsWith(".tmp-"));
  const today = () => new Date().toISOString().slice(0, 10);

  test("writes an interval backup atomically — content copied, no staging dir left", async () => {
    seedDb();
    const backup = await import("../db/backup");
    backup.performBackup();

    const iv = intervals();
    expect(iv).toHaveLength(1);
    expect(readFileSync(join(backupDir, iv[0], "postgres.auto.conf"), "utf8")).toBe("live-data");
    expect(temps()).toHaveLength(0); // rename-on-success leaves no .tmp-* dir
  });

  test("skips backup entirely in degraded (circuit-breaker) mode", async () => {
    seedDb();
    const { setReadiness } = await import("../readiness");
    setReadiness({ state: "degraded", reason: "data-recovery-needed" });

    const backup = await import("../db/backup");
    backup.performBackup();

    // Returns before mkdirSync — the backup dir is never even created.
    expect(existsSync(backupDir)).toBe(false);
  });

  test("cleans up the staging dir and writes nothing when the copy fails", async () => {
    // dbPath intentionally does NOT exist → cpSync throws inside atomicCopyDir.
    const backup = await import("../db/backup");
    expect(() => backup.performBackup()).not.toThrow();

    expect(intervals()).toHaveLength(0);
    expect(dailies()).toHaveLength(0);
    expect(temps()).toHaveLength(0); // partial copy removed, never lingers
  });

  test("sweeps a stale .tmp-* dir left behind by a prior crashed copy", async () => {
    seedDb();
    mkdirSync(join(backupDir, ".tmp-ezcorp-db-crashed.999"), { recursive: true });

    const backup = await import("../db/backup");
    backup.performBackup();

    expect(temps()).toHaveLength(0); // stale staging dir swept
    expect(intervals()).toHaveLength(1);
  });

  test("prunes interval backups by mtime honoring EZCORP_BACKUP_INTERVAL_KEEP, not lexicographic name order", async () => {
    seedDb();
    mkdirSync(backupDir, { recursive: true });
    // Lexicographically-LATEST name but the OLDEST mtime → must still prune,
    // proving rotation sorts by mtime (survives a volume restore where mtimes
    // don't track the embedded timestamp) and not by filename.
    const lexLatestOldest = join(backupDir, "ezcorp-db-9999-12-31T00-00-00-000Z");
    const janOld = join(backupDir, "pi-db-2026-01-01T00-00-00-000Z");
    const junNew1 = join(backupDir, "ezcorp-db-2026-06-01T00-00-00-000Z");
    const junNew2 = join(backupDir, "pi-db-2026-06-15T00-00-00-000Z");
    for (const p of [lexLatestOldest, janOld, junNew1, junNew2]) mkdirSync(p, { recursive: true });
    utimesSync(lexLatestOldest, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    utimesSync(janOld, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    utimesSync(junNew1, new Date("2026-06-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"));
    utimesSync(junNew2, new Date("2026-06-15T00:00:00Z"), new Date("2026-06-15T00:00:00Z"));

    process.env.EZCORP_BACKUP_INTERVAL_KEEP = "3";
    const backup = await import("../db/backup");
    backup.performBackup(); // new ezcorp-db-<now> is the newest by mtime

    expect(intervals()).toHaveLength(3);
    expect(existsSync(junNew1)).toBe(true); // two newest seeds survive
    expect(existsSync(junNew2)).toBe(true);
    expect(existsSync(lexLatestOldest)).toBe(false); // lex-latest but oldest → pruned
    expect(existsSync(janOld)).toBe(false);
  });

  test("falls back to the default interval cap when the env override is non-numeric", async () => {
    seedDb();
    mkdirSync(backupDir, { recursive: true });
    for (let i = 1; i <= 2; i++) mkdirSync(join(backupDir, `ezcorp-db-2026-05-0${i}T00-00-00-000Z`));
    process.env.EZCORP_BACKUP_INTERVAL_KEEP = "not-a-number";

    const backup = await import("../db/backup");
    backup.performBackup(); // 3 interval dirs total; default cap (12) prunes none

    expect(intervals()).toHaveLength(3);
  });

  test("promotes exactly one daily snapshot per UTC day and never duplicates it", async () => {
    seedDb();
    const backup = await import("../db/backup");
    backup.performBackup();

    const first = dailies();
    expect(first).toHaveLength(1);
    expect(first[0]).toBe(`daily-${today()}`);
    expect(readFileSync(join(backupDir, first[0], "postgres.auto.conf"), "utf8")).toBe("live-data");

    backup.performBackup(); // second run same day → still exactly one daily
    expect(dailies()).toHaveLength(1);
  });

  test("prunes daily snapshots to EZCORP_BACKUP_DAILY_KEEP, keeping the newest by mtime", async () => {
    seedDb();
    mkdirSync(backupDir, { recursive: true });
    const d1 = join(backupDir, "daily-2026-06-01");
    const d2 = join(backupDir, "daily-2026-06-02");
    const d3 = join(backupDir, "daily-2026-06-03");
    for (const p of [d1, d2, d3]) mkdirSync(p, { recursive: true });
    utimesSync(d1, new Date("2026-06-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"));
    utimesSync(d2, new Date("2026-06-02T00:00:00Z"), new Date("2026-06-02T00:00:00Z"));
    utimesSync(d3, new Date("2026-06-03T00:00:00Z"), new Date("2026-06-03T00:00:00Z"));
    process.env.EZCORP_BACKUP_DAILY_KEEP = "2";

    const backup = await import("../db/backup");
    backup.performBackup(); // adds today's daily (newest) → prune to 2

    const remaining = dailies();
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain(`daily-${today()}`); // today's kept
    expect(existsSync(d1)).toBe(false); // oldest pruned
  });

  test("a failed daily promotion does not throw or lose the interval backup", async () => {
    seedDb();
    mkdirSync(backupDir, { recursive: true });
    // A pre-existing interval dir with a FAR-FUTURE mtime outranks the fresh
    // backup, so with cap=1 the just-written interval backup is pruned away
    // before promoteDaily copies from it → the daily source is gone and the
    // promotion fails. performBackup must swallow that and stay healthy.
    const future = join(backupDir, "ezcorp-db-future");
    mkdirSync(future, { recursive: true });
    utimesSync(future, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
    process.env.EZCORP_BACKUP_INTERVAL_KEEP = "1";

    const backup = await import("../db/backup");
    expect(() => backup.performBackup()).not.toThrow();

    expect(dailies()).toHaveLength(0); // promotion failed → no daily written
    expect(existsSync(future)).toBe(true); // surviving interval backup kept
  });
});
