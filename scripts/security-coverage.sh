#!/usr/bin/env bash
# Coverage producer for the 9 web security helpers that the node/vitest v8
# coverage leg CANNOT measure: their bun:test suites re-register mocks per
# `beforeEach` via `mock.module` — a bun-runtime feature with no `vi.mock`
# (statically hoisted) equivalent. This runs the security bun:test suites
# per-file under `bun --coverage` (from web/, so $lib resolves), re-roots the
# web SF paths (bun emits them relative to web/, like the node-vitest leg does),
# merges, and FILTERS the merged lcov to EXACTLY the 9 un-excluded security
# source files.
#
# Why filter to only the 9: an unfiltered bun coverage run from web/ instruments
# the whole transitively-imported web/src/lib tree, emitting bun's TypeScript
# span-set DA records. Merged with the v8/vitest leg's clean line-set that would
# drag OTHER files' merged percentage below either measurement alone (the
# documented "dual bun+v8 instrumentation union" hazard — see EXCLUDES in
# scripts/coverage-config.ts). The 9 security files themselves have NO such
# hazard (vitest can't measure them, nothing else feeds their coverage), so
# scoping to exactly them — the coverage equivalent of the vitest leg's
# `--coverage.include` — is precise and safe. Uploaded as an `lcov-cov-*`
# artifact so the `Per-file coverage gate` merges + enforces it.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/test-file-sets.sh
source "$SCRIPT_DIR/lib/test-file-sets.sh"

cd "$REPO_ROOT"

# Ensure SvelteKit types exist (needed for $lib alias resolution under bun).
if [ ! -f web/.svelte-kit/tsconfig.json ]; then
  echo "Generating SvelteKit types..."
  ( cd web && bunx svelte-kit sync )
fi

PARALLEL=${PARALLEL:-6}
COV_OUT=${COV_OUT:-coverage-shard}
mkdir -p "$COV_OUT"

# The 9 security source files removed from EXCLUDES in scripts/coverage-config.ts.
# KEEP IN SYNC with that removal — this is the filter allowlist so only these
# enter the merged gate lcov (see header). validation.ts is intentionally NOT
# here: it is measurable by the vitest leg and must not be double-instrumented.
SEC_SRC=(
  web/src/lib/server/security/bearer-auth.ts
  web/src/lib/server/security/openai-extension-creds.ts
  web/src/lib/server/security/payload.ts
  web/src/lib/server/security/internal-auth.ts
  web/src/lib/server/security/system-user.ts
  web/src/lib/server/security/bundled-creds.ts
  web/src/lib/server/security/rate-limiter.ts
  web/src/lib/server/security/api-keys.ts
  web/src/lib/server/security/resource-quotas.ts
)

mapfile -t FILES < <(security_test_files)

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Running ${#FILES[@]} security bun:test suites under --coverage (${PARALLEL} parallel)..."

RUNNING=0
IDX=0
for f in "${FILES[@]}"; do
  covdir="$TMPDIR/cov_$IDX"
  rel="${f#web/}"
  (
    set +e
    OUTPUT=$( cd "$REPO_ROOT/web" && bun test --timeout 30000 --coverage --coverage-reporter=lcov --coverage-dir="$covdir" "./$rel" 2>&1 )
    echo "$?" > "$TMPDIR/code_$IDX"
    echo "$OUTPUT" | tail -3 > "$TMPDIR/out_$IDX"
  ) &
  IDX=$((IDX + 1))
  RUNNING=$((RUNNING + 1))
  if [ "$RUNNING" -ge "$PARALLEL" ]; then wait -n 2>/dev/null || true; RUNNING=$((RUNNING - 1)); fi
done
wait

# Surface any shard that failed to RUN (infra) — pass/fail is gated separately by
# the web-bun-tests job, but a crash here means we produced no coverage.
FAILED=0
for ((i = 0; i < ${#FILES[@]}; i++)); do
  code=$(cat "$TMPDIR/code_$i" 2>/dev/null || echo 1)
  if [ "$code" != "0" ]; then
    echo "--- security shard did not exit 0: ${FILES[$i]} (code=$code) ---"
    cat "$TMPDIR/out_$i" 2>/dev/null | sed 's/^/  /'
    FAILED=1
  fi
done

# Re-root web SF paths: bun (run from web/) emits `SF:src/...`; the gate keys
# on `web/src/...`. Backend imports appear as `SF:../src/...` and are left
# untouched by the anchored `^SF:src/` match (identical to the vitest leg).
for d in "$TMPDIR"/cov_*; do
  [ -f "$d/lcov.info" ] && sed -i 's#^SF:src/#SF:web/src/#' "$d/lcov.info"
done

# Merge (applies the repo's noise filter + SF canonicalisation).
bun scripts/merge-lcov.ts "$TMPDIR/cov_*/lcov.info" "$TMPDIR/merged.lcov"

# Filter the merged lcov to EXACTLY the 9 security source files.
OUT_LCOV="$COV_OUT/lcov_security.info"
: > "$OUT_LCOV"
keep=" ${SEC_SRC[*]} "
in_block=0
kept=0
while IFS= read -r line; do
  if [[ "$line" == SF:* ]]; then
    sf="${line#SF:}"
    if [[ "$keep" == *" $sf "* ]]; then in_block=1; kept=$((kept + 1)); else in_block=0; fi
  fi
  if [ "$in_block" = "1" ]; then
    printf '%s\n' "$line"
    [ "$line" = "end_of_record" ] && in_block=0
  fi
done < "$TMPDIR/merged.lcov" >> "$OUT_LCOV"

echo "wrote $kept security source record(s) → $OUT_LCOV"
# We must emit coverage for all 9 files or the gate can't enforce them.
if [ "$kept" -ne "${#SEC_SRC[@]}" ]; then
  echo "::error::expected coverage for ${#SEC_SRC[@]} security files, got $kept"
  exit 1
fi
[ "$FAILED" = "0" ] || { echo "::error::a security coverage shard failed to run"; exit 1; }
exit 0
