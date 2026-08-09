/**
 * PostgreSQL MAJOR-version guard for the embedded PGlite data directory.
 *
 * ## Why this exists
 *
 * PGlite bundles a whole Postgres build, so bumping PGlite can bump Postgres:
 * `@electric-sql/pglite` 0.3.16 shipped **PostgreSQL 17.5**, 0.5.4 ships
 * **PostgreSQL 18.3**. Postgres data directories are never compatible across
 * majors — that is core Postgres behaviour, not a PGlite quirk — so a datadir
 * written by 0.3.x makes 0.5.x abort at startup:
 *
 * ```
 * FATAL:  database files are incompatible with server
 * DETAIL: The data directory was initialized by PostgreSQL version 17,
 *         which is not compatible with this version 18.3.
 * ```
 *
 * PGlite swallows that FATAL unless `debug` is on, so all the caller actually
 * sees is `Error: PGlite failed to initialize properly` — a message that never
 * names a version. `connection.ts` catches exactly that, and under
 * `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1` it renames the datadir aside and
 * boots an EMPTY database. So the major is decided HERE, from the datadir's own
 * `PG_VERSION` file and strictly BEFORE `openPglite()`: a mismatch has to be a
 * loud refusal that names the version, never an anonymous open failure.
 *
 * ## What this module no longer does
 *
 * It used to carry a real PG 17 -> 18 upgrade — a logical dump under a second
 * bundled engine (`@electric-sql/pglite-legacy`, an alias of 0.3.16, plus
 * `@electric-sql/pglite-tools` for `pgDump`) and a restore under the new one.
 * Both engines are gone, and with them ~24 MB of runtime image. A PG 17 datadir
 * is now REFUSED rather than converted. The file keeps its name because what
 * survives here is the recovery half of that upgrade.
 *
 * ## The crash-recovery state machine survives, and has to
 *
 * An older build could be interrupted mid-swap, and this build still has to
 * clean that up. Every one of its steps is a pure `rename(2)` or `rm`, so it
 * needs no Postgres engine of any major — which is exactly why it outlives the
 * upgrade it belonged to. The paths an interrupted run may have left:
 *
 * ```
 *   <db>                              live datadir
 *   <db>.pg-upgrade-tmp               staging (its real path is in the marker)
 *   <db>.pg17-backup.<ts>             the pre-upgrade original (ditto)
 *   ../.ezcorp-datadir-upgrade.json   crash marker (sibling — survives renames)
 * ```
 *
 * `resolveRecovery()` reads the on-disk `PG_VERSION` of each path — never mere
 * directory existence, because `initPglite` may have `mkdir`ed an empty one —
 * and decides deterministically:
 *
 * | live | tmp | backup | meaning | action |
 * |---|---|---|---|---|
 * | 18 | — | — | swap completed | clear marker |
 * | 17 | — | — | crashed before any rename; original intact | clear up, then refuse |
 * | absent | 18 | 17 | crashed BETWEEN the renames | finish the swap |
 * | absent | not 18 | 17 | crashed between renames, staging unusable | roll back, then refuse |
 * | anything else | | | unprovable | refuse loudly |
 *
 * Deleting this would be silent data loss, not dead-code cleanup. In the
 * `finish-swap` state the live datadir is ABSENT: `connection.ts` would `mkdir`
 * an empty one, PGlite would bootstrap a fresh cluster, `migrate()` would run,
 * and the operator would boot into an empty app with their real database
 * sitting in a sibling directory nobody thinks to look at.
 */
import { existsSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logger";

const log = logger.child("db");

/** Postgres major shipped by the PGlite version this build depends on. */
export const CURRENT_PG_MAJOR = "18";
/**
 * The major this project used to be able to upgrade FROM, kept because both
 * the refusal and `resolveRecovery` still have to recognise it: a PG 17 datadir
 * gets a message that says what happened, not a generic one, and a marker left
 * by the old bridge names 17 in its `fromMajor`.
 */
export const LEGACY_PG_MAJOR = "17";

/**
 * The database `connection.ts` opens, passed EXPLICITLY rather than left to the
 * driver default.
 *
 * PGlite changed its default database from `template1` to `postgres` in 0.4.x.
 * Naming it from one constant keeps the app off whatever the installed driver
 * happens to default to today — a default that has already moved once, and
 * whose move is what made 0.4.x unusable as an upgrade stepping stone (opening
 * a 0.3.x datadir with it SUCCEEDS and presents an empty database while the
 * real data sits unreachable in `template1`).
 */
export const APP_DATABASE = "postgres";

const MARKER_FILENAME = ".ezcorp-datadir-upgrade.json";

/**
 * PGlite writes these when the engine is running. A SIGKILLed container leaves
 * them behind and the next open aborts at the WASM level — a false positive
 * `connection.ts` clears before its own open.
 */
const LOCK_FILES = ["postmaster.pid", "postmaster.opts"] as const;

/**
 * The crash marker an OLDER build wrote while upgrading. Nothing writes one any
 * more; this build only ever reads and clears them.
 */
export type UpgradeMarker = {
  phase: "dumping" | "swapping";
  fromMajor: string;
  toMajor: string;
  tmpPath: string;
  backupPath: string;
  startedAt: string;
};

/**
 * What `assertDatadirCompatible` actually did, for logs and tests.
 *
 * There is deliberately no `recovered-rolled-back` member: a roll-back restores
 * the PRE-upgrade (PG 17) datadir, which this build cannot open, so that arm
 * always continues into the refusal below rather than reporting success.
 */
export type DatadirGuardAction =
  | "none-fresh-install"
  | "none-already-current"
  | "recovered-completed-swap"
  | "recovered-cleared-marker";

export type DatadirGuardOutcome = {
  action: DatadirGuardAction;
  /** Where a previous build's pre-upgrade datadir was retained, when known. */
  backupPath?: string;
};

export function markerPathFor(dbPath: string): string {
  return join(dirname(dbPath), MARKER_FILENAME);
}

/**
 * The Postgres major that wrote `dir`, read from its `PG_VERSION` file.
 *
 * `undefined` for a path that does not exist, is not a datadir, or whose
 * `PG_VERSION` is not a plain integer — all of which mean "nothing to check
 * here" rather than an error.
 *
 * The strictness is deliberate and load-bearing. A CORRUPT `PG_VERSION` (a NUL
 * byte, a truncated write) is not a version this module can reason about, and
 * it must NOT be mistaken for "some other major" and refused here: the
 * open-failure path in `connection.ts` already owns corrupt datadirs, with a
 * recovery marker, operator hints and the `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE`
 * escape hatch behind it (two 2026-05-10 prod incidents shaped that contract).
 * Returning `undefined` here leaves that path exactly as it was.
 */
export function readDatadirMajor(dir: string): string | undefined {
  try {
    const raw = readFileSync(join(dir, "PG_VERSION"), "utf8").trim();
    return /^\d+$/.test(raw) ? raw : undefined;
  } catch {
    // Missing dir, missing PG_VERSION, or no permission. All are "no datadir".
    return undefined;
  }
}

export function readUpgradeMarker(dbPath: string): UpgradeMarker | null {
  try {
    return JSON.parse(readFileSync(markerPathFor(dbPath), "utf8")) as UpgradeMarker;
  } catch {
    // No marker, or a truncated one from a crash mid-write — either way there
    // is no trustworthy crash record, so fall back to the PG_VERSION checks.
    return null;
  }
}

export function clearUpgradeMarker(dbPath: string): void {
  try {
    unlinkSync(markerPathFor(dbPath));
  } catch {
    // Already gone — clearing is idempotent by design.
    return;
  }
}

/**
 * Remove stale PGlite lock files so an unclean shutdown doesn't read as an
 * unreadable datadir. Called by `connection.ts` on every boot.
 */
export function clearStaleLockFiles(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  for (const name of LOCK_FILES) {
    const path = join(dbPath, name);
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
      log.info("Removed stale PGlite lock file", { path });
    } catch (err) {
      log.warn("Failed to remove stale PGlite lock file", { path, error: String(err) });
    }
  }
}

/** What a crashed upgrade left behind, decided from PG_VERSION rather than existence. */
export type RecoveryPlan =
  | { kind: "retry" }
  | { kind: "finish-swap" }
  | { kind: "roll-back" }
  | { kind: "clear-marker" }
  | { kind: "refuse"; reason: string };

export function resolveRecovery(dbPath: string, marker: UpgradeMarker): RecoveryPlan {
  const live = readDatadirMajor(dbPath);
  const tmp = readDatadirMajor(marker.tmpPath);
  const backup = readDatadirMajor(marker.backupPath);

  if (live === CURRENT_PG_MAJOR) return { kind: "clear-marker" };
  if (live === LEGACY_PG_MAJOR) return { kind: "retry" };
  if (live === undefined && tmp === CURRENT_PG_MAJOR) return { kind: "finish-swap" };
  if (live === undefined && backup === LEGACY_PG_MAJOR) return { kind: "roll-back" };
  return {
    kind: "refuse",
    reason: `live=${live ?? "absent"} tmp=${tmp ?? "absent"} backup=${backup ?? "absent"}`,
  };
}

/**
 * Prove `dbPath` is a datadir this build's Postgres can open, or throw.
 *
 * Safe to call on every boot: a fresh install, an already-current datadir and
 * an external-Postgres deployment are all no-ops. MUST be called before
 * `openPglite()` — see the module header for what happens if it is not.
 */
export async function assertDatadirCompatible(dbPath: string): Promise<DatadirGuardOutcome> {
  const marker = readUpgradeMarker(dbPath);
  if (marker) {
    const plan = resolveRecovery(dbPath, marker);
    log.warn("Datadir upgrade marker found — an earlier build's upgrade did not finish", {
      phase: marker.phase,
      startedAt: marker.startedAt,
      plan: plan.kind,
    });
    switch (plan.kind) {
      case "clear-marker":
        clearUpgradeMarker(dbPath);
        rmSync(marker.tmpPath, { recursive: true, force: true });
        return { action: "recovered-cleared-marker", backupPath: marker.backupPath };
      case "finish-swap":
        rmSync(dbPath, { recursive: true, force: true });
        renameSync(marker.tmpPath, dbPath);
        clearUpgradeMarker(dbPath);
        log.info("Completed an interrupted datadir swap", { backupPath: marker.backupPath });
        return { action: "recovered-completed-swap", backupPath: marker.backupPath };
      case "roll-back":
        rmSync(dbPath, { recursive: true, force: true });
        rmSync(marker.tmpPath, { recursive: true, force: true });
        renameSync(marker.backupPath, dbPath);
        clearUpgradeMarker(dbPath);
        log.warn("Rolled an interrupted datadir upgrade back to the original");
        // Falls through to the major check below, which refuses: the original
        // this just restored is by definition the PRE-upgrade (PG 17) datadir.
        break;
      case "retry":
        // Nothing was ever renamed, so the live datadir is still the untouched
        // original. Drop the crashed attempt's leftovers and let the major
        // check below deliver the refusal.
        rmSync(marker.tmpPath, { recursive: true, force: true });
        clearUpgradeMarker(dbPath);
        break;
      default:
        throw new Error(
          `Refusing to boot: an interrupted PostgreSQL ${marker.fromMajor}->${marker.toMajor} datadir upgrade left a state that cannot be resolved safely (${plan.reason}). ` +
            `The original datadir may be at ${marker.backupPath}. Restore it manually and remove ${markerPathFor(dbPath)}.`,
        );
    }
  }

  const major = readDatadirMajor(dbPath);
  if (major === undefined) return { action: "none-fresh-install" };
  if (major === CURRENT_PG_MAJOR) return { action: "none-already-current" };
  if (major === LEGACY_PG_MAJOR) {
    throw new Error(
      `Refusing to boot: the database at ${dbPath} was written by PostgreSQL ${LEGACY_PG_MAJOR}, but this build runs PostgreSQL ${CURRENT_PG_MAJOR}, and it no longer ships the PostgreSQL ${LEGACY_PG_MAJOR} engine needed to read one. ` +
        "THE DATA DIRECTORY HAS NOT BEEN MODIFIED. " +
        `To recover, either restore a PostgreSQL ${CURRENT_PG_MAJOR} backup of this directory, or run an EZCorp build that still carries the ${LEGACY_PG_MAJOR}->${CURRENT_PG_MAJOR} upgrade bridge and let it convert the directory first.`,
    );
  }
  throw new Error(
    `Refusing to boot: the database at ${dbPath} was written by PostgreSQL ${major}, but this build runs PostgreSQL ${CURRENT_PG_MAJOR}. Postgres data directories are never compatible across majors. ` +
      "THE DATA DIRECTORY HAS NOT BEEN MODIFIED. " +
      `To recover, either restore a PostgreSQL ${CURRENT_PG_MAJOR} backup of this directory, or run the EZCorp build that wrote it.`,
  );
}
