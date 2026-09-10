#!/usr/bin/env bash
# Collect every mandatory browser lane against one mapped build, then use the
# same strict aggregation path as CI. This is the complete local route-coverage
# command, not a mock-only diagnostic.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="${EZCORP_BROWSER_COVERAGE_OUTPUT:-$repo_root/tasks/testing-gaps/browser/v8-coverage/full}"
base_url="${PI_E2E_MOCK_BASE_URL:-http://localhost:4173}"

# The source revision in the raw receipt must identify the exact bytes built.
# Ignored mapped-build and receipt artifacts do not appear in this Git check.
bun "$repo_root/scripts/git-worktree-clean.ts" "$repo_root"

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
export PI_E2E_MOCK_BASE_URL="$base_url"

cd "$repo_root"
bash scripts/browser-coverage-build.sh
# The lane collectors start previews only under EZCORP_BROWSER_COVERAGE=1.
# A second build would change map identities between receipts and make their
# immutable-build merge invalid.
[ -f "$repo_root/web/build/client/manifest.json" ] || {
	echo "browser coverage build wrote no client manifest" >&2
	exit 1
}

archive_playwright_artifacts() {
	local lane_output=$1
	local lane=$2
	local artifact_dir="$lane_output/playwright-artifacts"

	# Playwright reuses web/test-results on its next invocation. Copy the
	# completed lane before that happens so a later lane cannot erase its
	# failure PNG or trace. Blob output belongs only to the evidence lane.
	if [ -d "$repo_root/web/test-results" ]; then
		mkdir -p "$artifact_dir/test-results"
		cp -a "$repo_root/web/test-results/." "$artifact_dir/test-results/"
	fi
	if [ "$lane" = evidence ] && [ -d "$repo_root/web/blob-report" ]; then
		mkdir -p "$artifact_dir/blob-report"
		cp -a "$repo_root/web/blob-report/." "$artifact_dir/blob-report/"
	fi
}

lane_status=0
for lane in mock-gate mock-full evidence fresh-setup real-auth; do
	case "$lane" in
		fresh-setup|real-auth) lane_output="$output_dir/real-auth/$lane" ;;
		*) lane_output="$output_dir/$lane" ;;
	esac
	echo "browser route coverage: collecting $lane"
	this_lane_status=0
	if [ "$lane" = evidence ]; then
		EZCORP_E2E_EVIDENCE=1 EZCORP_BROWSER_COVERAGE_OUTPUT="$lane_output" \
			bash scripts/collect-browser-route-coverage-lane.sh "$lane" || this_lane_status=$?
	elif ! EZCORP_BROWSER_COVERAGE_OUTPUT="$lane_output" bash scripts/collect-browser-route-coverage-lane.sh "$lane"; then
		this_lane_status=1
	fi
	archive_playwright_artifacts "$lane_output" "$lane"
	if [ "$this_lane_status" -ne 0 ]; then
		echo "::error::browser coverage lane failed: $lane" >&2
		lane_status=1
	fi
done

merge_status=0
if ! bash scripts/merge-browser-route-coverage.sh "$output_dir" "$output_dir/merged"; then
	merge_status=1
fi

# Preserve all partial receipts and converter diagnostics after a product
# failure. The result remains nonzero if any required lane or aggregate failed.
if [ "$lane_status" -ne 0 ]; then exit "$lane_status"; fi
exit "$merge_status"
