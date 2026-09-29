/**
 * A real git repository carrying the real patch-coverage gate scripts, so a
 * test can drive the gate's `main()` over a real diff. Shared by the type-only
 * (scripts/check-patch-coverage-typeonly.test.ts) and attestation
 * (scripts/check-patch-coverage-attestation.test.ts) end-to-end suites.
 *
 * Every command (`git` and `bun`) runs isolated from the caller's own git
 * context: a hook that exports `GIT_DIR` and friends would otherwise make
 * `git init`/`git commit` act on the hook's repository instead of the sandbox.
 */
import { expect } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scratchGitEnv } from "./scratch-git";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const GATE_SCRIPTS = ["check-patch-coverage.ts", "coverage-config.ts", "git-output.ts", "unified-diff.ts"] as const;

export type PatchGateSandbox = { root: string; base: string; cleanup: () => void };

/** `home` is colocated under `cwd` so one `rmSync(root, ...)` cleans it up with the rest. */
export async function runInSandbox(cwd: string, command: readonly string[], env: Record<string, string> = {}) {
  const home = join(cwd, ".git-scratch-home");
  mkdirSync(home, { recursive: true });
  const proc = Bun.spawn([...command], { cwd, env: { ...scratchGitEnv(home), ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** The sandbox at its base commit: the gate scripts plus one anchor source file. */
export async function makePatchGateSandbox(): Promise<PatchGateSandbox> {
  const root = mkdtempSync(join(tmpdir(), "patchcov-sandbox-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "coverage"), { recursive: true });
  mkdirSync(join(root, "src/factory"), { recursive: true });
  for (const script of GATE_SCRIPTS) copyFileSync(join(REPO_ROOT, "scripts", script), join(root, "scripts", script));
  await Bun.write(join(root, "src/factory/anchor.ts"), "export const anchor = 1;\n");
  await runInSandbox(root, ["git", "init", "--initial-branch=main"]);
  await runInSandbox(root, ["git", "config", "user.email", "gate@example.test"]);
  await runInSandbox(root, ["git", "config", "user.name", "Gate Sandbox"]);
  await runInSandbox(root, ["git", "add", "-A"]);
  await runInSandbox(root, ["git", "commit", "-m", "base"]);
  const base = (await runInSandbox(root, ["git", "rev-parse", "HEAD"])).stdout.trim();
  expect(base, "sandbox base commit is missing").toMatch(/^[0-9a-f]{40}$/);
  return { root, base, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Write files (repository-relative path to content) and an lcov, commit, run the real gate over the diff, then roll back. */
export async function gateAfterWriting(
  sandbox: PatchGateSandbox,
  files: Readonly<Record<string, string>>,
  lcov = "",
): Promise<{ exitCode: number; output: string }> {
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(sandbox.root, relPath)), { recursive: true });
    await Bun.write(join(sandbox.root, relPath), content);
  }
  await Bun.write(join(sandbox.root, "coverage/lcov.info"), lcov);
  await runInSandbox(sandbox.root, ["git", "add", "-A"]);
  const committed = await runInSandbox(sandbox.root, ["git", "commit", "-m", "change"]);
  expect(committed.exitCode, committed.stderr).toBe(0);
  const result = await runInSandbox(sandbox.root, ["bun", join(sandbox.root, "scripts/check-patch-coverage.ts")], {
    BASE_REF: sandbox.base,
  });
  // Roll back so each case starts from the same base diff.
  await runInSandbox(sandbox.root, ["git", "reset", "--hard", sandbox.base]);
  return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` };
}
