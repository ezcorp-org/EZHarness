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
 *   4. a STALE/invalid `EZCORP_PROJECT_ROOT` (marker dir missing) falls
 *      through to the real repo root at the `resolveLockfilePath` level
 *   5. an END-TO-END drive of the REAL tamper gate
 *      (`verifyManifestAgainstLock`) under the env override, with NO
 *      `setLockfilePathOverride` seam: green when the override-root
 *      lockfile matches, fail-closed when that lockfile is tampered
 *
 * The individual root-resolution BRANCHES (env / import-meta / .git
 * walk-up / cwd fallback) are exercised exhaustively against
 * `resolveProjectRoot` in `bundled-getProjectRoot.test.ts`; because
 * `resolveLockfilePath` now delegates to `getProjectRoot` (which wraps
 * that same resolver) those branches are inherited here rather than
 * re-tested — the walk-up specifically is covered there.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  resolveLockfilePath,
  setLockfilePathOverride,
  clearLockfileCache,
  canonicalizeAndHash,
  verifyManifestAgainstLock,
} from "../bundled-lock";
import {
  __resetProjectRootCacheForTests,
  getProjectRoot,
  resolveProjectRoot,
} from "../bundled";
import type { ExtensionManifestV2, ToolDefinition } from "../types";

const tmpDirs: string[] = [];

/** Build a tmp dir that passes `getProjectRoot`'s bundled-tree check. */
function makeTmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ezcorp-lockroot-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "docs", "extensions", "examples"), { recursive: true });
  return dir;
}

/**
 * A tmp dir that EXISTS but is missing the `docs/extensions/examples/`
 * marker — a stale/misconfigured `EZCORP_PROJECT_ROOT` the resolver must
 * REJECT (fall through), not accept.
 */
function makeBareTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ezcorp-bareroot-"));
  tmpDirs.push(dir);
  return dir;
}

const TOOL_A: ToolDefinition = {
  name: "alpha",
  description: "alpha tool",
  inputSchema: { type: "object", properties: { x: { type: "string" } } },
};
const TOOL_B: ToolDefinition = {
  name: "beta",
  description: "beta tool",
  inputSchema: { type: "object", properties: { y: { type: "number" } } },
};

function fixtureManifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "fixture",
    version: "1.0.0",
    description: "fixture",
    author: { name: "EZCorp" },
    entrypoint: "./index.ts",
    tools: [TOOL_A, TOOL_B],
    permissions: {},
  };
}

/** Write a `manifest.lock.json` directly under `root` (no path-override seam). */
function writeLockfileAt(
  root: string,
  entries: Record<string, { version: string; entrypoint: string; toolsHash: string }>,
): void {
  writeFileSync(
    join(root, "manifest.lock.json"),
    JSON.stringify(
      { schemaVersion: 1, generatedAt: new Date().toISOString(), extensions: entries },
      null,
      2,
    ),
  );
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

  test("stale EZCORP_PROJECT_ROOT (marker dir missing) → resolveLockfilePath falls through to real repo root", () => {
    // Baseline: with no override, the resolver lands on the real repo root
    // (import.meta branch under `bun test`).
    const realRoot = getProjectRoot();
    const bare = makeBareTmpDir(); // exists, but no docs/extensions/examples
    expect(realRoot).not.toBe(bare);

    // A stale/misconfigured override must be IGNORED — the gate keeps
    // pointing at the real tree, not the bogus root.
    process.env.EZCORP_PROJECT_ROOT = bare;
    __resetProjectRootCacheForTests();
    clearLockfileCache();

    const lockPath = resolveLockfilePath();
    expect(lockPath.startsWith(bare)).toBe(false);
    expect(lockPath).toBe(join(realRoot, "manifest.lock.json"));
    // Prove the fall-through happened at the env step specifically.
    expect(resolveProjectRoot({ env: { EZCORP_PROJECT_ROOT: bare } }).source).not.toBe("env");
  });
});

describe("REAL tamper gate under EZCORP_PROJECT_ROOT (no path-override seam)", () => {
  test("verifyManifestAgainstLock validates green against the override-root lockfile, then fails closed when it is tampered", async () => {
    const overrideRoot = makeTmpRepo(); // valid: has the bundled-tree marker
    const manifest = fixtureManifest();
    const toolsHash = canonicalizeAndHash(manifest.tools ?? []);
    writeLockfileAt(overrideRoot, {
      fixture: { version: "1.0.0", entrypoint: "./index.ts", toolsHash },
    });

    // Drive the REAL chain: env → getProjectRoot → resolveLockfilePath →
    // loadManifestLock → verifyManifestAgainstLock. No setLockfilePathOverride.
    process.env.EZCORP_PROJECT_ROOT = overrideRoot;
    __resetProjectRootCacheForTests();
    clearLockfileCache();

    // Sanity: the gate reads the override-root lockfile (not the seam, not
    // the source tree).
    expect(resolveLockfilePath()).toBe(join(overrideRoot, "manifest.lock.json"));
    expect(await verifyManifestAgainstLock("fixture", manifest)).toEqual({ ok: true });

    // Tamper the lockfile AT THE OVERRIDE ROOT → the gate fails closed.
    writeLockfileAt(overrideRoot, {
      fixture: { version: "1.0.0", entrypoint: "./index.ts", toolsHash: "sha256-TAMPERED" },
    });
    clearLockfileCache(); // loadManifestLock caches by path — force a re-read
    const tampered = await verifyManifestAgainstLock("fixture", manifest);
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.reason).toBe("tool-list drift");
  });
});
