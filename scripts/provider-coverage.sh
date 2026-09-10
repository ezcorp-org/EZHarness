#!/usr/bin/env bash
# Canonical Bun coverage producer for src/providers/**. Provider suites use
# module-level mocks, so each runs in its own Bun process. The merged LCOV is
# filtered to these sources before it joins the global report, preventing
# unrelated imported files from changing their instrumentation denominator.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COV_OUT=${COV_OUT:-coverage-provider}
mkdir -p "$COV_OUT"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

PROVIDER_SRC=(
  src/providers/circuit-breaker.ts
  src/providers/credential-store.ts
  src/providers/credentials.ts
  src/providers/encryption.ts
  src/providers/file.ts
  src/providers/kilo.ts
  src/providers/llm.ts
  src/providers/local-model-check.ts
  src/providers/model-capabilities.ts
  src/providers/model-discovery.ts
  src/providers/openai-compat-client.ts
  src/providers/provider-error.ts
  src/providers/registry.ts
  src/providers/router.ts
  src/providers/shell.ts
)

# One process per test file preserves mock.module isolation and exercises each
# public behavior path without a synthetic import-only coverage case.
TEST_FILES=(
  src/__tests__/encryption.test.ts
  src/__tests__/encryption-aad.unit.test.ts
  src/__tests__/credentials.test.ts
  src/__tests__/credential-store.test.ts
  src/__tests__/kilo-provider.test.ts
  src/__tests__/kilo-catalog.test.ts
  src/__tests__/model-registry.test.ts
  src/__tests__/registry-custom-models.test.ts
  src/__tests__/registry-oauth-model-resolution.test.ts
  src/__tests__/oauth-model-swap.test.ts
  src/__tests__/routing-custom-models.test.ts
  src/__tests__/model-router.test.ts
  src/__tests__/model-capabilities.test.ts
  src/__tests__/local-model-check.test.ts
  src/__tests__/circuit-breaker.test.ts
  src/__tests__/providers/file.test.ts
  src/__tests__/providers/shell.test.ts
  src/__tests__/llm-provider.test.ts
  src/__tests__/model-discovery.test.ts
  src/__tests__/provider-error.test.ts
  src/__tests__/openai-compat-client.test.ts
  src/__tests__/mock-provider.test.ts
)

cd "$REPO_ROOT"
for i in "${!TEST_FILES[@]}"; do
  bun test --timeout 30000 --coverage --coverage-reporter=lcov \
    --coverage-dir="$TMPDIR/cov_$i" "${TEST_FILES[$i]}"
done
bun scripts/merge-lcov.ts "$TMPDIR/cov_*/lcov.info" "$TMPDIR/merged.lcov"

OUT_LCOV="$COV_OUT/lcov.info"
: > "$OUT_LCOV"
keep=" ${PROVIDER_SRC[*]} "
in_block=0
kept=0
while IFS= read -r line; do
  if [[ "$line" == SF:* ]]; then
    sf="${line#SF:}"
    if [[ "$keep" == *" $sf "* ]]; then
      in_block=1
      kept=$((kept + 1))
    else
      in_block=0
    fi
  fi
  if [ "$in_block" = "1" ]; then
    printf '%s\n' "$line" >> "$OUT_LCOV"
    [ "$line" = "end_of_record" ] && in_block=0
  fi
done < "$TMPDIR/merged.lcov"

if [ "$kept" -ne "${#PROVIDER_SRC[@]}" ]; then
  echo "::error::provider producer expected ${#PROVIDER_SRC[@]} source records, got $kept" >&2
  exit 1
fi
if ! rg -q '^DA:[1-9][0-9]*,[0-9]+$' "$OUT_LCOV"; then
  echo "::error::provider producer emitted no executable DA records" >&2
  exit 1
fi
echo "wrote $kept provider source records → $OUT_LCOV"
