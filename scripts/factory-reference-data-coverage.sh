#!/usr/bin/env bash
# The `reference.data.v1` producer: both legs of the C10 data journey.
#
# This is a coverage producer rather than a CI workflow step because it needs a
# container runtime AND the pinned PyArrow image, which is built from the
# committed uv.lock by scripts/build-factory-data-image.sh. An absent image is a
# READINESS FAILURE, not a skip: C10 says an unavailable pinned runner fails the
# gate rather than falling back to something else.
#
# Legs:
#   * ./src/factory/reference-data/journey.integration.test.ts
#       the embedded-database leg, on real Podman
#   * ./tests/postgres/factory-reference-data.test.ts
#       real PostgreSQL, S3-backed blobs, a real immutable publication, and the
#       256 MiB boundary
#
# Environment the real leg needs:
#   FACTORY_TEST_POSTGRES_URL, EZCORP_FACTORY_STORAGE_SECRETS_DIR
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=${COV_OUT:?COV_OUT is required}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/factory-reference-data-coverage.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out" "$tmp/unit" "$tmp/journey" "$tmp/postgres" "$tmp/postgres-bytes" "$tmp/postgres-rows"
cd "$repo_root"

image=$(bun -e 'const m = await import("./src/factory/reference-data/guest.ts"); process.stdout.write(await m.factoryReferenceDataImage());')
podman image exists "$image" || {
  echo "factory reference data: the pinned runner image $image is absent." >&2
  echo "Build it from the committed lock: bash scripts/build-factory-data-image.sh" >&2
  exit 1
}

bun test --timeout 60000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/unit" \
  ./src/factory/reference-data/csv.test.ts \
  ./src/factory/reference-data/thrift.test.ts \
  ./src/factory/reference-data/parquet.test.ts \
  ./src/factory/reference-data/manifest.test.ts \
  ./src/factory/reference-data/reconcile.test.ts \
  ./src/factory/reference-data/materials.test.ts \
  ./src/factory/reference-data/guest.test.ts \
  ./src/factory/reference-data/pack.test.ts

bun test --timeout 1800000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/journey" \
  ./src/factory/reference-data/journey.integration.test.ts

# The real leg runs in THREE invocations. Both C10 boundary cases in one process
# write roughly 600 MB of objects in three minutes, which OOM-killed the shared
# object store at its container memory cap; each leg on its own is well inside
# it. Splitting lowers the peak without weakening any case.
if [ -n "${FACTORY_TEST_POSTGRES_URL:-}" ]; then
  # The faithful full-file run, with the maximum-row case declared last so this
  # is what proves W04's per-operation object budget after every sibling.
  bun test --timeout 4800000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/postgres" \
    ./tests/postgres/factory-reference-data.test.ts
  sleep 30
  bun test --timeout 5400000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/postgres-bytes" \
    --test-name-pattern '256 MiB' ./tests/postgres/factory-reference-data.test.ts
  sleep 30
  bun test --timeout 5400000 --coverage --coverage-reporter=lcov --coverage-dir="$tmp/postgres-rows" \
    --test-name-pattern 'maximum row count' ./tests/postgres/factory-reference-data.test.ts
else
  echo "factory reference data: FACTORY_TEST_POSTGRES_URL is unset; the real leg did not run." >&2
  exit 1
fi

bun scripts/merge-lcov.ts "$tmp/*/lcov.info" "$out/lcov.info"
