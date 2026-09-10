#!/usr/bin/env bash
# Run the canonical Vitest pool once under Node V8 coverage. CI invokes one
# shard per existing Web tests shard; local coverage invokes it unsharded.
# Its union was proven to supersede the retired selected V8 leg before that
# duplicate producer was removed from cov-extras.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
out_dir=""
shard=""
# This launcher can run beside bounded Bun coverage legs in local full mode.
# Keep Vitest's pool explicit so it cannot fan out to every host CPU.
max_workers=${WEB_VITEST_COVERAGE_MAX_WORKERS:-2}

usage() {
  echo "usage: web-vitest-coverage.sh --output <directory> [--shard N/T]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      out_dir=${2:-}
      shift 2
      ;;
    --shard)
      shard=${2:-}
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [ -z "$out_dir" ]; then
  usage
  exit 2
fi
if [[ "$out_dir" != /* ]]; then
  out_dir="$repo_root/$out_dir"
fi
if [ -n "$shard" ] && ! [[ "$shard" =~ ^[1-9][0-9]*/[1-9][0-9]*$ ]]; then
  echo "invalid Vitest shard: $shard" >&2
  exit 2
fi
if ! [[ "$max_workers" =~ ^[1-9][0-9]*$ ]]; then
  echo "WEB_VITEST_COVERAGE_MAX_WORKERS must be a positive integer (got $max_workers)" >&2
  exit 2
fi

mkdir -p "$out_dir"
source "$repo_root/scripts/web-vitest-coverage-includes.sh"
web_vitest_coverage_args
cd "$repo_root/web"
args=(
  vitest run
  --testTimeout=30000
  "--maxWorkers=$max_workers"
  --coverage
  --coverage.provider=v8
  --coverage.reporter=lcovonly
  --coverage.exclude='**/*.test.ts'
  --coverage.exclude='**/__tests__/**'
  --coverage.exclude='**/*.d.ts'
  "--coverage.reportsDirectory=$out_dir"
  "${WEB_VITEST_COVERAGE_ARGS[@]}"
)
if [ -n "$shard" ]; then
  args+=("--shard=$shard")
fi
# npx uses Node's inspector, required by @vitest/coverage-v8. Do not use
# `bunx --bun`: Bun has no inspector Coverage domain.
npx "${args[@]}"

lcov="$out_dir/lcov.info"
if [ ! -s "$lcov" ]; then
  echo "Vitest coverage did not write $lcov" >&2
  exit 1
fi
# Vitest writes paths relative to web/. Convert them to repo-absolute paths so
# merge-lcov and the source-record guard agree with every other producer.
sed -i "s#^SF:src/#SF:$repo_root/web/src/#; s#^TN:.*#TN:ezcorp-node-v8#" "$lcov"
bun "$repo_root/scripts/filter-web-vitest-lcov.ts" "$lcov"
