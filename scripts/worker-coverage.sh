#!/usr/bin/env bash
# Canonical worker receipt. Its Pi-ai boundary suite uses Bun's instrumenter;
# imported host files are filtered out so they cannot dilute worker/index.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/lcov-validation.sh
source "$SCRIPT_DIR/lib/lcov-validation.sh"
COV_OUT=${COV_OUT:-coverage-worker}
mkdir -p "$COV_OUT"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

cd "$REPO_ROOT"
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$TMPDIR/raw" ./worker/src/index.test.ts
bun scripts/filter-lcov-sources.ts "$TMPDIR/raw/lcov.info" --output "$COV_OUT/lcov.info" worker/src/index.ts

lines_found=$(awk -F: '$1 == "LF" { print $2 }' "$COV_OUT/lcov.info")
lines_hit=$(awk -F: '$1 == "LH" { print $2 }' "$COV_OUT/lcov.info")
if [ "$(lcov_source_count "$COV_OUT/lcov.info")" -ne 1 ] || ! lcov_has_executable_da "$COV_OUT/lcov.info" || \
   ! [[ "$lines_found" =~ ^[1-9][0-9]*$ ]] || [ "$lines_found" != "$lines_hit" ]; then
  echo "::error::worker producer must emit one fully-covered executable worker/src/index.ts record" >&2
  exit 1
fi
echo "wrote canonical worker source record → $COV_OUT/lcov.info"
