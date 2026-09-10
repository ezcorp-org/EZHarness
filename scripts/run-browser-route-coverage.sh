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
source_revision="$(cd "$repo_root" && git rev-parse HEAD)"
export EZCORP_BROWSER_COVERAGE=1
export EZCORP_BROWSER_COVERAGE_EXPECTED_MANIFEST="$manifest"
export EZCORP_BROWSER_COVERAGE_SOURCE_REVISION="$source_revision"
export EZCORP_BROWSER_COVERAGE_OUTPUT="$output_dir"
export PI_E2E_MOCK_BASE_URL="$base_url"

cd "$repo_root"
bash scripts/browser-coverage-build.sh
# playwright.config.ts sees EZCORP_BROWSER_COVERAGE=1 and starts preview only.
# Do not let a second build replace the source maps whose digest the receipt
# uses as its build identity.
[ -f "$repo_root/web/build/client/manifest.json" ] || {
	echo "browser coverage build wrote no client manifest" >&2
	exit 1
}

mapfile -t mock_gate < <(bun scripts/e2e-lane-args.ts mock-gate)
mapfile -t mock_full < <(bun scripts/e2e-lane-args.ts mock-full)
[ "${#mock_gate[@]}" -gt 0 ] && [ "${#mock_full[@]}" -gt 0 ] || {
	echo "browser coverage requires non-empty mock-gate and mock-full lanes" >&2
	exit 1
}

playwright_status=0
(
	cd web
	bunx playwright test --project=chromium --workers=2 --reporter=list "${mock_gate[@]}" "${mock_full[@]}"
) || playwright_status=$?

mapfile -t receipts < <(find "$output_dir" -maxdepth 1 -type f -name 'chromium-worker-*.json' -print | sort)
merged="$output_dir/merged.json"
lcov="$output_dir/lcov.info"
collector_status=0
if [ "${#receipts[@]}" -eq 0 ]; then
	echo "browser coverage wrote no worker receipts" >&2
	collector_status=1
else
	bun scripts/browser-coverage-to-lcov.ts --merge-raw "$merged" "${receipts[@]}" || collector_status=$?
	if [ "$collector_status" -eq 0 ]; then
		bun scripts/browser-route-coverage-manifest.ts --check "$merged" || collector_status=$?
	fi
	if [ "$collector_status" -eq 0 ]; then
		bun scripts/browser-coverage-to-lcov.ts "$merged" "$lcov" || collector_status=$?
	fi
	if [ -f "$merged" ]; then
		bun -e 'const raw = await Bun.file(process.argv.at(-1)).json(); console.log(`browser coverage checkpoints: ${raw.testsWithApplicationScripts ?? 0} with scripts, ${raw.testsWithoutApplicationScripts ?? 0} without scripts`)' "$merged"
	fi
	[ "$collector_status" -ne 0 ] || echo "browser route coverage: ${#receipts[@]} worker receipt(s) → $lcov"
fi

# Keep all partial receipts and converter diagnostics for a failed product
# journey, but retain the Playwright nonzero result as the command outcome.
if [ "$playwright_status" -ne 0 ]; then exit "$playwright_status"; fi
exit "$collector_status"
