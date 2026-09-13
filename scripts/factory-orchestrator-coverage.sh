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
node_modules/.bin/tsc -b packages/@ezcorp/factory-transport/tsconfig.build.json --force
node_modules/.bin/tsc -b packages/@ezcorp/factory-orchestrator/tsconfig.build.json --force
NODE_V8_COVERAGE="$TEMP_ROOT/v8" \
FACTORY_BUNDLE_CODE_PATH="$TEMP_ROOT/workflow-bundle.js" \
FACTORY_BUNDLE_MAP_PATH="$TEMP_ROOT/workflow-bundle.map.json" \
timeout --signal=TERM --kill-after=30s 600s \
  node --test --test-concurrency=1 --experimental-strip-types --experimental-test-coverage \
  --test-coverage-include='packages/@ezcorp/factory-orchestrator/src/**/*.ts' \
  --test-coverage-include='packages/@ezcorp/factory-transport/src/**/*.ts' \
  --test-coverage-include='src/factory/file-key-wraps.ts' \
  --test-coverage-include='src/factory/orchestration-process.ts' \
  --test-coverage-include='src/factory/orchestration-readiness-writer.ts' \
  --test-reporter=spec --test-reporter-destination="$COV_OUT/test-progress.log" \
  --test-reporter=lcov --test-reporter-destination="$TEMP_ROOT/direct.lcov" \
  "${FACTORY_ORCHESTRATOR_TESTS[@]}"

node scripts/factory-orchestrator-v8-to-lcov.mjs \
  "$TEMP_ROOT/v8" "$TEMP_ROOT/workflow-bundle.js" "$TEMP_ROOT/workflow-bundle.map.json" "$TEMP_ROOT/workflow.lcov"
sed 's/^TN:$/TN:ezcorp-node-v8/' "$TEMP_ROOT/direct.lcov" > "$COV_OUT/lcov.info"
cat "$TEMP_ROOT/workflow.lcov" >> "$COV_OUT/lcov.info"
