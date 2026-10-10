#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COV_OUT=${COV_OUT:-"$REPO_ROOT/coverage-factory-orchestrator"}
TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/factory-orchestrator-coverage.XXXXXX")
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$COV_OUT" "$TEMP_ROOT/v8"
FACTORY_NODE_RUNTIME_DIR=${XDG_RUNTIME_DIR:-"/run/user/$(id -u)"}
if [ ! -d "$FACTORY_NODE_RUNTIME_DIR" ]; then
  echo "factory Node runtime directory is missing: $FACTORY_NODE_RUNTIME_DIR" >&2
  exit 1
fi
export XDG_RUNTIME_DIR=$FACTORY_NODE_RUNTIME_DIR

cd "$REPO_ROOT"
source scripts/lib/test-file-sets.sh
mapfile -t FACTORY_ORCHESTRATOR_TESTS < <(factory_orchestrator_test_files)
if [ "${#FACTORY_ORCHESTRATOR_TESTS[@]}" -eq 0 ]; then
  echo "factory orchestrator test set is empty" >&2
  exit 1
fi
source scripts/lib/test-totals.sh
node_modules/.bin/tsc -b packages/@ezcorp/factory-transport/tsconfig.build.json --force
node_modules/.bin/tsc -b packages/@ezcorp/factory-orchestrator/tsconfig.build.json --force
# Fail loudly, never hang in silence (W4H-21: hosted run 38001537073 printed nothing for ten minutes until the job timeout).
# - Each test ends within PER_TEST_TIMEOUT_MS, 3.3x the slowest green test (60.0 s, "continues only from a quiescent state
#   and restores absolute timers"); --test-force-exit then ends the file even when the timed-out test left a handle open.
# - The spec reporter writes to stdout, and tee keeps the same bytes in the progress log, so the job log names each test as
#   it ends. (A second spec reporter for the file would be a third reporter, and node then warns MaxListenersExceeded.)
# - INNER_TIMEOUT_S plus the kill grace ends 120 s before ci.yml's 10-minute job timeout, which also pays for the 33 s of
#   setup steps, the two builds above and the steps after this script. On failure the job log gets the progress-log tail.
# node's totals print after the run, pass or fail, so the job log always shows a count.
PER_TEST_TIMEOUT_MS=200000
INNER_TIMEOUT_S=450
PROGRESS_TAIL_LINES=60
set +e
NODE_V8_COVERAGE="$TEMP_ROOT/v8" \
FACTORY_BUNDLE_CODE_PATH="$TEMP_ROOT/workflow-bundle.js" \
FACTORY_BUNDLE_MAP_PATH="$TEMP_ROOT/workflow-bundle.map.json" \
timeout --signal=TERM --kill-after=30s "${INNER_TIMEOUT_S}s" \
  node --test --test-concurrency=1 --test-timeout="$PER_TEST_TIMEOUT_MS" --test-force-exit \
  --experimental-strip-types --experimental-test-coverage \
  --test-coverage-include='packages/@ezcorp/factory-orchestrator/src/**/*.ts' \
  --test-coverage-include='packages/@ezcorp/factory-transport/src/**/*.ts' \
  --test-coverage-include='src/factory/file-key-wraps.ts' \
  --test-coverage-include='src/factory/orchestration-process.ts' \
  --test-coverage-include='src/factory/orchestration-readiness-writer.ts' \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=lcov --test-reporter-destination="$TEMP_ROOT/direct.lcov" \
  "${FACTORY_ORCHESTRATOR_TESTS[@]}" | tee "$COV_OUT/test-progress.log"
node_status=${PIPESTATUS[0]}
if [ "$node_status" -ne 0 ]; then
  echo "factory orchestrator tests failed: exit $node_status (124 = the ${INNER_TIMEOUT_S}s inner timeout); the progress log ends:" >&2
  tail -n "$PROGRESS_TAIL_LINES" "$COV_OUT/test-progress.log"
fi
set -e
print_node_totals "$COV_OUT/test-progress.log"
[ "$node_status" -eq 0 ] || exit "$node_status"

node scripts/factory-orchestrator-v8-to-lcov.mjs \
  "$TEMP_ROOT/v8" "$TEMP_ROOT/workflow-bundle.js" "$TEMP_ROOT/workflow-bundle.map.json" "$TEMP_ROOT/workflow.lcov"
sed 's/^TN:$/TN:ezcorp-node-v8/' "$TEMP_ROOT/direct.lcov" > "$COV_OUT/lcov.info"
cat "$TEMP_ROOT/workflow.lcov" >> "$COV_OUT/lcov.info"
