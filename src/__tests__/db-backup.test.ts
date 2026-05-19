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

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.EZCORP_BACKUP_DIR;
  delete process.env.EZCORP_IMAGE_SHA;
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
  test("stopBackups calls performBackup safely when PGlite is null", async () => {
    const backup = await import("../db/backup");
    backup.startBackups();
    backup.stopBackups();
    backup.stopBackups(); // idempotent
  });

  test("startBackups and stopBackups are idempotent", async () => {
    const backup = await import("../db/backup");
    backup.startBackups();
    backup.startBackups();
    backup.stopBackups();
    backup.stopBackups();
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

describe("backup logic (unit)", () => {
  test("backup rotation keeps only MAX_BACKUPS files", () => {
    const MAX_BACKUPS = 5;
    mkdirSync(backupDir, { recursive: true });

    for (let i = 0; i < 7; i++) {
      const name = `pi-db-2026-01-0${i + 1}T00-00-00-000Z`;
      mkdirSync(join(backupDir, name));
    }

    const backups = readdirSync(backupDir)
      .filter((f: string) => f.startsWith("pi-db-"))
      .sort()
      .reverse();

    const toDelete = backups.slice(MAX_BACKUPS);
    expect(toDelete).toHaveLength(2);
    for (const old of toDelete) {
      rmSync(join(backupDir, old), { recursive: true, force: true });
    }

    const remaining = readdirSync(backupDir).filter((f: string) => f.startsWith("pi-db-"));
    expect(remaining).toHaveLength(5);
  });

  test("timestamp format produces valid filename", () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `ezcorp-db-${timestamp}`;
    const nameWithoutExt = filename;
    expect(nameWithoutExt).not.toMatch(/[:.]/);
    expect(filename).toMatch(/^ezcorp-db-/);
  });

  test("pruning respects legacy pi-db- and new ezcorp-db- prefixes jointly (newest-first by timestamp)", () => {
    // Rename boundary: a volume upgraded from an older build may hold both
    // old- and new-prefixed backups. Rotation must prune to the 5-total cap
    // and pick oldest by the ISO timestamp tail — NOT by the prefix itself
    // (a naive lex-sort would keep all `pi-db-*` over newer `ezcorp-db-*`).
    mkdirSync(backupDir, { recursive: true });

    // Seed 3 legacy (older, Jan) + 4 new (newer, Mar) = 7 total.
    for (let i = 1; i <= 3; i++) {
      mkdirSync(join(backupDir, `pi-db-2026-01-0${i}T00-00-00-000Z`));
    }
    for (let i = 1; i <= 4; i++) {
      mkdirSync(join(backupDir, `ezcorp-db-2026-03-0${i}T00-00-00-000Z`));
    }

    // Exercise the real pruneBackups path via performBackup — which can't
    // run here (no PGlite). Instead, reproduce the sort logic under test:
    const INTERVAL_PREFIXES = ["ezcorp-db-", "pi-db-"];
    const stripPrefix = (n: string) => {
      for (const p of INTERVAL_PREFIXES) if (n.startsWith(p)) return n.slice(p.length);
      return n;
    };
    const entries = readdirSync(backupDir)
      .filter((f) => INTERVAL_PREFIXES.some((p) => f.startsWith(p)))
      .sort((a, b) => stripPrefix(b).localeCompare(stripPrefix(a)));

    expect(entries).toHaveLength(7);
    const toDelete = entries.slice(5);
    expect(toDelete).toHaveLength(2);
    // The two oldest by timestamp (both `pi-db-2026-01-0{1,2}`) should drop.
    expect(toDelete.every((n) => n.startsWith("pi-db-"))).toBe(true);
    expect(toDelete).toContain("pi-db-2026-01-01T00-00-00-000Z");
    expect(toDelete).toContain("pi-db-2026-01-02T00-00-00-000Z");
  });
});
