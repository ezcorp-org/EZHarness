#!/usr/bin/env bash
# Merge the five mandatory browser-lane receipts from one mapped build, then
# fail closed on provenance, source-map fidelity, and every scripted route.
set -euo pipefail

if [ "$#" -ne 2 ]; then
	printf 'usage: %s <receipt-root> <output-dir>\n' "$0" >&2
	exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
receipt_root="$1"
output_dir="$2"
required_lanes=(mock-gate mock-full evidence real-auth/fresh-setup real-auth/real-auth)

for lane in "${required_lanes[@]}"; do
	if ! find "$receipt_root/$lane" -type f -name 'chromium-worker-*.json' -print -quit 2>/dev/null | grep --line-buffered -q .; then
		printf '::error::browser coverage artifact has no receipt for %s\n' "$lane" >&2
		exit 1
	fi
done

mapfile -t receipts < <(find "$receipt_root" -type f -name 'chromium-worker-*.json' -print | sort)
[ "${#receipts[@]}" -gt 0 ] || {
	echo '::error::browser coverage artifacts had no worker receipts' >&2
	exit 1
}

mkdir -p "$output_dir"
merged="$output_dir/merged.json"
lcov="$output_dir/lcov.info"

cd "$repo_root"
bun scripts/browser-coverage-to-lcov.ts --merge-raw "$merged" "${receipts[@]}"
bun scripts/browser-route-coverage-manifest.ts --check "$merged"
bun scripts/browser-coverage-to-lcov.ts "$merged" "$lcov"
bun scripts/verify-browser-coverage-receipt.ts "$merged" "$lcov"
bun -e 'const raw = await Bun.file(process.argv.at(-1)).json(); console.log(`browser coverage checkpoints: ${raw.testsWithApplicationScripts ?? 0} with scripts, ${raw.testsWithoutApplicationScripts ?? 0} without scripts`)' "$merged"
echo "browser route coverage: ${#receipts[@]} worker receipt(s) → $lcov"
