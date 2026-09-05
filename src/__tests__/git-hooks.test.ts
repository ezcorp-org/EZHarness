/**
 * Local git-hooks behaviour tests (.githooks/pre-commit, .githooks/pre-push,
 * scripts/setup-git-hooks.sh).
 *
 * STRATEGY
 *   Each test drives the REAL hook scripts inside a throwaway `git init` repo
 *   under a tmpdir — no mocks. The pre-commit hook lints staged files with the
 *   repo's real biome (2.4.13), so each fixture repo copies the real biome.json
 *   and symlinks the repo's node_modules so `bunx biome` resolves locally
 *   (no network). A `==` (noDoubleEquals) file is the deterministic lint error;
 *   a plain `a + b` file is the clean control.
 *
 *   The setup-git-hooks.sh tests assert its guarded wire-up: no-op under CI or
 *   outside a git work tree, otherwise sets core.hooksPath. CI is passed
 *   explicitly per-case because the ambient env may or may not set it.
 *
 *   REGRESSION (PR #240): `repoWithPreCommit()` deliberately does NOT mirror
 *   this whole repo — no scripts/, no .bun-version — because the hook is
 *   meant to work in any minimal git repo that reuses it. When the bun
 *   version-skew check was added to .githooks/pre-commit, it unconditionally
 *   sourced scripts/lib/bun-version-check.sh; that file doesn't exist in this
 *   fixture, so the source failed, check_bun_version_skew was never defined,
 *   and calling it read as "command not found" (exit 127) — which the hook's
 *   `if ! check_bun_version_skew; then fail; fi` treated as a genuine skew
 *   and blocked EVERY commit, lint-clean or not. Caught by the "ALLOWS a
 *   commit" test below going red for the wrong reason (a "bun version skew"
 *   banner instead of a lint pass). The fix made the hook define a no-op
 *   fallback before conditionally sourcing the real helper (see
 *   .githooks/pre-commit and scripts/lib/bun-version-check.sh's REGRESSION
 *   note) — the "pre-commit hook > bun version skew" describe block below
 *   exercises BOTH the missing-helper no-op path (implicitly, via the
 *   existing plain-fixture tests above) and the enforcing path (explicitly,
 *   via `repoWithBunVersionCheck`) so a future change can't silently make
 *   the check permanently inert either.
 */
import { test, expect, describe, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBunVersion } from "../../scripts/check-bun-version.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PRE_COMMIT = join(REPO_ROOT, ".githooks/pre-commit");
const PRE_PUSH = join(REPO_ROOT, ".githooks/pre-push");
const SETUP = join(REPO_ROOT, "scripts/setup-git-hooks.sh");
const BIOME_JSON = join(REPO_ROOT, "biome.json");
const GITIGNORE = join(REPO_ROOT, ".gitignore");
const NODE_MODULES = join(REPO_ROOT, "node_modules");
const CHECK_BUN_VERSION_TS = join(REPO_ROOT, "scripts/check-bun-version.ts");
const BUN_VERSION_CHECK_SH = join(REPO_ROOT, "scripts/lib/bun-version-check.sh");

// Env with CI + EZ_SKIP_HOOKS stripped so the ambient runner (which may set CI)
// can't mask the "hooks actually run / setup actually wires" default paths.
const baseEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) baseEnv[k] = v;
}
delete baseEnv.CI;
delete baseEnv.EZ_SKIP_HOOKS;

type Run = { exitCode: number; out: string };

function sh(cmd: string[], opts: { cwd: string; env?: Record<string, string> }): Run {
  const p = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env ?? baseEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: p.exitCode,
    out: p.stdout.toString() + p.stderr.toString(),
  };
}

const created: string[] = [];

/** Fresh `git init` repo (identity configured), tracked for cleanup. */
function initRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  sh(["git", "init", "-q"], { cwd: dir });
  sh(["git", "config", "user.email", "hooks@test.local"], { cwd: dir });
  sh(["git", "config", "user.name", "Hook Test"], { cwd: dir });
  return dir;
}

/** Repo wired with the real pre-commit hook + biome so lint runs for real. */
function repoWithPreCommit(): string {
  const dir = initRepo("ezcorp-precommit-");
  mkdirSync(join(dir, ".githooks"));
  copyFileSync(PRE_COMMIT, join(dir, ".githooks/pre-commit"));
  chmodSync(join(dir, ".githooks/pre-commit"), 0o755);
  copyFileSync(BIOME_JSON, join(dir, "biome.json"));
  // biome.json sets vcs.useIgnoreFile — a real checkout always ships a
  // .gitignore, so the fixture must too or biome errors on a missing ignore
  // file (masking the actual lint result).
  copyFileSync(GITIGNORE, join(dir, ".gitignore"));
  symlinkSync(NODE_MODULES, join(dir, "node_modules"));
  sh(["git", "config", "core.hooksPath", ".githooks"], { cwd: dir });
  return dir;
}

/**
 * Add the real bun-version-check machinery to a `repoWithPreCommit()`
 * fixture, at the exact relative layout .githooks/pre-commit and
 * scripts/lib/bun-version-check.sh expect (scripts/lib/bun-version-check.sh
 * + scripts/check-bun-version.ts + a repo-root .bun-version pinning
 * `pinnedVersion`). Without this call, a fixture repo has NEITHER file —
 * that absence is exactly the PR #240 regression case, and is exercised
 * implicitly by the plain `repoWithPreCommit()` tests above. WITH this call,
 * the hook's enforcing path runs for real, so a future change can't make the
 * check permanently inert without a test noticing.
 */
function withBunVersionCheck(dir: string, pinnedVersion: string): void {
  mkdirSync(join(dir, "scripts/lib"), { recursive: true });
  copyFileSync(CHECK_BUN_VERSION_TS, join(dir, "scripts/check-bun-version.ts"));
  copyFileSync(BUN_VERSION_CHECK_SH, join(dir, "scripts/lib/bun-version-check.sh"));
  writeFileSync(join(dir, ".bun-version"), `${pinnedVersion}\n`);
}

/** Repo with an initial commit — required before `git worktree add`. */
function initRepoWithCommit(prefix: string): string {
  const dir = initRepo(prefix);
  writeFileSync(join(dir, "README.md"), "seed\n");
  sh(["git", "add", "."], { cwd: dir });
  sh(["git", "commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

/** Attach a linked worktree on a new branch; returns its (tracked) path. */
function addWorktree(primary: string, branch: string): string {
  const wt = `${primary}-wt-${branch}`;
  created.push(wt);
  sh(["git", "worktree", "add", "-q", "-b", branch, wt], { cwd: primary });
  return wt;
}

/** Read a single git config value (trimmed; "" when unset). */
function readCfg(cwd: string, key: string): string {
  return sh(["git", "config", "--get", key], { cwd }).out.trim();
}

const LINT_ERROR_TS = "export function bad(a: number, b: number): boolean {\n  return a == b;\n}\n";
const CLEAN_TS = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

// The pre-commit tests spawn git → hook → `bunx biome`; a cold bunx/biome start
// can exceed the 5s default, so give them headroom (biome itself is ~1-2s).
const BIOME_TIMEOUT_MS = 30_000;

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

describe("pre-commit hook", () => {
  test("BLOCKS a commit whose staged .ts file fails biome lint", () => {
    const dir = repoWithPreCommit();
    writeFileSync(join(dir, "bad.ts"), LINT_ERROR_TS);
    sh(["git", "add", "bad.ts"], { cwd: dir });

    const res = sh(["git", "commit", "-m", "add bad"], { cwd: dir });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("pre-commit");
    expect(res.out.toLowerCase()).toContain("biome");
    // Commit must NOT have landed.
    const log = sh(["git", "log", "--oneline"], { cwd: dir });
    expect(log.out).not.toContain("add bad");
  }, BIOME_TIMEOUT_MS);

  test("ALLOWS a commit whose staged .ts file is lint-clean", () => {
    const dir = repoWithPreCommit();
    writeFileSync(join(dir, "good.ts"), CLEAN_TS);
    sh(["git", "add", "good.ts"], { cwd: dir });

    const res = sh(["git", "commit", "-m", "add good"], { cwd: dir });
    expect(res.exitCode).toBe(0);
    const log = sh(["git", "log", "--oneline"], { cwd: dir });
    expect(log.out).toContain("add good");
  }, BIOME_TIMEOUT_MS);

  test("EZ_SKIP_HOOKS=1 bypasses the hook even for a lint-violating file", () => {
    const dir = repoWithPreCommit();
    writeFileSync(join(dir, "bad.ts"), LINT_ERROR_TS);
    sh(["git", "add", "bad.ts"], { cwd: dir });

    const res = sh(["git", "commit", "-m", "skip hooks"], {
      cwd: dir,
      env: { ...baseEnv, EZ_SKIP_HOOKS: "1" },
    });
    expect(res.exitCode).toBe(0);
    // The hook never ran, so its failure banner must be absent.
    expect(res.out).not.toContain("pre-commit:");
    const log = sh(["git", "log", "--oneline"], { cwd: dir });
    expect(log.out).toContain("skip hooks");
  });
});

// PR #240 regression coverage: the plain repoWithPreCommit() tests above have
// NEITHER scripts/lib/bun-version-check.sh NOR scripts/check-bun-version.ts,
// so they exercise the "checker missing → silent no-op" path (that absence
// used to block every commit — see the file header). These tests add the
// real checker via withBunVersionCheck() and drive it end-to-end THROUGH the
// hook, so the enforcing path (warn on patch, block on major, bypassable via
// EZ_SKIP_HOOKS) has a regression test of its own — not just the CLI-level
// coverage in src/__tests__/check-bun-version.test.ts, which never spawns
// .githooks/pre-commit at all and so could not have caught this.
describe("pre-commit hook > bun version skew", () => {
  const running = parseBunVersion(Bun.version);
  if (!running) {
    throw new Error(`could not parse the running Bun.version="${Bun.version}" — test setup is broken`);
  }

  test("a matching pin is silent — no skew banner, commit lands", () => {
    const dir = repoWithPreCommit();
    withBunVersionCheck(dir, Bun.version);
    writeFileSync(join(dir, "good.ts"), CLEAN_TS);
    sh(["git", "add", "good.ts"], { cwd: dir });

    const res = sh(["git", "commit", "-m", "add good"], { cwd: dir });
    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("bun version skew");
    const log = sh(["git", "log", "--oneline"], { cwd: dir });
    expect(log.out).toContain("add good");
  }, BIOME_TIMEOUT_MS);

  test("a patch-level pin mismatch warns but the commit still lands", () => {
    const dir = repoWithPreCommit();
    withBunVersionCheck(dir, `${running.major}.${running.minor}.${running.patch + 1}`);
    writeFileSync(join(dir, "good.ts"), CLEAN_TS);
    sh(["git", "add", "good.ts"], { cwd: dir });

    const res = sh(["git", "commit", "-m", "add good"], { cwd: dir });
    expect(res.exitCode).toBe(0);
    expect(res.out).toContain("bun version skew (patch)");
    const log = sh(["git", "log", "--oneline"], { cwd: dir });
    expect(log.out).toContain("add good");
  }, BIOME_TIMEOUT_MS);

  test("a major-level pin mismatch BLOCKS the commit, even for a lint-clean file", () => {
    const dir = repoWithPreCommit();
    withBunVersionCheck(dir, `${running.major + 1}.0.0`);
    writeFileSync(join(dir, "good.ts"), CLEAN_TS);
    sh(["git", "add", "good.ts"], { cwd: dir });

    const res = sh(["git", "commit", "-m", "add good"], { cwd: dir });
    expect(res.exitCode).not.toBe(0);
    expect(res.out).toContain("bun version skew (major)");
    const log = sh(["git", "log", "--oneline"], { cwd: dir });
    expect(log.out).not.toContain("add good");
  }, BIOME_TIMEOUT_MS);

  test("EZ_SKIP_HOOKS=1 bypasses a blocking major-level pin mismatch", () => {
    const dir = repoWithPreCommit();
    withBunVersionCheck(dir, `${running.major + 1}.0.0`);
    writeFileSync(join(dir, "good.ts"), CLEAN_TS);
    sh(["git", "add", "good.ts"], { cwd: dir });

    const res = sh(["git", "commit", "-m", "add good"], {
      cwd: dir,
      env: { ...baseEnv, EZ_SKIP_HOOKS: "1" },
    });
    expect(res.exitCode).toBe(0);
    const log = sh(["git", "log", "--oneline"], { cwd: dir });
    expect(log.out).toContain("add good");
  }, BIOME_TIMEOUT_MS);
});

describe("pre-push hook", () => {
  test("EZ_SKIP_HOOKS=1 short-circuits to exit 0 before any check", () => {
    // Run the real script directly against the worktree; the escape hatch must
    // return before spawning the (slow) lint/typecheck/svelte steps.
    const res = sh(["bash", PRE_PUSH], {
      cwd: REPO_ROOT,
      env: { ...baseEnv, EZ_SKIP_HOOKS: "1" },
    });
    expect(res.exitCode).toBe(0);
    expect(res.out).not.toContain("Typecheck");
  });
});

// Every "wires hooks" case passes `baseEnv` (CI stripped in module init) so the
// suite is deterministic under GitHub Actions, which sets CI=true globally —
// inheriting ambient env would make the setup a no-op and red these tests.
describe("setup-git-hooks.sh", () => {
  test("wires hooks per-worktree inside a git work tree (no CI)", () => {
    const dir = initRepo("ezcorp-setup-ok-");
    const res = sh(["bash", SETUP], { cwd: dir, env: baseEnv });
    expect(res.exitCode).toBe(0);
    expect(readCfg(dir, "core.hooksPath")).toBe(".githooks");
    // The scoping only binds if the shared mechanism flag is enabled.
    expect(readCfg(dir, "extensions.worktreeConfig")).toBe("true");
  });

  test("scopes hooksPath to the worktree it runs in, not sibling checkouts", () => {
    const primary = initRepoWithCommit("ezcorp-setup-wt-");
    const linked = addWorktree(primary, "linked");
    // Run setup ONLY in the linked worktree.
    const res = sh(["bash", SETUP], { cwd: linked, env: baseEnv });
    expect(res.exitCode).toBe(0);
    expect(readCfg(linked, "core.hooksPath")).toBe(".githooks");
    // Primary shares the same .git but must NOT inherit the linked tree's hooks.
    expect(readCfg(primary, "core.hooksPath")).toBe("");
    // The mechanism flag is shared (visible from both) — it enables nothing alone.
    expect(readCfg(primary, "extensions.worktreeConfig")).toBe("true");
  });

  test("inverse: setup in the primary tree does not leak to a linked worktree", () => {
    const primary = initRepoWithCommit("ezcorp-setup-inv-");
    const linked = addWorktree(primary, "inv");
    const res = sh(["bash", SETUP], { cwd: primary, env: baseEnv });
    expect(res.exitCode).toBe(0);
    expect(readCfg(primary, "core.hooksPath")).toBe(".githooks");
    expect(readCfg(linked, "core.hooksPath")).toBe("");
  });

  test("no-op under CI=1 (leaves hooks unwired)", () => {
    const dir = initRepo("ezcorp-setup-ci-");
    const res = sh(["bash", SETUP], { cwd: dir, env: { ...baseEnv, CI: "1" } });
    expect(res.exitCode).toBe(0);
    expect(readCfg(dir, "core.hooksPath")).toBe("");
    // The CI guard returns before touching config at all.
    expect(readCfg(dir, "extensions.worktreeConfig")).toBe("");
  });

  test("no-op (exit 0) outside a git work tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "ezcorp-setup-nogit-"));
    created.push(dir);
    const res = sh(["bash", SETUP], { cwd: dir, env: baseEnv });
    expect(res.exitCode).toBe(0);
    // Nothing git-related should have been created.
    const isRepo = sh(["git", "rev-parse", "--is-inside-work-tree"], { cwd: dir });
    expect(isRepo.exitCode).not.toBe(0);
  });
});
