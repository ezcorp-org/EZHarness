/**
 * Cross-process cache of the MIGRATED PGlite datadir.
 *
 * WHY. Every DB-touching backend test file is its own bun process, and each
 * one builds the same migrated database from scratch: boot a blank PGlite
 * (~600ms), replay all of `migrate()` (~400ms), dump the datadir (~70ms).
 * Restoring a prepared datadir instead costs ~270ms — and 399 files import
 * `test-pglite.ts`. Doing the build once per POOL RUN rather than once per
 * PROCESS is the last large lever left on the suite's wall clock.
 *
 * ## The cache key is the deliverable, not the cache
 *
 * A stale entry is a FALSE GREEN on schema: every test would run against the
 * old database and pass, and the gate that exists to catch schema mistakes
 * becomes the thing hiding them. That failure is silent, which makes it worse
 * than the slowness it buys. So the key must move whenever anything that can
 * change the resulting datadir changes. This repo has NO numbered migrations
 * and no version table — `migrate()` is one big idempotent function — so there
 * is no version number to key on. The key is a content hash instead, over:
 *
 *  1. **The transitive relative-import closure of `src/db/migrate.ts`.** Not
 *     just `migrate.ts`: it calls into `seed-self-project.ts`, four named
 *     modules under `src/db/migrations/`, `extensions/secrets-store.ts`, and
 *     (by deliberate lazy import, to break a require cycle) `queries/
 *     extensions.ts`, `queries/workflow-versions.ts`, `queries/
 *     workflow-runs.ts` and `extensions/bundled.ts`. The crawl follows static
 *     imports, `export … from`, `require()` AND `import()` so a lazily-reached
 *     migration step cannot slip past it. It is deliberately over-broad
 *     (377 files today): over-invalidation costs ONE rebuild per pool run,
 *     under-invalidation costs correctness.
 *  2. **`src/db/schema.ts`.** Not a DDL input, but the snapshot is only ever
 *     consumed through `drizzle(pglite, { schema })`, so its column mappers
 *     decide what a write against the restored DB means. It is already inside
 *     (1) via `connection.ts`; naming it a root keeps that true after a
 *     refactor that breaks the path.
 *  3. **`src/__tests__/helpers/test-pglite.ts`.** It owns the extension set
 *     registered at construction (`vector`, `pg_trgm` — which must be present
 *     at build AND at restore) and the dump format. Either change alters what
 *     the snapshot means.
 *  4. **Unresolved relative specifiers, by their raw text.** A specifier that
 *     resolves to nothing today (a path in a doc comment, or a module not yet
 *     written) still contributes, so ADDING the file it names moves the key.
 *  5. **The installed `@electric-sql/pglite` version.** The datadir is a
 *     binary Postgres data directory produced by a specific WASM build.
 *     Feeding one from another version to `loadDataDir` is exactly the silent
 *     mismatch this cache must not create.
 *  6. **`bun.lock`.** Pins every other dependency exactly — cheaper and more
 *     complete than hashing `node_modules`.
 *  7. **The env vars `migrate()` reads that WRITE ROWS** (`seedSelfProject`).
 *     Set `EZCORP_SELF_PROJECT_PATH` and the migrated DB gains a project row.
 *  8. **A format constant**, so changing the cache's own encoding invalidates
 *     every entry without anyone having to remember to clear a directory.
 *
 * Deliberately NOT in the key, with reasons:
 *  - `getProjectRoot()`, threaded into `normalize-extension-state-root`. That
 *    migration is UPDATE-only, so on the fresh database this cache snapshots
 *    it writes nothing. The cache directory is repo-local anyway, so two
 *    checkouts never share an entry.
 *  - The contents of `node_modules`. Pinned by (5) + (6).
 *
 * ## Concurrency
 *
 * The pool runs many processes at once and they all start cold together, so
 * several may build and write the same key simultaneously. Writes go to a
 * per-process temp file and are published with `rename(2)`, which is atomic
 * within a directory on Linux: a reader sees either no entry or a complete
 * one, never a half-written datadir. First writer wins; a later identical
 * write simply replaces it atomically. A read that fails for ANY reason
 * returns `undefined`, and the caller falls back to a real `migrate()` — the
 * cache can only ever make the suite slower, never wrong.
 *
 * Entries also expire on age (`CACHE_MAX_AGE_MS`) — not for schema staleness,
 * which the key handles, but to bound the one thing a restored datadir really
 * does carry: the frozen `NOW()` of its seeded rows.
 *
 * Escape hatches: `EZ_PGLITE_SNAPSHOT_CACHE=0` disables it entirely,
 * `EZ_PGLITE_SNAPSHOT_CACHE_DIR` relocates it, and deleting the directory is
 * always safe.
 *
 * `node:fs` sync reads (not `Bun.file`) are used for the crawl on purpose:
 * fingerprinting is a synchronous whole-closure read of ~380 small files
 * (~6ms), and awaiting each one individually is strictly slower.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Repo root: this file lives at `<root>/src/__tests__/helpers/`. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/**
 * Bump to invalidate every existing entry — e.g. if the dump format, the
 * extension set's meaning, or this file's hashing scheme changes in a way the
 * content hash itself would not catch.
 */
export const CACHE_FORMAT = 1;

/** How many entries survive a prune (current key + one previous). */
export const CACHE_KEEP = 2;

/**
 * Entries expire after a day.
 *
 * The one thing a restored datadir carries that a freshly-migrated one does
 * not is FROZEN TIME: every seeded row's `created_at DEFAULT NOW()` is stamped
 * when the snapshot was built. In-process that was always true and always
 * seconds old; across processes it could otherwise be weeks. This bounds the
 * skew a suite can ever observe on a seeded row to something on the order of
 * the in-process behaviour it replaces, at a cost of at most one extra rebuild
 * per day. It is a bound, not a correctness mechanism — schema staleness is
 * handled by the key, which is a content hash and does not expire.
 */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Crawl roots. See the module header for why each one is here. Order is
 * irrelevant — the closure is sorted before hashing.
 */
export const SCHEMA_INPUT_ROOTS: readonly string[] = [
  join(REPO_ROOT, "src", "db", "migrate.ts"),
  join(REPO_ROOT, "src", "db", "schema.ts"),
  join(REPO_ROOT, "src", "__tests__", "helpers", "test-pglite.ts"),
];

/**
 * Env vars `migrate()` reads that change the ROWS in the migrated database.
 * `seedSelfProject` inserts a `projects` row (and a `settings` row) when
 * `EZCORP_SELF_PROJECT_PATH` is set, named by `EZCORP_SELF_PROJECT_NAME`.
 *
 * `src/__tests__/preload.ts:49` already deletes the first of these before any
 * suite runs, for exactly this reason ("would leak into test-pglite's cached
 * migrated snapshot"). Keying on it too is belt and braces: preload stops the
 * value reaching `migrate()`, and this stops two differently-configured runs
 * ever sharing one entry if that scrub is removed or bypassed.
 */
export const MIGRATE_ENV_KEYS: readonly string[] = [
  "EZCORP_SELF_PROJECT_PATH",
  "EZCORP_SELF_PROJECT_NAME",
];

/**
 * Relative module specifiers, in every form that can reach a migration step:
 * `import … from "./x"`, bare `import "./x"`, `export … from "./x"`,
 * `import("./x")` and `require("./x")`. Comments and strings match too — that
 * is over-inclusion, which is the safe direction (see the module header).
 */
const RELATIVE_SPEC_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*)\(?\s*["'](\.[^"']*)["']/g;

const ENTRY_PREFIX = "migrated-";
const ENTRY_SUFFIX = ".tar";
/** A temp file older than this belongs to a process that will never finish. */
const ABANDONED_TMP_MS = 60 * 60 * 1000;

/**
 * `dumpDataDir("none")` hands back a `File` named `pgdata.tar` typed
 * `application/x-tar` — and `loadDataDir` SNIFFS both on the way back in:
 * an `application/x-gzip`-family type, or a `.tgz`/`.tar.gz` name, makes it
 * gunzip the bytes before untarring (verified in
 * `@electric-sql/pglite/dist/chunk-*.js`).
 *
 * A bare `new Blob([bytes])` carries neither, which is ACCIDENTALLY right for
 * an uncompressed dump and would be silently wrong the day the helper switches
 * to `dumpDataDir("gzip")`: the in-process path would keep working (it still
 * has the original `File`) and only the disk round trip would break. So an
 * entry is rehydrated with the same name and type it was dumped with, and the
 * test suite pins that pair against what `dumpDataDir` actually returns.
 */
export const SNAPSHOT_FILE_NAME = "pgdata.tar";
export const SNAPSHOT_MIME_TYPE = "application/x-tar";

export type SchemaInputs = {
  /** Absolute paths of every readable file in the closure, sorted. */
  files: string[];
  /** `<relative-source> -> <specifier>` for every specifier that resolved to nothing, sorted. */
  unresolved: string[];
};

type CacheOptions = {
  dir?: string;
  env?: Record<string, string | undefined>;
};

/**
 * Resolve a relative specifier the way bun does for this repo's TypeScript:
 * exact file, `.ts`, directory `index.ts`, and the TS-ESM `./x.js` spelling
 * of `./x.ts`. Returns `undefined` when nothing on disk matches.
 */
export function resolveRelativeSpecifier(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base.replace(/\.js$/, ".ts")];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/**
 * Transitive relative-import closure of `roots`. Cycle-safe (`migrate.ts` →
 * `queries/extensions.ts` → `connection.ts` → `migrate.ts` is a real one).
 */
export function collectSchemaInputs(roots: readonly string[]): SchemaInputs {
  const files = new Set<string>();
  const unresolved = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (files.has(file)) continue;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      // A root (or a path that passed existsSync then vanished) is not
      // readable. Record it by NAME so the key still moves if it appears.
      unresolved.add(`${relative(REPO_ROOT, file)} -> <unreadable>`);
      continue;
    }
    files.add(file);
    for (const match of text.matchAll(RELATIVE_SPEC_RE)) {
      const spec = match[1] as string;
      const target = resolveRelativeSpecifier(file, spec);
      if (target) stack.push(target);
      else unresolved.add(`${relative(REPO_ROOT, file)} -> ${spec}`);
    }
  }
  return { files: [...files].sort(), unresolved: [...unresolved].sort() };
}

/**
 * Version of the INSTALLED `@electric-sql/pglite`, found by walking up from
 * `startDir` — a git worktree has no `node_modules` of its own and resolves
 * against the main checkout's. `"unknown"` when it cannot be found, which
 * keeps the fingerprint defined (and constant) rather than throwing.
 */
export function installedPgliteVersion(startDir: string = REPO_ROOT): string {
  let dir = resolve(startDir);
  for (;;) {
    const manifest = join(dir, "node_modules", "@electric-sql", "pglite", "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
      return parsed.version ?? "unknown";
    }
    const parent = dirname(dir);
    if (parent === dir) return "unknown";
    dir = parent;
  }
}

/** sha256 of `bun.lock` (every other dependency, pinned), or `"none"`. */
export function lockfileDigest(repoRoot: string = REPO_ROOT): string {
  const lock = join(repoRoot, "bun.lock");
  if (!existsSync(lock)) return "none";
  return new Bun.CryptoHasher("sha256").update(readFileSync(lock)).digest("hex");
}

/**
 * The cache key: a hex sha256 over every input that can change the migrated
 * datadir. Injectable so the staleness proof can drive it over a fixture tree
 * instead of the real one.
 */
export function schemaFingerprint(
  options: {
    roots?: readonly string[];
    env?: Record<string, string | undefined>;
    repoRoot?: string;
  } = {},
): string {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const roots = options.roots ?? SCHEMA_INPUT_ROOTS;
  const env = options.env ?? process.env;
  const { files, unresolved } = collectSchemaInputs(roots);

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`format:${CACHE_FORMAT}\n`);
  for (const file of files) {
    hasher.update(`file:${relative(repoRoot, file)}\n`);
    hasher.update(readFileSync(file));
    hasher.update("\n");
  }
  for (const miss of unresolved) hasher.update(`unresolved:${miss}\n`);
  hasher.update(`pglite:${installedPgliteVersion(repoRoot)}\n`);
  hasher.update(`lock:${lockfileDigest(repoRoot)}\n`);
  for (const key of MIGRATE_ENV_KEYS) hasher.update(`env:${key}=${env[key] ?? ""}\n`);
  return hasher.digest("hex");
}

/** `EZ_PGLITE_SNAPSHOT_CACHE=0` turns the cache off completely. */
export function isSnapshotCacheEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.EZ_PGLITE_SNAPSHOT_CACHE !== "0";
}

/** Repo-local scratch (`.cache` is gitignored), or `EZ_PGLITE_SNAPSHOT_CACHE_DIR`. */
export function snapshotCacheDir(env: Record<string, string | undefined> = process.env): string {
  return env.EZ_PGLITE_SNAPSHOT_CACHE_DIR ?? join(REPO_ROOT, ".cache", "pglite-snapshots");
}

/** Absolute path of the entry for `key`. */
export function snapshotEntryPath(dir: string, key: string): string {
  return join(dir, `${ENTRY_PREFIX}${key}${ENTRY_SUFFIX}`);
}

/**
 * Read a cached datadir. Returns `undefined` — never throws — for a miss, a
 * disabled cache, or an unreadable entry, so the caller always has the option
 * of building for real.
 */
export async function readCachedSnapshot(key: string, options: CacheOptions = {}): Promise<File | undefined> {
  const env = options.env ?? process.env;
  if (!isSnapshotCacheEnabled(env)) return undefined;
  const path = snapshotEntryPath(options.dir ?? snapshotCacheDir(env), key);
  try {
    if (Date.now() - statSync(path).mtimeMs > CACHE_MAX_AGE_MS) return undefined;
    // Name and type restored, not dropped — see SNAPSHOT_FILE_NAME.
    return new File([await Bun.file(path).arrayBuffer()], SNAPSHOT_FILE_NAME, { type: SNAPSHOT_MIME_TYPE });
  } catch {
    // Miss, or an entry that raced with a prune. Either way the caller
    // migrates for real — the cache is never load-bearing for correctness.
    return undefined;
  }
}

/**
 * Publish a datadir under `key`. Writes a per-process temp file and installs
 * it with an atomic `rename(2)`, so a concurrent reader can never observe a
 * partial entry. Returns whether an entry was published.
 */
export async function writeCachedSnapshot(
  key: string,
  data: Blob,
  options: CacheOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  if (!isSnapshotCacheEnabled(env)) return false;
  const dir = options.dir ?? snapshotCacheDir(env);
  const final = snapshotEntryPath(dir, key);
  const tmp = `${final}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    // A rejected write leaves only the temp file, which is never renamed —
    // so a failed write can produce a miss but never a corrupt entry.
    await Bun.write(tmp, data);
    renameSync(tmp, final);
  } catch {
    // Read-only or full disk, or a racing prune removed the directory.
    // Caching is opportunistic; the snapshot we already hold is still good.
    try {
      unlinkSync(tmp);
    } catch {
      // Never created, or already cleaned up.
    }
    return false;
  }
  pruneSnapshotCache(dir, CACHE_KEEP);
  return true;
}

/**
 * Keep the `keep` most recently modified entries, delete the rest — plus any
 * temp file abandoned by a process that was killed mid-write (a SIGKILLed pool
 * would otherwise leak a 33MB file it can never claim). "Abandoned" is defined
 * by age so a write in flight in another process is never touched.
 *
 * Returns the number of files deleted, or `-1` if the prune was abandoned (a
 * concurrent pool process removed an entry between `readdir` and `unlink`, or
 * the directory is gone). Abandoning is safe: the next write prunes again.
 */
export function pruneSnapshotCache(dir: string, keep: number): number {
  try {
    const names = readdirSync(dir).filter((name) => name.startsWith(ENTRY_PREFIX));
    const withMtime = names.map((name) => {
      const path = join(dir, name);
      return { path, isEntry: name.endsWith(ENTRY_SUFFIX), mtimeMs: statSync(path).mtimeMs };
    });
    const doomed = withMtime
      .filter((f) => f.isEntry)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(keep)
      .concat(withMtime.filter((f) => !f.isEntry && Date.now() - f.mtimeMs > ABANDONED_TMP_MS));
    for (const file of doomed) unlinkSync(file.path);
    return doomed.length;
  } catch {
    // Raced with another pool process, or the directory does not exist.
    return -1;
  }
}
