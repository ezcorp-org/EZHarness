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
# Run the repo's full lint (`bun run lint` — the ONE definition of which paths
# get linted, so the hooks can't drift from CI) and CLASSIFY the outcome.
# Echoes biome's tail output. Returns:
#   0 — checked >0 files, lint clean
#   1 — checked >0 files, lint violations
#   2 — "Checked 0 files", i.e. a VACUOUS pass. NOT a real pass — the caller
#       decides whether to WARN+skip (pre-push) or FAIL (ci-local).
#
# The historical trigger for rc=2 was linting `.` from a git worktree: a
# `!**/<segment>` entry in biome.json's `files.includes` matches the ABSOLUTE
# path, so `!**/.claude` swallowed every checkout under
# `<repo>/.claude/worktrees/agent-*/`. Both halves of that are now fixed —
# biome.json uses root-relative `!.claude`, and `bun run lint` passes EXPLICIT
# paths, which biome resolves regardless of what the ignore globs match. This
# guard stays as a cheap backstop against a third way of reaching zero.
run_biome_full() {
  local out rc
  out=$(bun run lint 2>&1)
  rc=$?
  echo "$out" | tail -n 3
  if echo "$out" | grep -q "Checked 0 files"; then
    return 2
  fi
  return "$rc"
}

# svelte_check
# The same errors-only Svelte template/type gate CI runs (`cd web && bunx
# svelte-check --tsgo`, preceded by `svelte-kit sync` so generated `$types`
# exist). Warnings stay visible; only errors set a non-zero exit.
# --tsgo must match ci.yml exactly — without it svelte-check throws on the
# TypeScript 7 dual install rather than running (see web/package.json).
svelte_check() {
  (
    cd web || return 1
    bunx --bun svelte-kit sync >/dev/null 2>&1 || true
    bunx svelte-check --tsgo
  )
}
