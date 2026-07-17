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
#       Pass/fail is gated on P-MEMBERSHIP (passfail_files in
#       lib/test-file-sets.sh) with an isolated retry sweep: a failing file
#       that belongs to the pass/fail set P is re-run ONCE — serially,
#       isolated, PLAIN (no --coverage, no parallel siblings). Real breakage
#       fails both runs and REDS the shard (exit 1); an instrumentation/
#       contention flake (several backend suites are timing/rate-limit
#       sensitive under --coverage on the slow CI runner) passes the clean
#       re-run and is tolerated. Failures OUTSIDE P (e.g. the
#       docs/extensions/examples suites, which fail by design without Docker)
#       are never pass/fail-gated — they are listed as non-gating files and
#       the Per-file coverage gate's thresholds remain their only gate. A
#       missing per-file result ("no result recorded", e.g. an OOM-killed
#       subshell) counts as a failure and enters the same P-gate + retry
#       path. A shard also still exits non-zero on an INFRASTRUCTURE failure
#       (the runner couldn't execute). No legs/merge/check here.
#
#   legs-only (CI; COVERAGE_LEGS_ONLY=1):
#       Run ONLY the SDK + harness-client + suggest + ai-kit + node-vitest
#       coverage legs and emit their lcov into $COV_OUT. No host files, no
#       merge, no check.
#
# $COV_OUT — directory the CI modes copy per-shard lcov into (uploaded as an
# artifact). Unused in full mode.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-file-sets.sh
source "$SCRIPT_DIR/lib/test-file-sets.sh"

# Pool width: min(nproc, 6) — see default_parallel in lib/test-file-sets.sh.
PARALLEL=${PARALLEL:-$(default_parallel)}
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
      # Wall-clock ms per file — feeds the LPT shard planner's timings
      # manifest (emitted as $COV_OUT/timings-shard-N.json below).
      START_MS=$(date +%s%3N)
      OUTPUT=$(bun test $tflag --coverage --coverage-reporter=lcov --coverage-dir="$covdir" "./$f" 2>&1)
      CODE=$?
      echo $(( $(date +%s%3N) - START_MS )) > "$TMPDIR/time_$idx"
      echo "$CODE" > "$codefile"
      echo "$OUTPUT" > "$outfile"
    ) &
    idx=$((idx + 1)); running=$((running + 1))
    if [ "$running" -ge "$PARALLEL" ]; then wait -n 2>/dev/null || true; running=$((running - 1)); fi
  done
  wait
  HOST_COUNT=$idx
}

# Tally pass/fail from a shard's captured output (summary counts only — the
# pass/fail GATING signal is the per-file exit code, not this tally).
tally() {
  local output="$1"
  local p f
  p=$(summary_count "$output" pass)
  f=$(summary_count "$output" fail)
  TOTAL_PASS=$((TOTAL_PASS + ${p:-0}))
  TOTAL_FAIL=$((TOTAL_FAIL + ${f:-0}))
}

# ── SDK + harness-client + suggest + ai-kit + node-vitest legs ──────────────
run_legs() {
  # The 5 legs are independent (disjoint covdirs, own exit codes) and run
  # CONCURRENTLY — cov-extras wall clock = max(legs), not their sum. Each
  # leg's combined stdout/stderr is captured to its own file and printed
  # SEQUENTIALLY after the wait, so logs never interleave. Exit-code
  # semantics: the SDK + suggest legs are pass/fail-TOLERATED
  # (coverage-only), the harness-client (HC_EXIT), ai-kit (AIKIT_EXIT) and
  # node-vitest (VITEST_EXIT) legs gate. A leg that dies without writing its
  # exit-code file counts as exit 1 for the gating legs (fail-closed).
  local legs="$TMPDIR/legs"
  mkdir -p "$legs"

  # Leg file lists come from lib/test-file-sets.sh (sdk_leg_files & co) —
  # ONE definition shared with the orphan-drift meta-test, so a leg's set
  # can never drift from what the meta-test credits it with running.

  # SDK: top-level test/ + co-located entities/__tests__/ (the canonical
  # coverage for entities/{validate,tools,storage,slug}.ts). mock.module-free,
  # so bundling preserves the 100% module-load instrumentation parity.
  # Pass/fail tolerated (coverage-only).
  # DIR args are LOAD-BEARING: bun discovers test/ before entities/__tests__
  # here; feeding the same files as a sorted explicit list reorders entities
  # first and 12 entities tests fail (order-dependent state in the bundled
  # process — a latent coupling, documented not fixed). sdk_leg_files()
  # mirrors exactly these dirs for the drift meta-test's crediting.
  (
    set +e
    bun test --coverage --coverage-reporter=lcov --coverage-dir="$TMPDIR/cov_sdk" \
      ./packages/@ezcorp/sdk/test/ ./packages/@ezcorp/sdk/src/entities/__tests__/ \
      > "$legs/sdk.out" 2>&1
    echo "$?" > "$legs/sdk.code"
  ) &

  # harness-client — its own mock.module-free shard. Unlike the SDK leg above,
  # its pass/fail GATES: the event-name parity test + the route-table
  # meta-assertions in index.test.ts are part of the remote-control contract, so
  # a failure must red CI, not merely report. The real exit code lands in
  # HC_EXIT below (checked in the mode dispatch). Dir arg mirrored by
  # harness_client_leg_files() for the drift meta-test.
  (
    set +e
    bun test --coverage --coverage-reporter=lcov --coverage-dir="$TMPDIR/cov_hc" \
      ./packages/@ezcorp/harness-client/ \
      > "$legs/hc.out" 2>&1
    echo "$?" > "$legs/hc.code"
  ) &

  # Composer-suggest backend leg — dedicated bun-coverage shard feeding the
  # `src/suggest/**` + suggestion-feedback threshold keys. The host-shard set
  # (coverage_host_files) subtracts exactly this set; small isolated suites
  # also dodge Bun's large-suite attribution drift. Pass/fail is tolerated
  # like the SDK leg (thresholds are the gate); the suites are also
  # pass/fail-gated in P via the CI residual job.
  (
    set +e
    mapfile -t LEG_FILES < <(suggest_leg_files)
    # Empty-set guard: `bun test` with ZERO file args runs the WHOLE tree —
    # a rotted find must fail loud, never silently widen the leg.
    if [ "${#LEG_FILES[@]}" -eq 0 ]; then
      echo "::error::suggest leg file set is EMPTY (find rot in suggest_leg_files?) — refusing an unscoped bun test" > "$legs/suggest.out"
      echo 1 > "$legs/suggest.code"
      exit 1
    fi
    bun test --coverage --coverage-reporter=lcov --coverage-dir="$TMPDIR/cov_suggest" \
      "${LEG_FILES[@]/#/./}" \
      > "$legs/suggest.out" 2>&1
    echo "$?" > "$legs/suggest.code"
  ) &

  # ai-kit leg (wave 3): these 22 files previously ran ONLY at release time —
  # a rotted SKILL.md drift-guard assertion proved the gap. unit/ +
  # integration/ are deterministic (verified per-file AND bundled, no
  # Docker); e2e/ self-skips without EZCORP_E2E_BASE_URL. Pass/fail GATES
  # like the harness-client leg (AIKIT_EXIT) — deterministic package suites
  # have no instrumentation-flake excuse.
  (
    set +e
    mapfile -t LEG_FILES < <(aikit_leg_files)
    # Empty-set guard: see the suggest leg — an empty find must red the
    # (gating) AIKIT_EXIT, not run the whole tree.
    if [ "${#LEG_FILES[@]}" -eq 0 ]; then
      echo "::error::ai-kit leg file set is EMPTY (find rot in aikit_leg_files?) — refusing an unscoped bun test" > "$legs/aikit.out"
      echo 1 > "$legs/aikit.code"
      exit 1
    fi
    bun test --coverage --coverage-reporter=lcov --coverage-dir="$TMPDIR/cov_aikit" \
      "${LEG_FILES[@]/#/./}" \
      > "$legs/aikit.out" 2>&1
    echo "$?" > "$legs/aikit.code"
  ) &

  # Node-run vitest leg for the vitest-only web/src/lib files. @vitest/coverage-v8
  # needs node:inspector's Coverage domain, which Bun does not implement, so this
  # leg MUST run under node (CI provisions node 22). --coverage.include is scoped
  # to JUST the target lib paths so the leg doesn't pull all of web/src/lib/**
  # into the gate. Subshell so `cd web` never leaks.
  VITEST_COV="$TMPDIR/cov_vitest"
  (
  set +e
  ( cd web && npx vitest run \
      src/__tests__/api-workflows.server.test.ts \
      src/__tests__/api-workflows-name.server.test.ts \
      src/__tests__/api-workflows-name-run.server.test.ts \
      src/__tests__/pipelines-redirect.server.test.ts \
      src/lib/components/WorkflowStepForm.component.test.ts \
      src/lib/components/WorkflowBuilder.component.test.ts \
      src/__tests__/api-hooks.server.test.ts \
      src/__tests__/webhook-pipeline.server.test.ts \
      src/__tests__/api-webhook-rotate.server.test.ts \
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
      src/__tests__/api-conversations-id-tree.server.test.ts \
      src/__tests__/api-conversations-id-rewind.server.test.ts \
      src/__tests__/api-conversations-id-messages-mid-retry.server.test.ts \
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
      src/__tests__/pending-permission-tray.component.test.ts \
      src/__tests__/stores-pending-permission-tray.integration.component.test.ts \
      src/__tests__/stores-ask-user-dedup.integration.component.test.ts \
      src/__tests__/composer-suggest-logic.unit.test.ts \
      src/__tests__/api-composer-suggest.server.test.ts \
      src/__tests__/api-composer-suggest-feedback.server.test.ts \
      src/lib/components/__tests__/SuggestionPopover.component.test.ts \
      src/lib/components/__tests__/ComposerSuggestSection.component.test.ts \
      src/__tests__/sse-resume-buffer.unit.test.ts \
      src/lib/dev-badge.unit.test.ts \
      src/lib/components/DevBadge.component.test.ts \
      src/lib/ez/__tests__/page-context.unit.test.ts \
      src/lib/ez/__tests__/client-tool-dispatcher.unit.test.ts \
      src/__tests__/api-projects-id-features-scan.server.test.ts \
      src/lib/topic-contexts-logic.unit.test.ts \
      src/lib/components/__tests__/TopicPills.component.test.ts \
      src/lib/components/__tests__/TopicsPopover.component.test.ts \
      src/lib/components/__tests__/TopicContextsSection.component.test.ts \
      src/__tests__/api-context-types.server.test.ts \
      src/__tests__/api-contexts.server.test.ts \
      src/__tests__/api-conversations-topics.server.test.ts \
      src/__tests__/api-topics-extract.server.test.ts \
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
      --coverage.include='src/routes/api/projects/[id]/features/scan/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/tree/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/rewind/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/rewind/schema.ts' \
      --coverage.include='src/routes/api/conversations/[id]/messages/[mid]/retry/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/messages/[mid]/retry/schema.ts' \
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
      --coverage.include='src/lib/components/tool-cards/PendingPermissionTray.svelte' \
      --coverage.include='src/lib/stores.svelte.ts' \
      --coverage.include='src/lib/composer-suggest-logic.ts' \
      --coverage.include='src/lib/components/SuggestionPopover.svelte' \
      --coverage.include='src/lib/components/settings/ComposerSuggestSection.svelte' \
      --coverage.include='src/lib/server/scoped-tools.ts' \
      --coverage.include='src/routes/api/composer/suggest/+server.ts' \
      --coverage.include='src/routes/api/composer/suggest/schema.ts' \
      --coverage.include='src/routes/api/composer/suggest/feedback/+server.ts' \
      --coverage.include='src/lib/server/sse-resume-buffer.ts' \
      --coverage.include='src/lib/dev-badge.ts' \
      --coverage.include='src/lib/components/DevBadge.svelte' \
      --coverage.include='src/lib/ez/page-context.ts' \
      --coverage.include='src/lib/ez/client-tool-dispatcher.ts' \
      --coverage.include='src/lib/topic-contexts-logic.ts' \
      --coverage.include='src/lib/components/chat/TopicPills.svelte' \
      --coverage.include='src/lib/components/chat/TopicsPopover.svelte' \
      --coverage.include='src/lib/components/settings/TopicContextsSection.svelte' \
      --coverage.include='src/routes/api/conversations/[id]/topics/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/topics/schema.ts' \
      --coverage.include='src/routes/api/conversations/[id]/topics/[topicId]/extract/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/topics/[topicId]/extract/schema.ts' \
      --coverage.include='src/routes/api/contexts/+server.ts' \
      --coverage.include='src/routes/api/contexts/[id]/+server.ts' \
      --coverage.include='src/routes/api/context-types/+server.ts' \
      --coverage.include='src/routes/api/workflows/+server.ts' \
      --coverage.include='src/routes/api/workflows/schema.ts' \
      --coverage.include='src/routes/api/workflows/[name]/+server.ts' \
      --coverage.include='src/routes/api/workflows/[name]/run/+server.ts' \
      --coverage.include='src/routes/**/pipelines/+page.server.ts' \
      --coverage.include='src/lib/components/WorkflowStepForm.svelte' \
      --coverage.include='src/lib/components/WorkflowBuilder.svelte' \
      --coverage.include='src/routes/api/hooks/[extensionId]/[slug]/+server.ts' \
      --coverage.include='src/routes/api/extensions/[name]/webhooks/[slug]/rotate/+server.ts' ) \
    > "$legs/vitest.out" 2>&1
  echo "$?" > "$legs/vitest.code"
  ) &

  wait

  # Print each leg's captured output sequentially (no interleaving), then
  # tally + collect exit codes with the pre-parallel gating semantics.
  local leg
  for leg in sdk hc suggest aikit vitest; do
    echo ""
    echo "── leg output: $leg ──"
    cat "$legs/$leg.out" 2>/dev/null || echo "(no output captured)"
  done
  # Tally the bun legs (as before the parallelisation; the vitest
  # summary format never matched the bun "N pass" parser).
  for leg in sdk hc suggest aikit; do
    tally "$(cat "$legs/$leg.out" 2>/dev/null)"
  done

  HC_EXIT=$(cat "$legs/hc.code" 2>/dev/null || echo 1)
  if [ "$HC_EXIT" != "0" ]; then
    FAILED_FILES+=("harness-client coverage leg")
    echo "--- FAIL: harness-client coverage leg (exit $HC_EXIT) ---"
  fi

  AIKIT_EXIT=$(cat "$legs/aikit.code" 2>/dev/null || echo 1)
  if [ "$AIKIT_EXIT" != "0" ]; then
    FAILED_FILES+=("ai-kit coverage leg")
    echo "--- FAIL: ai-kit coverage leg (exit $AIKIT_EXIT) ---"
  fi

  # Tolerated legs: their exit codes are LOGGED, never gated — sdk + suggest
  # are coverage-only here (thresholds are their gate; suggest additionally
  # pass/fail-gates via the residual job). Printing the codes keeps the
  # tolerance VISIBLE instead of silently discarding the written .code files.
  SDK_LEG_EXIT=$(cat "$legs/sdk.code" 2>/dev/null || echo "?")
  SUGGEST_LEG_EXIT=$(cat "$legs/suggest.code" 2>/dev/null || echo "?")
  echo "tolerated leg exit codes (not gated): sdk=$SDK_LEG_EXIT suggest=$SUGGEST_LEG_EXIT"

  VITEST_EXIT=$(cat "$legs/vitest.code" 2>/dev/null || echo 1)
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

# Copy every per-leg lcov produced this run into $COV_OUT (CI artifact).
# Used by legs-only mode (4 small files); host-shard mode PRE-MERGES its
# ~200 per-file lcovs into one artifact file instead — see the shard branch.
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
  # The harness-client (HC_EXIT), ai-kit (AIKIT_EXIT) and node-vitest
  # (VITEST_EXIT) legs GATE here — the SDK + suggest legs stay
  # pass/fail-tolerant (coverage-only; suggest also gates via the residual
  # job). This is the exit status the cov-extras CI job reports.
  if [ "$VITEST_EXIT" != "0" ] || [ "$HC_EXIT" != "0" ] || [ "$AIKIT_EXIT" != "0" ]; then exit 1; fi
  exit 0
fi

# SHARD_INDEX/SHARD_TOTAL must be set together: a lone SHARD_TOTAL used to
# make the stride slice silently select 0 files (awk idx="" matches nothing),
# and a lone SHARD_INDEX silently ran the FULL set in "full mode". Both are
# misconfigurations that must red, not green.
if { [ -n "$SHARD_TOTAL" ] && [ -z "$SHARD_INDEX" ]; } || { [ -n "$SHARD_INDEX" ] && [ -z "$SHARD_TOTAL" ]; }; then
  echo "::error::SHARD_INDEX and SHARD_TOTAL must be set together (got SHARD_INDEX='${SHARD_INDEX:-}' SHARD_TOTAL='${SHARD_TOTAL:-}')"
  exit 1
fi

# Build the host file list (sliced for shard mode).
if [ -n "$SHARD_TOTAL" ]; then
  if [ -n "$HOST_FILES_OVERRIDE" ] && [ -z "$CI" ]; then
    # Dev-only escape hatch: run an explicit file list (one repo-relative path
    # per line) to exercise the P-membership gate + retry sweep locally without
    # a full 1-of-N shard. INERT IN CI: GitHub Actions always sets CI, so this
    # branch can never replace the real set there (no gate-weakening surface).
    mapfile -t FILES < "$HOST_FILES_OVERRIDE"
    echo "== host-shard mode (HOST_FILES_OVERRIDE, dev-only): ${#FILES[@]} files =="
  else
    mapfile -t FILES < <(coverage_host_files | shard_slice "$SHARD_INDEX" "$SHARD_TOTAL")
    echo "== host-shard mode: shard ${SHARD_INDEX}/${SHARD_TOTAL} → ${#FILES[@]} files =="
  fi
else
  mapfile -t FILES < <(coverage_host_files)
  echo "== full local coverage mode: ${#FILES[@]} host files =="
fi

run_host_pool FILES

# Tally + collect failing files (by exit code). A MISSING result/code file
# (OOM/SIGKILL-ed subshell wrote neither) is a FAILURE — "no result recorded"
# — never a silent skip: in shard mode it feeds the P-membership gate below;
# elsewhere it is at least visible in the failed-files list.
for ((i = 0; i < HOST_COUNT; i++)); do
  if [ -f "$TMPDIR/result_$i" ]; then
    OUTPUT=$(cat "$TMPDIR/result_$i")
    CODE=$(cat "$TMPDIR/code_$i" 2>/dev/null || echo 1)
  else
    OUTPUT=""
    CODE=1
    echo "--- no result recorded (killed?): ${FILES[$i]} — counting as a failure ---"
  fi
  tally "$OUTPUT"
  # A file is failing if bun exited non-zero OR its summary reported failures
  # (same OR as collect_pool_results — a bun exit-0-with-"N fail" summary must
  # not slip past the P-gate).
  FILE_FAIL=$(summary_count "$OUTPUT" fail)
  if [ "$CODE" != "0" ] || [ "${FILE_FAIL:-0}" != "0" ]; then
    FAILED_FILES+=("${FILES[$i]}")
  fi
done

if [ -n "$SHARD_TOTAL" ]; then
  # SHARDED CI form: emit lcov, then gate pass/fail on P-MEMBERSHIP with an
  # isolated retry sweep (the design documented in ci.yml's cov-shard comment
  # and lib/test-file-sets.sh):
  #   - a failing file that belongs to the pass/fail set P is re-run ONCE —
  #     serially, isolated, PLAIN (bun test, NO --coverage, no parallel
  #     siblings). Real breakage fails both runs; an instrumentation/
  #     contention flake passes the clean re-run and is tolerated.
  #   - a P-member still failing after the isolated re-run REDS the shard.
  #   - failures OUTSIDE P (e.g. the docs/extensions/examples suites that
  #     fail by design without Docker) are never pass/fail-gated — listed as
  #     non-gating files; the Per-file coverage gate's thresholds remain
  #     their only gate.
  #
  # PRE-MERGE: the shard's ~200 per-file lcovs are merged into ONE artifact
  # file here (~110MB → <1MB; the gate then merges 8 files, not ~1000).
  # merge-lcov's output is deterministic and the merge is associative with an
  # idempotent noise filter, so pre-merge + gate merge-of-merges is
  # byte-identical to one direct merge (proven: wave-2 equivalence check).
  # A shard that produced NO per-file lcov must red like the old
  # if-no-files-found: error did — an empty merge output would silently
  # green, so guard explicitly.
  if [ -n "$COV_OUT" ]; then
    N_LCOV=0
    for shard_lcov in "$TMPDIR"/cov_*/lcov.info; do
      [ -f "$shard_lcov" ] && N_LCOV=$((N_LCOV + 1))
    done
    if [ "$N_LCOV" -eq 0 ]; then
      echo "::error::shard produced no per-file lcov output (infrastructure failure)"
      exit 1
    fi
    bun scripts/merge-lcov.ts "$TMPDIR/cov_*/lcov.info" "$COV_OUT/lcov_shard_${SHARD_INDEX}.info"
    echo "pre-merged $N_LCOV per-file lcov(s) → $COV_OUT/lcov_shard_${SHARD_INDEX}.info"

    # Per-file wall-clock timings — rides the lcov artifact. Same envelope as
    # the committed scripts/shard-timings.json so shard artifacts can be
    # merged (union of timingsMs) into a refreshed manifest for the LPT
    # planner (scripts/shard-plan.ts).
    {
      printf '{\n  "version": 1,\n  "source": "cov-shard %s/%s run",\n  "timingsMs": {\n' \
        "$SHARD_INDEX" "$SHARD_TOTAL"
      TIMING_FIRST=1
      for ((i = 0; i < HOST_COUNT; i++)); do
        [ -f "$TMPDIR/time_$i" ] || continue
        [ "$TIMING_FIRST" = "1" ] || printf ',\n'
        printf '    "%s": %s' "${FILES[$i]}" "$(cat "$TMPDIR/time_$i")"
        TIMING_FIRST=0
      done
      printf '\n  }\n}\n'
    } > "$COV_OUT/timings-shard-${SHARD_INDEX}.json"
    echo "emitted per-file timings → $COV_OUT/timings-shard-${SHARD_INDEX}.json"
  fi
  echo ""
  echo "  ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | ${#FILES[@]} files (shard ${SHARD_INDEX}/${SHARD_TOTAL})"

  declare -A IN_P=()
  while IFS= read -r pf; do IN_P["$pf"]=1; done < <(passfail_files)
  P_FAILED=()
  NONP_FAILED=()
  for f in "${FAILED_FILES[@]}"; do
    if [ -n "${IN_P[$f]:-}" ]; then P_FAILED+=("$f"); else NONP_FAILED+=("$f"); fi
  done

  if [ "${#NONP_FAILED[@]}" -gt 0 ]; then
    echo ""
    echo "Failing non-gating files (TOLERATED — not in the pass/fail set P; thresholds are their gate):"
    for f in "${NONP_FAILED[@]}"; do echo "  - $f"; done
  fi

  STILL_FAILED=()
  if [ "${#P_FAILED[@]}" -gt 0 ]; then
    echo ""
    echo "Retry sweep: ${#P_FAILED[@]} failed pass/fail-set (P) file(s) — re-running each once, serial + isolated + PLAIN (no --coverage):"
    for f in "${P_FAILED[@]}"; do
      set +e
      # Wall-clock watchdog: bun's per-test timeout can't catch a module-LOAD
      # hang, so cap the whole re-run at 5 min — it reds fast instead of
      # stalling to the job timeout (timeout(1) exits 124 → still-failing;
      # -k 30 sends SIGKILL 30s after SIGTERM for a SIGTERM-immune hang,
      # exit 137 → still-failing). If the timeout binary is missing, fall
      # back to the plain run: the exit code still gates identically,
      # nothing soft-passes.
      if command -v timeout >/dev/null 2>&1; then
        RETRY_OUT=$(timeout -k 30 300 bun test --timeout 30000 "./$f" 2>&1)
      else
        RETRY_OUT=$(bun test --timeout 30000 "./$f" 2>&1)
      fi
      RETRY_CODE=$?
      set -e
      if [ "$RETRY_CODE" = "0" ]; then
        echo "  - $f: passed the isolated plain re-run (instrumentation/contention flake — tolerated)"
      else
        echo "  - $f: STILL FAILING after isolated re-run (exit $RETRY_CODE)"
        echo "$RETRY_OUT" | tail -20 | sed 's/^/      /'
        STILL_FAILED+=("$f")
      fi
    done
  fi

  if [ "${#STILL_FAILED[@]}" -gt 0 ]; then
    echo ""
    echo "Shard FAILED: ${#STILL_FAILED[@]} pass/fail-set (P) file(s) failed the pooled run AND the isolated plain re-run:"
    for f in "${STILL_FAILED[@]}"; do echo "  - $f"; done
    exit 1
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
# harness-client and ai-kit legs' pass/fail. It does NOT gate the host pool's
# pass/fail — the CI shards own that. check-coverage catches any flaky-shard
# coverage drop.
if [ "$CHECK_EXIT" != "0" ] || [ "$VITEST_EXIT" != "0" ] || [ "$HC_EXIT" != "0" ] || [ "$AIKIT_EXIT" != "0" ]; then
  exit 1
fi
exit 0
