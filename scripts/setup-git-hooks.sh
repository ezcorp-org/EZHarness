#!/usr/bin/env bash
# Point git at the checked-in .githooks/ so developers get the local shift-left
# hooks (pre-commit lint + manifest-lock, pre-push lint/typecheck/svelte-check)
# after a plain `bun install`. Called from package.json postinstall.
#
# Scoped PER WORKING TREE, not to the shared config: this repo is developed in
# linked git worktrees that share one `.git`, so a shared `core.hooksPath` would
# mean `bun install` in a worktree flips hooks on for the primary checkout (and
# vice-versa). Instead we enable `extensions.worktreeConfig` (shared, but
# mechanism-only — it enables nothing by itself) and write `core.hooksPath` to
# the CURRENT tree's `config.worktree`, so each checkout opts in independently.
#
# MUST be a safe no-op — never fail an install — in the environments where
# there's no developer git repo to wire up:
#   - CI ($CI set): the required checks ARE the gate; local hooks are noise.
#   - Docker builds / tarball installs: no .git present.
#   - git too old for `--worktree`: skip cleanly rather than leak to shared.
# so it exits 0 in all of those, and swallows any error from the git calls.
set -u

# Never break `bun install`: any unexpected failure below still exits 0.
main() {
  # CI opt-out: the server-side required checks are the enforcement gate.
  if [ -n "${CI:-}" ]; then
    return 0
  fi

  # Only wire hooks when we're actually inside a git work tree (skips Docker
  # image builds and tarball installs where .git is absent).
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi

  # Enable the per-worktree config mechanism (shared, idempotent, harmless on
  # its own), then scope hooksPath to THIS working tree only. The relative
  # `.githooks` resolves against each tree's own root at hook-run time. On a git
  # too old to support `--worktree`, bail cleanly (no shared-config fallback —
  # CI stays the backstop) rather than leak the setting across worktrees.
  git config extensions.worktreeConfig true || return 0
  git config --worktree core.hooksPath .githooks || return 0

  # Git preserves the executable bit from the index, but make sure a fresh
  # checkout / filesystem that dropped it still yields runnable hooks.
  chmod +x .githooks/* 2>/dev/null || true

  echo "✓ git hooks enabled for this working tree (core.hooksPath=.githooks). Skip with EZ_SKIP_HOOKS=1 or --no-verify."
  return 0
}

main || true
exit 0
