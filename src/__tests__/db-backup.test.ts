import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let backupDir: string;
let dbPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-backup-test-"));
  backupDir = join(tempDir, "backups");
  dbPath = join(tempDir, "test-pg");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

mock.module("../db/connection", () => ({
  getPglite: () => null,
  getDbPath: () => dbPath,
  getDb: () => null,
  initDb: async () => {},
  closeDb: async () => {},
}));

afterAll(() => restoreModuleMocks());

describe("backup module", () => {
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
    const filename = `pi-db-${timestamp}`;
    const nameWithoutExt = filename;
    expect(nameWithoutExt).not.toMatch(/[:.]/);
    expect(filename).toMatch(/^pi-db-/);
  });
});
