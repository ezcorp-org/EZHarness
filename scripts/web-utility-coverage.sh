#!/usr/bin/env bash
# Direct Bun LCOV producer for web utility suites that must run from web/ for
# SvelteKit's $lib/$server aliases. They are P members but are deliberately
# excluded from the root coverage host pool; this is their single instrumented
# execution. Per-file processes retain Bun mock isolation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/test-file-sets.sh
source "$SCRIPT_DIR/lib/test-file-sets.sh"

COV_OUT=${COV_OUT:-coverage-web-utility}
mkdir -p "$COV_OUT"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
# This producer already runs each suite in its own process. Keep the local
# fan-out bounded even on a large CI host, independently of host-pool width.
WEB_UTILITY_COVERAGE_MAX_WORKERS=${WEB_UTILITY_COVERAGE_MAX_WORKERS:-3}
case "$WEB_UTILITY_COVERAGE_MAX_WORKERS" in
  ''|*[!0-9]*) echo "::error::WEB_UTILITY_COVERAGE_MAX_WORKERS must be a positive integer" >&2; exit 2 ;;
esac
if [ "$WEB_UTILITY_COVERAGE_MAX_WORKERS" -lt 1 ]; then
  echo "::error::WEB_UTILITY_COVERAGE_MAX_WORKERS must be a positive integer" >&2
  exit 2
fi

# Bun resolves SvelteKit aliases from this generated project file. Fresh
# worktrees do not carry .svelte-kit, while normal web test commands create it.
if [ ! -f "$REPO_ROOT/web/.svelte-kit/tsconfig.json" ]; then
  echo "Generating SvelteKit types..."
  (cd "$REPO_ROOT/web" && bunx svelte-kit sync)
fi

mapfile -t FILES < <(web_utility_coverage_files)
if [ "${#FILES[@]}" -eq 0 ]; then
  echo "::error::web_utility_coverage_files produced an EMPTY set" >&2
  exit 1
fi

# The canonical registry owns this source list and the producer tag. Keeping
# this script as a consumer avoids a second hand-maintained source allowlist.
UTILITY_PRODUCER=$(cd "$REPO_ROOT" && bun -e 'import { BUN_WEB_UTILITY_COVERAGE_PRODUCER } from "./scripts/coverage-config.ts"; console.log(BUN_WEB_UTILITY_COVERAGE_PRODUCER)')
mapfile -t UTILITY_SRC < <(cd "$REPO_ROOT" && bun -e 'import { BUN_WEB_UTILITY_SOURCES } from "./scripts/coverage-config.ts"; console.log(BUN_WEB_UTILITY_SOURCES.join("\n"))')
if [ -z "$UTILITY_PRODUCER" ] || [ "${#UTILITY_SRC[@]}" -eq 0 ]; then
  echo "::error::web utility canonical producer registry is empty" >&2
  exit 1
fi

echo "Running ${#FILES[@]} direct web utility suites under Bun coverage (${WEB_UTILITY_COVERAGE_MAX_WORKERS} parallel)..."
running=0
for i in "${!FILES[@]}"; do
  f="${FILES[$i]}"
  covdir="$TMPDIR/cov_$i"
  rel="${f#web/}"
  (
    set +e
    (cd "$REPO_ROOT/web" && bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$covdir" "./$rel") >"$TMPDIR/out_$i" 2>&1
    echo "$?" >"$TMPDIR/code_$i"
  ) &
  running=$((running + 1))
  if [ "$running" -ge "$WEB_UTILITY_COVERAGE_MAX_WORKERS" ]; then wait -n || true; running=$((running - 1)); fi
done
wait || true

failed=0
for i in "${!FILES[@]}"; do
  code=$(cat "$TMPDIR/code_$i" 2>/dev/null || echo 1)
  if [ "$code" != "0" ]; then
    echo "--- web utility coverage shard failed: ${FILES[$i]} (exit $code) ---"
    cat "$TMPDIR/out_$i" 2>/dev/null || true
    failed=1
  fi
done
[ "$failed" = "0" ] || exit 1

# Bun emits SF:src/... from web/. Tag raw fragments before their internal
# merge, then make source keys repo-relative. Canonical-source merging rejects
# untagged or foreign evidence rather than mixing Bun and V8 line maps.
for d in "$TMPDIR"/cov_*; do
  [ -f "$d/lcov.info" ] || continue
  sed -i \
    -e "s#^TN:\$#TN:$UTILITY_PRODUCER#" \
    -e 's#^SF:src/#SF:web/src/#' \
    "$d/lcov.info"
done
for raw_lcov in "$TMPDIR"/cov_*/lcov.info; do
  if ! rg -q "^TN:$UTILITY_PRODUCER\$" "$raw_lcov"; then
    echo "::error::web utility raw LCOV lacked the trusted producer tag: $raw_lcov" >&2
    exit 1
  fi
done
bun "$REPO_ROOT/scripts/merge-lcov.ts" "$TMPDIR/cov_*/lcov.info" "$TMPDIR/merged.lcov"
bun "$REPO_ROOT/scripts/filter-lcov-sources.ts" "$TMPDIR/merged.lcov" --output "$COV_OUT/lcov.info" "${UTILITY_SRC[@]}"

kept=$(rg -c '^SF:' "$COV_OUT/lcov.info")
if [ "$kept" -ne "${#UTILITY_SRC[@]}" ]; then
  echo "::error::web utility producer expected ${#UTILITY_SRC[@]} source records, got $kept" >&2
  exit 1
fi
if ! rg -q '^DA:[1-9][0-9]*,[0-9]+$' "$COV_OUT/lcov.info"; then
  echo "::error::web utility producer emitted no executable DA records" >&2
  exit 1
fi
echo "wrote $kept web utility source records → $COV_OUT/lcov.info"
