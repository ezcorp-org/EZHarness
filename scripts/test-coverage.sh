#!/usr/bin/env bash
# Run each host / example test file in its own bun process with --coverage,
# plus one bundled run for the SDK suite (no mock.module contamination there,
# and bundling preserves module-load instrumentation parity with Phase 1's
# 100% SDK baseline). Merge all per-shard lcov files into coverage/lcov.info
# and enforce scripts/coverage-thresholds.json.
#
# Mirrors scripts/test.sh's parallel pattern for host tests.
set -e

PARALLEL=${PARALLEL:-6}
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()

# Host + example tests run per-file for mock.module() isolation.
# The import-wizard endpoint tests sit beside their routes (bun:test);
# include them so their lcov merges and the import paths are gated.
#
# The Phase 66/67 search-helper bun:test suites also join the per-file loop so
# their lcov merges and the web/src/lib/search logic paths get gated. Run
# from the repo root, the loop body below already emits web/-prefixed SF
# paths, so no cd / SF rewrite is needed. SCOPED to JUST the target
# search-helper test files (snippet-sanitize + search-mode + palette-results)
# — NOT the whole web/src/__tests__ dir. Widening to the whole dir transitively imports
# dozens of unrelated web/src/lib, SDK, and example modules, whose
# sourcemap-attributed zero-hit DA records inflate the denominator on files
# already pinned at 100% (web/src/lib/**:90, packages/@ezcorp/sdk/src/**:100,
# docs/extensions/examples/*/index.ts:100), surfacing them as new gate
# violations. Scoping to the two target files confines the gate change to the
# five intended Phase 66 files (verified: no other threshold-matched file
# regresses). The vitest-only deep-link-resolve + goal-row-logic
# run under the node-vitest leg below (coverage-v8 fails under Bun).
mapfile -t FILES < <({
  find src/__tests__ -name "*.test.ts"
  find docs/extensions/examples -name "*.test.ts"
  find web/src/routes/api/import -name "*.test.ts"
  # github-projects integration: its UNIT tests live next to the source, so
  # enumerate them here for the coverage merge (gates client/daemon/spawn/
  # queries/bus-registry/handler + the web route handlers). The *integration*
  # tests are EXCLUDED from the coverage leg on purpose — they load several
  # real modules with a different DA line-set, which floats the denominator and
  # false-drops the unit-measured files (the bun attribution drift). They still
  # run for correctness in scripts/test.sh.
  find src/integrations/github-projects/__tests__ -name "*.test.ts" ! -name "*integration*"
  find src/extensions/__tests__ -name "github-projects-handler*.test.ts" ! -name "*integration*"
  find web/src/routes/api/integrations/github-projects/__tests__ -name "*.test.ts"
  # extension-secrets (Phase 0): the secrets-store coverage test lives next to
  # its source under src/extensions/__tests__ (the queries test under
  # src/__tests__ is already caught above). Integration variants are excluded
  # from the coverage leg per the github-projects convention. The web
  # entry-route tests (Phase 1B) land in the extensions __tests__ dir — empty
  # today, so this find is a no-op until then.
  find src/extensions/__tests__ -name "secrets-*.test.ts" ! -name "*integration*"
  find web/src/routes/api/extensions/__tests__ -name "*.test.ts"
  printf '%s\n' \
    web/src/__tests__/snippet-sanitize.test.ts \
    web/src/__tests__/search-mode.test.ts \
    web/src/__tests__/shared-ui-components.test.ts \
    web/src/lib/search/__tests__/palette-results.test.ts \
    web/src/lib/__tests__/diff-view-mode.test.ts \
    web/src/lib/__tests__/tool-scope-logic.test.ts \
    web/src/lib/__tests__/loaded-tools-logic.test.ts \
    web/src/lib/__tests__/briefing-cron.test.ts \
    web/src/__tests__/test-surface.test.ts \
    web/src/__tests__/test-surface-bypass.test.ts \
    web/src/__tests__/mock-llm-store.test.ts \
    web/src/__tests__/mock-llm-route.test.ts \
    web/src/__tests__/runs-wait-route.test.ts \
    web/src/__tests__/seed-reset-route.test.ts \
    web/src/__tests__/route-contract.test.ts
} | sort)

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

RUNNING=0
IDX=0

for f in "${FILES[@]}"; do
  OUTFILE="$TMPDIR/result_$IDX"
  COVDIR="$TMPDIR/cov_$IDX"
  # Give DB-heavy suites headroom: setupTestDb() in a beforeAll can exceed bun's
  # 5s default under --coverage instrumentation + PARALLEL contention, crashing
  # the shard as "(unnamed)" — which drops any gated file it solely covers to 0%
  # and fails the gate. EXCLUDE the example e2e shards: their real-subprocess
  # tests genuinely fail-by-timeout, so a long timeout would balloon the job
  # ~45min. Keep their 5s fast-fail.
  case "$f" in
    docs/extensions/examples/*) TIMEOUT_FLAG="" ;;
    *) TIMEOUT_FLAG="--timeout 30000" ;;
  esac
  (
    OUTPUT=$(bun test $TIMEOUT_FLAG --coverage --coverage-reporter=lcov --coverage-dir="$COVDIR" "./$f" 2>&1) || true
    echo "$OUTPUT" > "$OUTFILE"
  ) &
  IDX=$((IDX + 1))
  RUNNING=$((RUNNING + 1))

  if [ "$RUNNING" -ge "$PARALLEL" ]; then
    wait -n 2>/dev/null || true
    RUNNING=$((RUNNING - 1))
  fi
done

wait

for ((i=0; i<${#FILES[@]}; i++)); do
  OUTFILE="$TMPDIR/result_$i"
  [ -f "$OUTFILE" ] || continue
  OUTPUT=$(cat "$OUTFILE")

  PASS=$(echo "$OUTPUT" | awk '/pass/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="pass") print $j}' | tail -1)
  FAIL=$(echo "$OUTPUT" | awk '/fail/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="fail") print $j}' | tail -1)

  TOTAL_PASS=$((TOTAL_PASS + ${PASS:-0}))
  TOTAL_FAIL=$((TOTAL_FAIL + ${FAIL:-0}))

  if [ "${FAIL:-0}" != "0" ]; then
    FAILED_FILES+=("${FILES[$i]}")
    echo "--- FAIL: ${FILES[$i]} ---"
    echo "$OUTPUT" | awk '/\(fail\)/'
    echo ""
  fi
done

# SDK tests bundled into a single shard (no mock.module use).
# Includes BOTH the top-level test/ suite AND the co-located
# src/entities/__tests__/ unit suites: the latter are the canonical
# coverage for entities/{validate,tools,storage,slug}.ts, which the
# top-level test/ files only touch incidentally (imports, not the
# validate/store entry points). Without them those entity files drop far
# below the packages/@ezcorp/sdk/src/**:100 gate. Both dirs are
# mock.module-free, so bundling preserves the 100% module-load
# instrumentation parity the SDK baseline relies on.
SDK_OUT="$TMPDIR/result_sdk"
SDK_COV="$TMPDIR/cov_sdk"
SDK_OUTPUT=$(bun test --coverage --coverage-reporter=lcov --coverage-dir="$SDK_COV" ./packages/@ezcorp/sdk/test/ ./packages/@ezcorp/sdk/src/entities/__tests__/ 2>&1) || true
echo "$SDK_OUTPUT" > "$SDK_OUT"
SDK_PASS=$(echo "$SDK_OUTPUT" | awk '/pass/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="pass") print $j}' | tail -1)
SDK_FAIL=$(echo "$SDK_OUTPUT" | awk '/fail/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="fail") print $j}' | tail -1)
TOTAL_PASS=$((TOTAL_PASS + ${SDK_PASS:-0}))
TOTAL_FAIL=$((TOTAL_FAIL + ${SDK_FAIL:-0}))
if [ "${SDK_FAIL:-0}" != "0" ]; then
  FAILED_FILES+=("packages/@ezcorp/sdk/test/**")
  echo "--- FAIL: SDK bundled ---"
  echo "$SDK_OUTPUT" | awk '/\(fail\)/'
  echo ""
fi

# Harness-client package — its own shard (mock.module-free, isolated like SDK)
# so packages/@ezcorp/harness-client/src/** is measured + gated at 100.
HC_OUT="$TMPDIR/result_hc"
HC_COV="$TMPDIR/cov_hc"
HC_OUTPUT=$(bun test --coverage --coverage-reporter=lcov --coverage-dir="$HC_COV" ./packages/@ezcorp/harness-client/ 2>&1) || true
echo "$HC_OUTPUT" > "$HC_OUT"
HC_PASS=$(echo "$HC_OUTPUT" | awk '/pass/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="pass") print $j}' | tail -1)
HC_FAIL=$(echo "$HC_OUTPUT" | awk '/fail/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="fail") print $j}' | tail -1)
TOTAL_PASS=$((TOTAL_PASS + ${HC_PASS:-0}))
TOTAL_FAIL=$((TOTAL_FAIL + ${HC_FAIL:-0}))
if [ "${HC_FAIL:-0}" != "0" ]; then
  FAILED_FILES+=("packages/@ezcorp/harness-client/**")
  echo "--- FAIL: harness-client ---"
  echo "$HC_OUTPUT" | awk '/\(fail\)/'
  echo ""
fi

# Node-run vitest coverage leg for the vitest-only web/src/lib files.
# WHY node, not bun: @vitest/coverage-v8 needs node:inspector's Coverage
# domain, which Bun does not implement (`bunx --bun vitest --coverage`
# fails with "Coverage APIs are not supported"). release-sdk.yml already
# provisions node 22 before `bun run test:coverage`, so this leg works in
# the gate CI with no new workflow setup. deep-link-resolve.ts transitively
# imports a Svelte-rune module, so bun cannot compile it — this leg is the
# ONLY way those lines get measured. --coverage.include is scoped to JUST
# the five target lib paths so the leg does not pull all of web/src/lib/**
# into the gate (which would surface other unmeasured files as violations
# under the web/src/lib/**:90 wildcard). Run in a subshell so `cd web`
# never leaks to the rest of the script.
VITEST_COV="$TMPDIR/cov_vitest"
VITEST_EXIT=0
( cd web && npx vitest run \
    src/__tests__/deep-link-resolve.unit.test.ts \
    src/lib/components/goal-row-logic.unit.test.ts \
    src/lib/components/UpdateBanner.component.test.ts \
    src/__tests__/version-endpoint.server.test.ts \
    src/__tests__/relative-time.unit.test.ts \
    src/__tests__/relative-time.test.ts \
    src/__tests__/http-errors.unit.test.ts \
    src/__tests__/session-cookie.server.test.ts \
    src/__tests__/shutdown.server.test.ts \
    src/__tests__/extension-helpers-clamp.server.test.ts \
    src/__tests__/conversation-ownership.server.test.ts \
    src/__tests__/mention-logic.unit.test.ts \
    src/__tests__/mention-logic-EZ-sigil.unit.test.ts \
    src/__tests__/mention-logic-feature.unit.test.ts \
    src/__tests__/mention-logic-lesson-sigil.unit.test.ts \
    src/lib/__tests__/markdown.unit.test.ts \
    src/lib/__tests__/safe-redirect.unit.test.ts \
    src/__tests__/fuzzy-match.unit.test.ts \
    src/__tests__/chat-input-logic.unit.test.ts \
    src/__tests__/api-preview-consent.server.test.ts \
    src/__tests__/preview-dispatch.server.test.ts \
    src/__tests__/preview-ws-bridge.server.test.ts \
    src/__tests__/context-register-preview-bus.server.test.ts \
    src/lib/components/tool-cards/preview-consent-card-logic.unit.test.ts \
    src/__tests__/ExtensionToolSelector.component.test.ts \
    src/lib/components/hub/HubPageView.component.test.ts \
    src/lib/components/__tests__/ModeFormModal.component.test.ts \
    src/lib/chat/page-handlers/__tests__/inherit-mode.unit.test.ts \
    src/__tests__/tools-api-mode-scope.server.test.ts \
    src/__tests__/api-extensions-id-reapprove-drift.server.test.ts \
    src/lib/hub.unit.test.ts \
    src/lib/settings-nav.unit.test.ts \
    src/lib/settings-search.unit.test.ts \
    src/lib/settings-search-config.unit.test.ts \
    src/__tests__/api-search-backend.server.test.ts \
    src/lib/components/__tests__/SearchDefaultsSection.component.test.ts \
    src/lib/components/__tests__/SearchBackendSection.component.test.ts \
    "src/routes/(app)/settings/search/__tests__/page.component.test.ts" \
    src/lib/capability-policy-ui.unit.test.ts \
    src/lib/components/__tests__/CapabilitiesPanel.component.test.ts \
    src/lib/ezcorp-config-edit.unit.test.ts \
    src/lib/components/__tests__/AuthorCompositionPanel.component.test.ts \
    src/lib/components/__tests__/UsesList.component.test.ts \
    "src/routes/(app)/extensions/author/__tests__/page.component.test.ts" \
    src/__tests__/api-users.server.test.ts \
    src/lib/audit-log-view.unit.test.ts \
    src/lib/settings-models.unit.test.ts \
    src/lib/save-flash.unit.test.ts \
    src/lib/admin-guard.unit.test.ts \
    src/lib/scroll-to-hash.unit.test.ts \
    src/lib/chat-prompt-nav.unit.test.ts \
    src/lib/extensions/extension-sort.unit.test.ts \
    src/__tests__/resume-path.unit.test.ts \
    src/__tests__/sw-runtime.unit.test.ts \
    src/__tests__/service-worker.shell.unit.test.ts \
    src/lib/components/__tests__/AuditLogSection.component.test.ts \
    src/lib/components/__tests__/CustomModelsSection.component.test.ts \
    src/lib/components/__tests__/SystemHealth.component.test.ts \
    src/lib/components/__tests__/UsersSection.component.test.ts \
    src/lib/components/__tests__/settings-save-model.component.test.ts \
    src/lib/components/__tests__/InvitesSection.component.test.ts \
    src/lib/components/__tests__/TeamsSection.component.test.ts \
    src/lib/components/__tests__/ProvidersSection.component.test.ts \
    src/lib/components/__tests__/ApiKeyManager.component.test.ts \
    src/lib/components/__tests__/ModesSection.component.test.ts \
    src/lib/components/__tests__/SaveIndicator.component.test.ts \
    src/lib/components/__tests__/SettingsSection.component.test.ts \
    src/__tests__/settings-layout.component.test.ts \
    --coverage --coverage.provider=v8 --coverage.reporter=lcovonly \
    --coverage.reportsDirectory="$VITEST_COV" \
    --coverage.include='src/lib/search/*.ts' \
    --coverage.include='src/lib/hub.ts' \
    --coverage.include='src/lib/components/goal-row-logic.ts' \
    --coverage.include='src/lib/components/UpdateBanner.svelte' \
    --coverage.include='src/lib/components/UpdateBanner.helpers.ts' \
    --coverage.include='src/routes/api/version/+server.ts' \
    --coverage.include='src/lib/utils/relative-time.ts' \
    --coverage.include='src/lib/server/http-errors.ts' \
    --coverage.include='src/lib/server/auth/session-cookie.ts' \
    --coverage.include='src/lib/server/shutdown.ts' \
    --coverage.include='src/lib/server/extension-helpers.ts' \
    --coverage.include='src/lib/server/conversation-ownership.ts' \
    --coverage.include='src/lib/mention-logic.ts' \
    --coverage.include='src/lib/markdown.ts' \
    --coverage.include='src/lib/safe-redirect.ts' \
    --coverage.include='src/lib/fuzzy-match.ts' \
    --coverage.include='src/lib/components/tool-cards/preview-consent-card-logic.ts' \
    --coverage.include='src/routes/api/preview/[id]/token/+server.ts' \
    --coverage.include='src/routes/api/preview/consent/+server.ts' \
    --coverage.include='src/lib/components/ExtensionToolSelector.svelte' \
    --coverage.include='src/lib/components/hub/HubPageView.svelte' \
    --coverage.include='src/lib/components/ModeFormModal.svelte' \
    --coverage.include='src/lib/chat/page-handlers/inherit-mode.ts' \
    --coverage.include='src/routes/api/tools/+server.ts' \
    --coverage.include='src/routes/api/extensions/[id]/reapprove-drift/+server.ts' \
    --coverage.include='src/lib/settings-nav.ts' \
    --coverage.include='src/lib/settings-search.ts' \
    --coverage.include='src/lib/settings-search-config.ts' \
    --coverage.include='src/routes/api/search/backend/+server.ts' \
    --coverage.include='src/lib/components/settings/SearchDefaultsSection.svelte' \
    --coverage.include='src/lib/components/settings/SearchBackendSection.svelte' \
    --coverage.include='src/lib/capability-policy-ui.ts' \
    --coverage.include='src/lib/components/extensions/CapabilitiesPanel.svelte' \
    --coverage.include='src/lib/ezcorp-config-edit.ts' \
    --coverage.include='src/lib/components/extensions/AuthorCompositionPanel.svelte' \
    --coverage.include='src/lib/components/extensions/UsesList.svelte' \
    --coverage.include='src/routes/api/users/+server.ts' \
    --coverage.include='src/lib/audit-log-view.ts' \
    --coverage.include='src/lib/settings-models.ts' \
    --coverage.include='src/lib/save-flash.svelte.ts' \
    --coverage.include='src/lib/admin-guard.ts' \
    --coverage.include='src/lib/scroll-to-hash.ts' \
    --coverage.include='src/lib/chat-prompt-nav.ts' \
    --coverage.include='src/lib/extensions/extension-sort.ts' \
    --coverage.include='src/lib/resume-path.ts' \
    --coverage.include='src/lib/sw-runtime.ts' \
    --coverage.include='src/service-worker.ts' \
    --coverage.include='src/lib/components/settings/ProvidersSection.svelte' \
    --coverage.include='src/lib/components/settings/TeamsSection.svelte' \
    --coverage.include='src/lib/components/settings/InvitesSection.svelte' \
    --coverage.include='src/lib/components/settings/ModesSection.svelte' \
    --coverage.include='src/lib/components/settings/ApiKeyManager.svelte' \
    --coverage.include='src/lib/components/settings/UsersSection.svelte' \
    --coverage.include='src/lib/components/settings/SystemHealth.svelte' \
    --coverage.include='src/lib/components/settings/AuditLogSection.svelte' \
    --coverage.include='src/lib/components/settings/CustomModelsSection.svelte' \
    --coverage.include='src/lib/components/settings/SettingsSection.svelte' \
    --coverage.include='src/lib/components/settings/SaveIndicator.svelte' ) || VITEST_EXIT=$?
# vitest (run from web/) emits SF paths web/-relative (SF:src/lib/...).
# Re-root them so merge-lcov.ts resolves them against the repo root and the
# repo-root-relative threshold keys (web/src/lib/...) match.
if [ -f "$VITEST_COV/lcov.info" ]; then
  sed -i 's#^SF:src/#SF:web/src/#' "$VITEST_COV/lcov.info"
fi
if [ "$VITEST_EXIT" != "0" ]; then
  FAILED_FILES+=("web vitest-coverage leg (deep-link-resolve + goal-row-logic)")
  echo "--- FAIL: web vitest-coverage leg (exit $VITEST_EXIT) ---"
  echo ""
fi

echo ""
echo "================================"
echo "  ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | $((${#FILES[@]} + 1)) shards"
echo "================================"

if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  echo ""
  echo "Failed files:"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
fi

# Merge per-shard lcov → coverage/lcov.info, then enforce thresholds.
mkdir -p coverage
bun scripts/merge-lcov.ts "$TMPDIR/cov_*/lcov.info" coverage/lcov.info

CHECK_EXIT=0
bun scripts/check-coverage.ts || CHECK_EXIT=$?

# This job gates COVERAGE (check-coverage) + the vitest leg's own integrity.
# It does NOT re-gate test pass/fail: the dedicated `Backend tests` and
# `Web tests (vitest)` CI jobs own that. Re-running every shard here under
# `--coverage` instrumentation adds enough memory/time overhead that a few
# integration/e2e shards flake on the constrained CI runner even though they
# pass cleanly in the Backend job — which would otherwise hold the coverage
# gate hostage to unrelated flakiness. TOTAL_FAIL is printed above for
# visibility but is not a hard failure here. (If a flaky shard ever drops a
# gated file's coverage, check-coverage catches that and fails CHECK_EXIT.)
if [ "$CHECK_EXIT" != "0" ] || [ "$VITEST_EXIT" != "0" ]; then
  exit 1
fi
exit 0
