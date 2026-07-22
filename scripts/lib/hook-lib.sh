#!/usr/bin/env bash
# Shared helpers for the local git hooks (.githooks/*) AND scripts/ci-local.sh,
# so the biome worktree vacuous-pass guard and the per-step timing wrapper live
# in ONE place (DRY) instead of being copy-pasted. Source this file; don't
# execute it. Run from the repo root (callers cd there first).

# hook_step NAME CMD [ARGS...]
# Print a header, run CMD, print elapsed seconds, and return CMD's exit status.
# Standalone twin of ci-local.sh's run_step so the hooks can time their steps.
hook_step() {
  local name="$1"
  shift
  echo ""
  echo "── ${name} ─────────────────────────────────"
  local start=$SECONDS
  local rc=0
  "$@" || rc=$?
  echo "   (${name}: $((SECONDS - start))s)"
  return "$rc"
}

# run_biome_full
# Run `biome check .` over the whole tree and CLASSIFY the outcome so each
# caller can apply its own policy to the git-worktree vacuous case. Echoes
# biome's tail output. Returns:
#   0 — checked >0 files, lint clean
#   1 — checked >0 files, lint violations
#   2 — "Checked 0 files": biome resolves nothing in a git WORKTREE
#       (vcs.useIgnoreFile + `.git`-is-a-file). NOT a real pass — the caller
#       decides whether to WARN+skip (pre-push) or FAIL (ci-local).
run_biome_full() {
  local out rc
  out=$(bunx biome check . 2>&1)
  rc=$?
  echo "$out" | tail -n 3
  if echo "$out" | grep -q "Checked 0 files"; then
    return 2
  fi
  return "$rc"
}

# svelte_check
# The same errors-only Svelte template/type gate CI runs (`cd web && bunx
# svelte-check`, preceded by `svelte-kit sync` so generated `$types` exist).
# Warnings stay visible; only errors set a non-zero exit.
svelte_check() {
  (
    cd web || return 1
    bunx --bun svelte-kit sync >/dev/null 2>&1 || true
    bunx svelte-check
  )
}
