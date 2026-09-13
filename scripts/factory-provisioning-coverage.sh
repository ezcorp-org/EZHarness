#!/usr/bin/env bash
set -euo pipefail
export PATH="/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH"
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=${COV_OUT:?COV_OUT is required}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/factory-provisioning-coverage.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out" "$tmp/bun"
cd "$repo_root"
bun test --coverage --coverage-reporter=lcov --coverage-dir="$tmp/bun" ./tests/postgres/factory-provisioning.test.ts
bun scripts/filter-lcov-sources.ts "$tmp/bun/lcov.info" --output "$out/lcov.info" src/factory/provisioning/local.ts
