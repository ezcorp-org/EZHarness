#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=${COV_OUT:?COV_OUT is required}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/factory-pool-coverage.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out" "$tmp/bun-ledger" "$tmp/bun-postgres-ledger" "$tmp/bun-service" "$tmp/bun-token" "$tmp/bun-http" "$tmp/bun-postgres-http" "$tmp/bun-process" "$tmp/node-v8"
cd "$repo_root"
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/bun-ledger" ./src/factory/pool/ledger.integration.test.ts
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/bun-postgres-ledger" ./tests/postgres/factory-pool.test.ts
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/bun-service" ./tests/postgres/factory-pool-service.test.ts
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/bun-token" ./src/factory/pool/service-token.test.ts
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/bun-http" ./src/factory/pool/client.test.ts ./src/factory/pool/service-routes.test.ts
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/bun-postgres-http" ./tests/postgres/factory-pool-http.test.ts
bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/bun-process" ./src/factory/pool/process.test.ts ./src/factory/pool/readiness.test.ts
bun test --timeout 60000 ./tests/postgres/factory-pool-process.test.ts
NODE_V8_COVERAGE="$tmp/node-v8" FACTORY_POOL_NODE_V8_BUNDLE="$tmp/server.mjs" bun test --timeout 30000 ./tests/postgres/factory-pool-mtls.test.ts
node scripts/node-v8-to-lcov.mjs "$tmp/node-v8" "$tmp/server.mjs" "$tmp/server.mjs" "$tmp/server.lcov" src/factory/pool/service-server.ts
mkdir "$tmp/lcov"
cp "$tmp/bun-ledger/lcov.info" "$tmp/lcov/ledger.info"
cp "$tmp/bun-postgres-ledger/lcov.info" "$tmp/lcov/postgres-ledger.info"
cp "$tmp/bun-service/lcov.info" "$tmp/lcov/service.info"
cp "$tmp/bun-token/lcov.info" "$tmp/lcov/token.info"
cp "$tmp/bun-http/lcov.info" "$tmp/lcov/http.info"
cp "$tmp/bun-postgres-http/lcov.info" "$tmp/lcov/postgres-http.info"
cp "$tmp/bun-process/lcov.info" "$tmp/lcov/process.info"
cp "$tmp/server.lcov" "$tmp/lcov/server.info"
bun scripts/merge-lcov.ts "$tmp/lcov/*.info" "$tmp/merged.lcov"
bun scripts/filter-lcov-sources.ts "$tmp/merged.lcov" --output "$out/lcov.info" src/factory/pool/client.ts src/factory/pool/index.ts src/factory/pool/ledger.ts src/factory/pool/process.ts src/factory/pool/readiness.ts src/factory/pool/service.ts src/factory/pool/service-routes.ts src/factory/pool/service-server.ts src/factory/pool/service-token.ts src/factory/pool/wire.ts
