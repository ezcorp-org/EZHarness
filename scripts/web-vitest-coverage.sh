#!/usr/bin/env bash
# Run the canonical Vitest pool once under Node V8 coverage for shared web libs.
# CI invokes one shard per existing Web tests shard; local coverage invokes it
# unsharded. The legacy selected Vitest leg remains until the first full union
# proves every existing threshold has identical-or-better evidence.
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
out_dir=""
shard=""

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

mkdir -p "$out_dir"
cd "$repo_root/web"
args=(
  vitest run
  --coverage
  --coverage.provider=v8
  --coverage.reporter=lcovonly
  --coverage.include='src/lib/**'
  --coverage.exclude='**/*.test.ts'
  --coverage.exclude='**/__tests__/**'
  --coverage.exclude='**/*.d.ts'
  "--coverage.reportsDirectory=$out_dir"
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
sed -i "s#^SF:src/#SF:$repo_root/web/src/#" "$lcov"
