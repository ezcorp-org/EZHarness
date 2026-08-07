/**
 * Hermetic project-root override for backend tests.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Anything that persists extension state resolves its base directory
 * through `getProjectRoot()` (`src/extensions/project-root.ts`) and lands under
 * `<projectRoot>/.ezcorp/extension-data/…` — the binding layout in
 * `src/extensions/CLAUDE.md`. A test that exercises that write path
 * therefore writes into the REAL checkout unless it moves the root.
 *
 * `process.chdir(tmp)` does NOT move it. `getProjectRoot()` resolves in the
 * order env → `import.meta.dir` → `.git` walk-up → cwd, and step 2 always
 * hits: `project-root.ts` literally lives in `src/extensions/`, so its own
 * module path pins the answer to the real repo before cwd is ever
 * consulted (that anchoring is deliberate — see
 * `src/__tests__/ez-drafts-project-root-anchor.test.ts`). A chdir-based
 * "isolation" is a no-op, and the test silently writes to the checkout.
 * On a tree whose `.ezcorp/extension-data` is owned by another uid (the
 * dev container writes it as uid 1000) every such write is an EACCES and
 * the suite fails for reasons that have nothing to do with the code — and
 * only ever on that tree, which is why CI never sees it.
 *
 * WHAT IT DOES
 * ────────────
 * Builds a throwaway directory that is a *believable* project root and
 * points every resolver at it:
 *
 *   - `docs/extensions/examples/` — `getProjectRoot()` rejects an
 *     `EZCORP_PROJECT_ROOT` that doesn't look like the repo.
 *   - `.git/` — so the SDK's `findProjectRoot()` cwd-walk
 *     (`buildAllowedEnv()` uses it to tell a spawned extension subprocess
 *     where its root is) agrees with `getProjectRoot()` instead of pointing
 *     back at the checkout.
 *   - `node_modules` / `packages` symlinks — a sandboxed extension spawned
 *     from a draft dir under this root resolves `@ezcorp/sdk` by walking UP
 *     for `node_modules`, and the landlock jail grants
 *     `<projectRoot>/{node_modules,packages}` read-only. Linking the real
 *     trees in keeps a real subprocess round-trip working from `/tmp`.
 *     `cleanup()`'s `rmSync` removes the LINKS, never their targets.
 *   - `EZCORP_PROJECT_ROOT` + a project-root cache reset, and a chdir into
 *     the root so cwd-anchored resolvers agree too.
 *
 * `cleanup()` restores cwd, the env var and the cache, then removes the
 * directory. Call it from `afterAll`/`afterEach`; it is idempotent.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  __resetProjectRootCacheForTests,
  getProjectRoot,
} from "../../extensions/bundled";

export interface TempProjectRoot {
  /** Absolute, realpath-resolved root. `.ezcorp/**` lands under here. */
  readonly root: string;
  /** Restore cwd + env + cache and delete the directory. Idempotent. */
  cleanup(): void;
}

/** Trees linked in from the real checkout so module resolution still works. */
const LINKED_TREES = ["node_modules", "packages"] as const;

/**
 * Nearest ancestor of `from` that contains `node_modules` — exactly the
 * one Bun's own resolver would find when importing a bare specifier from
 * `from`. In a git worktree that is the primary checkout, not the
 * worktree, so this cannot be derived from the project root.
 */
function findNodeModulesHost(from: string): string | undefined {
  let dir = from;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(dir, "node_modules"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Create a temp project root, point the resolvers at it, and return a
 * handle whose `cleanup()` undoes all of it.
 */
export function useTempProjectRoot(prefix = "ez-project-root-"): TempProjectRoot {
  // Resolve the REAL root before the override so the symlink sources are
  // the checkout's, not the temp dir's.
  const realRoot = getProjectRoot();
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));

  mkdirSync(join(root, "docs", "extensions", "examples"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });

  const nodeModulesHost = findNodeModulesHost(realRoot);
  for (const tree of LINKED_TREES) {
    const source = [nodeModulesHost, realRoot]
      .map((base) => (base ? join(base, tree) : ""))
      .find((candidate) => candidate !== "" && existsSync(candidate));
    if (source) symlinkSync(source, join(root, tree));
  }

  const savedEnv = process.env.EZCORP_PROJECT_ROOT;
  const savedCwd = process.cwd();
  process.env.EZCORP_PROJECT_ROOT = root;
  __resetProjectRootCacheForTests();
  process.chdir(root);

  let cleaned = false;
  return {
    root,
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      process.chdir(savedCwd);
      if (savedEnv === undefined) delete process.env.EZCORP_PROJECT_ROOT;
      else process.env.EZCORP_PROJECT_ROOT = savedEnv;
      __resetProjectRootCacheForTests();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
