/**
 * Project-root resolution — the single choke-point every on-disk lookup
 * in the host funnels through (`join(getProjectRoot(), …)`).
 *
 * WHY IT LIVES IN ITS OWN MODULE
 * ──────────────────────────────
 * This used to sit at the top of `./bundled.ts`, which has nothing to do
 * with resolving a filesystem root. That placement had a real cost:
 * `bundled.ts` pulls in `../db/queries/extensions`, so anything wanting
 * `getProjectRoot()` also pulled in the whole DB layer — and
 * `src/db/migrate.ts` needing the root closed the cycle
 * `migrate.ts → bundled.ts → db/queries/extensions.ts →
 * db/connection.ts → migrate.ts`. `migrate.ts` and
 * `src/startup/background-timers.ts` both worked around it with a
 * dynamic `import()`. This module's only non-builtin dependency is
 * `../logger`, so both are now plain static imports.
 *
 * `./bundled.ts` re-exports `getProjectRoot`, `resolveProjectRoot` and
 * `__resetProjectRootCacheForTests`, so every existing importer keeps
 * working with no edit; new code should import from here. (To count them:
 * `grep -rln 'getProjectRoot\|resolveProjectRoot' --include='*.ts' src web`.)
 *
 * RESOLUTION ORDER (first match wins) — works in both direct Bun
 * execution and SvelteKit bundled-server contexts (vite preview):
 *
 *   1. `EZCORP_PROJECT_ROOT` env var — explicit override. Validated: the
 *      path must exist AND contain `docs/extensions/examples/`. An env
 *      var pointing at a non-existent dir or one missing the bundled
 *      tree is ignored (not fail-closed, just falls through) so a stale
 *      shell env doesn't brick startup.
 *   2. Substring match on `import.meta.dir` / `import.meta.url` — works
 *      under direct `bun src/...` execution where this file's path
 *      contains `src/extensions/`. Cheapest path; preserves existing
 *      behavior for unit tests and host scripts.
 *   3. Walk up from `import.meta.dir` (or `process.cwd()` if the meta
 *      lookup failed) looking for a `.git` directory. Required for
 *      Vite-bundled `vite preview` where step 2 fails because the
 *      bundler rewrites `import.meta.url` to point inside
 *      `web/build/server/`. Result must also contain
 *      `docs/extensions/examples/` to be accepted — bare `.git` in a
 *      vendor dir isn't enough.
 *   4. Fallback to `process.cwd()`.
 *
 * STEP 4 IS THE PRODUCTION PATH — it is not an error branch. In the
 * shipped container every earlier step misses, verifiably:
 * `EZCORP_PROJECT_ROOT` is never set (the Dockerfile sets no such `ENV`;
 * the only writer in the repo is `web/playwright.real.config.ts`), the
 * entrypoint is `CMD ["bun","run","web/build/index.js"]` so vite has
 * rewritten `import.meta` into `web/build/server/` and step 2 misses, and
 * `.dockerignore:4` excludes `.git` so the step-3 walk-up finds nothing.
 * `WORKDIR /app` then makes `process.cwd()` the correct answer — which is
 * why nobody has ever noticed. Consequence: the WARN below fires on every
 * production boot, and this is the HOT path, not dead code. Treat a change
 * to steps 1–3 as a change to a fallback nobody reaches in prod, and a
 * change to step 4 as a change to what production actually does.
 *
 * Cached after the first call (process-lifetime). Tests can reset via
 * the `__resetProjectRootCacheForTests` seam below.
 *
 * `resolveProjectRoot` is exported alongside `getProjectRoot` so a caller
 * that needs the uncached resolution (or the `source` that produced it)
 * doesn't re-derive project root with a separate `.git`-walk helper. Its
 * only callers today are `getProjectRoot` and four test files — every
 * production consumer (`bundled-lock.ts`, `permissions.ts`, `registry.ts`,
 * the `__test/cleanup-extension` route, …) wants the cached
 * `getProjectRoot`.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../logger";

const log = logger.child("extensions");

/** Which rule in the resolution order produced the answer. */
export type ProjectRootSource = "env" | "import-meta" | "git-walk" | "cwd-fallback";

export interface ProjectRootResolution {
  root: string;
  source: ProjectRootSource;
}

/**
 * TEST-ONLY — no production caller passes any of these. Every consumer in
 * `src/`, `web/` and `extensions/` calls the zero-argument
 * `getProjectRoot()`; the overrides exist so the resolution order can be
 * driven branch-by-branch without mkdtemp'ing a repo per assertion.
 * Same convention as `__resetProjectRootCacheForTests` below. If you find
 * yourself wanting one of these at a call site, you want an
 * `EZCORP_PROJECT_ROOT` env var instead.
 */
export interface ProjectRootOverrides {
  /** Override for the `EZCORP_PROJECT_ROOT` env var. */
  env?: NodeJS.ProcessEnv;
  /** Override for `import.meta.dir`. Pass an empty string to simulate "missing". */
  importMetaDir?: string;
  /**
   * Override for `import.meta.url` (step 2's secondary signal). Pass an
   * empty string to simulate "missing", a non-`file:` URL to exercise the
   * `fileURLToPath` failure path.
   *
   * Needed because the branch it drives is unreachable under Bun: this
   * module's own `import.meta.dir` always satisfies the primary match
   * first. See the comment on that branch for when it IS live.
   */
  importMetaUrl?: string;
  /** Override for the starting cwd in the `.git` walk-up. */
  cwd?: string;
  /** Override for the existsSync probe (used to fake bundled tree presence). */
  existsSync?: (p: string) => boolean;
}

let cachedProjectRoot: string | undefined;

/**
 * Test-only: drop the cached resolution so the next `getProjectRoot()`
 * call re-runs the full resolution order. Do NOT call from production
 * code — the cache is intentional (the answer is stable per process).
 */
export function __resetProjectRootCacheForTests(): void {
  cachedProjectRoot = undefined;
}

/**
 * Walk up from `from` looking for a directory containing `.git`.
 * Returns the first match, or `undefined` if the root is reached
 * without finding one. `.git` may be a directory (normal repo) or a
 * file (git worktree / submodule), so we accept either.
 */
function walkUpForGit(
  from: string,
  exists: (p: string) => boolean,
): string | undefined {
  let dir = from;
  // Hard cap on iterations as a belt-and-braces guard against a
  // pathological filesystem where `dirname()` doesn't fixed-point.
  for (let i = 0; i < 64; i++) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

function isProjectRootCandidate(
  root: string,
  exists: (p: string) => boolean,
): boolean {
  return exists(join(root, "docs", "extensions", "examples"));
}

/**
 * Internal resolver used by both `getProjectRoot()` (the cached entry
 * point) and tests (via the overrides parameter). Pure — no
 * side-effects; the WARN for step 4 is emitted by the caller via
 * `warnIfCwdFallback`.
 */
export function resolveProjectRoot(
  overrides: ProjectRootOverrides = {},
): ProjectRootResolution {
  const env = overrides.env ?? process.env;
  const exists = overrides.existsSync ?? existsSync;

  // 1) Env override.
  const envRoot = env.EZCORP_PROJECT_ROOT;
  if (typeof envRoot === "string" && envRoot.length > 0) {
    if (exists(envRoot) && isProjectRootCandidate(envRoot, exists)) {
      return { root: envRoot, source: "env" };
    }
    // Stale env var — fall through silently (the eventual step-4 WARN is
    // the only log). Don't fail-closed: a real operator with a typo in
    // their shell rc should still get a server.
  }

  // 2) Substring match on import.meta.dir / import.meta.url.
  // `overrides.importMetaDir` distinguishes "test passed a value" from
  // "test didn't override" — `in` check so an empty string means
  // "simulate missing import.meta.dir" without falling back to the real
  // one.
  const hasMetaDirOverride = "importMetaDir" in overrides;
  // `import.meta.dir` is a BUN EXTENSION, not standard `import.meta`.
  // Measured: `node --input-type=module -e 'console.log(typeof
  // import.meta.dir, typeof import.meta.url)'` prints `undefined string`;
  // the same line under `bun -e` prints `string string`. Hence the
  // typeof guard — and hence the `import.meta.url` branch below.
  const realMetaDir = typeof import.meta.dir === "string" ? import.meta.dir : "";
  const metaDir = hasMetaDirOverride ? (overrides.importMetaDir ?? "") : realMetaDir;
  // `metaDir` is always a string, so the empty case needs no separate
  // guard — `"".includes(…)` is already false.
  if (metaDir.includes(join("src", "extensions"))) {
    return { root: join(metaDir, "..", ".."), source: "import-meta" };
  }
  // `import.meta.url` — the STANDARD spelling of the same fact, and the
  // only one available on a runtime that resolves this module but does
  // not implement Bun's `import.meta.dir`. That is the vite/vitest Node
  // leg of `bun run test:coverage`, where `realMetaDir` above is `""` and
  // this branch is what still returns the right root. It is the matched
  // pair of the typeof guard: delete this and that guard silently becomes
  // a no-op that falls through to the `.git` walk-up.
  //
  // It is NOT the vite-preview / production-bundle case — vite rewrites
  // `.url` into `web/build/server/` too, so both spellings miss there and
  // step 3/4 do that work (see the module header).
  //
  // Skipped when the `importMetaDir` test override is in play and no URL
  // override accompanies it (the test wants to drive resolution without
  // bleed-through from this file's actual path).
  const metaUrl = "importMetaUrl" in overrides
    ? (overrides.importMetaUrl ?? "")
    : (hasMetaDirOverride ? "" : import.meta.url);
  if (metaUrl) {
    try {
      const thisDir = dirname(fileURLToPath(metaUrl));
      if (thisDir.includes(join("src", "extensions"))) {
        return { root: join(thisDir, "..", ".."), source: "import-meta" };
      }
    } catch {
      // Not a file URL (bundler rewrote it to something else) — fall through.
    }
  }

  // 3) `.git` walk-up starting from metaDir (if present) then cwd.
  const cwd = overrides.cwd ?? process.cwd();
  const starts: string[] = [];
  if (metaDir) starts.push(metaDir);
  starts.push(cwd);
  for (const start of starts) {
    const gitRoot = walkUpForGit(start, exists);
    if (gitRoot && isProjectRootCandidate(gitRoot, exists)) {
      return { root: gitRoot, source: "git-walk" };
    }
  }

  // 4) Final fallback.
  return { root: cwd, source: "cwd-fallback" };
}

/**
 * Emit the step-4 notice for a resolution that fell through to
 * `process.cwd()`.
 *
 * Split out of `getProjectRoot()` rather than inlined for testability:
 * `getProjectRoot()` takes no overrides, and under Bun this module's own
 * `import.meta.dir` always satisfies step 2, so the branch is unreachable
 * from that entry point in any bun:test process. As a named function the
 * branch that production actually takes is directly assertable.
 *
 * On the wording: this is NOT an error report. Step 4 is the path the
 * shipped container takes on every boot (see the module header — no env
 * var, vite-rewritten `import.meta`, no `.git` in the image), and `cwd` is
 * the right answer there because `WORKDIR /app`. The line exists so that
 * when the root IS wrong, the log already says which rule picked it. Kept
 * at `warn` rather than demoted to `info` deliberately: `info` is the
 * default level, so a demotion would not reduce the noise, and dropping it
 * entirely would remove the only breadcrumb for the case it was added for.
 * Making it genuinely quiet means setting `EZCORP_PROJECT_ROOT=/app` in the
 * Dockerfile so step 1 wins — a deploy change, tracked separately.
 */
export function warnIfCwdFallback(resolution: ProjectRootResolution): void {
  if (resolution.source !== "cwd-fallback") return;
  log.warn(
    "getProjectRoot() resolved via the process.cwd() fallback — expected in the " +
      "container (no EZCORP_PROJECT_ROOT, no .git in the image), and correct there " +
      "because WORKDIR is the install root. If bundled-extension lookups are failing, " +
      "this is the first thing to check: set EZCORP_PROJECT_ROOT, run from the repo " +
      "root, or ensure docs/extensions/examples/ is present.",
    { cwd: resolution.root },
  );
}

export function getProjectRoot(): string {
  if (cachedProjectRoot !== undefined) return cachedProjectRoot;
  const resolution = resolveProjectRoot();
  warnIfCwdFallback(resolution);
  cachedProjectRoot = resolution.root;
  return resolution.root;
}
