#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=${COV_OUT:?COV_OUT is required}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/factory-compute-admissions-coverage.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out" "$tmp/unit" "$tmp/postgres" "$tmp/authority" "$tmp/lcov"
cd "$repo_root"
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/unit" ./src/__tests__/factory-compute-admissions.test.ts
bun test --timeout 60000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/postgres" ./tests/postgres/factory-compute-admissions.test.ts
bun test --timeout 60000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/authority" ./tests/postgres/factory-run-lifecycle.test.ts
cp "$tmp/unit/lcov.info" "$tmp/lcov/unit.info"
cp "$tmp/postgres/lcov.info" "$tmp/lcov/postgres.info"
cp "$tmp/authority/lcov.info" "$tmp/lcov/authority.info"
bun scripts/merge-lcov.ts "$tmp/lcov/*.info" "$tmp/merged.lcov"
bun scripts/filter-lcov-sources.ts "$tmp/merged.lcov" --output "$out/lcov.info" src/factory/compute-admissions.ts src/db/migrations/add-factory-compute-admissions.ts
