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

PARALLEL=${PARALLEL:-6}
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()

# Repo-relative web/src/... paths (computed from the repo root so the finds in
# test-file-sets.sh resolve). bun test itself runs from web/ (below) so the
# web/ tsconfig + $lib alias resolve — strip the leading `web/` at call time.
mapfile -t FILES < <(web_bunleg_files)

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
    OUTPUT=$(bun test "./$rel" 2>&1)
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
      # Surface the tail of its output so CI failures are diagnosable.
      echo "  (no per-test failures parsed; exit code $CODE — showing output tail)"
      echo "$OUTPUT" | tail -20 | sed 's/^/  /'
    fi
    echo ""
  fi
done

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
