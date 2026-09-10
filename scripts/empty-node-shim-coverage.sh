#!/usr/bin/env bash
# Canonical Bun receipt for the literal Node-module browser alias contract.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COV_OUT=${COV_OUT:-coverage-empty-node-shim}
mkdir -p "$COV_OUT"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
cd "$REPO_ROOT"
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$TMPDIR/raw" ./src/__tests__/empty-node-shim.test.ts
bun scripts/filter-lcov-sources.ts "$TMPDIR/raw/lcov.info" --output "$COV_OUT/lcov.info" web/src/lib/empty-node-shim.ts
sed -i 's#^TN:.*#TN:ezcorp-bun-shim#' "$COV_OUT/lcov.info"
awk -F: '$1 == "LF" { lf=$2 } $1 == "LH" { lh=$2 } END { exit !(lf > 0 && lf == lh) }' "$COV_OUT/lcov.info" || { echo "::error::empty-node shim producer requires 100% line coverage" >&2; exit 1; }
