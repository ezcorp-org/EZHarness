#!/usr/bin/env bun
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
      const process = Bun.spawnSync(
        ["git", "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );
      return {
        exitCode: process.exitCode,
        stdout: process.stdout.toString(),
        stderr: process.stderr.toString(),
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

if (import.meta.main) {
  const repoRoot = process.argv[2] ?? process.cwd();
  assertCleanGitWorktree(repoRoot);
  console.log("verified clean Git worktree: " + repoRoot);
}
