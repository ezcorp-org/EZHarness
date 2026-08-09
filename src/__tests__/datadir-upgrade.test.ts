/**
 * The PostgreSQL MAJOR-version guard on the embedded PGlite data directory.
 *
 * The headline test boots the REAL `initDb()` in a subprocess against a
 * PostgreSQL 17 data directory with `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1`
 * set, and proves the boot REFUSES while the directory is left byte-for-byte
 * alone. That ordering lives in `connection.ts`, so nothing short of a real
 * boot proves it — see the describe block for why it is the highest-consequence
 * path in the module.
 *
 * The fixtures are `PG_VERSION` files plus a payload, not real clusters, and
 * that is the point rather than a shortcut: the guard decides from `PG_VERSION`
 * alone and never opens PGlite. Building a genuine PG 17 datadir would require
 * shipping the PG 17 engine, which is the dependency this module exists to have
 * removed.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CURRENT_PG_MAJOR,
  LEGACY_PG_MAJOR,
  assertDatadirCompatible,
  clearStaleLockFiles,
  clearUpgradeMarker,
  markerPathFor,
  readDatadirMajor,
  readUpgradeMarker,
  resolveRecovery,
  type UpgradeMarker,
} from "../db/datadir-upgrade";

const roots: string[] = [];

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ez-datadir-${label}-`));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** Stand up a datadir with a given PG_VERSION but no real cluster behind it. */
function fakeDatadir(path: string, major: string | null): string {
  mkdirSync(path, { recursive: true });
  if (major !== null) writeFileSync(join(path, "PG_VERSION"), `${major}\n`);
  return path;
}

/**
 * A datadir the guard must refuse, carrying a payload file that stands in for
 * the operator's irreplaceable data. Every refusal test asserts the payload is
 * still there afterwards.
 */
function datadirWithPayload(path: string, major: string): string {
  fakeDatadir(path, major);
  writeFileSync(join(path, "payload.txt"), "irreplaceable");
  return path;
}

function payloadIntact(dbPath: string): boolean {
  return readFileSync(join(dbPath, "payload.txt"), "utf8") === "irreplaceable";
}

/**
 * Write the crash marker an OLDER build would have left mid-upgrade.
 *
 * The test writes it by hand rather than calling a helper, because nothing in
 * this build writes one any more — a marker can only ever arrive from a
 * previous image, which is exactly the situation being simulated.
 */
function writeLegacyMarker(dbPath: string, overrides: Partial<UpgradeMarker> = {}): UpgradeMarker {
  const marker: UpgradeMarker = {
    phase: "dumping",
    fromMajor: LEGACY_PG_MAJOR,
    toMajor: CURRENT_PG_MAJOR,
    tmpPath: "/nonexistent/tmp",
    backupPath: "/nonexistent/backup",
    startedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
  mkdirSync(dirname(markerPathFor(dbPath)), { recursive: true });
  writeFileSync(markerPathFor(dbPath), JSON.stringify(marker, null, 2));
  return marker;
}

/** Matches the PG 17 refusal specifically, including its recovery advice. */
const PG17_REFUSAL =
  /written by PostgreSQL 17.*runs PostgreSQL 18.*no longer ships.*HAS NOT BEEN MODIFIED.*17->18 upgrade bridge/s;

/**
 * The highest-consequence path in the module.
 *
 * `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1` (plumbed in `compose.prod.yml`,
 * default unset) renames a failed-open datadir aside and boots EMPTY. PGlite
 * 0.5.4 opening a PG 17 datadir throws a bare "PGlite failed to initialize
 * properly" that never names a version, so if the guard did not run strictly
 * BEFORE `openPglite()` an operator with that flag set would have their
 * database renamed away and replaced with an empty one — by the very check
 * meant to protect them.
 *
 * Asserted by booting the REAL `initDb()` in a subprocess.
 */
describe("an operator with EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1 is refused, never destroyed", () => {
  const root = tmpRoot("auto-destroy");
  const dbPath = join(root, "ezcorp-db");
  let child: {
    ok: boolean;
    initError: string | null;
    corruptedSiblings: string[];
    readinessState: string;
    readinessReason: string | null;
  };

  beforeAll(async () => {
    datadirWithPayload(dbPath, LEGACY_PG_MAJOR);

    const connectionAbs = resolve(import.meta.dir, "..", "db", "connection.ts");
    const readinessAbs = resolve(import.meta.dir, "..", "readiness.ts");
    const driverPath = join(root, "driver.ts");
    writeFileSync(
      driverPath,
      `
      import { readdirSync } from "node:fs";
      import { dirname, basename } from "node:path";
      const result = { ok: false, initError: null, corruptedSiblings: [],
                       readinessState: "", readinessReason: null };
      const { getReadiness } = await import(${JSON.stringify(readinessAbs)});
      try {
        const conn = await import(${JSON.stringify(connectionAbs)});
        await conn.initDb();
        result.ok = true;
        await conn.closeDb();
      } catch (e) {
        result.initError = e instanceof Error ? e.message : String(e);
      }
      const readiness = getReadiness();
      result.readinessState = readiness.state;
      result.readinessReason = readiness.reason ?? null;
      const dbPath = process.env.EZCORP_DB_PATH;
      const names = readdirSync(dirname(dbPath));
      result.corruptedSiblings = names.filter((n) => n.startsWith(basename(dbPath) + ".corrupted."));
      process.stdout.write("\\n__BEGIN__" + JSON.stringify(result) + "__END__\\n");
      process.exit(0);
      `,
    );

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      EZCORP_DB_PATH: dbPath,
      EZCORP_BACKUP_DIR: join(root, "backups"),
      // The flag that makes this path dangerous.
      EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE: "1",
    };
    delete env.DATABASE_URL;
    delete env.EZCORP_IMAGE_SHA;

    const proc = Bun.spawnSync(["bun", driverPath], { env, stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(proc.stdout);
    const body = out.split("__BEGIN__")[1]?.split("__END__")[0];
    if (!body) {
      throw new Error(
        `child produced no result. stderr: ${new TextDecoder().decode(proc.stderr).slice(-2000)}`,
      );
    }
    child = JSON.parse(body);
  });

  test("the boot refuses, and the error names the version rather than being anonymous", () => {
    expect(child.ok).toBe(false);
    expect(child.initError).toMatch(PG17_REFUSAL);
    // The failure PGlite itself would have produced, had the guard run late.
    expect(child.initError).not.toMatch(/failed to initialize properly/);
  });

  test("the datadir is NOT renamed aside and no empty database is substituted", () => {
    expect(child.corruptedSiblings).toEqual([]);
    expect(readdirSync(root)).toContain("ezcorp-db");
  });

  test("the data directory is left exactly as it was", () => {
    expect(readDatadirMajor(dbPath)).toBe(LEGACY_PG_MAJOR);
    expect(payloadIntact(dbPath)).toBe(true);
  });

  test("readiness explains the refusal instead of crash-looping mute", () => {
    expect(child.readinessState).toBe("degraded");
    expect(child.readinessReason).toBe("datadir-incompatible");
  });
});

/**
 * The readiness half of the refusal, driven IN THIS PROCESS.
 *
 * The subprocess above proves the boot ORDERING; this proves what an operator
 * sees on `/api/ready` while it is refused, and it runs where the coverage
 * instrumentation can see it (a child process is not instrumented). It calls
 * `guardDatadirMajor` rather than `initDb` because the test preload freezes
 * `connection.ts`'s `DB_PATH` before any test file runs — the parameter is the
 * only way to point it at a datadir of a chosen major.
 */
describe("the refusal is reported on /api/ready, not just thrown", () => {
  const root = tmpRoot("readiness");
  const dbPath = join(root, "ezcorp-db");
  let guardError: Error | undefined;
  let readiness: { state: string; reason?: string; detail?: unknown };

  beforeAll(async () => {
    datadirWithPayload(dbPath, LEGACY_PG_MAJOR);
    const { guardDatadirMajor } = await import("../db/connection");
    const { getReadiness } = await import("../readiness");
    await guardDatadirMajor(dbPath).catch((e: Error) => {
      guardError = e;
    });
    readiness = getReadiness();
  });

  afterAll(async () => {
    // The readiness singleton is process-wide; don't leak "degraded" onwards.
    const { resetReadiness } = await import("../readiness");
    resetReadiness();
  });

  test("the guard rethrows the version-naming refusal", () => {
    expect(guardError).toBeDefined();
    expect(guardError?.message).toMatch(PG17_REFUSAL);
  });

  test("readiness is degraded with a reason an operator can act on", () => {
    expect(readiness.state).toBe("degraded");
    expect(readiness.reason).toBe("datadir-incompatible");
    expect(readiness.detail).toMatchObject({ dbPath, expectedPgMajor: CURRENT_PG_MAJOR });
  });

  test("a compatible datadir passes the guard and leaves readiness alone", async () => {
    const { guardDatadirMajor } = await import("../db/connection");
    const { getReadiness, resetReadiness } = await import("../readiness");
    resetReadiness();
    const current = fakeDatadir(join(root, "current-db"), CURRENT_PG_MAJOR);

    await expect(guardDatadirMajor(current)).resolves.toBeUndefined();

    expect(getReadiness().state).toBe("booting");
  });
});

describe("when there is nothing to do", () => {
  test("a fresh install with no datadir is a no-op", async () => {
    const root = tmpRoot("fresh");
    const outcome = await assertDatadirCompatible(join(root, "ezcorp-db"));
    expect(outcome.action).toBe("none-fresh-install");
  });

  test("a directory with no PG_VERSION is treated as a fresh install", async () => {
    const root = tmpRoot("empty");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), null);
    const outcome = await assertDatadirCompatible(dbPath);
    expect(outcome.action).toBe("none-fresh-install");
  });

  test("a blank PG_VERSION reads as absent rather than as a version", () => {
    const root = tmpRoot("blank");
    const dbPath = join(root, "ezcorp-db");
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dbPath, "PG_VERSION"), "  \n");
    expect(readDatadirMajor(dbPath)).toBeUndefined();
  });

  test("a CORRUPT PG_VERSION is left to the open-failure path, not refused here", async () => {
    // `connection.ts` owns corrupt datadirs — recovery marker, operator hints
    // and the EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE escape hatch. If this module
    // claimed them as "some other major" it would refuse first and disable all
    // of that. Pinned because db-corruption-catch.unit.test.ts depends on it.
    const root = tmpRoot("corrupt");
    for (const [label, bytes] of [
      ["nul", "\0"],
      ["truncated", "1"],
      ["garbage", "not-a-version"],
      ["two-part", "9.6"],
    ] as const) {
      const dbPath = join(root, label);
      mkdirSync(dbPath, { recursive: true });
      writeFileSync(join(dbPath, "PG_VERSION"), bytes);
      // "1" is a plain integer, so it IS a version — just not one we support.
      if (label === "truncated") {
        expect(readDatadirMajor(dbPath)).toBe("1");
        continue;
      }
      expect(readDatadirMajor(dbPath)).toBeUndefined();
      await expect(assertDatadirCompatible(dbPath)).resolves.toEqual({
        action: "none-fresh-install",
      });
    }
  });

  test("an already-current datadir is a no-op", async () => {
    const root = tmpRoot("current");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), CURRENT_PG_MAJOR);
    const outcome = await assertDatadirCompatible(dbPath);
    expect(outcome.action).toBe("none-already-current");
  });
});

describe("refusing a datadir this build cannot open", () => {
  test("a PostgreSQL 17 datadir gets its own message, and is not touched", async () => {
    const root = tmpRoot("pg17");
    const dbPath = datadirWithPayload(join(root, "ezcorp-db"), LEGACY_PG_MAJOR);

    await expect(assertDatadirCompatible(dbPath)).rejects.toThrow(PG17_REFUSAL);

    expect(readDatadirMajor(dbPath)).toBe(LEGACY_PG_MAJOR);
    expect(payloadIntact(dbPath)).toBe(true);
    // No staging, no backup, no marker: the guard never creates anything.
    expect(readdirSync(root)).toEqual(["ezcorp-db"]);
  });

  test("any other major gets the generic message, without the bridge advice", async () => {
    const root = tmpRoot("pg16");
    const dbPath = datadirWithPayload(join(root, "ezcorp-db"), "16");

    const error = await assertDatadirCompatible(dbPath).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /written by PostgreSQL 16.*runs PostgreSQL 18.*HAS NOT BEEN MODIFIED/s,
    );
    // Telling a PG 16 operator to run the 17->18 bridge would be wrong: no
    // build ever converted 16, so that advice belongs to the 17 message only.
    expect((error as Error).message).not.toContain("bridge");

    expect(readDatadirMajor(dbPath)).toBe("16");
    expect(payloadIntact(dbPath)).toBe(true);
  });

  test("an unresolvable interrupted upgrade is refused rather than guessed at", async () => {
    const root = tmpRoot("unresolvable");
    const dbPath = join(root, "ezcorp-db");
    // No live datadir, no usable staging, no backup — nothing provable.
    writeLegacyMarker(dbPath, { phase: "swapping" });
    await expect(assertDatadirCompatible(dbPath)).rejects.toThrow(/cannot be resolved safely/);
    // The marker survives a refusal so the operator can see the state.
    expect(readUpgradeMarker(dbPath)).not.toBeNull();
  });
});

describe("resolveRecovery decides from PG_VERSION, never from mere existence", () => {
  test("an empty directory left by mkdir does not read as a completed swap", () => {
    const root = tmpRoot("mkdir-race");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), null);
    const tmpPath = fakeDatadir(join(root, "staging"), CURRENT_PG_MAJOR);
    const backup = fakeDatadir(join(root, "backup"), LEGACY_PG_MAJOR);
    const marker = writeLegacyMarker(dbPath, { tmpPath, backupPath: backup });
    expect(resolveRecovery(dbPath, marker)).toEqual({ kind: "finish-swap" });
  });

  test("a live PG 18 datadir means the swap already completed", () => {
    const root = tmpRoot("done");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), CURRENT_PG_MAJOR);
    expect(resolveRecovery(dbPath, writeLegacyMarker(dbPath))).toEqual({ kind: "clear-marker" });
  });

  test("a live PG 17 datadir means no rename happened", () => {
    const root = tmpRoot("retry");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), LEGACY_PG_MAJOR);
    expect(resolveRecovery(dbPath, writeLegacyMarker(dbPath))).toEqual({ kind: "retry" });
  });

  test("no live datadir and unusable staging falls back to the backup", () => {
    const root = tmpRoot("rollback");
    const dbPath = join(root, "ezcorp-db");
    const backup = fakeDatadir(join(root, "backup"), LEGACY_PG_MAJOR);
    const marker = writeLegacyMarker(dbPath, { backupPath: backup });
    expect(resolveRecovery(dbPath, marker)).toEqual({ kind: "roll-back" });
  });

  test("nothing on disk at all is unprovable and refuses", () => {
    const root = tmpRoot("nothing");
    const dbPath = join(root, "ezcorp-db");
    const plan = resolveRecovery(dbPath, writeLegacyMarker(dbPath));
    expect(plan.kind).toBe("refuse");
    expect(plan).toHaveProperty("reason", "live=absent tmp=absent backup=absent");
  });
});

/**
 * The recovery arms are pure `rename(2)` and `rm`, so they need no PostgreSQL
 * engine of any major and outlive the upgrade they were written for. They are
 * the difference between an interrupted upgrade being repaired and the operator
 * booting into an empty app with their database stranded in a sibling dir.
 */
describe("crash recovery of an upgrade an older build did not finish", () => {
  test("a crash after both renames just clears the marker and the staging dir", async () => {
    const root = tmpRoot("rec-cleared");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), CURRENT_PG_MAJOR);
    const tmpPath = fakeDatadir(join(root, "staging"), CURRENT_PG_MAJOR);
    const backup = fakeDatadir(join(root, "backup"), LEGACY_PG_MAJOR);
    writeLegacyMarker(dbPath, { phase: "swapping", tmpPath, backupPath: backup });

    const outcome = await assertDatadirCompatible(dbPath);

    expect(outcome.action).toBe("recovered-cleared-marker");
    expect(outcome.backupPath).toBe(backup);
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(markerPathFor(dbPath))).toBe(false);
    expect(readDatadirMajor(dbPath)).toBe(CURRENT_PG_MAJOR);
  });

  test("a crash BETWEEN the two renames completes the swap and boots", async () => {
    const root = tmpRoot("rec-finish");
    const dbPath = join(root, "ezcorp-db");
    // Exactly the mid-swap state: live gone, staging built, backup holding the
    // original. Plus the empty dir a racing mkdir would leave.
    mkdirSync(dbPath, { recursive: true });
    const tmpPath = fakeDatadir(join(root, "staging"), CURRENT_PG_MAJOR);
    writeFileSync(join(tmpPath, "marker.txt"), "the upgraded one");
    const backup = fakeDatadir(join(root, "backup"), LEGACY_PG_MAJOR);
    writeLegacyMarker(dbPath, { phase: "swapping", tmpPath, backupPath: backup });

    const outcome = await assertDatadirCompatible(dbPath);

    expect(outcome.action).toBe("recovered-completed-swap");
    expect(outcome.backupPath).toBe(backup);
    expect(readDatadirMajor(dbPath)).toBe(CURRENT_PG_MAJOR);
    // The live datadir is the STAGED one, not the empty placeholder.
    expect(readFileSync(join(dbPath, "marker.txt"), "utf8")).toBe("the upgraded one");
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(markerPathFor(dbPath))).toBe(false);
  });

  test("a crash between the renames with unusable staging rolls back, then refuses", async () => {
    const root = tmpRoot("rec-rollback");
    const dbPath = join(root, "ezcorp-db");
    const tmpPath = fakeDatadir(join(root, "staging"), null); // half-written, no PG_VERSION
    const backup = datadirWithPayload(join(root, "backup"), LEGACY_PG_MAJOR);
    writeLegacyMarker(dbPath, { phase: "swapping", tmpPath, backupPath: backup });

    // The rollback restores the PRE-upgrade datadir, which is by definition the
    // one this build cannot open — so it must NOT report success and hand a PG
    // 17 directory to openPglite().
    await expect(assertDatadirCompatible(dbPath)).rejects.toThrow(PG17_REFUSAL);

    // ...but the rollback itself still happened, so the operator's data is back
    // at the canonical path instead of stranded in a sibling.
    expect(readDatadirMajor(dbPath)).toBe(LEGACY_PG_MAJOR);
    expect(payloadIntact(dbPath)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(markerPathFor(dbPath))).toBe(false);
  });

  test("a crash before any rename clears the leftovers, then refuses", async () => {
    const root = tmpRoot("rec-retry");
    const dbPath = datadirWithPayload(join(root, "ezcorp-db"), LEGACY_PG_MAJOR);
    const staleTmp = fakeDatadir(join(root, "staging"), null);
    writeFileSync(join(staleTmp, "junk.txt"), "leftovers from the crashed attempt");
    writeLegacyMarker(dbPath, { phase: "dumping", tmpPath: staleTmp });

    // Nothing was ever renamed, so the live datadir is the untouched original:
    // a PG 17 one, which this build refuses.
    await expect(assertDatadirCompatible(dbPath)).rejects.toThrow(PG17_REFUSAL);

    // The crashed attempt's staging and marker are gone, so the next boot sees
    // a plain PG 17 datadir and gives the same clean answer.
    expect(existsSync(staleTmp)).toBe(false);
    expect(existsSync(markerPathFor(dbPath))).toBe(false);
    expect(readDatadirMajor(dbPath)).toBe(LEGACY_PG_MAJOR);
    expect(payloadIntact(dbPath)).toBe(true);
  });
});

describe("the crash marker", () => {
  test("reads back what an older build wrote, and clearing is idempotent", () => {
    const root = tmpRoot("marker");
    const dbPath = join(root, "ezcorp-db");
    const written = writeLegacyMarker(dbPath, { phase: "swapping" });
    expect(readUpgradeMarker(dbPath)).toEqual(written);

    clearUpgradeMarker(dbPath);
    expect(readUpgradeMarker(dbPath)).toBeNull();
    // Clearing again must not throw — recovery paths call it unconditionally.
    clearUpgradeMarker(dbPath);
    expect(readUpgradeMarker(dbPath)).toBeNull();
  });

  test("a marker truncated by a crash mid-write reads as no marker", () => {
    const root = tmpRoot("marker-corrupt");
    const dbPath = join(root, "ezcorp-db");
    writeFileSync(markerPathFor(dbPath), '{"phase":"swap');
    expect(readUpgradeMarker(dbPath)).toBeNull();
  });

  test("lives beside the datadir, so a rename of the datadir cannot move it", () => {
    const dbPath = "/data/ezcorp-db";
    expect(markerPathFor(dbPath)).toBe("/data/.ezcorp-datadir-upgrade.json");
    expect(markerPathFor(dbPath).startsWith(`${dbPath}/`)).toBe(false);
  });
});

describe("clearStaleLockFiles", () => {
  test("removes both lock files a SIGKILLed engine leaves behind", () => {
    const root = tmpRoot("locks");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), CURRENT_PG_MAJOR);
    writeFileSync(join(dbPath, "postmaster.pid"), "123");
    writeFileSync(join(dbPath, "postmaster.opts"), "opts");

    clearStaleLockFiles(dbPath);

    expect(existsSync(join(dbPath, "postmaster.pid"))).toBe(false);
    expect(existsSync(join(dbPath, "postmaster.opts"))).toBe(false);
    // Real data is untouched.
    expect(readDatadirMajor(dbPath)).toBe(CURRENT_PG_MAJOR);
  });

  test("a missing datadir and a clean one are both no-ops", () => {
    const root = tmpRoot("locks-none");
    clearStaleLockFiles(join(root, "absent"));
    const clean = fakeDatadir(join(root, "clean"), CURRENT_PG_MAJOR);
    clearStaleLockFiles(clean);
    expect(readDatadirMajor(clean)).toBe(CURRENT_PG_MAJOR);
  });

  test("an unremovable lock file is survivable — boot is not blocked by it", () => {
    const root = tmpRoot("locks-stuck");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), CURRENT_PG_MAJOR);
    // A directory at the lock path makes unlinkSync throw EISDIR/EPERM.
    mkdirSync(join(dbPath, "postmaster.pid"), { recursive: true });
    writeFileSync(join(dbPath, "postmaster.opts"), "opts");

    expect(() => clearStaleLockFiles(dbPath)).not.toThrow();
    // The removable one still went.
    expect(existsSync(join(dbPath, "postmaster.opts"))).toBe(false);
  });
});
