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
# The import-wizard endpoint tests sit beside their routes (bun:test);
# include them so their lcov merges and the import paths are gated.
#
# The Phase 66 search-helper bun:test suites also join the per-file loop so
# their lcov merges and the web/src/lib/search logic paths get gated. Run
# from the repo root, the loop body below already emits web/-prefixed SF
# paths, so no cd / SF rewrite is needed. SCOPED to JUST the two target
# search-helper test files (snippet-sanitize + search-mode) — NOT the whole
# web/src/__tests__ dir. Widening to the whole dir transitively imports
# dozens of unrelated web/src/lib, SDK, and example modules, whose
# sourcemap-attributed zero-hit DA records inflate the denominator on files
# already pinned at 100% (web/src/lib/**:90, packages/@ezcorp/sdk/src/**:100,
# docs/extensions/examples/*/index.ts:100), surfacing them as new gate
# violations. Scoping to the two target files confines the gate change to the
# five intended Phase 66 files (verified: no other threshold-matched file
# regresses). The vitest-only deep-link-resolve + goal-row-logic + GoalPill
# run under the node-vitest leg below (coverage-v8 fails under Bun).
mapfile -t FILES < <({
  find src/__tests__ -name "*.test.ts"
  find docs/extensions/examples -name "*.test.ts"
  find web/src/routes/api/import -name "*.test.ts"
  printf '%s\n' \
    web/src/__tests__/snippet-sanitize.test.ts \
    web/src/__tests__/search-mode.test.ts
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

# Node-run vitest coverage leg for the vitest-only web/src/lib files.
# WHY node, not bun: @vitest/coverage-v8 needs node:inspector's Coverage
# domain, which Bun does not implement (`bunx --bun vitest --coverage`
# fails with "Coverage APIs are not supported"). release-sdk.yml already
# provisions node 22 before `bun run test:coverage`, so this leg works in
# the gate CI with no new workflow setup. deep-link-resolve.ts transitively
# imports a Svelte-rune module, so bun cannot compile it — this leg is the
# ONLY way those lines get measured. --coverage.include is scoped to JUST
# the five target lib paths so the leg does not pull all of web/src/lib/**
# into the gate (which would surface other unmeasured files as violations
# under the web/src/lib/**:90 wildcard). Run in a subshell so `cd web`
# never leaks to the rest of the script.
VITEST_COV="$TMPDIR/cov_vitest"
VITEST_EXIT=0
( cd web && npx vitest run \
    src/__tests__/deep-link-resolve.unit.test.ts \
    src/lib/components/goal-row-logic.unit.test.ts \
    src/lib/components/GoalPill.component.test.ts \
    --coverage --coverage.provider=v8 --coverage.reporter=lcovonly \
    --coverage.reportsDirectory="$VITEST_COV" \
    --coverage.include='src/lib/search/**' \
    --coverage.include='src/lib/components/goal-row-logic.ts' \
    --coverage.include='src/lib/components/GoalPill.svelte' ) || VITEST_EXIT=$?
# vitest (run from web/) emits SF paths web/-relative (SF:src/lib/...).
# Re-root them so merge-lcov.ts resolves them against the repo root and the
# repo-root-relative threshold keys (web/src/lib/...) match.
if [ -f "$VITEST_COV/lcov.info" ]; then
  sed -i 's#^SF:src/#SF:web/src/#' "$VITEST_COV/lcov.info"
fi
if [ "$VITEST_EXIT" != "0" ]; then
  FAILED_FILES+=("web vitest-coverage leg (deep-link-resolve + goal-row-logic + GoalPill)")
  echo "--- FAIL: web vitest-coverage leg (exit $VITEST_EXIT) ---"
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

if [ "$TOTAL_FAIL" != "0" ] || [ "$CHECK_EXIT" != "0" ] || [ "$VITEST_EXIT" != "0" ]; then
  exit 1
fi
exit 0
