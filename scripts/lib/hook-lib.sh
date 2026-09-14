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

# ── Staged unit tests (pre-commit shift-left) ───────────────────────────────
# Run the unit tests that correspond to the files a commit is staging, so a
# broken test is caught before the push instead of by CI. Advisory speed, NOT
# the backstop: the cap below deliberately SKIPS rather than blocks on a wide
# commit, because a pre-commit hook that takes minutes gets bypassed, and a
# bypassed hook checks nothing.

# staged_test_targets FILE...
# Print the test files that cover the given staged paths, one per line.
# A staged test file maps to itself; a staged source file maps to the test
# files this repo's layouts put it next to (colocated, sibling __tests__/, or
# the central src/__tests__/ and web/src/__tests__/ pools).
staged_test_targets() {
  local f base dir cand
  for f in "$@"; do
    case "$f" in
      *.test.ts | *.test.tsx | *.spec.ts)
        [ -f "$f" ] && echo "$f"
        continue
        ;;
      *.ts | *.tsx | *.svelte) ;;
      *) continue ;;
    esac
    base=$(basename "$f")
    base="${base%.*}"
    # `.svelte.ts` rune modules lose two extensions, not one.
    base="${base%.svelte}"
    dir=$(dirname "$f")
    for cand in \
      "$dir/$base.test.ts" \
      "$dir/$base.unit.test.ts" \
      "$dir/$base.component.test.ts" \
      "$dir/$base.server.test.ts" \
      "$dir/__tests__/$base.test.ts" \
      "$dir/__tests__/$base.unit.test.ts" \
      "$dir/__tests__/$base.component.test.ts" \
      "$dir/__tests__/$base.server.test.ts" \
      "src/__tests__/$base.test.ts" \
      "web/src/__tests__/$base.test.ts" \
      "web/src/__tests__/$base.unit.test.ts"; do
      [ -f "$cand" ] && echo "$cand"
    done
  done | sort -u
}

# run_staged_tests FILE...
# Resolve the staged paths to test files and run them in the CORRECT runner.
# Runner choice is not guessed from the filename: it asks the same
# test-file-sets.sh functions test.sh and test-coverage.sh use, so a file that
# was deliberately moved between the bun and vitest legs (see the explicit
# include list in web/vitest.config.ts) can never be run by the wrong one here.
# Backend files run ONE PER PROCESS with --timeout 30000 — bare `bun test` over
# several backend files deadlocks on cross-file mock.module() contamination,
# and the 5s default hook budget is too short for a PGlite restore.
run_staged_tests() {
  local max="${EZ_PRECOMMIT_TEST_MAX:-12}"
  local targets count
  targets=$(staged_test_targets "$@")

  if [ -z "$targets" ]; then
    echo "  no test file maps to the staged changes — skipping"
    return 0
  fi
  count=$(printf '%s\n' "$targets" | wc -l | tr -d ' ')
  if [ "$count" -gt "$max" ]; then
    echo "  $count test files map to this commit (cap ${max}) — skipping."
    echo "  A wide commit is what pre-push and CI are for; raise with EZ_PRECOMMIT_TEST_MAX."
    return 0
  fi

  # Same standalone-copy guard as the caller: without the file-set definitions
  # we cannot tell which runner owns a test, and guessing would run it in the
  # wrong one. Skip loudly rather than guess.
  local sets
  sets="$(git rev-parse --show-toplevel)/scripts/lib/test-file-sets.sh"
  if [ ! -r "$sets" ]; then
    echo "  scripts/lib/test-file-sets.sh not found — skipping (cannot resolve runners)"
    return 0
  fi
  # shellcheck source=/dev/null
  . "$sets" || return 1
  local bunset
  bunset=$({ passfail_files; web_bunleg_files; } 2>/dev/null | sort -u)

  local bun_targets=() vitest_targets=() t
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    if printf '%s\n' "$bunset" | grep -qxF -- "$t"; then
      bun_targets+=("$t")
    elif [ "${t#web/}" != "$t" ]; then
      vitest_targets+=("${t#web/}")
    else
      bun_targets+=("$t")
    fi
  done <<EOF
$targets
EOF

  local rc=0
  for t in "${bun_targets[@]-}"; do
    [ -n "$t" ] || continue
    echo "  bun: $t"
    # "./$t", never a bare "$t": bun treats a bare argument as a NAME FILTER and
    # searches only bunfig.toml's `root` (src/__tests__), so any test outside
    # that tree resolves to zero files — which bun exits non-zero for. That read
    # as "your test failed" on a file whose tests are fine. scripts/test.sh
    # prefixes for the same reason.
    bun test --timeout 30000 "./$t" || rc=1
  done
  if [ "${#vitest_targets[@]}" -gt 0 ]; then
    echo "  vitest: ${vitest_targets[*]}"
    # `--silent=true`, not a bare `--silent`: vitest's CAC parser treats the
    # next argv entry as the flag's VALUE and dies on the first test path.
    (cd web && bunx vitest run --silent=true "${vitest_targets[@]}") || rc=1
  fi
  return "$rc"
}
