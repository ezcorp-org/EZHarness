#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=${COV_OUT:?COV_OUT is required}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/factory-package-preparation-coverage.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out" "$tmp/pglite"
cd "$repo_root"
source scripts/lib/watchdog.sh # EZ_POOL_TEST_TIMEOUT_MS, the pool's per-test budget (one definition)
bun test --timeout "$EZ_POOL_TEST_TIMEOUT_MS" --coverage --coverage-reporter=lcov --coverage-dir="$tmp/pglite" ./src/factory/package-preparation.integration.test.ts ./src/db/migrations/add-factory-package-preparations.test.ts
bun scripts/filter-lcov-sources.ts "$tmp/pglite/lcov.info" --output "$out/lcov.info" src/factory/package-preparation.ts src/db/migrations/add-factory-package-preparations.ts
