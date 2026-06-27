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

PARALLEL=${PARALLEL:-6}
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()

# Collect all test files. The import-wizard endpoint tests live next
# to their SvelteKit routes (bun:test, per-file isolated like the rest),
# so include that dir alongside the canonical src/__tests__ pool.
mapfile -t FILES < <({
  find src/__tests__ -name "*.test.ts"
  find web/src/routes/api/import -name "*.test.ts"
  # github-projects integration: tests live next to their source (not under
  # src/__tests__), so enumerate those dirs explicitly — unit + integration.
  find src/integrations/github-projects/__tests__ -name "*.test.ts"
  find src/extensions/__tests__ -name "github-projects-handler*.test.ts"
  find web/src/routes/api/integrations/github-projects/__tests__ -name "*.test.ts"
} | sort)

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Run each file in its own process, up to PARALLEL at a time
RUNNING=0
IDX=0

for f in "${FILES[@]}"; do
  OUTFILE="$TMPDIR/result_$IDX"
  CODEFILE="$TMPDIR/code_$IDX"
  (
    OUTPUT=$(bun test "./$f" 2>&1)
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

# Collect results
for ((i=0; i<${#FILES[@]}; i++)); do
  OUTFILE="$TMPDIR/result_$i"
  [ -f "$OUTFILE" ] || continue
  OUTPUT=$(cat "$OUTFILE")
  CODE=$(cat "$TMPDIR/code_$i" 2>/dev/null || echo 1)

  PASS=$(echo "$OUTPUT" | awk '/pass/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="pass") print $j}' | tail -1)
  FAIL=$(echo "$OUTPUT" | awk '/fail/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="fail") print $j}' | tail -1)

  TOTAL_PASS=$((TOTAL_PASS + ${PASS:-0}))
  # Count at least one failure when bun exited non-zero but printed no parseable
  # "N fail" (module-load error, crash, or SIGKILL with no summary).
  if [ "$CODE" != "0" ] && [ "${FAIL:-0}" = "0" ]; then
    FAIL=1
  fi
  TOTAL_FAIL=$((TOTAL_FAIL + ${FAIL:-0}))

  # A file is failing if bun exited non-zero OR the summary reported failures.
  if [ "$CODE" != "0" ] || [ "${FAIL:-0}" != "0" ]; then
    FAILED_FILES+=("${FILES[$i]}")
    echo "--- FAIL: ${FILES[$i]} ---"
    DETAIL=$(echo "$OUTPUT" | awk '/\(fail\)/')
    if [ -n "$DETAIL" ]; then
      echo "$DETAIL"
    else
      # No per-test "(fail)" line — the file errored at load or was killed.
      # Surface the tail of its output so CI failures are diagnosable instead
      # of printing an empty header (the historical false-positive symptom).
      echo "  (no per-test failures parsed; exit code $CODE — showing output tail)"
      echo "$OUTPUT" | tail -20 | sed 's/^/  /'
    fi
    echo ""
  fi
done

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
