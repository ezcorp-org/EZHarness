#!/usr/bin/env bash
# Run each test file in its own bun process to prevent mock.module() contamination.
# Files run in parallel (up to PARALLEL jobs) for speed, but each gets full isolation.
#
# WHY THIS WRAPPER EXISTS (Phase 54 verification-gap closure, 2026-05-11):
# ──────────────────────────────────────────────────────────────────────
# Naive `bun test` from the repo root globs all 553 spec files into a
# single bun process. Two independent verification runs (35+ min and
# 20+ min wall-clock) HUNG past warm-up with repeating "Watchdog deferred"
# log lines and never progressed. Root cause: cross-file `mock.module()`
# state bleeds between specs in a single bun process — at this pool size
# (553 files × tens of module mocks each) the contamination produces a
# deadlock that bun's per-test timeout cannot surface (the wait is at
# module-load, not in a test body).
#
# Bisection (Phase 54 gap-closure, 2026-05-11): `bun test src/__tests__/a*`
# alone completes in <60s; `bun test src/__tests__/{a..f}*` completes in
# <3min; only the full 553-file pool hangs. No single offending spec —
# the failure mode is emergent at pool size, not file-local. Therefore
# the mitigation is the WRAPPER (per-file process isolation), not a
# skip-list.
#
# CANONICAL ENTRY POINTS for the backend pool:
#   - `bun run test`         (uses package.json:15 → this script)
#   - `bash scripts/test.sh` (this script directly)
# DO NOT run bare `bun test` from the repo root — it hangs. If a CI step
# or doc references bare `bun test`, route it through this wrapper instead.
#
# Per-file targeted runs are fine: `bun test src/__tests__/foo.test.ts`.
# It's only the unbounded glob that triggers the cross-spec deadlock.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-file-sets.sh
source "$SCRIPT_DIR/lib/test-file-sets.sh"

# Default pool width: min(nproc, 6) — see default_parallel in
# lib/test-file-sets.sh. Explicit PARALLEL still overrides.
PARALLEL=${PARALLEL:-$(default_parallel)}
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()

# The pass/fail set (P) is defined in scripts/lib/test-file-sets.sh and shared
# with scripts/test-coverage.sh so the two can never drift. RESIDUAL_ONLY=1
# runs ONLY the files in P that the coverage shards do NOT run (the
# *integration* variants) — the CI `residual-tests` job uses this so every
# pass/fail file runs somewhere without re-running what the coverage shards
# already cover. Empty residual is fine (the loop is a no-op).
# CRITICAL_ONLY=1 runs ONLY the curated critical correctness set (RBAC /
# migrations / gh-projects concurrency / auth / secrets / mention-wiring) that
# the CI `backend-critical` job gates strictly on pass/fail — see
# critical_backend_files() in lib/test-file-sets.sh.
if [ -n "$RESIDUAL_ONLY" ]; then
  mapfile -t FILES < <(residual_passfail_files)
elif [ -n "$CRITICAL_ONLY" ]; then
  mapfile -t FILES < <(critical_backend_files)
else
  mapfile -t FILES < <(passfail_files)
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Run each file in its own process, up to PARALLEL at a time
RUNNING=0
IDX=0

for f in "${FILES[@]}"; do
  OUTFILE="$TMPDIR/result_$IDX"
  CODEFILE="$TMPDIR/code_$IDX"
  (
    # set +e (scoped to this subshell): the script runs under `set -e`, so a
    # FAILING `bun test` makes the `OUTPUT=$(...)` command-substitution
    # assignment abort the subshell BEFORE the exit-code/output files are
    # written. That file then leaves no result_$IDX, the collection loop below
    # `continue`s past the missing file, its failure is never tallied, and
    # test.sh exits 0 on a genuinely red file — silently swallowing the failure
    # (proven: a residual-set file failing left no code/result file and the run
    # reported 0 fail). set +e records the real exit code so a failing file is
    # ALWAYS counted. Mirrors the identical guard in test-coverage.sh's
    # run_host_pool, which was fixed for exactly this reason.
    set +e
    # --timeout 30000: DB-heavy suites share the host with PARALLEL-1 sibling
    # PGlite processes; bun's 5s default per-test ceiling is contention-bound,
    # not correctness-bound, in this pool. A genuine hang still fails at 30s.
    OUTPUT=$(bun test --timeout 30000 "./$f" 2>&1)
    # Record bun's per-shard exit code — the authoritative pass/fail signal.
    # Scraping the summary alone is unreliable: a file that errors at module
    # load prints "N fail" with no "(fail)" lines, and a file killed (SIGKILL/
    # OOM) under parallel load may print no summary at all. The exit code is
    # the only signal that survives both, so we never silently pass a crash.
    echo "$?" > "$CODEFILE"
    echo "$OUTPUT" > "$OUTFILE"
  ) &
  IDX=$((IDX + 1))
  RUNNING=$((RUNNING + 1))

  if [ "$RUNNING" -ge "$PARALLEL" ]; then
    wait -n 2>/dev/null || true
    RUNNING=$((RUNNING - 1))
  fi
done

# Wait for remaining
wait

# Collect results (shared with test-web.sh — see lib/test-file-sets.sh). A
# missing result file counts as a FAILURE ("no result recorded (killed?)"),
# never a silent skip.
collect_pool_results FILES

echo ""
echo "================================"
echo "  ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | ${#FILES[@]} files"
echo "================================"

if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  echo ""
  echo "Failed files:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
fi

[ "$TOTAL_FAIL" = "0" ] && exit 0 || exit 1
