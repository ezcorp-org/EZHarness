#!/usr/bin/env bash
# Canonical Bun receipt for the browser API transport contract.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COV_OUT=${COV_OUT:-coverage-api-client}
mkdir -p "$COV_OUT"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cd "$REPO_ROOT"
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$TMPDIR/raw" \
  ./src/__tests__/api-client-functions.test.ts ./src/__tests__/api-client-route-contracts.test.ts
bun scripts/filter-lcov-sources.ts "$TMPDIR/raw/lcov.info" --output "$COV_OUT/lcov.info" web/src/lib/api.ts
sed -i 's#^TN:.*#TN:ezcorp-bun-api#' "$COV_OUT/lcov.info"
lf=$(awk -F: '$1 == "LF" { print $2 }' "$COV_OUT/lcov.info")
lh=$(awk -F: '$1 == "LH" { print $2 }' "$COV_OUT/lcov.info")
if ! [[ "$lf" =~ ^[1-9][0-9]*$ && "$lh" =~ ^[1-9][0-9]*$ ]] || [ $((lh * 100)) -lt $((lf * 96)) ]; then
  echo "::error::api client producer requires at least 96% line coverage (LF=$lf LH=$lh)" >&2
  exit 1
fi
