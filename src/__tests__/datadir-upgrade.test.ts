/**
 * The PostgreSQL 17 -> 18 datadir upgrade.
 *
 * The headline test is deliberately NOT a fixture: it builds a real PG 17
 * datadir with the legacy engine and the REAL `migrate()` (all 74 tables),
 * writes real rows including a `vector(384)` column under its HNSW index —
 * the memory/KB embeddings path — then runs the real upgrade and reads
 * everything back through the new engine. This code rewrites live user
 * databases, so a toy table would not be evidence.
 *
 * The recovery and refusal paths are driven through injected seams instead:
 * they are about what is on disk after a SIGKILL, so booting WASM Postgres for
 * them would add minutes and prove nothing extra.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { PGlite as CurrentPGlite } from "@electric-sql/pglite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  APP_DATABASE,
  CURRENT_PG_MAJOR,
  LEGACY_PG_MAJOR,
  LEGACY_SOURCE_DATABASE,
  backupPathFor,
  clearStaleLockFiles,
  clearUpgradeMarker,
  collectTableCounts,
  markerPathFor,
  readDatadirMajor,
  readUpgradeMarker,
  resolveRecovery,
  restoreIntoNewDatadir,
  tmpPathFor,
  upgradeDatadirIfNeeded,
  verifyRestoredDatadir,
  writeUpgradeMarker,
  type TableCounts,
  type UpgradeDeps,
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

/** A 384-dim embedding, deterministic so KNN distances are exact. */
function embedding(seed: number): string {
  return `[${Array.from({ length: 384 }, (_, i) => ((i + seed) % 7) / 7).join(",")}]`;
}

/**
 * Build a GENUINE PostgreSQL 17 datadir the way a 0.3.x deployment really did:
 * the legacy engine, the real `migrate()`, and rows including a vector column.
 * Returns the source row counts for later comparison.
 */
async function buildLegacyDatadir(dbPath: string): Promise<TableCounts> {
  const { PGlite } = await import("@electric-sql/pglite-legacy");
  const { vector } = await import("@electric-sql/pglite-legacy/vector");
  const { pg_trgm } = await import("@electric-sql/pglite-legacy/contrib/pg_trgm");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../db/schema");
  const { migrate } = await import("../db/migrate");

  // Explicit source database, exactly as `dumpLegacyDatadir` reads it — a
  // fixture built against the driver DEFAULT would stop proving anything the
  // day that default moves, which is the 0.4.x failure this module guards.
  const pg = new PGlite({
    dataDir: dbPath,
    database: LEGACY_SOURCE_DATABASE,
    extensions: { vector, pg_trgm },
  });
  await pg.waitReady;
  // Same resolution artifact as `dumpLegacyDatadir`'s cast: drizzle's types
  // come from the 0.5.4 PGlite, the instance is the 0.3.16 alias. Identical
  // runtime API — this is how a 0.3.x deployment's datadir was really made.
  await migrate(drizzle(pg as unknown as CurrentPGlite, { schema }));
  await pg.query(
    `INSERT INTO memories (id, content, category, embedding)
     VALUES ($1, $2, 'fact', $3::vector), ($4, $5, 'fact', $6::vector)`,
    ["mem-1", "the first remembered thing", embedding(1), "mem-2", "the second remembered thing", embedding(2)],
  );
  await pg.query(`INSERT INTO projects (id, name, path) VALUES ($1, $2, $3)`, [
    "proj-1",
    "Upgrade Probe",
    "/tmp/upgrade-probe",
  ]);
  const counts = await collectTableCounts((sql) => pg.query(sql));
  await pg.close();
  return counts;
}

/** Stand up a datadir with a given PG_VERSION but no real cluster behind it. */
function fakeDatadir(path: string, major: string | null): string {
  mkdirSync(path, { recursive: true });
  if (major !== null) writeFileSync(join(path, "PG_VERSION"), `${major}\n`);
  return path;
}

function marker(overrides: Partial<UpgradeMarker> = {}): UpgradeMarker {
  return {
    phase: "dumping",
    fromMajor: LEGACY_PG_MAJOR,
    toMajor: CURRENT_PG_MAJOR,
    tmpPath: "/nonexistent/tmp",
    backupPath: "/nonexistent/backup",
    startedAt: "2026-08-08T00:00:00.000Z",
    ...overrides,
  };
}

/** Deps that must never run — any call is a test failure. */
const forbiddenDeps: UpgradeDeps = {
  dump: () => {
    throw new Error("dump must not run");
  },
  restore: () => {
    throw new Error("restore must not run");
  },
  verify: () => {
    throw new Error("verify must not run");
  },
};

describe("real PG 17 -> 18 upgrade of a fully migrated datadir", () => {
  const root = tmpRoot("roundtrip");
  const dbPath = join(root, "ezcorp-db");
  let outcomeAction: string;
  let backupPath: string | undefined;
  let sourceCounts: TableCounts;

  beforeAll(async () => {
    sourceCounts = await buildLegacyDatadir(dbPath);
    expect(readDatadirMajor(dbPath)).toBe(LEGACY_PG_MAJOR);

    const outcome = await upgradeDatadirIfNeeded(dbPath);
    outcomeAction = outcome.action;
    backupPath = outcome.backupPath;
  });

  test("reports an upgrade and leaves a PG 18 datadir in place", () => {
    expect(outcomeAction).toBe("upgraded");
    expect(readDatadirMajor(dbPath)).toBe(CURRENT_PG_MAJOR);
  });

  test("retains the original PG 17 datadir as a rollback target", () => {
    expect(backupPath).toBeDefined();
    expect(readDatadirMajor(backupPath as string)).toBe(LEGACY_PG_MAJOR);
  });

  test("leaves no staging directory or marker behind", () => {
    expect(existsSync(tmpPathFor(dbPath))).toBe(false);
    expect(existsSync(markerPathFor(dbPath))).toBe(false);
  });

  test("every table survives with the same row count", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const pg = new PGlite(dbPath, { extensions: { vector, pg_trgm } });
    await pg.waitReady;
    const after = await collectTableCounts((sql) => pg.query(sql));
    await pg.close();

    // The real schema, not a handful of tables.
    expect(Object.keys(sourceCounts).length).toBeGreaterThan(70);
    expect(after).toEqual(sourceCounts);
  });

  test("the rows, the vector column and its HNSW index all still work", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const pg = new PGlite(dbPath, { extensions: { vector, pg_trgm } });
    await pg.waitReady;

    const rows = (await pg.query("select id, content from memories order by id")) as {
      rows: { id: string; content: string }[];
    };
    expect(rows.rows).toEqual([
      { id: "mem-1", content: "the first remembered thing" },
      { id: "mem-2", content: "the second remembered thing" },
    ]);

    // The embeddings are not merely present, they are still queryable as
    // vectors: an exact self-match plus a strictly greater distance.
    const knn = (await pg.query(
      "select id, (embedding <=> $1::vector) as d from memories order by embedding <=> $1::vector limit 2",
      [embedding(1)],
    )) as { rows: { id: string; d: number }[] };
    expect(knn.rows[0]?.id).toBe("mem-1");
    expect(knn.rows[0]?.d).toBe(0);
    expect(knn.rows[1]?.d).toBeGreaterThan(0);

    const idx = (await pg.query(
      "select indexname from pg_indexes where indexname = 'idx_memories_embedding_hnsw'",
    )) as { rows: { indexname: string }[] };
    expect(idx.rows).toHaveLength(1);

    const ext = (await pg.query("select extname from pg_extension order by extname")) as {
      rows: { extname: string }[];
    };
    expect(ext.rows.map((r) => r.extname)).toContain("vector");
    expect(ext.rows.map((r) => r.extname)).toContain("pg_trgm");

    // pg_trgm's C functions are live, not just a catalog entry.
    const sim = (await pg.query("select similarity('remembered thing', 'remembered thin') as s")) as {
      rows: { s: number }[];
    };
    expect(sim.rows[0]?.s).toBeGreaterThan(0);

    await pg.close();
  });

  test("the upgraded datadir is the one the app opens, and it is writable", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite-pgvector");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const pg = new PGlite(dbPath, { extensions: { vector, pg_trgm } });
    await pg.waitReady;
    await pg.query(`INSERT INTO projects (id, name, path) VALUES ($1, $2, $3)`, [
      "post-upgrade",
      "Written After Upgrade",
      "/tmp/after",
    ]);
    const n = (await pg.query("select count(*)::int as n from projects")) as { rows: { n: number }[] };
    expect(n.rows[0]?.n).toBe((sourceCounts.projects ?? 0) + 1);
    await pg.close();
  });

  test("a second call is a no-op — the upgrade is not repeated", async () => {
    const outcome = await upgradeDatadirIfNeeded(dbPath, forbiddenDeps);
    expect(outcome.action).toBe("none-already-current");
  });
});

/**
 * The highest-consequence path in the change.
 *
 * `EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1` (plumbed in `compose.prod.yml`,
 * default unset) renames a failed-open datadir aside and boots EMPTY. A PG 17
 * datadir cannot be opened by the PG 18 engine, so if the upgrade did not run
 * strictly BEFORE `openPglite()`, an operator with that flag set would have
 * their database destroyed by the very update meant to migrate it.
 *
 * Asserted by booting the REAL `initDb()` in a subprocess — the ordering lives
 * in `connection.ts`, so nothing short of a real boot proves it.
 */
describe("an operator with EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE=1 gets migrated, never destroyed", () => {
  const root = tmpRoot("auto-destroy");
  const dbPath = join(root, "ezcorp-db");
  let sourceCounts: TableCounts;
  let child: {
    ok: boolean;
    initError: string | null;
    corruptedSiblings: string[];
    backups: string[];
    memories: Array<{ id: string; content: string }>;
    projectCount: number;
    currentDatabase: string;
    tableCount: number;
  };

  beforeAll(async () => {
    sourceCounts = await buildLegacyDatadir(dbPath);
    expect(readDatadirMajor(dbPath)).toBe(LEGACY_PG_MAJOR);

    const connectionAbs = resolve(import.meta.dir, "..", "db", "connection.ts");
    const driverPath = join(root, "driver.ts");
    writeFileSync(
      driverPath,
      `
      import { readdirSync } from "node:fs";
      import { dirname, join, basename } from "node:path";
      const result = { ok: false, initError: null, corruptedSiblings: [], backups: [],
                       memories: [], projectCount: 0, currentDatabase: "", tableCount: 0 };
      try {
        const conn = await import(${JSON.stringify(connectionAbs)});
        await conn.initDb();
        result.ok = true;
        const pg = conn.getPglite();
        result.currentDatabase = (await pg.query("select current_database() as d")).rows[0].d;
        result.memories = (await pg.query("select id, content from memories order by id")).rows;
        result.projectCount = (await pg.query("select count(*)::int as n from projects")).rows[0].n;
        result.tableCount = (await pg.query(
          "select count(*)::int as n from information_schema.tables where table_schema='public'"
        )).rows[0].n;
        await conn.closeDb();
      } catch (e) {
        result.initError = e instanceof Error ? (e.stack ?? e.message) : String(e);
      }
      const dbPath = process.env.EZCORP_DB_PATH;
      const parent = dirname(dbPath);
      const base = basename(dbPath);
      const names = readdirSync(parent);
      result.corruptedSiblings = names.filter((n) => n.startsWith(base + ".corrupted."));
      result.backups = names.filter((n) => n.startsWith(base + ".pg17-backup."));
      process.stdout.write("\\n__BEGIN__" + JSON.stringify(result) + "__END__\\n");
      process.exit(0);
      `,
    );

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      EZCORP_DB_PATH: dbPath,
      EZCORP_BACKUP_DIR: join(root, "backups"),
      // The flag that made this path dangerous.
      EZCORP_AUTO_DESTROY_ON_OPEN_FAILURE: "1",
    };
    delete env.DATABASE_URL;
    delete env.EZCORP_IMAGE_SHA;

    const proc = Bun.spawnSync(["bun", driverPath], { env, stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(proc.stdout);
    const body = out.split("__BEGIN__")[1]?.split("__END__")[0];
    if (!body) {
      throw new Error(`child produced no result. stderr: ${new TextDecoder().decode(proc.stderr).slice(-2000)}`);
    }
    child = JSON.parse(body);
  });

  test("the boot succeeds instead of hitting the open-failure path at all", () => {
    expect(child.initError).toBeNull();
    expect(child.ok).toBe(true);
  });

  test("the datadir is NOT renamed aside and no empty database is substituted", () => {
    expect(child.corruptedSiblings).toEqual([]);
    expect(child.tableCount).toBe(Object.keys(sourceCounts).length);
  });

  test("every row the operator had is still there after the boot", () => {
    expect(child.memories).toEqual([
      { id: "mem-1", content: "the first remembered thing" },
      { id: "mem-2", content: "the second remembered thing" },
    ]);
    expect(child.projectCount).toBe(sourceCounts.projects);
  });

  test("the datadir was upgraded in place and the original retained", () => {
    expect(readDatadirMajor(dbPath)).toBe(CURRENT_PG_MAJOR);
    expect(child.backups).toHaveLength(1);
    expect(readDatadirMajor(join(root, child.backups[0] as string))).toBe(LEGACY_PG_MAJOR);
  });

  test("the app connects to the database the restore actually wrote", () => {
    // Pins the template1 -> postgres hazard end to end: had the restore landed
    // in a different database than connection.ts opens, the row assertions
    // above would have been made against an empty schema.
    expect(child.currentDatabase).toBe(APP_DATABASE);
  });
});

describe("when there is nothing to do", () => {
  test("a fresh install with no datadir is a no-op", async () => {
    const root = tmpRoot("fresh");
    const outcome = await upgradeDatadirIfNeeded(join(root, "ezcorp-db"), forbiddenDeps);
    expect(outcome.action).toBe("none-fresh-install");
  });

  test("a directory with no PG_VERSION is treated as a fresh install", async () => {
    const root = tmpRoot("empty");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), null);
    const outcome = await upgradeDatadirIfNeeded(dbPath, forbiddenDeps);
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
      await expect(upgradeDatadirIfNeeded(dbPath, forbiddenDeps)).resolves.toEqual({
        action: "none-fresh-install",
      });
    }
  });

  test("an already-current datadir is a no-op", async () => {
    const root = tmpRoot("current");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), CURRENT_PG_MAJOR);
    const outcome = await upgradeDatadirIfNeeded(dbPath, forbiddenDeps);
    expect(outcome.action).toBe("none-already-current");
  });
});

describe("refusing what it cannot safely upgrade", () => {
  test("a datadir from an unsupported major is refused loudly, not silently reset", async () => {
    const root = tmpRoot("pg16");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), "16");
    await expect(upgradeDatadirIfNeeded(dbPath, forbiddenDeps)).rejects.toThrow(
      /written by PostgreSQL 16.*can only upgrade from 17/s,
    );
    // The refusal must not have touched the data.
    expect(readDatadirMajor(dbPath)).toBe("16");
  });

  test("an unresolvable interrupted upgrade is refused rather than guessed at", async () => {
    const root = tmpRoot("unresolvable");
    const dbPath = join(root, "ezcorp-db");
    // No live datadir, no usable staging, no backup — nothing provable.
    writeUpgradeMarker(dbPath, marker({ phase: "swapping" }));
    await expect(upgradeDatadirIfNeeded(dbPath, forbiddenDeps)).rejects.toThrow(
      /cannot be resolved safely/,
    );
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
    expect(resolveRecovery(dbPath, marker({ tmpPath, backupPath: backup }))).toEqual({ kind: "finish-swap" });
  });

  test("a live PG 18 datadir means the swap already completed", () => {
    const root = tmpRoot("done");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), CURRENT_PG_MAJOR);
    expect(resolveRecovery(dbPath, marker())).toEqual({ kind: "clear-marker" });
  });

  test("a live PG 17 datadir means no rename happened, so retry", () => {
    const root = tmpRoot("retry");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), LEGACY_PG_MAJOR);
    expect(resolveRecovery(dbPath, marker())).toEqual({ kind: "retry" });
  });

  test("no live datadir and unusable staging falls back to the backup", () => {
    const root = tmpRoot("rollback");
    const dbPath = join(root, "ezcorp-db");
    const backup = fakeDatadir(join(root, "backup"), LEGACY_PG_MAJOR);
    expect(resolveRecovery(dbPath, marker({ backupPath: backup }))).toEqual({ kind: "roll-back" });
  });

  test("nothing on disk at all is unprovable and refuses", () => {
    const root = tmpRoot("nothing");
    const plan = resolveRecovery(join(root, "ezcorp-db"), marker());
    expect(plan.kind).toBe("refuse");
    expect(plan).toHaveProperty("reason", "live=absent tmp=absent backup=absent");
  });
});

describe("crash recovery on the next boot", () => {
  test("a crash after both renames just clears the marker and the staging dir", async () => {
    const root = tmpRoot("rec-cleared");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), CURRENT_PG_MAJOR);
    const tmpPath = fakeDatadir(tmpPathFor(dbPath), CURRENT_PG_MAJOR);
    const backup = fakeDatadir(join(root, "backup"), LEGACY_PG_MAJOR);
    writeUpgradeMarker(dbPath, marker({ phase: "swapping", tmpPath, backupPath: backup }));

    const outcome = await upgradeDatadirIfNeeded(dbPath, forbiddenDeps);
    expect(outcome.action).toBe("recovered-cleared-marker");
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(markerPathFor(dbPath))).toBe(false);
    expect(readDatadirMajor(dbPath)).toBe(CURRENT_PG_MAJOR);
  });

  test("a crash BETWEEN the two renames completes the swap", async () => {
    const root = tmpRoot("rec-finish");
    const dbPath = join(root, "ezcorp-db");
    // Exactly the mid-swap state: live gone, staging verified, backup holding
    // the original. Plus the empty dir a racing mkdir would leave.
    mkdirSync(dbPath, { recursive: true });
    const tmpPath = fakeDatadir(tmpPathFor(dbPath), CURRENT_PG_MAJOR);
    writeFileSync(join(tmpPath, "marker.txt"), "the upgraded one");
    const backup = fakeDatadir(join(root, "backup"), LEGACY_PG_MAJOR);
    writeUpgradeMarker(dbPath, marker({ phase: "swapping", tmpPath, backupPath: backup }));

    const outcome = await upgradeDatadirIfNeeded(dbPath, forbiddenDeps);
    expect(outcome.action).toBe("recovered-completed-swap");
    expect(outcome.backupPath).toBe(backup);
    expect(readDatadirMajor(dbPath)).toBe(CURRENT_PG_MAJOR);
    // The live datadir is the STAGED one, not the empty placeholder.
    expect(readFileSync(join(dbPath, "marker.txt"), "utf8")).toBe("the upgraded one");
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(markerPathFor(dbPath))).toBe(false);
  });

  test("a crash between the renames with unusable staging rolls back to the original", async () => {
    const root = tmpRoot("rec-rollback");
    const dbPath = join(root, "ezcorp-db");
    const tmpPath = fakeDatadir(tmpPathFor(dbPath), null); // half-written, no PG_VERSION
    const backup = fakeDatadir(join(root, "backup"), LEGACY_PG_MAJOR);
    writeFileSync(join(backup, "marker.txt"), "the original");
    writeUpgradeMarker(dbPath, marker({ phase: "swapping", tmpPath, backupPath: backup }));

    const outcome = await upgradeDatadirIfNeeded(dbPath, forbiddenDeps);
    expect(outcome.action).toBe("recovered-rolled-back");
    expect(readDatadirMajor(dbPath)).toBe(LEGACY_PG_MAJOR);
    expect(readFileSync(join(dbPath, "marker.txt"), "utf8")).toBe("the original");
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(markerPathFor(dbPath))).toBe(false);
  });

  test("a crash before any rename retries the upgrade from the untouched original", async () => {
    const root = tmpRoot("rec-retry");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), LEGACY_PG_MAJOR);
    const staleTmp = fakeDatadir(tmpPathFor(dbPath), null);
    writeFileSync(join(staleTmp, "junk.txt"), "leftovers from the crashed attempt");
    writeUpgradeMarker(dbPath, marker({ phase: "dumping", tmpPath: staleTmp }));

    let sawStaleTmp = true;
    const outcome = await upgradeDatadirIfNeeded(dbPath, {
      dump: async () => {
        // The crashed attempt's staging must be gone before we rebuild.
        sawStaleTmp = existsSync(staleTmp);
        return { sql: "-- dump --", counts: { projects: 1 } };
      },
      restore: async (tmpPath) => {
        fakeDatadir(tmpPath, CURRENT_PG_MAJOR);
      },
      verify: async () => {},
    });

    expect(sawStaleTmp).toBe(false);
    expect(outcome.action).toBe("upgraded");
    expect(readDatadirMajor(dbPath)).toBe(CURRENT_PG_MAJOR);
    expect(readDatadirMajor(outcome.backupPath as string)).toBe(LEGACY_PG_MAJOR);
  });
});

describe("a failed upgrade leaves the original exactly as it was", () => {
  async function failingStage(stage: "dump" | "restore" | "verify"): Promise<{
    dbPath: string;
    error: Error;
  }> {
    const root = tmpRoot(`fail-${stage}`);
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), LEGACY_PG_MAJOR);
    writeFileSync(join(dbPath, "payload.txt"), "irreplaceable");
    const boom = new Error(`${stage} exploded`);
    const deps: UpgradeDeps = {
      dump: async () => {
        if (stage === "dump") throw boom;
        return { sql: "-- dump --", counts: { projects: 1 } };
      },
      restore: async (tmpPath) => {
        fakeDatadir(tmpPath, CURRENT_PG_MAJOR);
        if (stage === "restore") throw boom;
      },
      verify: async () => {
        if (stage === "verify") throw boom;
      },
    };
    let error: Error | undefined;
    await upgradeDatadirIfNeeded(dbPath, deps).catch((e: Error) => {
      error = e;
    });
    return { dbPath, error: error as Error };
  }

  for (const stage of ["dump", "restore", "verify"] as const) {
    test(`a failure during ${stage} propagates and rolls the disk back to the pre-upgrade state`, async () => {
      const { dbPath, error } = await failingStage(stage);
      expect(error).toBeDefined();
      expect(error.message).toBe(`${stage} exploded`);
      // Original untouched...
      expect(readDatadirMajor(dbPath)).toBe(LEGACY_PG_MAJOR);
      expect(readFileSync(join(dbPath, "payload.txt"), "utf8")).toBe("irreplaceable");
      // ...staging removed, and NO marker, so the next boot is a clean retry
      // rather than a recovery of a crash that never happened.
      expect(existsSync(tmpPathFor(dbPath))).toBe(false);
      expect(existsSync(markerPathFor(dbPath))).toBe(false);
    });
  }
});

describe("verification catches a restore that did not fully land", () => {
  const root = tmpRoot("verify");
  let good: string;

  beforeAll(async () => {
    good = join(root, "restored");
    await restoreIntoNewDatadir(
      good,
      "CREATE TABLE kept (id int); INSERT INTO kept VALUES (1), (2); CREATE TABLE empty_one (id int);",
    );
  });

  test("passes when every table matches", async () => {
    await expect(verifyRestoredDatadir(good, { kept: 2, empty_one: 0 })).resolves.toBeUndefined();
  });

  test("fails on a row-count shortfall", async () => {
    await expect(verifyRestoredDatadir(good, { kept: 3, empty_one: 0 })).rejects.toThrow(
      /kept: expected 3, got 2/,
    );
  });

  test("fails on a table that did not restore at all", async () => {
    await expect(verifyRestoredDatadir(good, { kept: 2, empty_one: 0, vanished: 1 })).rejects.toThrow(
      /vanished: expected 1, got missing table/,
    );
  });

  test("fails on a table the source never had", async () => {
    await expect(verifyRestoredDatadir(good, { kept: 2 })).rejects.toThrow(
      /unexpected tables: empty_one/,
    );
  });
});

describe("collectTableCounts", () => {
  test("counts every public base table and quotes exotic identifiers", async () => {
    const seen: string[] = [];
    const counts = await collectTableCounts(async (sql) => {
      seen.push(sql);
      if (sql.includes("information_schema")) {
        return { rows: [{ table_name: "plain" }, { table_name: 'we"ird' }] };
      }
      return { rows: [{ n: 7 }] };
    });
    expect(counts).toEqual({ plain: 7, 'we"ird': 7 });
    // The embedded quote is doubled, so the statement shape cannot be changed
    // by a table name.
    expect(seen).toContain('select count(*)::int as n from "we""ird"');
  });

  test("a count query that returns no row is recorded as zero rather than undefined", async () => {
    const counts = await collectTableCounts(async (sql) =>
      sql.includes("information_schema") ? { rows: [{ table_name: "odd" }] } : { rows: [] },
    );
    expect(counts).toEqual({ odd: 0 });
  });
});

describe("the crash marker", () => {
  test("round-trips and is idempotent to clear", () => {
    const root = tmpRoot("marker");
    const dbPath = join(root, "ezcorp-db");
    const written = marker({ phase: "swapping" });
    writeUpgradeMarker(dbPath, written);
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
    mkdirSync(root, { recursive: true });
    writeFileSync(markerPathFor(dbPath), '{"phase":"swap');
    expect(readUpgradeMarker(dbPath)).toBeNull();
  });

  test("lives beside the datadir, so a rename of the datadir cannot move it", () => {
    const dbPath = "/data/ezcorp-db";
    expect(markerPathFor(dbPath)).toBe("/data/.ezcorp-datadir-upgrade.json");
    expect(markerPathFor(dbPath).startsWith(`${dbPath}/`)).toBe(false);
  });
});

describe("path helpers", () => {
  test("staging and backup are siblings of the datadir, so rename stays atomic", () => {
    expect(tmpPathFor("/data/ezcorp-db")).toBe("/data/ezcorp-db.pg-upgrade-tmp");
    expect(backupPathFor("/data/ezcorp-db", "2026-08-08T00-00-00-000Z")).toBe(
      "/data/ezcorp-db.pg17-backup.2026-08-08T00-00-00-000Z",
    );
  });
});

describe("clearStaleLockFiles", () => {
  test("removes both lock files a SIGKILLed engine leaves behind", () => {
    const root = tmpRoot("locks");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), LEGACY_PG_MAJOR);
    writeFileSync(join(dbPath, "postmaster.pid"), "123");
    writeFileSync(join(dbPath, "postmaster.opts"), "opts");

    clearStaleLockFiles(dbPath);

    expect(existsSync(join(dbPath, "postmaster.pid"))).toBe(false);
    expect(existsSync(join(dbPath, "postmaster.opts"))).toBe(false);
    // Real data is untouched.
    expect(readDatadirMajor(dbPath)).toBe(LEGACY_PG_MAJOR);
  });

  test("a missing datadir and a clean one are both no-ops", () => {
    const root = tmpRoot("locks-none");
    clearStaleLockFiles(join(root, "absent"));
    const clean = fakeDatadir(join(root, "clean"), LEGACY_PG_MAJOR);
    clearStaleLockFiles(clean);
    expect(readDatadirMajor(clean)).toBe(LEGACY_PG_MAJOR);
  });

  test("an unremovable lock file is survivable — boot is not blocked by it", () => {
    const root = tmpRoot("locks-stuck");
    const dbPath = fakeDatadir(join(root, "ezcorp-db"), LEGACY_PG_MAJOR);
    // A directory at the lock path makes unlinkSync throw EISDIR/EPERM.
    mkdirSync(join(dbPath, "postmaster.pid"), { recursive: true });
    writeFileSync(join(dbPath, "postmaster.opts"), "opts");

    expect(() => clearStaleLockFiles(dbPath)).not.toThrow();
    // The removable one still went.
    expect(existsSync(join(dbPath, "postmaster.opts"))).toBe(false);
  });
});
