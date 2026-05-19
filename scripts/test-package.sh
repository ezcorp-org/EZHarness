#!/usr/bin/env bash
# test-package.sh — validate the @ezcorp/sdk publish tarball before npm publish.
#
# Runs `bun pm pack --dry-run` inside packages/@ezcorp/sdk and asserts:
#   1. No dev-only files leak (*.test.ts, /test/, tsconfig*, .tsbuildinfo,
#      .vscode, .DS_Store, stray dotfiles)
#   2. Required dist artifacts present (index/runtime/test JS + .d.ts)
#   3. package.json + README.md present
#   4. Every path referenced by the package.json `exports` map resolves to
#      a file present in the tarball (checks bun/types/import conditions)
#
# Exit 0 on all-pass, 1 on any assertion failure (with diagnostic).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SDK_DIR="${REPO_ROOT}/packages/@ezcorp/sdk"

if [[ ! -f "${SDK_DIR}/package.json" ]]; then
  echo "✗ could not find ${SDK_DIR}/package.json" >&2
  exit 1
fi

cd "${SDK_DIR}"

# Capture pack output (combined stdout+stderr; the preamble "[… ] .env"
# line bun emits goes to stderr, packed lines go to stdout).
PACK_OUT="$(bun pm pack --dry-run 2>&1)"

# Extract `packed <size> <path>` lines → path column only.
# Paths in published npm packages never contain whitespace, so $3 is safe.
FILES="$(awk '/^packed /{print $3}' <<<"${PACK_OUT}")"

if [[ -z "${FILES}" ]]; then
  echo "✗ bun pm pack --dry-run produced no 'packed' lines" >&2
  echo "--- raw output ---" >&2
  echo "${PACK_OUT}" >&2
  exit 1
fi

FAILURES=()
fail() { FAILURES+=("$1"); }

# ── Assertion 1: no dev-only files ─────────────────────────────────
DISALLOW_PATTERN='(\.test\.ts$|^test/|tsconfig.*\.json$|\.tsbuildinfo$|\.js\.map$|\.vscode(/|$)|\.DS_Store$|^\.git|^\.env)'
if LEAKED="$(grep -E "${DISALLOW_PATTERN}" <<<"${FILES}" || true)" && [[ -n "${LEAKED}" ]]; then
  fail "dev-only files leaked into tarball:"$'\n'"${LEAKED}"
fi

# ── Assertion 2: required files present ────────────────────────────
REQUIRED=(
  "package.json"
  "README.md"
  "dist/index.js"
  "dist/index.d.ts"
  "dist/runtime/index.js"
  "dist/runtime/index.d.ts"
  "dist/test/index.js"
  "dist/test/index.d.ts"
)

for req in "${REQUIRED[@]}"; do
  if ! grep -qxF "${req}" <<<"${FILES}"; then
    fail "required file missing from tarball: ${req}"
  fi
done

# ── Assertion 3: exports map paths all resolve ─────────────────────
# Flatten the exports object into one path per line (strip the leading "./").
EXPORT_PATHS="$(jq -r '
  .exports
  | to_entries[]
  | .value
  | to_entries[]
  | .value
' package.json | sed 's|^\./||')"

while IFS= read -r path; do
  [[ -z "${path}" ]] && continue
  if ! grep -qxF "${path}" <<<"${FILES}"; then
    fail "exports map path not in tarball: ${path}"
  fi
done <<<"${EXPORT_PATHS}"

# ── Report ─────────────────────────────────────────────────────────
if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo "✗ tarball validation FAILED" >&2
  for f in "${FAILURES[@]}"; do
    echo "  - ${f}" >&2
  done
  echo "" >&2
  echo "--- tarball contents (first 80 paths) ---" >&2
  head -n 80 <<<"${FILES}" >&2
  exit 1
fi

FILE_COUNT="$(wc -l <<<"${FILES}" | tr -d ' ')"
echo "✓ tarball clean (${FILE_COUNT} files)"
