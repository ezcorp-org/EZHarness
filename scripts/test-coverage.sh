#!/usr/bin/env bash
# Run each host / example test file in its own bun process with --coverage,
# plus one bundled run for the SDK suite (no mock.module contamination there,
# and bundling preserves module-load instrumentation parity with Phase 1's
# 100% SDK baseline). Merge all per-shard lcov files into coverage/lcov.info
# and enforce scripts/coverage-thresholds.json.
#
# Mirrors scripts/test.sh's parallel pattern for host tests.
set -e

PARALLEL=${PARALLEL:-6}
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()

# Host + example tests run per-file for mock.module() isolation.
mapfile -t FILES < <({
  find src/__tests__ -name "*.test.ts"
  find docs/extensions/examples -name "*.test.ts"
} | sort)

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

RUNNING=0
IDX=0

for f in "${FILES[@]}"; do
  OUTFILE="$TMPDIR/result_$IDX"
  COVDIR="$TMPDIR/cov_$IDX"
  (
    OUTPUT=$(bun test --coverage --coverage-reporter=lcov --coverage-dir="$COVDIR" "./$f" 2>&1) || true
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

# SDK tests bundled into a single shard (no mock.module use).
SDK_OUT="$TMPDIR/result_sdk"
SDK_COV="$TMPDIR/cov_sdk"
SDK_OUTPUT=$(bun test --coverage --coverage-reporter=lcov --coverage-dir="$SDK_COV" ./packages/@ezcorp/sdk/test/ 2>&1) || true
echo "$SDK_OUTPUT" > "$SDK_OUT"
SDK_PASS=$(echo "$SDK_OUTPUT" | awk '/pass/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="pass") print $j}' | tail -1)
SDK_FAIL=$(echo "$SDK_OUTPUT" | awk '/fail/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="fail") print $j}' | tail -1)
TOTAL_PASS=$((TOTAL_PASS + ${SDK_PASS:-0}))
TOTAL_FAIL=$((TOTAL_FAIL + ${SDK_FAIL:-0}))
if [ "${SDK_FAIL:-0}" != "0" ]; then
  FAILED_FILES+=("packages/@ezcorp/sdk/test/**")
  echo "--- FAIL: SDK bundled ---"
  echo "$SDK_OUTPUT" | awk '/\(fail\)/'
  echo ""
fi

echo ""
echo "================================"
echo "  ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | $((${#FILES[@]} + 1)) shards"
echo "================================"

if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  echo ""
  echo "Failed files:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
fi

# Merge per-shard lcov → coverage/lcov.info, then enforce thresholds.
mkdir -p coverage
bun scripts/merge-lcov.ts "$TMPDIR/cov_*/lcov.info" coverage/lcov.info

CHECK_EXIT=0
bun scripts/check-coverage.ts || CHECK_EXIT=$?

if [ "$TOTAL_FAIL" != "0" ] || [ "$CHECK_EXIT" != "0" ]; then
  exit 1
fi
exit 0
