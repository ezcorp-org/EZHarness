#!/usr/bin/env bash
# The C12 provisioner against real PostgreSQL: the ledger, the database step,
# the upgrade ledger, the purge census, fleet composition, the operator
# entry's init and main paths, and the gateway process's production
# composition. Every other provisioning module is
# measured by its own unit suite in the default pool.
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=${COV_OUT:?COV_OUT is required}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/factory-provisioning-coverage.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out" "$tmp/bun"
cd "$repo_root"
mkdir -p "$tmp/gateway"
bun test --timeout 120000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/bun" \
  ./tests/postgres/factory-provisioning.test.ts
# The gateway reads DATABASE_URL at module load, so it runs in its own process
# with the database named up front. CI provides DATABASE_URL; locally a scratch
# database on the same server is named, created by the test, and dropped by it.
gateway_url=${DATABASE_URL:-$(bun -e 'const u = new URL(process.env.FACTORY_TEST_POSTGRES_URL); u.pathname = `/factory_gateway_${crypto.randomUUID().replaceAll("-", "")}`; console.log(u.toString())')}
DATABASE_URL="$gateway_url" bun test --timeout 120000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/gateway" \
  ./tests/postgres/factory-gateway-process.test.ts
bun scripts/merge-lcov.ts "$tmp/*/lcov.info" "$tmp/merged.info"
bun scripts/filter-lcov-sources.ts "$tmp/merged.info" --output "$out/lcov.info" \
  src/factory/provisioning/local.ts \
  src/factory/provisioning/ledger.ts \
  src/factory/provisioning/database.ts \
  src/factory/provisioning/census.ts \
  src/factory/provisioning/fleet-upgrade.ts \
  src/factory/provisioning/fleet.ts \
  src/factory/provisioning/fleet-cli.ts \
  src/factory/gateway-process.ts
