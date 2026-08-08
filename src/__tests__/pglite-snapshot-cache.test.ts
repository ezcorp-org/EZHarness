/**
 * The migrated-PGlite snapshot cache — and, more importantly, its KEY.
 *
 * A cache that is merely fast proves nothing. A stale entry here would be a
 * silent false green on schema: every test would run against the old database
 * and pass. So the claims this file makes, in order of what matters:
 *
 *  1. **Invalidation is positive and real.** A change to a real schema input —
 *     `src/db/migrate.ts` itself, and a named module under
 *     `src/db/migrations/` reached three hops down the real import graph —
 *     moves the key, and the cache MISSES. Proven on a faithful copy of the
 *     real closure, so it is the actual files and the actual graph under test,
 *     not a toy.
 *  2. **New inputs are discovered.** Adding an import to a crawled file pulls
 *     the new module into the key with no list to update by hand, and a
 *     specifier that resolves to nothing today still moves the key when the
 *     file it names appears.
 *  3. **The real roots reach every step of `migrate()`** — including the four
 *     `src/db/migrations/*` modules it calls and the four modules it reaches
 *     only by lazy `import()`. Guarded against future drift by re-deriving
 *     `migrate.ts`'s specifiers independently.
 *  4. **The hit path does not lie.** A database restored from a cached
 *     snapshot has the same catalog and the same seed rows as one built by
 *     running `migrate()` for real.
 *  5. **Concurrency is safe.** Publication is an atomic rename, a reader never
 *     sees a partial entry, and every failure degrades to a miss.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { migrate } from "../db/migrate";
import * as schema from "../db/schema";
import {
  CACHE_KEEP,
  CACHE_MAX_AGE_MS,
  MIGRATE_ENV_KEYS,
  REPO_ROOT,
  SCHEMA_INPUT_ROOTS,
  SNAPSHOT_FILE_NAME,
  SNAPSHOT_MIME_TYPE,
  collectSchemaInputs,
  installedPgliteVersion,
  isSnapshotCacheEnabled,
  lockfileDigest,
  pruneSnapshotCache,
  readCachedSnapshot,
  resolveRelativeSpecifier,
  schemaFingerprint,
  snapshotCacheDir,
  snapshotEntryPath,
  writeCachedSnapshot,
} from "./helpers/pglite-snapshot-cache";

const tempDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ez-snapcache-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, rel: string, text: string): string {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/**
 * A faithful copy of the REAL schema-input closure, with its relative
 * structure preserved so every import resolves inside the copy exactly as it
 * does in the repo. This is what lets the invalidation proof below run against
 * the actual `migrate.ts` and the actual `src/db/migrations/*` modules rather
 * than a fixture that only resembles them.
 */
function copyRealClosure(): { dir: string; roots: string[]; pathOf: (repoRel: string) => string } {
  const dir = tmp("realclosure");
  const { files } = collectSchemaInputs(SCHEMA_INPUT_ROOTS);
  for (const file of files) {
    const dest = join(dir, relative(REPO_ROOT, file));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
  }
  return {
    dir,
    roots: SCHEMA_INPUT_ROOTS.map((r) => join(dir, relative(REPO_ROOT, r))),
    pathOf: (repoRel: string) => join(dir, repoRel),
  };
}

const NO_ENV: Record<string, string | undefined> = {};

describe("cache key — invalidation on a real schema change", () => {
  test("editing src/db/migrate.ts moves the key and the cache MISSES", async () => {
    const { dir, roots, pathOf } = copyRealClosure();
    const cacheDir = tmp("cache");
    const before = schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV });

    // The entry a previous run would have published.
    await writeCachedSnapshot(before, new Blob(["migrated-datadir"]), { dir: cacheDir, env: NO_ENV });
    expect(await readCachedSnapshot(before, { dir: cacheDir, env: NO_ENV })).toBeDefined();

    // A schema change of exactly the shape this cache must never hide.
    const migratePath = pathOf("src/db/migrate.ts");
    writeFileSync(
      migratePath,
      `${readFileSync(migratePath, "utf8")}\n// await db.execute(sql\`ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT\`)\n`,
    );

    const after = schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV });
    expect(after).not.toBe(before);
    expect(await readCachedSnapshot(after, { dir: cacheDir, env: NO_ENV })).toBeUndefined();
  });

  test("editing a src/db/migrations/* module three hops down the graph also misses", async () => {
    const { dir, roots, pathOf } = copyRealClosure();
    const cacheDir = tmp("cache");
    const before = schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV });
    await writeCachedSnapshot(before, new Blob(["migrated-datadir"]), { dir: cacheDir, env: NO_ENV });

    // Not imported by the roots directly: migrate.ts imports it, and it is one
    // of the named modules the brief warns about.
    const modulePath = pathOf("src/db/migrations/claim-ownerless-kb-files-once.ts");
    expect(existsSync(modulePath)).toBe(true);
    writeFileSync(modulePath, `${readFileSync(modulePath, "utf8")}\n// schema-affecting edit\n`);

    const after = schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV });
    expect(after).not.toBe(before);
    expect(await readCachedSnapshot(after, { dir: cacheDir, env: NO_ENV })).toBeUndefined();
    // …and the entry that IS there is still readable under its own key, so the
    // miss is invalidation, not a broken cache.
    expect(await readCachedSnapshot(before, { dir: cacheDir, env: NO_ENV })).toBeDefined();
  });

  test("editing src/db/schema.ts moves the key", () => {
    const { dir, roots, pathOf } = copyRealClosure();
    const before = schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV });
    const schemaPath = pathOf("src/db/schema.ts");
    writeFileSync(schemaPath, `${readFileSync(schemaPath, "utf8")}\n// column mapper change\n`);
    expect(schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV })).not.toBe(before);
  });

  test("editing the test helper (it owns the extension set) moves the key", () => {
    const { dir, roots, pathOf } = copyRealClosure();
    const before = schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV });
    const helper = pathOf("src/__tests__/helpers/test-pglite.ts");
    writeFileSync(helper, `${readFileSync(helper, "utf8")}\n// EXTENSIONS changed\n`);
    expect(schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV })).not.toBe(before);
  });

  test("an unrelated edit outside the closure does NOT move the key", () => {
    const { dir, roots } = copyRealClosure();
    const before = schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV });
    write(dir, "src/db/not-imported-by-anything.ts", "export const x = 1;\n");
    expect(schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV })).toBe(before);
  });
});

describe("cache key — inputs beyond the source closure", () => {
  test("a self-project env var that seeds a row moves the key", () => {
    const { dir, roots } = copyRealClosure();
    const base = schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV });
    for (const key of MIGRATE_ENV_KEYS) {
      expect(schemaFingerprint({ roots, repoRoot: dir, env: { [key]: "/some/path" } })).not.toBe(base);
    }
  });

  test("the lockfile is an input, and its absence is a defined value", () => {
    const withoutLock = tmp("nolock");
    const root = write(withoutLock, "root.ts", "export const a = 1;\n");
    expect(lockfileDigest(withoutLock)).toBe("none");
    const before = schemaFingerprint({ roots: [root], repoRoot: withoutLock, env: NO_ENV });

    writeFileSync(join(withoutLock, "bun.lock"), '{"lockfileVersion": 1}');
    expect(lockfileDigest(withoutLock)).not.toBe("none");
    expect(schemaFingerprint({ roots: [root], repoRoot: withoutLock, env: NO_ENV })).not.toBe(before);
  });

  test("the installed pglite version is found by walking up to the real node_modules", () => {
    // A git worktree has no node_modules of its own — resolution must walk up
    // to the main checkout, or the datadir format would drop out of the key.
    expect(installedPgliteVersion()).toMatch(/^\d+\.\d+\.\d+/);
    // Nothing above a fresh temp dir, so the walk terminates instead of looping.
    expect(installedPgliteVersion(tmp("nonm"))).toBe("unknown");
  });
});

describe("closure crawl", () => {
  test("follows static, side-effect, re-export, dynamic and require specifiers", () => {
    const dir = tmp("crawl");
    write(dir, "dep.ts", "export const a = 1;\n");
    write(dir, "side.ts", "export const b = 2;\n");
    write(dir, "sub/re.ts", "export const c = 3;\n");
    write(dir, "dyn.ts", "export const d = 4;\n");
    write(dir, "pkg/index.ts", "export const e = 5;\n");
    write(dir, "esm.ts", "export const f = 6;\n");
    const root = write(
      dir,
      "root.ts",
      [
        'import { a } from "./dep";',
        'import "./side";',
        'export * from "./sub/re";',
        'const d = await import("./dyn");',
        'const p = require("./pkg");',
        'import { f } from "./esm.js";',
        'import nothing from "./nope";',
        'import external from "drizzle-orm";',
      ].join("\n"),
    );

    const { files, unresolved } = collectSchemaInputs([root]);
    const rel = files.map((f) => relative(dir, f)).sort();
    expect(rel).toEqual(["dep.ts", "dyn.ts", "esm.ts", "pkg/index.ts", "root.ts", "side.ts", "sub/re.ts"]);
    expect(unresolved.some((u) => u.endsWith("-> ./nope"))).toBe(true);
    // Bare specifiers are dependencies, not closure members — they are pinned
    // by the lockfile input instead.
    expect(rel.some((r) => r.includes("drizzle"))).toBe(false);
  });

  test("terminates on an import cycle", () => {
    const dir = tmp("cycle");
    const a = write(dir, "a.ts", 'import "./b";\nexport const a = 1;\n');
    write(dir, "b.ts", 'import "./a";\nexport const b = 2;\n');
    expect(collectSchemaInputs([a]).files.map((f) => relative(dir, f)).sort()).toEqual(["a.ts", "b.ts"]);
  });

  test("adding an import to a crawled file adds it to the key with no list to update", () => {
    const dir = tmp("newimport");
    const root = write(dir, "root.ts", 'import "./dep";\n');
    write(dir, "dep.ts", "export const a = 1;\n");
    const before = schemaFingerprint({ roots: [root], repoRoot: dir, env: NO_ENV });

    write(dir, "added.ts", "export const b = 2;\n");
    writeFileSync(root, 'import "./dep";\nimport "./added";\n');

    expect(collectSchemaInputs([root]).files.map((f) => relative(dir, f)).sort()).toEqual([
      "added.ts",
      "dep.ts",
      "root.ts",
    ]);
    expect(schemaFingerprint({ roots: [root], repoRoot: dir, env: NO_ENV })).not.toBe(before);
  });

  test("a specifier that resolves to nothing today still moves the key when its file appears", () => {
    const dir = tmp("appears");
    const root = write(dir, "root.ts", 'import "./later";\n');
    expect(collectSchemaInputs([root]).unresolved.some((u) => u.endsWith("-> ./later"))).toBe(true);
    const before = schemaFingerprint({ roots: [root], repoRoot: dir, env: NO_ENV });

    write(dir, "later.ts", "export const x = 1;\n");
    expect(schemaFingerprint({ roots: [root], repoRoot: dir, env: NO_ENV })).not.toBe(before);
  });

  test("an unreadable root is recorded by name rather than silently dropped", () => {
    const dir = tmp("missingroot");
    const ghost = join(dir, "ghost.ts");
    const { files, unresolved } = collectSchemaInputs([ghost]);
    expect(files).toEqual([]);
    expect(unresolved).toEqual([`${relative(REPO_ROOT, ghost)} -> <unreadable>`]);
  });

  test("a directory is never mistaken for a module", () => {
    const dir = tmp("dirspec");
    mkdirSync(join(dir, "plain"), { recursive: true });
    const from = write(dir, "from.ts", "export const x = 1;\n");
    expect(resolveRelativeSpecifier(from, "./plain")).toBeUndefined();
    expect(resolveRelativeSpecifier(from, "./nothing")).toBeUndefined();
  });

  test("the fingerprint is stable when nothing changes", () => {
    const { dir, roots } = copyRealClosure();
    expect(schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV })).toBe(
      schemaFingerprint({ roots, repoRoot: dir, env: NO_ENV }),
    );
    // The real one is a hex sha256 and is path-independent (repo-relative
    // names are hashed, not absolute ones), so CI and a worktree agree.
    expect(schemaFingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the real roots reach every step of migrate()", () => {
  const closure = collectSchemaInputs(SCHEMA_INPUT_ROOTS);
  const inClosure = (repoRel: string) => closure.files.includes(join(REPO_ROOT, repoRel));

  test("covers the roots, the named migration modules, and the lazily-imported ones", () => {
    for (const repoRel of [
      "src/db/migrate.ts",
      "src/db/schema.ts",
      "src/__tests__/helpers/test-pglite.ts",
      // Seeds rows.
      "src/db/seed-self-project.ts",
      // The four named modules migrate() calls.
      "src/db/migrations/add-user-commands-unique-name.ts",
      "src/db/migrations/backfill-api-key-write-scope.ts",
      "src/db/migrations/claim-ownerless-kb-files-once.ts",
      "src/db/migrations/normalize-extension-state-root.ts",
      // Reached ONLY through `await import(...)` — a crawl that followed
      // static imports alone would miss all four.
      "src/extensions/bundled.ts",
      "src/db/queries/extensions.ts",
      "src/db/queries/workflow-versions.ts",
      "src/db/queries/workflow-runs.ts",
      // Runs a backfill at the end of migrate().
      "src/extensions/secrets-store.ts",
    ]) {
      expect(inClosure(repoRel)).toBe(true);
    }
  });

  test("drift guard: every resolvable specifier in migrate.ts is in the closure", () => {
    // Re-derived here from the file text, independently of the crawl, so an
    // import added to migrate.ts tomorrow cannot quietly leave the key.
    const migratePath = join(REPO_ROOT, "src/db/migrate.ts");
    const text = readFileSync(migratePath, "utf8");
    const specs = [...text.matchAll(/["'](\.[^"']*)["']/g)].map((m) => m[1] as string);
    expect(specs.length).toBeGreaterThan(5);

    const resolved = specs
      .map((s) => resolveRelativeSpecifier(migratePath, s))
      .filter((p): p is string => p !== undefined);
    expect(resolved.length).toBeGreaterThan(5);
    for (const path of resolved) expect(closure.files).toContain(path);
  });

  test("the closure is broad enough to be a superset of src/db", () => {
    // Sanity floor on the crawl: if a resolution bug collapsed it to a handful
    // of files the fingerprint would still be "stable", just blind.
    expect(closure.files.length).toBeGreaterThan(200);
  });
});

describe("cache storage", () => {
  test("round trip: miss, publish, hit with identical bytes, and a different key still misses", async () => {
    const dir = tmp("cache");
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    expect(await readCachedSnapshot("k1", { dir, env: NO_ENV })).toBeUndefined();
    expect(await writeCachedSnapshot("k1", new Blob([bytes]), { dir, env: NO_ENV })).toBe(true);

    const hit = await readCachedSnapshot("k1", { dir, env: NO_ENV });
    expect(hit).toBeDefined();
    expect(new Uint8Array(await (hit as Blob).arrayBuffer())).toEqual(bytes);
    expect(await readCachedSnapshot("k2", { dir, env: NO_ENV })).toBeUndefined();
  });

  test("publication is atomic — no temp file survives a successful write", async () => {
    const dir = tmp("cache");
    await writeCachedSnapshot("k1", new Blob(["x"]), { dir, env: NO_ENV });
    expect(readdirSync(dir)).toEqual(["migrated-k1.tar"]);
    expect(readdirSync(dir).some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(existsSync(snapshotEntryPath(dir, "k1"))).toBe(true);
  });

  test("a write to an unwritable location degrades to a miss instead of throwing", async () => {
    const dir = tmp("cache");
    // A FILE where the cache directory should be: mkdirSync throws ENOTDIR.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");
    expect(await writeCachedSnapshot("k1", new Blob(["x"]), { dir: blocked, env: NO_ENV })).toBe(false);
    expect(await readCachedSnapshot("k1", { dir: blocked, env: NO_ENV })).toBeUndefined();
  });

  test("prune keeps the newest entries, spares foreign files, and tolerates a racing directory", () => {
    const dir = tmp("cache");
    // Distinct, ascending mtimes so "newest" is well defined (four writes in
    // the same millisecond would make the order arbitrary).
    for (const [i, key] of ["a", "b", "c", "d"].entries()) {
      const path = snapshotEntryPath(dir, key);
      writeFileSync(path, key);
      const stamp = new Date(Date.now() + i * 1000);
      utimesSync(path, stamp, stamp);
    }
    // Unrelated files are never touched — the cache owns only its own names.
    writeFileSync(join(dir, "README"), "keep me");

    expect(pruneSnapshotCache(dir, CACHE_KEEP)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["README", "migrated-c.tar", "migrated-d.tar"]);

    expect(pruneSnapshotCache(dir, 1)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["README", "migrated-d.tar"]);

    // A directory that does not exist is abandoned, not thrown.
    expect(pruneSnapshotCache(join(dir, "gone"), 1)).toBe(-1);
  });

  test("prune reaps a temp file a killed process left behind, but never one in flight", () => {
    const dir = tmp("cache");
    const live = join(dir, "migrated-x.tar.999.abc.tmp");
    const dead = join(dir, "migrated-y.tar.998.def.tmp");
    writeFileSync(live, "in flight");
    writeFileSync(dead, "orphaned by a SIGKILL");
    const longAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
    utimesSync(dead, longAgo, longAgo);

    expect(pruneSnapshotCache(dir, CACHE_KEEP)).toBe(1);
    expect(readdirSync(dir)).toEqual(["migrated-x.tar.999.abc.tmp"]);
  });

  test("a successful write prunes, so the cache cannot grow without bound", async () => {
    const dir = tmp("cache");
    for (const key of ["a", "b", "c", "d", "e"]) {
      await writeCachedSnapshot(key, new Blob([key]), { dir, env: NO_ENV });
    }
    expect(readdirSync(dir).length).toBe(CACHE_KEEP);
    // The key just written always survives its own prune.
    expect(existsSync(snapshotEntryPath(dir, "e"))).toBe(true);
  });

  test("an entry older than the max age is a miss, so frozen NOW() cannot drift far", async () => {
    const dir = tmp("cache");
    await writeCachedSnapshot("aged", new Blob(["x"]), { dir, env: NO_ENV });
    const path = snapshotEntryPath(dir, "aged");

    const justInside = new Date(Date.now() - CACHE_MAX_AGE_MS + 60_000);
    utimesSync(path, justInside, justInside);
    expect(await readCachedSnapshot("aged", { dir, env: NO_ENV })).toBeDefined();

    const justOutside = new Date(Date.now() - CACHE_MAX_AGE_MS - 60_000);
    utimesSync(path, justOutside, justOutside);
    expect(await readCachedSnapshot("aged", { dir, env: NO_ENV })).toBeUndefined();
    // Expiry is a miss, not a deletion — a rebuild republishes over it.
    expect(existsSync(path)).toBe(true);
  });

  test("EZ_PGLITE_SNAPSHOT_CACHE=0 disables both halves", async () => {
    const dir = tmp("cache");
    const off = { EZ_PGLITE_SNAPSHOT_CACHE: "0" };
    expect(isSnapshotCacheEnabled(off)).toBe(false);
    expect(isSnapshotCacheEnabled(NO_ENV)).toBe(true);
    expect(await writeCachedSnapshot("k1", new Blob(["x"]), { dir, env: off })).toBe(false);
    expect(existsSync(dir) && readdirSync(dir).length).toBeFalsy();

    await writeCachedSnapshot("k1", new Blob(["x"]), { dir, env: NO_ENV });
    expect(await readCachedSnapshot("k1", { dir, env: off })).toBeUndefined();
  });

  test("the cache is cwd-independent — a process.chdir() must not move it", () => {
    // Suites that use `useTempProjectRoot()` process.chdir() into a throwaway
    // root and `rm -rf` it on cleanup, and several of them call setupTestDb().
    // A cwd-relative cache dir would write entries INTO that root and have
    // them deleted — a silent 100% miss rate, not an error. Everything here is
    // anchored on `import.meta.dir` for exactly that reason; this pins it.
    const dirBefore = snapshotCacheDir(NO_ENV);
    const keyBefore = schemaFingerprint();
    expect(isAbsolute(dirBefore)).toBe(true);
    expect(SCHEMA_INPUT_ROOTS.every(isAbsolute)).toBe(true);

    const cwd = process.cwd();
    try {
      process.chdir(tmp("chdir"));
      expect(snapshotCacheDir(NO_ENV)).toBe(dirBefore);
      expect(SCHEMA_INPUT_ROOTS.every((r) => existsSync(r))).toBe(true);
      expect(schemaFingerprint()).toBe(keyBefore);
    } finally {
      process.chdir(cwd);
    }
  });

  test("the default cache dir is repo-local scratch, and is overridable", () => {
    expect(snapshotCacheDir(NO_ENV)).toBe(join(REPO_ROOT, ".cache", "pglite-snapshots"));
    expect(snapshotCacheDir({ EZ_PGLITE_SNAPSHOT_CACHE_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
    // `.cache` is gitignored, so entries can never be committed.
    expect(readFileSync(join(REPO_ROOT, ".gitignore"), "utf8")).toMatch(/^\.cache$/m);
  });
});

describe("the hit path does not lie", () => {
  const EXTENSIONS = { vector, pg_trgm } as const;

  async function digest(pg: PGlite): Promise<string> {
    const columns = await pg.query<Record<string, unknown>>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = 'public'
        ORDER BY table_name, column_name`,
    );
    const indexes = await pg.query<Record<string, unknown>>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
    );
    const projects = await pg.query<{ id: string }>("SELECT id FROM projects ORDER BY id");
    const exts = await pg.query<{ id: string }>("SELECT id FROM extensions ORDER BY id");
    return JSON.stringify([columns.rows, indexes.rows, projects.rows, exts.rows]);
  }

  test("a database restored from a cached snapshot matches one built by migrate()", async () => {
    const dir = tmp("cache");

    // Build once, exactly as test-pglite.ts does, and publish it.
    const seed = new PGlite({ extensions: EXTENSIONS });
    await seed.waitReady;
    await migrate(drizzle(seed, { schema }));
    const built = await digest(seed);
    const snapshot = await seed.dumpDataDir("none");
    await seed.close();
    expect(await writeCachedSnapshot("e2e", snapshot, { dir, env: NO_ENV })).toBe(true);

    // Read it back from DISK — a different process would see exactly this.
    const cached = await readCachedSnapshot("e2e", { dir, env: NO_ENV });
    expect(cached).toBeDefined();
    const restored = new PGlite({ loadDataDir: cached, extensions: EXTENSIONS });
    await restored.waitReady;
    expect(await digest(restored)).toBe(built);

    // The extensions registered at construction are live on the restored
    // instance too — pg_trgm's similarity() would 42883 otherwise.
    const sim = await restored.query<{ s: number }>("SELECT similarity('cat', 'cats') AS s");
    expect(sim.rows[0]?.s).toBeGreaterThan(0);
    await restored.close();
  }, 60_000);

  test("the round trip preserves the name and type loadDataDir sniffs", async () => {
    // PGlite decides gunzip-vs-plain from the blob's TYPE and NAME. Dropping
    // them on the way through disk is accidentally right for an uncompressed
    // dump and silently wrong for a gzipped one — so pin the pair against what
    // dumpDataDir actually returns. If the helper ever switches to
    // dumpDataDir("gzip"), this goes red instead of the cache going corrupt.
    const dir = tmp("cache");
    const blank = new PGlite({ extensions: EXTENSIONS });
    await blank.waitReady;
    const dumped = await blank.dumpDataDir("none");
    await blank.close();

    expect(dumped).toBeInstanceOf(File);
    expect((dumped as File).name).toBe(SNAPSHOT_FILE_NAME);
    expect(dumped.type).toBe(SNAPSHOT_MIME_TYPE);

    await writeCachedSnapshot("roundtrip", dumped, { dir, env: NO_ENV });
    const back = await readCachedSnapshot("roundtrip", { dir, env: NO_ENV });
    expect(back).toBeInstanceOf(File);
    expect((back as File).name).toBe((dumped as File).name);
    expect((back as File).type).toBe(dumped.type);
    expect((back as File).size).toBe(dumped.size);
  }, 60_000);

  test("a restored snapshot is a private copy — writes cannot leak between tests", async () => {
    const dir = tmp("cache");
    const seed = new PGlite({ extensions: EXTENSIONS });
    await seed.waitReady;
    await migrate(drizzle(seed, { schema }));
    const snapshot = await seed.dumpDataDir("none");
    await seed.close();
    await writeCachedSnapshot("iso", snapshot, { dir, env: NO_ENV });

    const first = new PGlite({ loadDataDir: await readCachedSnapshot("iso", { dir, env: NO_ENV }), extensions: EXTENSIONS });
    await first.waitReady;
    await first.query("INSERT INTO projects (id, name, path) VALUES ('leak-probe', 'x', '/')");
    await first.close();

    const second = new PGlite({ loadDataDir: await readCachedSnapshot("iso", { dir, env: NO_ENV }), extensions: EXTENSIONS });
    await second.waitReady;
    const rows = await second.query<{ id: string }>("SELECT id FROM projects WHERE id = 'leak-probe'");
    expect(rows.rows).toEqual([]);
    await second.close();
  }, 60_000);
});
