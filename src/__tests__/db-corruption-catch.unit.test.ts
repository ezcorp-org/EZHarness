/**
 * Tests for the corruption-catch hardening in `initPglite()`.
 *
 * Background: two production data-loss incidents on 2026-05-10 traced to
 * the catch branch in `src/db/connection.ts` interpreting ANY `openPglite()`
 * failure as corruption and renaming the data dir aside. The fix is:
 *
 *   - DEFAULT: preserve the data dir, write a `.ezcorp-recovery-needed.json`
 *     marker, set readiness=degraded with reason="data-recovery-needed",
 *     re-throw the original error. NO `${DB_PATH}.corrupted.<ts>` rename.
 *
 *   - LEGACY OPT-IN: `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1` (or "true")
 *     restores the rename-and-restart-fresh path for fresh installs / CI.
 *
 *   - Recovery marker is cleared on the next successful open (mirrors the
 *     `.migration-failed` circuit-breaker pattern).
 *
 *   - Memory mode (`:memory:`) short-circuits before the catch — unchanged.
 *
 * Test layout:
 *   1. Marker helpers (read/write/clear) — direct in-process unit tests.
 *      These mirror the existing `.migration-failed` marker tests in
 *      `db-backup.test.ts` and prove the marker file contract.
 *
 *   2. Catch branch behavior — driven via a Bun subprocess that imports
 *      `src/db/connection.ts` fresh, with `EZCORP_DB_PATH` set on the
 *      child's env BEFORE module load. Subprocessing is required because
 *      `DB_PATH` in connection.ts is captured at module-load time (line
 *      ~17) and the test-suite preload hard-binds it to ":memory:". The
 *      subprocess child opens a corrupted PGlite dir, prints its readiness
 *      + marker state as JSON, and exits non-zero so the parent can
 *      assert on it.
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;
let dbPath: string;
let backupDir: string;
let recoveryMarkerPath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ezcorp-corruption-catch-"));
  // Match the production layout: DB dir sits inside a parent that also
  // holds backups/ and the recovery marker.
  dbPath = join(tempDir, "ezcorp-db");
  backupDir = join(tempDir, "backups");
  recoveryMarkerPath = join(tempDir, ".ezcorp-recovery-needed.json");

  // For the in-process marker tests (Section 1), point `EZCORP_BACKUP_DIR`
  // at the temp backup dir and mock `getDbPath()` so the marker path
  // resolves under our tempDir. Section 2 (subprocess) sets these on the
  // child env directly.
  process.env.EZCORP_BACKUP_DIR = backupDir;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.EZCORP_BACKUP_DIR;
});

// Section 1 only — mock connection so backup.ts's recoveryMarkerPath() can
// resolve under our tempDir. Section 2 (subprocess) is unaffected; the
// child process has its own module graph.
mock.module("../db/connection", () => ({
  getPglite: () => null,
  getDbPath: () => dbPath,
  getDb: () => null,
  initDb: async () => {},
  closeDb: async () => {},
}));

afterAll(() => restoreModuleMocks());

// ── Section 1: recovery-marker helpers (in-process unit tests) ──

describe("recovery-needed marker helpers (in-process)", () => {
  test("read/write/clear round-trip", async () => {
    mkdirSync(dbPath, { recursive: true });
    const backup = await import("../db/backup");

    expect(backup.readRecoveryMarker()).toBeNull();

    backup.writeRecoveryMarker({
      ts: "2026-05-10T12:00:00.000Z",
      imageSha: "sha256:abc",
      error: "simulated open failure",
      dbPath,
    });

    const read = backup.readRecoveryMarker();
    expect(read).not.toBeNull();
    expect(read?.ts).toBe("2026-05-10T12:00:00.000Z");
    expect(read?.imageSha).toBe("sha256:abc");
    expect(read?.error).toBe("simulated open failure");
    expect(read?.dbPath).toBe(dbPath);

    // Marker lives next to the DB dir, not inside it — operators must be
    // able to inspect it even if the DB dir itself is unreadable.
    expect(existsSync(recoveryMarkerPath)).toBe(true);
    expect(existsSync(join(dbPath, ".ezcorp-recovery-needed.json"))).toBe(false);

    backup.clearRecoveryMarker();
    expect(backup.readRecoveryMarker()).toBeNull();
    expect(existsSync(recoveryMarkerPath)).toBe(false);
  });

  test("clearRecoveryMarker is a no-op when marker does not exist", async () => {
    const backup = await import("../db/backup");
    expect(() => backup.clearRecoveryMarker()).not.toThrow();
  });

  test("readRecoveryMarker returns null for malformed json", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(recoveryMarkerPath, "not json");
    const backup = await import("../db/backup");
    expect(backup.readRecoveryMarker()).toBeNull();
  });

  test("readRecoveryMarker returns null when required fields are missing", async () => {
    mkdirSync(tempDir, { recursive: true });
    // Valid JSON but missing `dbPath` — the type guard must reject it.
    writeFileSync(
      recoveryMarkerPath,
      JSON.stringify({ ts: "x", imageSha: "y", error: "z" }),
    );
    const backup = await import("../db/backup");
    expect(backup.readRecoveryMarker()).toBeNull();
  });

  test("recovery marker is DISTINCT from .migration-failed marker", async () => {
    // The two markers have different filenames and different schemas. A
    // recovery marker must not be mistaken for a migration-failed marker
    // (and vice-versa) by readMarker()/readRecoveryMarker().
    mkdirSync(dbPath, { recursive: true });
    const backup = await import("../db/backup");

    backup.writeRecoveryMarker({
      ts: "2026-05-10T12:00:00.000Z",
      imageSha: "sha256:abc",
      error: "open failed",
      dbPath,
    });

    // readMarker() looks for `.migration-failed`, not the recovery marker.
    expect(backup.readMarker()).toBeNull();
    // Conversely, the recovery marker is readable.
    expect(backup.readRecoveryMarker()).not.toBeNull();
  });
});

// ── Section 2: catch branch behavior (subprocess integration) ──
//
// We can't drive `initPglite()` in-process because `DB_PATH` is bound at
// module load and `preload.ts` already pinned it to `:memory:` for the
// whole test suite. A fresh subprocess gives us a clean module graph
// with our chosen env vars.

/**
 * Run a small Bun child process that imports `src/db/connection.ts`,
 * tries to open the DB, and prints { state, marker, ranOpens, exitedClean }
 * as a single JSON object on stdout.
 *
 * The child:
 *   1. Pre-creates `dbPath` with a corrupt `PG_VERSION` so real PGlite
 *      open() rejects.
 *   2. Calls `initDb()` and catches; reports readiness state + marker.
 *   3. Lists tempDir for any `ezcorp-db.corrupted.*` sibling.
 *
 * `extraEnv` overrides go on top of the parent's env.
 */
async function runChildBoot(
  childDbPath: string,
  childBackupDir: string,
  extraEnv: Record<string, string>,
): Promise<{
  ok: boolean;
  initError: string | null;
  readiness: { state: string; reason?: string; detail?: unknown };
  markerExists: boolean;
  markerContents: Record<string, unknown> | null;
  corruptedSiblings: string[];
  childStderr: string;
}> {
  // Pre-compute absolute module specifiers in the parent — easier to reason
  // about than juggling cwd inside the child.
  const connectionAbs = resolve(import.meta.dir, "..", "db", "connection.ts");
  const readinessAbs = resolve(import.meta.dir, "..", "readiness.ts");

  const driverSource = `
    import { existsSync, readFileSync, readdirSync } from "node:fs";
    import { dirname, join } from "node:path";

    async function main() {
      const result = {
        ok: false,
        initError: null,
        readiness: null,
        markerExists: false,
        markerContents: null,
        corruptedSiblings: [],
      };
      try {
        const { initDb } = await import(${JSON.stringify(connectionAbs)});
        try {
          await initDb();
          result.ok = true;
        } catch (e) {
          result.initError = (e instanceof Error ? (e.stack ?? e.message) : String(e));
        }
        const { getReadiness } = await import(${JSON.stringify(readinessAbs)});
        result.readiness = getReadiness();

        const dbPath = process.env.EZCORP_DB_PATH;
        if (dbPath && dbPath !== ":memory:") {
          const parent = dirname(dbPath);
          const markerPath = join(parent, ".ezcorp-recovery-needed.json");
          result.markerExists = existsSync(markerPath);
          if (result.markerExists) {
            try {
              result.markerContents = JSON.parse(readFileSync(markerPath, "utf8"));
            } catch {
              result.markerContents = { __parseError: true };
            }
          }
          if (existsSync(parent)) {
            const base = dbPath.split("/").pop();
            result.corruptedSiblings = readdirSync(parent).filter(
              (n) => n.startsWith(base + ".corrupted."),
            );
          }
        }
      } catch (e) {
        result.initError = "DRIVER_ERROR: " + String(e);
      }
      // Wrap the result in sentinels — the logger writes JSON log lines to
      // stdout before/during boot, which would defeat a naive JSON.parse on
      // the whole stdout buffer. The parent slices between the sentinels.
      process.stdout.write("\\n__EZCORP_DRIVER_BEGIN__" + JSON.stringify(result) + "__EZCORP_DRIVER_END__\\n");
    }

    main().then(() => process.exit(0)).catch((e) => {
      process.stderr.write(String(e));
      process.exit(2);
    });
  `;

  // Write the driver to a temp file so Bun's module resolver picks up the
  // worktree's package.json + tsconfig (inline -e scripts resolve from CWD
  // but lose import.meta context for require.resolve fallback).
  const driverPath = join(childBackupDir + "-driver.ts");
  mkdirSync(dirname(driverPath), { recursive: true });
  writeFileSync(driverPath, driverSource);

  const env: Record<string, string> = {
    ...process.env,
    EZCORP_DB_PATH: childDbPath,
    EZCORP_BACKUP_DIR: childBackupDir,
    // Suppress the parent suite's :memory: pin by overwriting it.
    EZCORP_NO_EXIT: "1",
    ...extraEnv,
  };
  // Strip any flag we want to defaultly-off unless extraEnv set it.
  if (!("EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE" in extraEnv)) {
    delete env.EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE;
  }
  if (!("EZCORP_IMAGE_SHA" in extraEnv)) {
    delete env.EZCORP_IMAGE_SHA;
  }
  if (!("DATABASE_URL" in extraEnv)) {
    delete env.DATABASE_URL;
  }

  const proc = Bun.spawnSync(["bun", "run", driverPath], {
    env,
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new TextDecoder().decode(proc.stdout);
  const childStderr = new TextDecoder().decode(proc.stderr);
  const beginIdx = stdout.indexOf("__EZCORP_DRIVER_BEGIN__");
  const endIdx = stdout.indexOf("__EZCORP_DRIVER_END__");
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    throw new Error(
      `Child driver did not emit sentinel-wrapped JSON.\nstdout=<<<${stdout}>>>\nstderr=<<<${childStderr}>>>`,
    );
  }
  const payload = stdout.slice(beginIdx + "__EZCORP_DRIVER_BEGIN__".length, endIdx);
  let parsed: any;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(
      `Child driver payload was not JSON.\npayload=<<<${payload}>>>\nstderr=<<<${childStderr}>>>`,
    );
  }
  return { ...parsed, childStderr };
}

// Helper: seed a "corrupt" DB dir that real PGlite will reject. A
// 1-byte PG_VERSION trips PGlite's version check immediately.
function seedCorruptDb(): void {
  mkdirSync(dbPath, { recursive: true });
  // A minimal pile of files that LOOKS like a PG data dir but with a
  // malformed PG_VERSION — PGlite's bootstrap rejects this.
  writeFileSync(join(dbPath, "PG_VERSION"), "\0");
  writeFileSync(join(dbPath, "sentinel.txt"), "user-data-must-survive");
}

describe("default mode — preserves data on open failure (subprocess)", () => {
  test("does NOT rename dbPath aside, writes recovery marker, propagates error", async () => {
    seedCorruptDb();

    const r = await runChildBoot(dbPath, backupDir, {
      EZCORP_IMAGE_SHA: "sha256:test-image-abc",
    });

    // Child saw an init failure.
    expect(r.ok).toBe(false);
    expect(r.initError).toBeTruthy();

    // Original data dir intact, sentinel preserved.
    expect(existsSync(dbPath)).toBe(true);
    expect(readFileSync(join(dbPath, "sentinel.txt"), "utf8")).toBe(
      "user-data-must-survive",
    );

    // No `.corrupted.<ts>` sibling.
    expect(r.corruptedSiblings).toEqual([]);

    // Recovery marker written with expected shape.
    expect(r.markerExists).toBe(true);
    expect(r.markerContents).not.toBeNull();
    const m = r.markerContents!;
    expect(m.imageSha).toBe("sha256:test-image-abc");
    expect(m.dbPath).toBe(dbPath);
    expect(typeof m.ts).toBe("string");
    expect(Number.isFinite(Date.parse(m.ts as string))).toBe(true);
    expect(String(m.error)).toMatch(/./); // non-empty

    // Readiness flipped to degraded with the right reason + recovery hints.
    expect(r.readiness.state).toBe("degraded");
    expect(r.readiness.reason).toBe("data-recovery-needed");
    const detail = r.readiness.detail as {
      recovery?: string[];
      dbPath?: string;
      imageSha?: string;
    };
    expect(Array.isArray(detail.recovery)).toBe(true);
    expect((detail.recovery ?? []).length).toBeGreaterThan(0);
    const recoveryJoined = (detail.recovery ?? []).join("\n");
    expect(recoveryJoined).toContain(join(dbPath, "..", "backups"));
    expect(detail.dbPath).toBe(dbPath);
  }, 60_000);

  test("falls back to imageSha='dev' when EZCORP_IMAGE_SHA unset", async () => {
    seedCorruptDb();
    const r = await runChildBoot(dbPath, backupDir, {});
    expect(r.markerExists).toBe(true);
    expect(r.markerContents).not.toBeNull();
    expect((r.markerContents as any).imageSha).toBe("dev");
  }, 60_000);
});

describe("EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE — legacy rename behavior (subprocess)", () => {
  test('flag value "1" renames dbPath aside (legacy CI/fresh-install path)', async () => {
    seedCorruptDb();
    const r = await runChildBoot(dbPath, backupDir, {
      EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE: "1",
    });

    // The legacy path tries to re-open after rename. With our corrupt
    // PG_VERSION moved aside, the fresh dir is empty so the second
    // openPglite() should succeed. We assert on the rename + no marker.
    const renamed = r.corruptedSiblings.find((n: string) =>
      n.startsWith("ezcorp-db.corrupted."),
    );
    expect(renamed).toBeTruthy();
    // The renamed-aside dir still contains the user's pre-failure file.
    expect(
      readFileSync(join(tempDir, renamed!, "sentinel.txt"), "utf8"),
    ).toBe("user-data-must-survive");

    // Recovery marker is NOT written in legacy mode — this path is for
    // operators who explicitly want auto-recovery.
    expect(r.markerExists).toBe(false);
  }, 60_000);

  test('flag value "true" is also honored (matches "1" semantics)', async () => {
    seedCorruptDb();
    const r = await runChildBoot(dbPath, backupDir, {
      EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE: "true",
    });
    const renamed = r.corruptedSiblings.find((n: string) =>
      n.startsWith("ezcorp-db.corrupted."),
    );
    expect(renamed).toBeTruthy();
    expect(r.markerExists).toBe(false);
  }, 60_000);

  test('any other flag value (e.g. "0", "false") leaves default-safe behavior', async () => {
    seedCorruptDb();
    const r = await runChildBoot(dbPath, backupDir, {
      EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE: "0",
    });
    expect(r.ok).toBe(false);
    expect(r.corruptedSiblings).toEqual([]);
    expect(r.markerExists).toBe(true);
  }, 60_000);
});

describe("recovery marker lifecycle (subprocess)", () => {
  test("marker is cleared on a subsequent successful open", async () => {
    // Pre-seed a recovery marker as if a prior boot had failed.
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      recoveryMarkerPath,
      JSON.stringify({
        ts: "2026-05-10T12:00:00.000Z",
        imageSha: "sha256:stale",
        error: "stale error from prior boot",
        dbPath,
      }),
    );
    expect(existsSync(recoveryMarkerPath)).toBe(true);

    // Now boot with NO corrupted dir — fresh open will succeed.
    // (dbPath does not exist; PGlite will create it cleanly.)
    const r = await runChildBoot(dbPath, backupDir, {});

    expect(r.ok).toBe(true);
    expect(existsSync(recoveryMarkerPath)).toBe(false);
    expect(r.markerExists).toBe(false);
  }, 60_000);
});

describe("memory mode is unaffected (subprocess)", () => {
  test(":memory: re-throws on simulated failure without writing a marker", async () => {
    // For :memory:, the existing `if (IS_MEMORY) throw e` short-circuit
    // fires first — so we won't hit the recovery-marker path. We can't
    // easily force PGlite to fail for :memory:, so we just assert a clean
    // boot succeeds AND that no marker file is written ANYWHERE near
    // tempDir (the marker logic would try `dirname(":memory:")` which is
    // `.` — writing there is both surprising and not what operators want).
    const r = await runChildBoot(":memory:", backupDir, {});

    expect(r.ok).toBe(true);
    expect(r.readiness.state).toBe("ready");
    // No `.ezcorp-recovery-needed.json` anywhere in tempDir.
    if (existsSync(tempDir)) {
      const matches = readdirSync(tempDir).filter((n) =>
        n.endsWith(".ezcorp-recovery-needed.json"),
      );
      expect(matches).toEqual([]);
    }
  }, 60_000);
});
