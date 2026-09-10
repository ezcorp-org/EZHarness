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
# fan-out bounded even on a large CI host.
PARALLEL=${PARALLEL:-3}

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

# Only these sources belong in this producer. Filtering prevents transitive Bun
# instrumentation from changing unrelated V8 source denominators.
UTILITY_SRC=(
  web/src/lib/chat-scroll-restore.ts
  web/src/lib/chat/attachment-client.ts
  web/src/lib/chat/chat-window-drop.ts
  web/src/lib/chat/page-handlers/inline-tool-handlers.ts
  web/src/lib/chat/page-handlers/panel-persistence.svelte.ts
  web/src/lib/clipboard.ts
  web/src/lib/combobox-nav.ts
  web/src/lib/commands.ts
  web/src/lib/components/tool-cards/price-chart-logic.ts
  web/src/lib/ez/pill-visibility.ts
  web/src/lib/focus-trap.ts
  web/src/lib/last-model.ts
  web/src/lib/markdown-speech.ts
  web/src/lib/panel-persistence.ts
  web/src/lib/progressive-image.ts
  web/src/lib/select-mode.ts
  web/src/lib/shortcuts.ts
  web/src/lib/sub-agent-routing.ts
  web/src/lib/theme.ts
  web/src/lib/workers/agent-fuzzy-search-bridge.ts
  web/src/lib/workers/agent-fuzzy-search-worker.ts
  web/src/lib/workers/kokoro-tts-bridge.ts
)

echo "Running ${#FILES[@]} direct web utility suites under Bun coverage (${PARALLEL} parallel)..."
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
  if [ "$running" -ge "$PARALLEL" ]; then wait -n || true; running=$((running - 1)); fi
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

# Bun emits SF:src/... from web/. Make the aggregate keys repo-relative.
for d in "$TMPDIR"/cov_*; do
  [ -f "$d/lcov.info" ] && sed -i 's#^SF:src/#SF:web/src/#' "$d/lcov.info"
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
