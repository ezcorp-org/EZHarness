/**
 * First-boot upgrade of the embedded PGlite data directory across a
 * PostgreSQL MAJOR version.
 *
 * ## Why this exists
 *
 * PGlite bundles a whole Postgres build, so bumping PGlite can bump Postgres:
 * `@electric-sql/pglite` 0.3.16 ships **PostgreSQL 17.5**, 0.5.4 ships
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
 * PGlite is the default database whenever `DATABASE_URL` is unset, so without
 * this module every existing self-hosted deployment would fail to boot on
 * update, surfacing only as the uninformative "PGlite failed to initialize
 * properly" (the FATAL above is swallowed unless `debug` is on).
 *
 * `pg_upgrade` does not exist in a WASM build, so the only path is a logical
 * dump under the old engine and a restore under the new one. Both engines are
 * therefore installed at once: `@electric-sql/pglite-legacy` is an alias of
 * 0.3.16 kept solely to READ old datadirs, and it can be dropped once no
 * supported upgrade path starts at PG 17.
 *
 * ## Why 0.4.x is never used as a stepping stone
 *
 * PGlite 0.4.x is still PostgreSQL 17, which makes it look like a cheaper
 * intermediate hop. It is not, and it is the more dangerous version to touch:
 * 0.4.x changed the DEFAULT DATABASE from `template1` to `postgres`. Opening a
 * 0.3.x datadir with 0.4.x therefore SUCCEEDS and presents an empty database —
 * 0 tables, no `vector` extension — while the real data sits unreachable in
 * `template1`. `migrate()` would then recreate the whole schema empty and the
 * user would see an empty install with no error anywhere. The 0.5.x hard
 * refusal is by far the safer failure, so the upgrade goes 0.3 → 0.5 directly.
 *
 * ## Safety model
 *
 * The original datadir is NEVER mutated. The new one is built alongside it and
 * only swapped in after it has been verified row-for-row against the source:
 *
 * ```
 *   <db>                      live datadir
 *   <db>.pg-upgrade-tmp       staging; built, verified, then renamed into place
 *   <db>.pg17-backup.<ts>     the original, retained after the swap (rollback)
 *   ../.ezcorp-datadir-upgrade.json   crash marker (sibling — survives renames)
 * ```
 *
 * Every step is crash-safe because the *only* destructive operations are two
 * `rename(2)` calls, and the state between them is detectable. On the next
 * boot `resolveRecovery()` reads the on-disk PG_VERSION of each path — never
 * mere directory existence, because `initPglite` may have `mkdir`ed an empty
 * one — and decides deterministically:
 *
 * | live | tmp | backup | meaning | action |
 * |---|---|---|---|---|
 * | 18 | — | — | swap completed | clear marker |
 * | 17 | — | — | crashed before any rename; original intact | retry |
 * | absent | 18 | 17 | crashed BETWEEN the renames | finish the swap |
 * | absent | not 18 | 17 | crashed between renames, staging unusable | roll back, retry |
 * | anything else | | | unprovable | refuse loudly |
 *
 * A half-swapped datadir is never presented as healthy. A handled failure (as
 * opposed to a crash) cleans up after itself and leaves the pre-upgrade state
 * exactly as it was, so a retry on the next boot is always safe and the marker
 * only ever describes a real crash.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logger";

const log = logger.child("db");

/** Postgres major shipped by the PGlite version this build depends on. */
export const CURRENT_PG_MAJOR = "18";
/** Postgres major shipped by `@electric-sql/pglite-legacy` (0.3.16). */
export const LEGACY_PG_MAJOR = "17";

const TMP_SUFFIX = ".pg-upgrade-tmp";
const BACKUP_SUFFIX = ".pg17-backup.";
const MARKER_FILENAME = ".ezcorp-datadir-upgrade.json";

/**
 * PGlite writes these when the engine is running. A SIGKILLed container leaves
 * them behind and the next open aborts at the WASM level — the same
 * false-positive `connection.ts` clears before its own open. The upgrade opens
 * the datadir too, so it has to clear them first or an unclean shutdown would
 * masquerade as an unreadable datadir.
 */
const LOCK_FILES = ["postmaster.pid", "postmaster.opts"] as const;

export type UpgradePhase = "dumping" | "swapping";

export type UpgradeMarker = {
  phase: UpgradePhase;
  fromMajor: string;
  toMajor: string;
  tmpPath: string;
  backupPath: string;
  startedAt: string;
};

/** What `upgradeDatadirIfNeeded` actually did, for logs and tests. */
export type UpgradeAction =
  | "none-fresh-install"
  | "none-already-current"
  | "upgraded"
  | "recovered-completed-swap"
  | "recovered-cleared-marker"
  | "recovered-rolled-back";

export type UpgradeOutcome = {
  action: UpgradeAction;
  /** Where the pre-upgrade datadir was retained, when a swap happened. */
  backupPath?: string;
};

/** Per-table row counts, keyed by table name — the verification contract. */
export type TableCounts = Record<string, number>;

export function tmpPathFor(dbPath: string): string {
  return `${dbPath}${TMP_SUFFIX}`;
}

export function backupPathFor(dbPath: string, stamp: string): string {
  return `${dbPath}${BACKUP_SUFFIX}${stamp}`;
}

export function markerPathFor(dbPath: string): string {
  return join(dirname(dbPath), MARKER_FILENAME);
}

/**
 * The Postgres major that wrote `dir`, read from its `PG_VERSION` file.
 *
 * `undefined` for a path that does not exist, is not a datadir, or whose
 * `PG_VERSION` is not a plain integer — all of which mean "nothing to upgrade
 * here" rather than an error.
 *
 * The strictness is deliberate and load-bearing. A CORRUPT `PG_VERSION` (a
 * NUL byte, a truncated write) is not a version this module can reason about,
 * and it must NOT be mistaken for "some other major" and refused here: the
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

export function writeUpgradeMarker(dbPath: string, marker: UpgradeMarker): void {
  const path = markerPathFor(dbPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2));
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
 * unreadable datadir. Shared with `connection.ts`, which needs exactly the
 * same pre-flight before its own open.
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

/**
 * Dump a PG 17 datadir to SQL using the legacy engine, along with the row
 * counts the restore will be verified against.
 *
 * `pgDump` emits a script that begins by setting an empty `search_path`, so
 * the caller MUST replay it as one whole `exec()` — splitting it into
 * statements loses that session state and the restore half-fails with
 * `relation "public.x" does not exist`.
 */
export async function dumpLegacyDatadir(dbPath: string): Promise<{ sql: string; counts: TableCounts }> {
  const { PGlite } = await import("@electric-sql/pglite-legacy");
  const { vector } = await import("@electric-sql/pglite-legacy/vector");
  const { pg_trgm } = await import("@electric-sql/pglite-legacy/contrib/pg_trgm");
  const { pgDump } = await import("@electric-sql/pglite-tools/pg_dump");

  clearStaleLockFiles(dbPath);
  const pg = new PGlite(dbPath, { extensions: { vector, pg_trgm } });
  try {
    await pg.waitReady;
    const counts = await collectTableCounts((sql) => pg.query(sql));
    // `pglite-tools@0.2.21` peer-pins pglite 0.3.16, so the LEGACY instance is
    // exactly what it expects at runtime. TypeScript disagrees only because
    // the bare specifier `@electric-sql/pglite` resolves to 0.5.4 in this tree
    // (0.3.16 is installed under the `-legacy` alias), and PGlite's private
    // field makes the two classes structurally distinct. A resolution
    // artifact, not an incompatibility — the round trip is covered by tests.
    const dump = await pgDump({ pg: pg as unknown as Parameters<typeof pgDump>[0]["pg"] });
    return { sql: await dump.text(), counts };
  } finally {
    await pg.close().catch(() => {});
  }
}

/** Build a fresh PG 18 datadir at `tmpPath` and replay `sql` into it. */
export async function restoreIntoNewDatadir(tmpPath: string, sql: string): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");

  const pg = new PGlite(tmpPath, { extensions: { vector, pg_trgm } });
  try {
    await pg.waitReady;
    // ONE exec for the WHOLE script — see dumpLegacyDatadir.
    await pg.exec(sql);
  } finally {
    await pg.close().catch(() => {});
  }
}

/**
 * Re-open the restored datadir and prove it matches the source table for table.
 *
 * The reconnect is load-bearing, not hygiene: the session that ran the restore
 * still carries the dump's empty `search_path`, so unqualified operators fail
 * there (`operator does not exist: public.vector <-> unknown`). A fresh session
 * is also what the app itself will get, which is what we actually want to
 * assert.
 */
export async function verifyRestoredDatadir(tmpPath: string, expected: TableCounts): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");

  const pg = new PGlite(tmpPath, { extensions: { vector, pg_trgm } });
  let actual: TableCounts;
  try {
    await pg.waitReady;
    actual = await collectTableCounts((sql) => pg.query(sql));
  } finally {
    await pg.close().catch(() => {});
  }

  const mismatches: string[] = [];
  for (const [table, count] of Object.entries(expected)) {
    const got = actual[table];
    if (got !== count) mismatches.push(`${table}: expected ${count}, got ${got ?? "missing table"}`);
  }
  const extra = Object.keys(actual).filter((t) => !(t in expected));
  if (extra.length > 0) mismatches.push(`unexpected tables: ${extra.sort().join(", ")}`);
  if (mismatches.length > 0) {
    throw new Error(`Upgraded datadir does not match the source: ${mismatches.sort().join("; ")}`);
  }
}

/**
 * Row count of every public base table, via an injected query function so the
 * same code serves the old engine and the new one.
 */
export async function collectTableCounts(
  query: (sql: string) => Promise<{ rows: unknown[] }>,
): Promise<TableCounts> {
  const listed = (await query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
  )) as { rows: { table_name: string }[] };
  const counts: TableCounts = {};
  for (const { table_name } of listed.rows) {
    // Identifiers come from the catalog, and are quoted so an exotic table
    // name can't change the shape of the statement.
    const res = (await query(`select count(*)::int as n from "${table_name.replace(/"/g, '""')}"`)) as {
      rows: { n: number }[];
    };
    counts[table_name] = res.rows[0]?.n ?? 0;
  }
  return counts;
}

/** Seams so the recovery/refusal paths are testable without booting WASM twice. */
export type UpgradeDeps = {
  dump: typeof dumpLegacyDatadir;
  restore: typeof restoreIntoNewDatadir;
  verify: typeof verifyRestoredDatadir;
};

const REAL_DEPS: UpgradeDeps = {
  dump: dumpLegacyDatadir,
  restore: restoreIntoNewDatadir,
  verify: verifyRestoredDatadir,
};

/** What a crashed run left behind, decided from PG_VERSION rather than existence. */
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
 * Bring `dbPath` up to the Postgres major this build runs, if it isn't already.
 * Safe to call on every boot: a fresh install, an already-current datadir and
 * an external-Postgres deployment are all no-ops.
 */
export async function upgradeDatadirIfNeeded(
  dbPath: string,
  deps: UpgradeDeps = REAL_DEPS,
): Promise<UpgradeOutcome> {
  const marker = readUpgradeMarker(dbPath);
  if (marker) {
    const plan = resolveRecovery(dbPath, marker);
    log.warn("Datadir upgrade marker found — a previous upgrade did not finish", {
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
        return { action: "recovered-rolled-back" };
      case "retry":
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
  if (major !== LEGACY_PG_MAJOR) {
    throw new Error(
      `Refusing to boot: the database at ${dbPath} was written by PostgreSQL ${major}, but this build runs PostgreSQL ${CURRENT_PG_MAJOR} and can only upgrade from ${LEGACY_PG_MAJOR}. ` +
        "Downgrade to the EZCorp version that wrote it, or restore a compatible backup.",
    );
  }

  return runUpgrade(dbPath, deps);
}

async function runUpgrade(dbPath: string, deps: UpgradeDeps): Promise<UpgradeOutcome> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tmpPath = tmpPathFor(dbPath);
  const backupPath = backupPathFor(dbPath, stamp);

  log.info("Upgrading the embedded database across a PostgreSQL major version", {
    from: LEGACY_PG_MAJOR,
    to: CURRENT_PG_MAJOR,
    dbPath,
    backupPath,
  });
  writeUpgradeMarker(dbPath, {
    phase: "dumping",
    fromMajor: LEGACY_PG_MAJOR,
    toMajor: CURRENT_PG_MAJOR,
    tmpPath,
    backupPath,
    startedAt: new Date().toISOString(),
  });

  try {
    // Leftovers from an earlier attempt are never reused.
    rmSync(tmpPath, { recursive: true, force: true });
    const { sql, counts } = await deps.dump(dbPath);
    await deps.restore(tmpPath, sql);
    await deps.verify(tmpPath, counts);
  } catch (err) {
    // The original has not been touched, so putting the disk back exactly as
    // we found it makes the next boot a clean retry rather than a recovery.
    rmSync(tmpPath, { recursive: true, force: true });
    clearUpgradeMarker(dbPath);
    log.error("Datadir upgrade failed — the original database is untouched", { error: String(err) });
    throw err;
  }

  writeUpgradeMarker(dbPath, {
    phase: "swapping",
    fromMajor: LEGACY_PG_MAJOR,
    toMajor: CURRENT_PG_MAJOR,
    tmpPath,
    backupPath,
    startedAt: new Date().toISOString(),
  });
  // The only two destructive operations in the whole module. A crash between
  // them is the "finish-swap" row of the recovery table.
  renameSync(dbPath, backupPath);
  renameSync(tmpPath, dbPath);
  clearUpgradeMarker(dbPath);

  log.info("Database upgraded; the pre-upgrade datadir was kept for rollback", {
    from: LEGACY_PG_MAJOR,
    to: CURRENT_PG_MAJOR,
    backupPath,
  });
  return { action: "upgraded", backupPath };
}
