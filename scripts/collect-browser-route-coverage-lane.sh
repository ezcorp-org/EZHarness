#!/usr/bin/env bash
# Run one existing browser lane against the shared mapped build and save only
# that lane's worker receipts. CI merges the artifacts after all lanes finish.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
lane="${1:-}"
case "$lane" in mock-gate|mock-full|evidence|fresh-setup|real-auth) ;; *) echo "usage: $0 <mock-gate|mock-full|evidence|fresh-setup|real-auth>" >&2; exit 2;; esac
: "${EZCORP_BROWSER_COVERAGE:=1}"
: "${EZCORP_BROWSER_COVERAGE_EXPECTED_MANIFEST:?browser coverage requires the printed route manifest}"
if [[ -z "${EZCORP_BROWSER_COVERAGE_SOURCE_REVISION:-}" ]]; then
  EZCORP_BROWSER_COVERAGE_SOURCE_REVISION="$(git -C "$repo_root" rev-parse HEAD)"
fi
[[ "$EZCORP_BROWSER_COVERAGE_SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || {
  echo "browser coverage source revision must be a 40-character Git revision" >&2
  exit 2
}
output_dir="${EZCORP_BROWSER_COVERAGE_OUTPUT:-$repo_root/tasks/testing-gaps/browser/v8-coverage/$lane}"
export EZCORP_BROWSER_COVERAGE EZCORP_BROWSER_COVERAGE_EXPECTED_MANIFEST EZCORP_BROWSER_COVERAGE_SOURCE_REVISION EZCORP_BROWSER_COVERAGE_OUTPUT="$output_dir"
[[ -f "$repo_root/web/build/client/manifest.json" ]] || { echo "browser coverage requires the mapped web/build artifact" >&2; exit 1; }
[[ ! -e "$output_dir" ]] || [[ -z "$(find "$output_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo "browser coverage output must be empty: $output_dir" >&2; exit 2; }
mkdir -p "$output_dir"
cd "$repo_root"
case "$lane" in
  mock-gate|mock-full|evidence)
    mapfile -t args < <(bun scripts/e2e-lane-args.ts "$lane")
    [ "${#args[@]}" -gt 0 ] || { echo "empty browser coverage lane: $lane" >&2; exit 1; }
    (cd web && bunx playwright test --project=chromium --workers=2 --reporter=list "${args[@]}")
    ;;
  fresh-setup|real-auth) bun scripts/run-real-e2e.ts "$lane" ;;
esac
mapfile -t receipts < <(find "$output_dir" -maxdepth 1 -type f -name 'chromium-worker-*.json' -print | sort)
[ "${#receipts[@]}" -gt 0 ] || { echo "browser coverage lane wrote no receipts: $lane" >&2; exit 1; }
echo "browser coverage lane $lane: ${#receipts[@]} worker receipt(s)"
