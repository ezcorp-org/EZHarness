#!/usr/bin/env bash
# Collect one same-build V8 receipt across every mock browser journey, then
# fail closed for all scripted Svelte routes and browser-canonical sources.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="${EZCORP_BROWSER_COVERAGE_OUTPUT:-$repo_root/tasks/testing-gaps/browser/v8-coverage/full}"
base_url="${PI_E2E_MOCK_BASE_URL:-http://localhost:4173}"

if [ -e "$output_dir" ] && find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit | grep --line-buffered -q .; then
	echo "browser coverage output must be empty: $output_dir" >&2
	exit 2
fi
mkdir -p "$output_dir"

manifest="$(cd "$repo_root" && bun scripts/browser-route-coverage-manifest.ts --print)"
export EZCORP_BROWSER_COVERAGE=1
export EZCORP_BROWSER_COVERAGE_EXPECTED_MANIFEST="$manifest"
export EZCORP_BROWSER_COVERAGE_OUTPUT="$output_dir"
export PI_E2E_MOCK_BASE_URL="$base_url"

cd "$repo_root"
bash scripts/browser-coverage-build.sh

mapfile -t mock_gate < <(bun scripts/e2e-lane-args.ts mock-gate)
mapfile -t mock_full < <(bun scripts/e2e-lane-args.ts mock-full)
[ "${#mock_gate[@]}" -gt 0 ] && [ "${#mock_full[@]}" -gt 0 ] || {
	echo "browser coverage requires non-empty mock-gate and mock-full lanes" >&2
	exit 1
}

(
	cd web
	bunx playwright test --project=chromium --workers=2 --reporter=list "${mock_gate[@]}" "${mock_full[@]}"
)

mapfile -t receipts < <(find "$output_dir" -maxdepth 1 -type f -name 'chromium-worker-*.json' -print | sort)
[ "${#receipts[@]}" -gt 0 ] || { echo "browser coverage wrote no worker receipts" >&2; exit 1; }

merged="$output_dir/merged.json"
lcov="$output_dir/lcov.info"
bun scripts/browser-coverage-to-lcov.ts --merge-raw "$merged" "${receipts[@]}"
bun scripts/browser-route-coverage-manifest.ts --check "$merged"
bun scripts/browser-coverage-to-lcov.ts "$merged" "$lcov"
echo "browser route coverage: ${#receipts[@]} worker receipt(s) → $lcov"
