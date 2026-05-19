#!/usr/bin/env bash
# Run web unit tests from the web/ directory.
# Each file runs in its own bun process to prevent mock.module() contamination.
set -e

cd "$(dirname "$0")/../web"

# Ensure SvelteKit types exist (needed for $lib alias resolution)
if [ ! -f .svelte-kit/tsconfig.json ]; then
  echo "Generating SvelteKit types..."
  bunx svelte-kit sync
fi

PARALLEL=${PARALLEL:-6}
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()

mapfile -t FILES < <(find src/__tests__ -name "*.test.ts" | sort)

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Running ${#FILES[@]} web unit test files (${PARALLEL} parallel)..."

RUNNING=0
IDX=0

for f in "${FILES[@]}"; do
  OUTFILE="$TMPDIR/result_$IDX"
  (
    OUTPUT=$(bun test "./$f" 2>&1) || true
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

  PASS=$(echo "$OUTPUT" | awk '/pass/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="pass") print $j}' | tail -1)
  FAIL=$(echo "$OUTPUT" | awk '/fail/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="fail") print $j}' | tail -1)

  TOTAL_PASS=$((TOTAL_PASS + ${PASS:-0}))
  TOTAL_FAIL=$((TOTAL_FAIL + ${FAIL:-0}))

  if [ "${FAIL:-0}" != "0" ]; then
    FAILED_FILES+=("${FILES[$i]}")
    echo "--- FAIL: ${FILES[$i]} ---"
    echo "$OUTPUT" | awk '/\(fail\)/'
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

[ "$TOTAL_FAIL" = "0" ] && exit 0 || exit 1
