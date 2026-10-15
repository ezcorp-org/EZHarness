#!/usr/bin/env bun
import { currentRepositoryGitContext } from "@ezcorp/sdk/git";

/** Fail a source-attested receipt when its checkout contains source changes. */
export type GitWorktreeStatus = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type GitWorktreeInspector = {
  status(repoRoot: string): GitWorktreeStatus;
};

function productionInspector(): GitWorktreeInspector {
  return {
    status(repoRoot) {
      // Item C2 (W18 hygiene): this inspects repoRoot's OWN worktree status
      // as invoked (a receipt-verification caller may itself run from
      // inside a hook, where staged-vs-committed distinctions matter), so
      // it keeps the invoking git context (currentRepositoryGitContext(),
      // never withoutGitContext() -- stripping would be wrong here, not
      // merely unneeded). The local result variable is renamed `process_`
      // (was `process`): the original name shadowed the global `process`
      // for this whole block, including its own initializer (a
      // `let`/`const` temporal-dead-zone rule), so `process.env` below
      // would otherwise throw.
      const env = currentRepositoryGitContext(process.env);
      const process_ = Bun.spawnSync(
        ["git", "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env },
      );
      return {
        exitCode: process_.exitCode,
        stdout: process_.stdout.toString(),
        stderr: process_.stderr.toString(),
      };
    },
  };
}

/**
 * Reject staged, tracked, and nonignored untracked changes. Git status omits
 * ignored mapped-build and receipt directories, so CI artifact extraction does
 * not invalidate the source identity.
 */
export function assertCleanGitWorktree(
  repoRoot: string,
  inspector: GitWorktreeInspector = productionInspector(),
): void {
  const status = inspector.status(repoRoot);
  if (status.exitCode !== 0) {
    throw new Error(
      "browser coverage could not inspect Git worktree at " + repoRoot + ": " +
      (status.stderr.trim() || "git status exited " + status.exitCode),
    );
  }

  const changes = status.stdout.trimEnd();
  if (changes.trim()) {
    throw new Error(
      "browser coverage requires a clean Git worktree before source attestation. Commit or remove these changes:\n" + changes,
    );
  }
}

export function runCleanGitWorktreeCli(
  args: readonly string[],
  cwd: string = process.cwd(),
  output: (message: string) => void = console.log,
): void {
  const repoRoot = args[0] ?? cwd;
  assertCleanGitWorktree(repoRoot);
  output("verified clean Git worktree: " + repoRoot);
}

if (import.meta.main) runCleanGitWorktreeCli(process.argv.slice(2));
