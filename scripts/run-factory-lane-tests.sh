#!/usr/bin/env bash
# Run one C11 lane's test files: bash scripts/run-factory-lane-tests.sh <lane job>
#
# The list comes from the ONE lane manifest, FACTORY_LANES in
# scripts/check-factory-lanes.ts (`tests` then `boundTests`). The hosted shard
# selection reads the same manifest (scripts/lib/test-file-sets.sh,
# lane_bound_test_files) and never selects a bound test, so a test whose
# precondition only this lane's runner has runs here and nowhere else.
# An unknown lane or an empty list fails closed: an empty `bun test` would run
# the whole repository. Before any test starts, every image the lane's pin
# files name (`--lane-images`) must be on this runner; an absent one fails here
# by name, not as "image not known" deep inside a test.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
job=${1:?usage: bash scripts/run-factory-lane-tests.sh <lane job>}
list=$(bun scripts/check-factory-lanes.ts --lane-tests "$job")
images=$(bun scripts/check-factory-lanes.ts --lane-images "$job")
while IFS= read -r image; do
  [ -n "$image" ] || continue
  podman image exists "$image" || { echo "Precondition failed: lane $job needs the pinned image $image on this runner, and it is absent." >&2; exit 3; }
done <<<"$images"
mapfile -t files <<<"$list"
echo "lane $job: ${#files[@]} test file(s)"
exec bun test --timeout 300000 "${files[@]/#/./}"
