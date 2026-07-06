/**
 * Regression tests for `resolveLockfilePath()` in
 * `src/extensions/bundled-lock.ts`.
 *
 * The tamper gate MUST validate the SAME on-disk tree that `bundled.ts`
 * loads bundled manifests from. `bundled.ts` joins each manifest path
 * onto `getProjectRoot()`; `resolveLockfilePath()` must therefore resolve
 * `manifest.lock.json` onto the SAME `getProjectRoot()`. Before this fix,
 * `resolveLockfilePath()` re-derived the root with a partial resolver
 * (import.meta substring → cwd only) that ignored `EZCORP_PROJECT_ROOT`
 * and the `.git` walk-up — so with the env override set the gate
 * validated a DIFFERENT tree's lockfile (spurious fail-closed refusals).
 *
 * These tests assert the two now agree:
 *   1. default (no env / no override) → `join(getProjectRoot(), lock)`
 *   2. `EZCORP_PROJECT_ROOT` override honored (the bug fix) — root AND
 *      lockfile both follow the override, in lockstep with
 *      `resolveProjectRoot`
 *   3. the `setLockfilePathOverride` test seam still short-circuits
 *
 * The individual root-resolution BRANCHES (env / import-meta / .git
 * walk-up / cwd fallback) are exercised exhaustively against
 * `resolveProjectRoot` in `bundled-getProjectRoot.test.ts`; because
 * `resolveLockfilePath` now delegates to `getProjectRoot` (which wraps
 * that same resolver) those branches are inherited here rather than
 * re-tested — the walk-up specifically is covered there.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  resolveLockfilePath,
  setLockfilePathOverride,
  clearLockfileCache,
} from "../bundled-lock";
import {
  __resetProjectRootCacheForTests,
  getProjectRoot,
  resolveProjectRoot,
} from "../bundled";

const tmpDirs: string[] = [];

/** Build a tmp dir that passes `getProjectRoot`'s bundled-tree check. */
function makeTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ezcorp-lockroot-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "docs", "extensions", "examples"), { recursive: true });
  return dir;
}

// Snapshot + restore the one env var the resolver reads so a test that
// drives the override can never leak into sibling test files.
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.EZCORP_PROJECT_ROOT;
  delete process.env.EZCORP_PROJECT_ROOT;
  setLockfilePathOverride(undefined);
  clearLockfileCache();
  __resetProjectRootCacheForTests();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.EZCORP_PROJECT_ROOT;
  else process.env.EZCORP_PROJECT_ROOT = savedEnv;
  setLockfilePathOverride(undefined);
  clearLockfileCache();
  __resetProjectRootCacheForTests();
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
  tmpDirs.length = 0;
});

describe("resolveLockfilePath delegates to getProjectRoot", () => {
  test("default (no env, no override): lockfile sits under getProjectRoot()", () => {
    const lockPath = resolveLockfilePath();
    // Byte-identical to composing the canonical root with the filename —
    // proving the tamper gate consults the same tree `bundled.ts` loads.
    expect(lockPath).toBe(join(getProjectRoot(), "manifest.lock.json"));
    expect(lockPath.endsWith("manifest.lock.json")).toBe(true);
  });

  test("EZCORP_PROJECT_ROOT override is honored — root AND lockfile follow it", () => {
    const repo = makeTmpRepo();
    process.env.EZCORP_PROJECT_ROOT = repo;
    __resetProjectRootCacheForTests();
    clearLockfileCache();

    // The bug: previously getProjectRoot() honored the override but
    // resolveLockfilePath() did not, so these diverged.
    expect(getProjectRoot()).toBe(repo);
    expect(resolveLockfilePath()).toBe(join(repo, "manifest.lock.json"));
  });

  test("under the env override, resolveProjectRoot and resolveLockfilePath agree", () => {
    const repo = makeTmpRepo();
    process.env.EZCORP_PROJECT_ROOT = repo;
    __resetProjectRootCacheForTests();
    clearLockfileCache();

    const resolved = resolveProjectRoot({ env: process.env });
    expect(resolved.source).toBe("env");
    expect(resolved.root).toBe(repo);
    // The lockfile's parent directory IS the resolved project root.
    expect(dirname(resolveLockfilePath())).toBe(resolved.root);
  });

  test("setLockfilePathOverride short-circuits ahead of project-root resolution", () => {
    const repo = makeTmpRepo();
    process.env.EZCORP_PROJECT_ROOT = repo;
    __resetProjectRootCacheForTests();
    clearLockfileCache();

    const custom = join(tmpdir(), "explicit-lockfile-override.json");
    setLockfilePathOverride(custom);
    // The explicit seam wins even though a valid project root resolves.
    expect(resolveLockfilePath()).toBe(custom);
  });
});
