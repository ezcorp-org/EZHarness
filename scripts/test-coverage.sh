#!/usr/bin/env bash
# Per-file --coverage runner for the host/example pool + the SDK, harness-client
# and node-vitest coverage legs. Each host file runs in its own bun process
# (mock.module() isolation; mirrors scripts/test.sh). The file sets live in
# scripts/lib/test-file-sets.sh so the coverage set and the pass/fail set can
# never drift apart.
#
# THREE MODES (selected by env):
#
#   full (default, `bun run test:coverage`):
#       Run the ENTIRE host set + all legs, merge every per-shard lcov into
#       coverage/lcov.info, and enforce scripts/coverage-thresholds.json.
#       Coverage-only: pass/fail is NOT a hard failure here (the CI shards and
#       the `Web tests` job own pass/fail). This preserves the historical local
#       `test:coverage` behaviour.
#
#   host-shard (CI; SHARD_INDEX + SHARD_TOTAL set):
#       Run only the 1-of-N stride slice of the host set under --coverage and
#       emit each shard's lcov into $COV_OUT for the coverage-gate job to merge.
#       This is the SHARDED form of the pre-split coverage job: it TOLERATES test
#       pass/fail (reports a summary + the failing files for visibility, but
#       exits 0 on test failures) and lets the Per-file coverage gate enforce
#       thresholds — the project's "enforces thresholds, not shard status"
#       contract. (Several backend suites are timing/rate-limit/build sensitive
#       and fail under --coverage AND on the slow CI runner even plain; the old
#       `Backend tests` pool masked them via a set -e bug. Gating shard pass/fail
#       here would red CI on those pre-existing env-flaky tests with no integrity
#       gain — the coverage threshold gate is and remains the real backend gate.)
#       A shard still exits non-zero on an INFRASTRUCTURE failure (the runner
#       couldn't execute), which the `Backend tests` aggregator surfaces.
#       No legs/merge/check here.
#
#   legs-only (CI; COVERAGE_LEGS_ONLY=1):
#       Run ONLY the SDK + harness-client + node-vitest coverage legs and emit
#       their lcov into $COV_OUT. No host files, no merge, no check.
#
# $COV_OUT — directory the CI modes copy per-shard lcov into (uploaded as an
# artifact). Unused in full mode.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-file-sets.sh
source "$SCRIPT_DIR/lib/test-file-sets.sh"

PARALLEL=${PARALLEL:-6}
COV_OUT=${COV_OUT:-}
TOTAL_PASS=0
TOTAL_FAIL=0
FAILED_FILES=()

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

[ -n "$COV_OUT" ] && mkdir -p "$COV_OUT"

# Per-file --coverage flags. Example e2e shards keep bun's 5s fast-fail (their
# real-subprocess cases genuinely time out without Docker; a long timeout would
# balloon the job). DB-heavy suites get 30s headroom so setupTestDb() in a
# beforeAll doesn't crash the shard as "(unnamed)" under instrumentation.
timeout_flag_for() {
  case "$1" in
    docs/extensions/examples/*) echo "" ;;
    *) echo "--timeout 30000" ;;
  esac
}

# ── host pool ───────────────────────────────────────────────────────────────
run_host_pool() {
  local -n _files=$1
  local running=0 idx=0
  for f in "${_files[@]}"; do
    local outfile="$TMPDIR/result_$idx" codefile="$TMPDIR/code_$idx" covdir="$TMPDIR/cov_$idx"
    local tflag; tflag=$(timeout_flag_for "$f")
    (
      # set +e: the script runs under set -e, so a failing `bun test` would
      # abort this subshell at the command-substitution assignment before the
      # output/exit-code files are written — making the failure invisible to the
      # summary. set +e (scoped to the subshell) records the real exit code so
      # the per-shard summary accurately reports failing files (visibility).
      set +e
      OUTPUT=$(bun test $tflag --coverage --coverage-reporter=lcov --coverage-dir="$covdir" "./$f" 2>&1)
      echo "$?" > "$codefile"
      echo "$OUTPUT" > "$outfile"
    ) &
    idx=$((idx + 1)); running=$((running + 1))
    if [ "$running" -ge "$PARALLEL" ]; then wait -n 2>/dev/null || true; running=$((running - 1)); fi
  done
  wait
  HOST_COUNT=$idx
}

# Tally pass/fail from a shard's captured output (visibility only).
tally() {
  local output="$1"
  local p f
  p=$(echo "$output" | awk '/pass/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="pass") print $j}' | tail -1)
  f=$(echo "$output" | awk '/fail/{for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)=="fail") print $j}' | tail -1)
  TOTAL_PASS=$((TOTAL_PASS + ${p:-0}))
  TOTAL_FAIL=$((TOTAL_FAIL + ${f:-0}))
}

# ── SDK + harness-client + node-vitest legs ─────────────────────────────────
run_legs() {
  # SDK: top-level test/ + co-located entities/__tests__/ (the canonical
  # coverage for entities/{validate,tools,storage,slug}.ts). mock.module-free,
  # so bundling preserves the 100% module-load instrumentation parity.
  local sdk_cov="$TMPDIR/cov_sdk" sdk_out
  sdk_out=$(bun test --coverage --coverage-reporter=lcov --coverage-dir="$sdk_cov" ./packages/@ezcorp/sdk/test/ ./packages/@ezcorp/sdk/src/entities/__tests__/ 2>&1) || true
  tally "$sdk_out"

  # harness-client — its own mock.module-free shard. Unlike the SDK leg above,
  # its pass/fail GATES: the event-name parity test + the route-table
  # meta-assertions in index.test.ts are part of the remote-control contract, so
  # a failure must red CI, not merely report. Capture the real exit code into the
  # global HC_EXIT (checked in the mode dispatch below) instead of the
  # pass/fail-tolerant `|| true`.
  HC_EXIT=0
  local hc_cov="$TMPDIR/cov_hc" hc_out
  hc_out=$(bun test --coverage --coverage-reporter=lcov --coverage-dir="$hc_cov" ./packages/@ezcorp/harness-client/ 2>&1) || HC_EXIT=$?
  tally "$hc_out"
  if [ "$HC_EXIT" != "0" ]; then
    FAILED_FILES+=("harness-client coverage leg")
    echo "--- FAIL: harness-client coverage leg (exit $HC_EXIT) ---"
  fi

  # Composer-suggest backend leg — dedicated bun-coverage shard feeding the
  # `src/suggest/**` + suggestion-feedback threshold keys. The host-shard set
  # (coverage_host_files) deliberately doesn't sweep these dirs; small
  # isolated suites also dodge Bun's large-suite attribution drift. Pass/fail
  # is tolerated like the SDK leg (thresholds are the gate); the suites also
  # run for correctness in `bun run test`.
  local suggest_cov="$TMPDIR/cov_suggest" suggest_out
  suggest_out=$(bun test --coverage --coverage-reporter=lcov --coverage-dir="$suggest_cov" \
    ./src/suggest/__tests__/intent-rank.test.ts \
    ./src/suggest/__tests__/embedding-cache.test.ts \
    ./src/suggest/__tests__/user-tool-priors.test.ts \
    ./src/suggest/__tests__/enhance.test.ts \
    ./src/suggest/__tests__/config.test.ts \
    ./src/suggest/__tests__/training-export.test.ts \
    ./src/db/queries/__tests__/suggestion-feedback.test.ts \
    ./src/db/queries/__tests__/settings-jsonb-roundtrip.test.ts 2>&1) || true
  tally "$suggest_out"

  # Node-run vitest leg for the vitest-only web/src/lib files. @vitest/coverage-v8
  # needs node:inspector's Coverage domain, which Bun does not implement, so this
  # leg MUST run under node (CI provisions node 22). --coverage.include is scoped
  # to JUST the target lib paths so the leg doesn't pull all of web/src/lib/**
  # into the gate. Subshell so `cd web` never leaks.
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
      src/__tests__/model-selector-logic.unit.test.ts \
      src/lib/save-flash.unit.test.ts \
      src/lib/admin-guard.unit.test.ts \
      src/lib/scroll-to-hash.unit.test.ts \
      src/lib/chat-prompt-nav.unit.test.ts \
      src/lib/extensions/extension-sort.unit.test.ts \
      src/lib/__tests__/rbac-grants-logic.unit.test.ts \
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
      src/lib/components/preprocess-result-logic.unit.test.ts \
      src/lib/components/tool-cards/grade-delta-logic.unit.test.ts \
      src/lib/components/tool-cards/GradeDeltaCard.component.test.ts \
      src/__tests__/composer-suggest-logic.unit.test.ts \
      src/__tests__/api-composer-suggest.server.test.ts \
      src/__tests__/api-composer-suggest-feedback.server.test.ts \
      src/lib/components/__tests__/SuggestionPopover.component.test.ts \
      src/lib/components/__tests__/ComposerSuggestSection.component.test.ts \
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
      --coverage.include='src/lib/model-selector-logic.ts' \
      --coverage.include='src/lib/save-flash.svelte.ts' \
      --coverage.include='src/lib/admin-guard.ts' \
      --coverage.include='src/lib/scroll-to-hash.ts' \
      --coverage.include='src/lib/chat-prompt-nav.ts' \
      --coverage.include='src/lib/extensions/extension-sort.ts' \
      --coverage.include='src/lib/rbac-grants-logic.ts' \
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
      --coverage.include='src/lib/components/settings/SaveIndicator.svelte' \
      --coverage.include='src/lib/components/preprocess-result-logic.ts' \
      --coverage.include='src/lib/components/tool-cards/grade-delta-logic.ts' \
      --coverage.include='src/lib/components/tool-cards/GradeDeltaCard.svelte' \
      --coverage.include='src/lib/composer-suggest-logic.ts' \
      --coverage.include='src/lib/components/SuggestionPopover.svelte' \
      --coverage.include='src/lib/components/settings/ComposerSuggestSection.svelte' \
      --coverage.include='src/lib/server/scoped-tools.ts' \
      --coverage.include='src/routes/api/composer/suggest/+server.ts' \
      --coverage.include='src/routes/api/composer/suggest/schema.ts' \
      --coverage.include='src/routes/api/composer/suggest/feedback/+server.ts' ) || VITEST_EXIT=$?
  # vitest (run from web/) emits SF paths web/-relative — re-root so merge-lcov.ts
  # resolves them against the repo root and the web/src/... threshold keys match.
  if [ -f "$VITEST_COV/lcov.info" ]; then
    sed -i 's#^SF:src/#SF:web/src/#' "$VITEST_COV/lcov.info"
  fi
  if [ "$VITEST_EXIT" != "0" ]; then
    FAILED_FILES+=("web vitest-coverage leg")
    echo "--- FAIL: web vitest-coverage leg (exit $VITEST_EXIT) ---"
  fi
}

# Copy every per-shard lcov produced this run into $COV_OUT (CI artifact).
emit_lcov() {
  [ -n "$COV_OUT" ] || return 0
  local n=0
  for d in "$TMPDIR"/cov_*; do
    [ -f "$d/lcov.info" ] || continue
    cp "$d/lcov.info" "$COV_OUT/lcov_${SHARD_INDEX:-x}_$(basename "$d").info"
    n=$((n + 1))
  done
  echo "emitted $n lcov shard(s) → $COV_OUT"
}

# ── mode dispatch ───────────────────────────────────────────────────────────

if [ -n "$COVERAGE_LEGS_ONLY" ]; then
  echo "== coverage legs-only mode =="
  run_legs
  emit_lcov
  echo "  ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | legs"
  # The harness-client leg (HC_EXIT) and the node-vitest leg (VITEST_EXIT) both
  # GATE here — the SDK leg stays pass/fail-tolerant (coverage-only). This is the
  # exit status the cov-extras CI job reports.
  if [ "$VITEST_EXIT" != "0" ] || [ "$HC_EXIT" != "0" ]; then exit 1; fi
  exit 0
fi

# Build the host file list (sliced for shard mode).
if [ -n "$SHARD_TOTAL" ]; then
  mapfile -t FILES < <(coverage_host_files | shard_slice "$SHARD_INDEX" "$SHARD_TOTAL")
  echo "== host-shard mode: shard ${SHARD_INDEX}/${SHARD_TOTAL} → ${#FILES[@]} files =="
else
  mapfile -t FILES < <(coverage_host_files)
  echo "== full local coverage mode: ${#FILES[@]} host files =="
fi

run_host_pool FILES

# Tally + collect failing files (by exit code) for the summary (visibility).
for ((i = 0; i < HOST_COUNT; i++)); do
  [ -f "$TMPDIR/result_$i" ] || continue
  OUTPUT=$(cat "$TMPDIR/result_$i")
  CODE=$(cat "$TMPDIR/code_$i" 2>/dev/null || echo 1)
  tally "$OUTPUT"
  if [ "$CODE" != "0" ]; then
    FAILED_FILES+=("${FILES[$i]}")
  fi
done

if [ -n "$SHARD_TOTAL" ]; then
  # SHARDED form of the pre-split coverage job: emit lcov and TOLERATE test
  # pass/fail (the Per-file coverage gate enforces thresholds — "enforces
  # thresholds, not shard status"). Failing files are listed for visibility but
  # do not red the shard; an INFRASTRUCTURE failure (couldn't run) still would,
  # via a non-zero exit before this point. See the header for why strict shard
  # gating is intentionally not done.
  emit_lcov
  echo ""
  echo "  ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | ${#FILES[@]} files (shard ${SHARD_INDEX}/${SHARD_TOTAL})"
  if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
    echo ""
    echo "Files with failing tests under coverage (TOLERATED — thresholds are the gate):"
    for f in "${FAILED_FILES[@]}"; do echo "  - $f"; done
  fi
  exit 0
fi

# ── full local mode: legs + merge + threshold check ─────────────────────────
run_legs

echo ""
echo "================================"
echo "  ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | $((${#FILES[@]} + 1)) shards"
echo "================================"
if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  echo ""
  echo "Failed files (visibility only — coverage gate below is authoritative):"
  for f in "${FAILED_FILES[@]}"; do echo "  - $f"; done
fi

mkdir -p coverage
bun scripts/merge-lcov.ts "$TMPDIR/cov_*/lcov.info" coverage/lcov.info

CHECK_EXIT=0
bun scripts/check-coverage.ts || CHECK_EXIT=$?

# Full local mode gates COVERAGE + the vitest leg's integrity + the
# harness-client leg's pass/fail (the remote-control contract). It does NOT gate
# the host pool's pass/fail — the CI shards own that. check-coverage catches any
# flaky-shard coverage drop.
if [ "$CHECK_EXIT" != "0" ] || [ "$VITEST_EXIT" != "0" ] || [ "$HC_EXIT" != "0" ]; then
  exit 1
fi
exit 0
