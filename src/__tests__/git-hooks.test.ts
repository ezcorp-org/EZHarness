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

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PRE_COMMIT = join(REPO_ROOT, ".githooks/pre-commit");
const PRE_PUSH = join(REPO_ROOT, ".githooks/pre-push");
const SETUP = join(REPO_ROOT, "scripts/setup-git-hooks.sh");
const BIOME_JSON = join(REPO_ROOT, "biome.json");
const GITIGNORE = join(REPO_ROOT, ".gitignore");
const NODE_MODULES = join(REPO_ROOT, "node_modules");

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

const LINT_ERROR_TS = "export function bad(a: number, b: number): boolean {\n  return a == b;\n}\n";
const CLEAN_TS = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

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
  });

  test("ALLOWS a commit whose staged .ts file is lint-clean", () => {
    const dir = repoWithPreCommit();
    writeFileSync(join(dir, "good.ts"), CLEAN_TS);
    sh(["git", "add", "good.ts"], { cwd: dir });

    const res = sh(["git", "commit", "-m", "add good"], { cwd: dir });
    expect(res.exitCode).toBe(0);
    const log = sh(["git", "log", "--oneline"], { cwd: dir });
    expect(log.out).toContain("add good");
  });

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

describe("setup-git-hooks.sh", () => {
  test("sets core.hooksPath=.githooks inside a git work tree (no CI)", () => {
    const dir = initRepo("ezcorp-setup-ok-");
    const res = sh(["bash", SETUP], { cwd: dir, env: baseEnv });
    expect(res.exitCode).toBe(0);
    const cfg = sh(["git", "config", "--get", "core.hooksPath"], { cwd: dir });
    expect(cfg.out.trim()).toBe(".githooks");
  });

  test("no-op under CI=1 (leaves core.hooksPath unset)", () => {
    const dir = initRepo("ezcorp-setup-ci-");
    const res = sh(["bash", SETUP], { cwd: dir, env: { ...baseEnv, CI: "1" } });
    expect(res.exitCode).toBe(0);
    const cfg = sh(["git", "config", "--get", "core.hooksPath"], { cwd: dir });
    expect(cfg.out.trim()).toBe("");
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
