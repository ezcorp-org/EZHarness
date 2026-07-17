#!/usr/bin/env bash
# Run the ORPHANED web bun-leg test pool (plain `web/src/**/*.test.ts` that
# vitest does NOT match and the backend coverage/passfail pools do NOT already
# run). Each file runs in its own bun process to prevent mock.module()
# contamination — the same per-file isolation scripts/test.sh uses for the
# backend pool.
#
# The file set is defined ONCE in scripts/lib/test-file-sets.sh
# (`web_bunleg_files`) so it can never drift from the coverage/passfail sets it
# subtracts. The CI `web-bun-tests` job runs this script.
#
# EXIT-CODE CAPTURE (was a bug): the previous version ran `bun test … || true`
# and only scraped the "N fail" summary — a module-load crash prints "0 fail"
# with no "(fail)" line, and a SIGKILL/OOM prints no summary at all, so both
# counted as PASS. This wrapper now records bun's per-shard exit code (the
# authoritative signal) exactly like scripts/test.sh, so a crash/kill is a
# real failure and can never ship green.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/test-file-sets.sh
source "$SCRIPT_DIR/lib/test-file-sets.sh"

cd "$REPO_ROOT"

# Ensure SvelteKit types exist (needed for $lib alias resolution under bun).
if [ ! -f web/.svelte-kit/tsconfig.json ]; then
  echo "Generating SvelteKit types..."
  ( cd web && bunx svelte-kit sync )
fi

# Default pool width: min(nproc, 6) — see default_parallel in
# lib/test-file-sets.sh. Explicit PARALLEL still overrides.
PARALLEL=${PARALLEL:-$(default_parallel)}
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()

# Repo-relative web/src/... paths (computed from the repo root so the finds in
# test-file-sets.sh resolve). bun test itself runs from web/ (below) so the
# web/ tsconfig + $lib alias resolve — strip the leading `web/` at call time.
mapfile -t FILES < <(web_bunleg_files)

# Non-empty guard: web_bunleg_files() is a computed set-difference (find minus
# the passfail/coverage sets). If a find path or the comm pipeline ever breaks
# it can silently yield ZERO files — the loop below is then a no-op and this
# required gate exits 0 having tested NOTHING (gate theater). ~225 files are
# expected; fail loudly instead of green-on-empty.
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "::error::web_bunleg_files produced an EMPTY set — the orphaned-web-test gate would pass without running anything. Check scripts/lib/test-file-sets.sh." >&2
  exit 1
fi

cd web

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Running ${#FILES[@]} orphaned web bun-leg test files (${PARALLEL} parallel)..."

RUNNING=0
IDX=0

for f in "${FILES[@]}"; do
  OUTFILE="$TMPDIR/result_$IDX"
  CODEFILE="$TMPDIR/code_$IDX"
  rel="${f#web/}"
  (
    # set +e (scoped to this subshell): the script runs under `set -e`, so a
    # FAILING `bun test` makes the `OUTPUT=$(...)` command-substitution
    # assignment abort the subshell BEFORE $CODEFILE/$OUTFILE are written. The
    # collection loop below then hits `[ -f "$OUTFILE" ] || continue`, skips the
    # missing file, never tallies its failure, and test-web.sh exits 0 on a
    # genuinely red file — silently swallowing it (the whole point of the
    # exit-code capture below is defeated without this). set +e records the real
    # exit code so a failing file is ALWAYS counted. Mirrors security-coverage.sh.
    set +e
    # --timeout 30000: contention-bound ceiling for the shared pool, mirroring
    # test.sh — a genuine hang still fails at 30s.
    OUTPUT=$(bun test --timeout 30000 "./$rel" 2>&1)
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

wait

# Collect results (shared with test.sh — see lib/test-file-sets.sh). A
# missing result file counts as a FAILURE ("no result recorded (killed?)"),
# never a silent skip.
collect_pool_results FILES

echo ""
echo "================================"
echo "  Web: ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | ${#FILES[@]} files"
echo "================================"

if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  echo ""
  echo "Failed files:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
fi

[ "${#FAILED_FILES[@]}" -eq 0 ] && exit 0 || exit 1
