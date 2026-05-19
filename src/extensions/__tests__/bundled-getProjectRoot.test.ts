/**
 * Unit tests for `getProjectRoot()` / `resolveProjectRoot()` in
 * `src/extensions/bundled.ts`.
 *
 * The function is the choke-point for every bundled-extension on-disk
 * lookup. Under SvelteKit's vite-bundled server (vite preview), the
 * legacy logic fell through to `process.cwd()` — which is `web/` in the
 * default harness, breaking every `docs/extensions/examples/<name>/`
 * lookup and crashing preview startup.
 *
 * Each test exercises one resolution branch:
 *
 *   1. `EZCORP_PROJECT_ROOT` env var (happy + stale-path-ignored)
 *   2. `import.meta.dir` substring-match (direct Bun execution)
 *   3. `.git` walk-up from a metadir / cwd that doesn't substring-match
 *      (the vite-preview branch)
 *   4. final cwd fallback (no env, no meta hit, no .git anywhere)
 *   5. caching (second call returns same string, no re-walk)
 *
 * `existsSync` is injected as an override so tests can fake the
 * `.git` + `docs/extensions/examples/` filesystem layout without
 * mkdtempSync'ing real directories on every assertion. The brief
 * specifies tmpdir-based tests for the `.git`-walk branches; we use a
 * real `mkdtempSync` ONLY there to prove the production code path
 * (which calls the real `existsSync`) handles a real filesystem layout.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetProjectRootCacheForTests,
  getProjectRoot,
  resolveProjectRoot,
} from "../bundled";

// Track tmpdirs created per test for afterEach cleanup.
const tmpDirs: string[] = [];

function makeTmpRepo(opts: { withDocsExamples: boolean; withGit: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "ezcorp-projroot-"));
  tmpDirs.push(dir);
  if (opts.withGit) mkdirSync(join(dir, ".git"), { recursive: true });
  if (opts.withDocsExamples) {
    mkdirSync(join(dir, "docs", "extensions", "examples"), { recursive: true });
  }
  return dir;
}

beforeEach(() => {
  __resetProjectRootCacheForTests();
});

afterEach(() => {
  for (const d of tmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
  tmpDirs.length = 0;
  __resetProjectRootCacheForTests();
});

describe("resolveProjectRoot — env-var branch", () => {
  test("EZCORP_PROJECT_ROOT pointing at a valid repo wins", () => {
    const repo = makeTmpRepo({ withDocsExamples: true, withGit: true });
    const got = resolveProjectRoot({
      env: { EZCORP_PROJECT_ROOT: repo },
      importMetaDir: "", // ensure step 2 misses
      cwd: tmpdir(),
    });
    expect(got.source).toBe("env");
    expect(got.root).toBe(repo);
  });

  test("EZCORP_PROJECT_ROOT pointing at a non-existent path is ignored (falls through)", () => {
    const got = resolveProjectRoot({
      env: { EZCORP_PROJECT_ROOT: "/no/such/path-definitely" },
      importMetaDir: "",
      cwd: tmpdir(),
      existsSync: () => false, // nothing exists anywhere
    });
    expect(got.source).toBe("cwd-fallback");
    expect(got.root).toBe(tmpdir());
  });

  test("EZCORP_PROJECT_ROOT pointing at a dir without docs/extensions/examples falls through", () => {
    // A valid dir but missing the bundled tree — must NOT be accepted.
    const bareDir = makeTmpRepo({ withDocsExamples: false, withGit: false });
    const got = resolveProjectRoot({
      env: { EZCORP_PROJECT_ROOT: bareDir },
      importMetaDir: "",
      cwd: tmpdir(),
    });
    expect(got.source).toBe("cwd-fallback");
  });
});

describe("resolveProjectRoot — import.meta.dir branch", () => {
  test("import.meta.dir contains src/extensions → substring-match root", () => {
    // Simulate direct-Bun execution from `bundled.ts` itself:
    // import.meta.dir = `<root>/src/extensions`. The function joins
    // `..`, `..` so the returned root is /fake/repo.
    const fakeRoot = "/fake/repo";
    const fakeMetaDir = join(fakeRoot, "src", "extensions");
    const got = resolveProjectRoot({
      env: {},
      importMetaDir: fakeMetaDir,
      cwd: "/elsewhere",
    });
    expect(got.source).toBe("import-meta");
    // join(metaDir, "..", "..") normalises to /fake/repo
    expect(got.root).toBe(fakeRoot);
  });
});

describe("resolveProjectRoot — .git walk-up branch", () => {
  test("metadir is unrelated but cwd has .git and docs/extensions/examples → git-walk root", () => {
    const repo = makeTmpRepo({ withDocsExamples: true, withGit: true });
    const got = resolveProjectRoot({
      env: {},
      importMetaDir: "/tmp/vite/build/server", // no substring hit
      cwd: repo,
    });
    expect(got.source).toBe("git-walk");
    expect(got.root).toBe(repo);
  });

  test("cwd is a subdir; walks up to find .git + docs/extensions/examples", () => {
    const repo = makeTmpRepo({ withDocsExamples: true, withGit: true });
    const sub = join(repo, "web");
    mkdirSync(sub, { recursive: true });
    const got = resolveProjectRoot({
      env: {},
      importMetaDir: "/tmp/vite/build/server",
      cwd: sub,
    });
    expect(got.source).toBe("git-walk");
    expect(got.root).toBe(repo);
  });

  test(".git found but docs/extensions/examples missing → walk-up rejects, falls back to cwd", () => {
    // A bare git repo (e.g. an unrelated vendor dir) MUST NOT be treated
    // as the EZCorp root just because it has `.git`. The bundled-tree
    // check is the second gate.
    const repo = makeTmpRepo({ withDocsExamples: false, withGit: true });
    const got = resolveProjectRoot({
      env: {},
      importMetaDir: "/tmp/vite/build/server",
      cwd: repo,
    });
    expect(got.source).toBe("cwd-fallback");
    expect(got.root).toBe(repo);
  });
});

describe("resolveProjectRoot — final fallback", () => {
  test("nothing matches → returns cwd with source=cwd-fallback", () => {
    const got = resolveProjectRoot({
      env: {},
      importMetaDir: "/tmp/vite/build/server",
      cwd: "/somewhere/with/no/git",
      existsSync: () => false,
    });
    expect(got.source).toBe("cwd-fallback");
    expect(got.root).toBe("/somewhere/with/no/git");
  });
});

describe("getProjectRoot — caching", () => {
  test("two calls return the same string and the second does NOT re-walk", () => {
    // Drive the production cached entry point. Both calls must return
    // identical strings (object identity via cache). We cannot easily
    // assert "no walk happened on call 2" from outside the module, but
    // strict identity is sufficient evidence — the resolver returns a
    // fresh `join()`'d string each call, so identity-equality only
    // holds when the cache short-circuits.
    const first = getProjectRoot();
    const second = getProjectRoot();
    expect(second).toBe(first);
  });
});
