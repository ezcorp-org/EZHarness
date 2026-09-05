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
#       Run the ENTIRE host set + all legs + the web-security leg, merge every
#       per-shard lcov into coverage/lcov.info, and enforce
#       scripts/coverage-thresholds.json.
#       TWO INDEPENDENT VERDICTS, TWO NON-ZERO EXIT CODES (see EXIT CODES).
#       The original design's premise is kept — coverage CAN be measured from
#       a run that had failures, and the CI shards / `Web tests` job own the
#       authoritative pass/fail — but the run no longer *claims success* when
#       tests failed. It used to: the failing-file list printed
#       "visibility only" and the script exited 0 on the coverage verdict
#       alone, so `bun run test:coverage; echo $?` reported a clean suite with
#       14 red tests on screen. Pass/fail is now gated on the SAME
#       P-MEMBERSHIP + isolated-retry rule host-shard mode uses
#       (gate_host_failures), so a full local run and a CI shard can never
#       disagree about whether a given file is red.
#       The web-security leg (run_security_leg) exists ONLY in this mode: on CI
#       that producer is its own job (`web-security-coverage`), so full local
#       mode is the only place that would otherwise be missing it. See
#       run_security_leg for the parity bug this closes.
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
#       re-run and is tolerated. Failures OUTSIDE P are never pass/fail-gated
#       — they are listed as non-gating files and the Per-file coverage gate's
#       thresholds remain their only gate. C\P is now just the scoped web
#       bun:test files (whose pass/fail home is `web-bun-tests` / vitest): the
#       docs/extensions/examples suites used to sit here as the canonical
#       "tolerated" example and are now IN P, so a red assertion in that tree
#       REDS the shard instead of exiting 0 (it previously did the latter). A
#       missing per-file result ("no result recorded", e.g. an OOM-killed
#       subshell) counts as a failure and enters the same P-gate + retry
#       path. A shard also still exits non-zero on an INFRASTRUCTURE failure
#       (the runner couldn't execute). No legs/merge/check here.
#
#   legs-only (CI; COVERAGE_LEGS_ONLY=1):
#       Run ONLY the SDK + harness-client + suggest + ai-kit + node-vitest
#       coverage legs and emit their lcov into $COV_OUT. No host files, no
#       merge, no threshold check.
#
# PRODUCER INTEGRITY (all three modes): a producer that runs must emit an
# lcov. Shard mode guards its pool (the N_LCOV check); the two leg-running
# modes call check_leg_lcov, which walks the LEG_COV_DIR registry in
# lib/test-file-sets.sh and FAILS NAMING each leg that produced nothing.
# Before that guard a dead leg vanished from the merge glob in silence, and
# the only symptom was a blizzard of downstream "no lcov data" violations
# against files the change never touched.
#
# EXIT CODES (full mode; the two CI modes are unchanged at 0/1):
#
#   0  coverage gate passed AND no pass/fail-gated test failed.
#   1  the COVERAGE verdict failed — check-coverage.ts, a gating leg's exit
#      code (harness-client / ai-kit / node-vitest / web-security), or a
#      producer-integrity guard (dead leg, empty host pool). Unchanged, so
#      every existing `if ! bash scripts/test-coverage.sh` consumer keeps its
#      meaning.
#   2  coverage PASSED but TESTS FAILED — one or more pass/fail-set (P) host
#      files failed the pooled run and the isolated plain re-run.
#
# Why a distinct code rather than collapsing the two: the verdicts have
# genuinely different remedies (a red 2 is a broken test, a red 1 is an
# uncovered line or a dead producer) and the header's original reasoning —
# that coverage is still worth reporting from a run with failures — stays
# true. Both are non-zero, so nothing that merely checks `$?` can be told the
# suite is fine when it is not. Callers that want the distinction read the
# code; callers that just want "did it work" get the right answer either way.
#
# $COV_OUT — directory the CI modes copy per-shard lcov into (uploaded as an
# artifact). Unused in full mode.
set -e

# Full-mode exit code for "coverage passed, tests failed". Named so the
# meaning survives a grep and the meta-test can pin it.
EXIT_TESTS_FAILED=2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/test-file-sets.sh
source "$SCRIPT_DIR/lib/test-file-sets.sh"

# Pool width: min(nproc, 6) — see default_parallel in lib/test-file-sets.sh.
PARALLEL=${PARALLEL:-$(default_parallel)}
COV_OUT=${COV_OUT:-}
TOTAL_PASS=0
TOTAL_FAIL=0
# Everything that failed, host files AND named legs — the visibility list.
FAILED_FILES=()
# Host POOL failures only (repo-relative test paths). Kept separate from
# FAILED_FILES because the pass/fail gate classifies by P-MEMBERSHIP, and the
# leg entries FAILED_FILES also carries ("harness-client coverage leg", …) are
# not paths: they would classify as "not in P" and be printed as TOLERATED
# when they are in fact gated by their own exit codes. Only full mode appends
# legs, so this is the same list as FAILED_FILES in the two CI modes.
HOST_FAILED_FILES=()
# file -> the --coverage-dir the pooled run wrote it into ($TMPDIR/cov_$i).
# Populated for every host file (not just failures) right after run_host_pool
# returns. recover_missing_coverage (lib/test-file-sets.sh) reads this to find
# a crashed file's shard directory without needing FILES/index plumbing of
# its own — see that function's header for why the recovery exists.
declare -A HOST_COVDIR=()

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

[ -n "$COV_OUT" ] && mkdir -p "$COV_OUT"

# Per-test timeout — ONE value for every producer this script runs, matching
# scripts/test.sh:109 exactly. DB-heavy suites need the 30s headroom so
# setupTestDb() in a beforeAll doesn't crash the shard as "(unnamed)" under
# instrumentation; a genuine hang still fails at 30s.
#
# "EVERY PRODUCER" IS NEW, AND IT WAS A REAL HOLE. The host pool took this
# value; the four bun package/suggest legs and the node/vitest leg took
# NOTHING, so they ran on their runners' DEFAULT 5s per-test budget
# (`bun test --help`: "default is 5000"; vitest's `testTimeout` default is
# likewise 5000 and web/vitest.config.ts sets no override). scripts/test.sh
# and the security leg (security-coverage.sh:71) were both already on 30s, so
# the same test file got 30s in one runner and 5s in another — and the legs
# are the WORST place for the short budget, because each one bundles its whole
# file set into a single process and five of them run concurrently ON TOP of
# the 1289-file host pool. Measured instance:
# `packages/@ezcorp/ai-kit/test/unit/cli-install.test.ts`'s "idempotent —
# second install" failed at 5014.97ms — a 0.3% overshoot of exactly that 5s
# budget — while the same file re-run alone is 26 pass / 0 fail in ~5.1-5.5s
# total across its 26 tests (measured three times on a loaded box). That is
# the host, not the code. And it was not harmless: the ai-kit, harness-client
# and vitest legs GATE (AIKIT_EXIT / HC_EXIT / VITEST_EXIT), so a contention
# flake there reds CI on someone else's load.
#
# Raising a ceiling a healthy run never reaches is not weakening a gate — the
# wall-clock ASSERTION rule in CLAUDE.md is about tests that measure the host;
# this is the pool budget that stops the host measuring the tests.
#
# docs/extensions/examples/** USED to be carved out to bun's 5s fast-fail, on
# the theory that "their real-subprocess cases genuinely time out without
# Docker" and a long timeout would balloon the job. That carve-out was safe
# only while those files were coverage-only: their failures were TOLERATED by
# the P-membership classifier below. They are now in P (see the examples sweep
# in lib/test-file-sets.sh), so the carve-out became a false-RED source — and
# a divergence, since test.sh already gives the very same files 30s.
#
# Measured, not guessed: run per-file under --coverage locally, the slowest
# single test in the 178-file examples tree is 1278ms (the real-subprocess
# `*.integration` / `mcp-real-spawn` suites). ci.yml's own measured CI/dev
# per-file ratio is p90 4.6x — 1278ms x 4.6 ~= 5.9s, i.e. OVER bun's 5s
# default. The 30s ceiling is never reached by a healthy run (0 timeouts
# across all 178 under --coverage), so nothing balloons.
# ONE number, two spellings — bun wants `--timeout N`, vitest wants
# `--testTimeout=N`. Deriving both from TEST_TIMEOUT_MS is what stops the two
# runners drifting apart again.
TEST_TIMEOUT_MS=30000
TEST_TIMEOUT_FLAG="--timeout $TEST_TIMEOUT_MS"

# ── host pool ───────────────────────────────────────────────────────────────
run_host_pool() {
  local -n _files=$1
  local running=0 idx=0
  for f in "${_files[@]}"; do
    local outfile="$TMPDIR/result_$idx" codefile="$TMPDIR/code_$idx" covdir="$TMPDIR/cov_$idx"
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
      OUTPUT=$(bun test $TEST_TIMEOUT_FLAG --coverage --coverage-reporter=lcov --coverage-dir="$covdir" "./$f" 2>&1)
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

  # Register every leg this mode runs with the lcov registry in
  # lib/test-file-sets.sh. The producers below take their --coverage-dir from
  # LEG_COV_DIR, and check_leg_lcov (called by BOTH mode dispatches at the
  # bottom of this file) walks the same registry — so a leg that dies without
  # writing an lcov is named, instead of silently vanishing from the merge
  # glob. See the registry's header for why the silent skip was so expensive.
  register_leg sdk cov_sdk
  register_leg harness-client cov_hc
  register_leg suggest cov_suggest
  register_leg ai-kit cov_aikit
  register_leg web-vitest cov_vitest

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
    bun test $TEST_TIMEOUT_FLAG --coverage --coverage-reporter=lcov --coverage-dir="${LEG_COV_DIR[sdk]}" \
      ./packages/@ezcorp/sdk/test/ ./packages/@ezcorp/sdk/src/entities/__tests__/ ./packages/@ezcorp/sdk/src/v4/ ./packages/@ezcorp/sdk/src/browser/ \
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
    bun test $TEST_TIMEOUT_FLAG --coverage --coverage-reporter=lcov --coverage-dir="${LEG_COV_DIR[harness-client]}" \
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
    bun test $TEST_TIMEOUT_FLAG --coverage --coverage-reporter=lcov --coverage-dir="${LEG_COV_DIR[suggest]}" \
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
    bun test $TEST_TIMEOUT_FLAG --coverage --coverage-reporter=lcov --coverage-dir="${LEG_COV_DIR[ai-kit]}" \
      "${LEG_FILES[@]/#/./}" \
      > "$legs/aikit.out" 2>&1
    echo "$?" > "$legs/aikit.code"
  ) &

  # Node-run vitest leg for the vitest-only web/src/lib files. @vitest/coverage-v8
  # needs node:inspector's Coverage domain, which Bun does not implement, so this
  # leg MUST run under node (CI provisions node 22). --coverage.include is scoped
  # to JUST the target lib paths so the leg doesn't pull all of web/src/lib/**
  # into the gate. Subshell so `cd web` never leaks.
  #
  # THIS LEG IS TWO HAND-MAINTAINED ALLOWLISTS AND THEY MUST AGREE. The test
  # files below say WHAT RUNS; the --coverage.include patterns further down say
  # WHAT IS MEASURED. A module is only covered in this leg when it is on BOTH,
  # and neither list is derived from the other, so a suite can be thoroughly
  # green and still report as untested — the "tested but unmeasured" trap this
  # file already documents from PR #97, reached the other way round.
  #
  # Measured instance (2026-08-05): `src/hooks.server.ts` was on NEITHER list,
  # so EVERY `src/__tests__/hooks-server-*.server.test.ts` suite was
  # unmeasured. A change to hooks.server.ts read as uncovered against the
  # `web/src/**` catch-all no matter how many tests covered it, and the last
  # author to hit this worked around the gate by porting a green vitest suite
  # into the bun pool. Both lists now carry it.
  #
  # ANTI-ROT: src/__tests__/coverage-leg-lcov-guard.test.ts parses this
  # command and fails if any listed test file is missing from disk, or if any
  # --coverage.include pattern matches NOTHING under web/ — the silent
  # no-match that looks identical to success at this leg's exit code. Adding
  # to either list is cheap; adding to only one is the bug.
  #
  # DYNAMIC ROUTE SEGMENTS IN --coverage.include: a SvelteKit `[param]` segment
  # is matched VERBATIM by vitest 4.1.6 — it is not a Bun-`Glob`-style character
  # class, so the bare form (`.../[provider]/...`) is correct and the escaped
  # `[[]id]` form below is belt-and-braces, not a requirement. MEASURED both
  # ways rather than assumed: the bare form emits a real record
  # (`SF:src/routes/api/providers/[provider]/refresh-models/+server.ts`,
  # LF:21 LH:21), while deliberately-wrong `[xyz]` / `refresh-modelsX` variants
  # emit ZERO records. Verify any NEW dynamic-segment include the same way —
  # an include that silently matches nothing looks identical to success at this
  # leg's exit code, and only reappears downstream as the patch-coverage gate's
  # "changed source file has NO lcov data". That is exactly how
  # api/health/+server.ts and the refresh-models handler reached CI tested but
  # unmeasured (PR #97).
  VITEST_COV="${LEG_COV_DIR[web-vitest]}"
  (
  set +e
  ( cd web && npx vitest run --testTimeout="$TEST_TIMEOUT_MS" \
      src/__tests__/bounded-json.server.test.ts \
      src/__tests__/api-tool-invoke.server.test.ts \
      src/__tests__/api-marketplace-id-install.server.test.ts \
      src/__tests__/api-marketplace-export-v4.server.test.ts \
      src/__tests__/task-helpers-load-snapshot.server.test.ts \
      src/__tests__/task-helpers-write-and-broadcast.server.test.ts \
      src/__tests__/task-helpers-find-assignment.server.test.ts \
      src/__tests__/task-helpers-pick-spawn-agent-config.server.test.ts \
      src/__tests__/task-helpers-broadcast-assignment-update.server.test.ts \
      src/__tests__/extension-author-page-server-load.server.test.ts \
      src/__tests__/extension-author-page.component.test.ts \
      src/lib/components/extensions/ExtensionBrowser.component.test.ts \
      'src/routes/(app)/extensions/[id]/preview/page.component.test.ts' \
      src/__tests__/extension-control-routes.server.test.ts \
      src/__tests__/extension-project-binding.server.test.ts \
      src/__tests__/project-proposal-fixture.server.test.ts \
      src/__tests__/marketplace-release-fixture.server.test.ts \
      src/__tests__/project-proposal-review.server.test.ts \
      src/__tests__/project-proposal-review.component.test.ts \
      src/__tests__/extension-review-location.server.test.ts \
      src/__tests__/mcp-control-request.server.test.ts \
      src/__tests__/mcp-staging-client.unit.test.ts \
      src/__tests__/extension-credential-resolver.server.test.ts \
      src/__tests__/extension-host-api-transport.server.test.ts \
      src/__tests__/extension-legacy-cutover.server.test.ts \
      src/__tests__/extension-source-import.server.test.ts \
      src/__tests__/extension-source-import-page.server.test.ts \
      src/__tests__/extension-source-import-page.component.test.ts \
      src/__tests__/extension-control-actor.server.test.ts \
      src/__tests__/api-workflows.server.test.ts \
      src/__tests__/api-workflows-name.server.test.ts \
      src/__tests__/api-workflows-name-run.server.test.ts \
      src/__tests__/api-workflows-run-control.server.test.ts \
      src/__tests__/api-workflows-run-trace.server.test.ts \
      src/__tests__/api-workflows-runs-client-contract.server.test.ts \
      src/__tests__/api-workflows-approvals-list.server.test.ts \
      src/__tests__/api-workflows-approvals-answer.server.test.ts \
      src/__tests__/workflow-approvals-logic.unit.test.ts \
      src/__tests__/api-workflows-fork.server.test.ts \
      src/__tests__/api-workflows-dry-run.server.test.ts \
      src/__tests__/api-workflows-claim-versions.server.test.ts \
      src/__tests__/api-workflows-delegations.server.test.ts \
      src/__tests__/api-workflows-delegations-preview.server.test.ts \
      src/__tests__/workflow-delegations-logic.unit.test.ts \
      src/__tests__/delegation-consent.server.test.ts \
      src/__tests__/agent-config-extension-gate.server.test.ts \
      src/__tests__/workflow-access-delegation.server.test.ts \
      src/__tests__/workflow-route-ladder.server.test.ts \
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
      src/__tests__/hooks-server-dev-indicator.server.test.ts \
      src/__tests__/hooks-server-failed-bearer-ratelimit.server.test.ts \
      src/__tests__/hooks-server-gate-initiator.server.test.ts \
      src/__tests__/hooks-server-get-client-ip.server.test.ts \
      src/__tests__/hooks-server-invite-public-path.server.test.ts \
      src/__tests__/hooks-server-onboarding-redirect.server.test.ts \
      src/__tests__/hooks-server-return-to.server.test.ts \
      src/__tests__/hooks-server-route-allowlist.server.test.ts \
      src/__tests__/hooks-server-session-refresh.server.test.ts \
      src/__tests__/hooks-server-session-refresh-e2e.server.test.ts \
      src/__tests__/hooks-server-setup-redirect.server.test.ts \
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
      src/lib/components/hub/HubNavSection.component.test.ts \
      src/lib/components/extensions/UninstallDialog.component.test.ts \
      src/__tests__/extensions-page-loader.server.test.ts \
      src/lib/components/hub/HubComponentRenderer.component.test.ts \
      src/lib/server/hub-render-pull.page-state.unit.test.ts \
      src/lib/__tests__/project-icon.unit.test.ts \
      src/lib/hub-last-page.unit.test.ts \
      src/lib/components/__tests__/ModeFormModal.component.test.ts \
      src/lib/chat/page-handlers/__tests__/inherit-mode.unit.test.ts \
      src/__tests__/tools-api-mode-scope.server.test.ts \
      src/__tests__/api-extensions-id-reapprove-drift.server.test.ts \
      src/__tests__/api-conversations-id-tree.server.test.ts \
      src/__tests__/api-conversations-id-graph.server.test.ts \
      src/lib/components/chat/__tests__/GraphCanvas.component.test.ts \
      src/lib/components/chat/__tests__/ChatGraphPanel.component.test.ts \
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
      src/lib/workflow-run-display.unit.test.ts \
      src/lib/workflow-trace-logic.unit.test.ts \
      src/lib/workflow-run-history.unit.test.ts \
      src/__tests__/RunPayload.component.test.ts \
      src/lib/components/__tests__/AuthorCompositionPanel.component.test.ts \
      src/lib/components/__tests__/UsesList.component.test.ts \
      src/__tests__/api-users.server.test.ts \
      src/lib/audit-log-view.unit.test.ts \
      src/lib/settings-models.unit.test.ts \
      src/lib/provider-meta.unit.test.ts \
      src/lib/tier-ladder-view.unit.test.ts \
      src/lib/components/__tests__/TierLadderSection.component.test.ts \
      src/lib/components/__tests__/DefaultSelectionSection.component.test.ts \
      src/lib/components/__tests__/ToolResultCapSection.component.test.ts \
      src/lib/components/__tests__/RoutingExperimentsSection.component.test.ts \
      src/lib/routing-experiments-view.unit.test.ts \
      src/__tests__/api-settings-key.server.test.ts \
      src/__tests__/model-selector-logic.unit.test.ts \
      src/lib/save-flash.unit.test.ts \
      src/lib/admin-guard.unit.test.ts \
      src/lib/scroll-to-hash.unit.test.ts \
      src/lib/chat-prompt-nav.unit.test.ts \
      src/lib/chat-turn-collapse.unit.test.ts \
      src/lib/components/TurnCollapsedSummary.component.test.ts \
      src/lib/extensions/extension-sort.unit.test.ts \
      src/lib/__tests__/rbac-grants-logic.unit.test.ts \
      src/__tests__/resume-path.unit.test.ts \
      src/__tests__/pull-to-refresh-logic.unit.test.ts \
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
      src/lib/components/tool-cards/ez-draft-card-logic.unit.test.ts \
      src/lib/components/tool-cards/tool-cards-logic.unit.test.ts \
      src/__tests__/extension-author-install.server.test.ts \
      src/__tests__/extension-author-page-logic.server.test.ts \
      src/__tests__/extension-author-page-server-load.server.test.ts \
      src/__tests__/extension-audit-page-loader.server.test.ts \
      src/lib/components/tool-cards/failure-class.unit.test.ts \
      src/__tests__/author-draft-files.unit.test.ts \
      src/lib/components/tool-cards/GradeDeltaCard.component.test.ts \
      src/lib/components/tool-cards/city-conditions-card-logic.unit.test.ts \
      src/lib/components/tool-cards/CityConditionsCard.component.test.ts \
      src/lib/components/tool-cards/workflow-run-card-logic.unit.test.ts \
      src/lib/components/tool-cards/WorkflowRunCard.component.test.ts \
      src/lib/components/tool-cards/web-context-card-logic.unit.test.ts \
      src/lib/components/tool-cards/WebContextCard.component.test.ts \
      src/__tests__/pending-permission-tray.component.test.ts \
      src/__tests__/stores-pending-permission-tray.integration.component.test.ts \
      src/__tests__/pending-decisions-tray.component.test.ts \
      src/__tests__/stores-pending-approval-tray.integration.component.test.ts \
      src/lib/components/tool-cards/PendingApprovalCard.component.test.ts \
      src/__tests__/stores-ask-user-dedup.integration.component.test.ts \
      src/__tests__/composer-suggest-logic.unit.test.ts \
      src/__tests__/api-composer-suggest.server.test.ts \
      src/__tests__/api-composer-suggest-feedback.server.test.ts \
      src/lib/components/__tests__/SuggestionPopover.component.test.ts \
      src/lib/components/__tests__/ComposerSuggestSection.component.test.ts \
      src/__tests__/sse-resume-buffer.unit.test.ts \
      src/__tests__/fetch-policy-dedup-clone.unit.test.ts \
      src/lib/chat/page-handlers/__tests__/stream-resume.unit.test.ts \
      src/lib/chat/page-handlers/__tests__/stream-resume-attach.component.test.ts \
      src/lib/chat/page-handlers/__tests__/task-hydrate-attach.component.test.ts \
      src/__tests__/api-conversations-id-tasks-assign.server.test.ts \
      src/__tests__/api-conversations-id-tasks-retry.server.test.ts \
      src/__tests__/api-conversations-id-tasks-assignments-start.server.test.ts \
      src/__tests__/api-conversations-id-tasks-assignments-stop.server.test.ts \
      src/__tests__/stores-task-snapshot.integration.component.test.ts \
      src/__tests__/api-conversations-id-tasks.server.test.ts \
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
      src/__tests__/security-web-active-run-idor.server.test.ts \
      src/__tests__/security-web-tool-call-output-idor.server.test.ts \
      src/__tests__/api-mcp-servers-id-put.server.test.ts \
      src/__tests__/api-extensions-id-modifiable.server.test.ts \
      src/__tests__/api-extensions-id-settings-user.server.test.ts \
      src/__tests__/security-web-invite-claim-order.server.test.ts \
      src/__tests__/security-web-conversations-parent-idor.server.test.ts \
      src/__tests__/api-extensions.server.test.ts \
      src/__tests__/api-users-id.server.test.ts \
      src/__tests__/api-models-default-selection.server.test.ts \
      src/__tests__/api-models-capabilities.server.test.ts \
      src/__tests__/provider-availability.server.test.ts \
      src/lib/chat/page-handlers/__tests__/send-message.test.ts \
      src/lib/command-registry.unit.test.ts \
      src/lib/components/DiffSummaryPanel.component.test.ts \
      src/__tests__/api-write-scope-gates.server.test.ts \
      src/__tests__/api-memories.server.test.ts \
      src/__tests__/api-memories-id.server.test.ts \
      src/__tests__/api-memories-patch.server.test.ts \
      src/__tests__/api-memories-list-scope.server.test.ts \
      src/__tests__/api-projects.server.test.ts \
      src/__tests__/api-projects-id.server.test.ts \
      src/__tests__/api-projects-path-validation.server.test.ts \
      src/__tests__/api-knowledge-base.server.test.ts \
      src/__tests__/api-knowledge-base-id.server.test.ts \
      src/__tests__/api-lessons.server.test.ts \
      src/__tests__/api-lessons-id.server.test.ts \
      src/__tests__/api-fs-mkdir.server.test.ts \
      src/__tests__/api-ez-actions.server.test.ts \
      src/__tests__/api-ez-actions-distill.server.test.ts \
      src/__tests__/api-ez-actions-generic.server.test.ts \
      src/__tests__/api-audit.server.test.ts \
      src/__tests__/api-extensions-id-audit.server.test.ts \
      src/__tests__/api-extensions-id-audit-stats.server.test.ts \
      src/__tests__/api-extensions-id-confirm.server.test.ts \
      src/__tests__/extensions-reapprove-route.server.test.ts \
      src/__tests__/api-settings.server.test.ts \
      src/__tests__/api-service-accounts.server.test.ts \
      src/__tests__/api-service-accounts-id.server.test.ts \
      src/__tests__/api-service-accounts-daily-cap.server.test.ts \
      src/lib/components/DelegationConsentDialog.component.test.ts \
      src/__tests__/api-health.server.test.ts \
      src/__tests__/api-providers-refresh-models.server.test.ts \
      src/__tests__/api-conversations-id-export.server.test.ts \
      src/__tests__/api-extensions-id-reopen.server.test.ts \
      src/__tests__/test-only-endpoints.server.test.ts \
      src/lib/__tests__/extract-tool-output.unit.test.ts \
      src/__tests__/context-usage-logic.test.ts \
      src/__tests__/format-map.test.ts \
      src/__tests__/inline-tool-store.test.ts \
      src/__tests__/inline-tool-store-upsert.test.ts \
      src/__tests__/api-agent-configs.server.test.ts \
      src/__tests__/api-agent-configs-id.server.test.ts \
      src/__tests__/api-agent-configs-generate.server.test.ts \
      src/__tests__/api-projects-id-tool-permission-mode.server.test.ts \
      src/__tests__/api-caller-tools.server.test.ts \
      src/__tests__/tools-api-caller-parity.server.test.ts \
      src/__tests__/api-conversations-tool-results.server.test.ts \
      src/__tests__/api-conversations-id-messages.server.test.ts \
      src/__tests__/api-conversations-id-messages-coverage.server.test.ts \
      src/__tests__/api-conversations-id-messages-goal.server.test.ts \
      src/__tests__/api-conversations-id-agent-chat.server.test.ts \
      src/__tests__/api-settings-developer-api-keys.server.test.ts \
      --coverage --coverage.provider=v8 --coverage.reporter=lcovonly \
      --coverage.include='src/lib/server/security/bounded-json.ts' \
      --coverage.include='src/lib/server/security/payload.ts' \
      --coverage.include='src/lib/server/task-helpers.ts' \
      --coverage.include='src/routes/api/tool-invoke/+server.ts' \
      --coverage.include='**/api/marketplace/*/install/+server.ts' \
      --coverage.include='**/api/marketplace/export/*/+server.ts' \
      --coverage.include='src/lib/server/extensions/*.ts' \
      --coverage.include='**/extensions/author/+page.svelte' \
      --coverage.include='**/extensions/author/+page.server.ts' \
      --coverage.include='**/extensions/project-proposals/**/+page.server.ts' \
      --coverage.include='**/extensions/project-proposals/**/+page.svelte' \
      --coverage.include='**/extensions/import-source/+page.server.ts' \
      --coverage.include='**/extensions/import-source/+page.svelte' \
      --coverage.include='**/api/extensions/*/audit/+server.ts' \
      --coverage.include='src/routes/api/__test/project-proposal/+server.ts' \
      --coverage.include='src/routes/api/__test/marketplace-release/+server.ts' \
      --coverage.include='src/routes/api/extensions/control/+server.ts' \
      --coverage.include='src/routes/api/extensions/releases/**/+server.ts' \
      --coverage.include='src/routes/api/extensions/import-source/+server.ts' \
      --coverage.reportsDirectory="$VITEST_COV" \
      --coverage.include='src/lib/search/*.ts' \
      --coverage.include='src/lib/hub.ts' \
      --coverage.include='src/lib/components/goal-row-logic.ts' \
      --coverage.include='src/lib/components/UpdateBanner.svelte' \
      --coverage.include='src/lib/components/UpdateBanner.helpers.ts' \
      --coverage.include='src/routes/api/version/+server.ts' \
      --coverage.include='src/lib/utils/relative-time.ts' \
      --coverage.include='src/lib/context-usage-logic.ts' \
      --coverage.include='src/lib/server/http-errors.ts' \
      --coverage.include='src/lib/server/auth/session-cookie.ts' \
      --coverage.include='src/hooks.server.ts' \
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
      --coverage.include='src/lib/components/hub/HubNavSection.svelte' \
      --coverage.include='src/lib/components/extensions/UninstallDialog.svelte' \
      --coverage.include='src/routes/**/extensions/+page.server.ts' \
      --coverage.include='src/lib/components/hub/HubInlineForm.svelte' \
      --coverage.include='src/lib/server/hub-render-pull.ts' \
      --coverage.include='src/lib/project-icon.ts' \
      --coverage.include='src/lib/command-registry.ts' \
      --coverage.include='src/lib/hub-last-page.ts' \
      --coverage.include='src/lib/components/ModeFormModal.svelte' \
      --coverage.include='src/lib/chat/page-handlers/inherit-mode.ts' \
      --coverage.include='src/routes/api/tools/+server.ts' \
      --coverage.include='src/routes/api/extensions/[id]/reapprove-drift/+server.ts' \
      --coverage.include='src/routes/api/extensions/[id]/modifiable/+server.ts' \
      --coverage.include='src/routes/api/extensions/[id]/settings/user/+server.ts' \
      --coverage.include='src/routes/api/audit/+server.ts' \
      --coverage.include='src/routes/api/audit/stats/+server.ts' \
      --coverage.include='src/routes/api/extensions/[id]/audit/stats/+server.ts' \
      --coverage.include='src/routes/api/extensions/[id]/confirm/+server.ts' \
      --coverage.include='src/routes/api/extensions/[id]/reapprove/+server.ts' \
      --coverage.include='src/routes/api/settings/+server.ts' \
      --coverage.include='src/routes/api/projects/[id]/features/scan/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/tree/+server.ts' \
      --coverage.include='src/routes/api/workflows/runs/+server.ts' \
      --coverage.include='src/routes/api/workflows/runs/[id]/+server.ts' \
      --coverage.include='src/routes/api/workflows/runs/[id]/resume/+server.ts' \
      --coverage.include='src/routes/api/workflows/runs/[id]/cancel/+server.ts' \
      --coverage.include='src/routes/api/workflows/approvals/+server.ts' \
      --coverage.include='src/routes/api/workflows/approvals/[id]/+server.ts' \
      --coverage.include='src/lib/workflow-approvals-logic.ts' \
      --coverage.include='src/routes/api/conversations/[id]/graph/+server.ts' \
      --coverage.include='src/lib/components/chat/GraphCanvas.svelte' \
      --coverage.include='src/lib/components/chat/ChatGraphPanel.svelte' \
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
      --coverage.include='src/lib/dependency-picker.ts' \
      --coverage.include='src/lib/workflow-run-display.ts' \
      --coverage.include='src/lib/workflow-trace-logic.ts' \
      --coverage.include='src/lib/workflow-run-history.ts' \
      --coverage.include='src/lib/components/workflows/RunPayload.svelte' \
      --coverage.include='src/lib/components/extensions/AuthorCompositionPanel.svelte' \
      --coverage.include='src/lib/components/extensions/UsesList.svelte' \
      --coverage.include='src/routes/api/users/+server.ts' \
      --coverage.include='src/lib/audit-log-view.ts' \
      --coverage.include='src/lib/settings-models.ts' \
      --coverage.include='src/lib/provider-meta.ts' \
      --coverage.include='src/lib/tier-ladder-view.ts' \
      --coverage.include='src/lib/components/settings/TierLadderSection.svelte' \
      --coverage.include='src/lib/components/settings/DefaultSelectionSection.svelte' \
      --coverage.include='src/lib/components/settings/ToolResultCapSection.svelte' \
      --coverage.include='src/lib/components/settings/RoutingExperimentsSection.svelte' \
      --coverage.include='src/lib/routing-experiments-view.ts' \
      --coverage.include='src/routes/api/settings/[key]/+server.ts' \
      --coverage.include='src/routes/api/models/default-selection/+server.ts' \
      --coverage.include='src/routes/api/models/capabilities/+server.ts' \
      --coverage.include='src/lib/server/provider-availability.ts' \
      --coverage.include='src/lib/chat/page-handlers/send-message.ts' \
      --coverage.include='src/lib/model-selector-logic.ts' \
      --coverage.include='src/lib/save-flash.svelte.ts' \
      --coverage.include='src/lib/admin-guard.ts' \
      --coverage.include='src/lib/scroll-to-hash.ts' \
      --coverage.include='src/lib/chat-prompt-nav.ts' \
      --coverage.include='src/lib/chat-turn-collapse.ts' \
      --coverage.include='src/lib/components/TurnCollapsedSummary.svelte' \
      --coverage.include='src/lib/extensions/extension-sort.ts' \
      --coverage.include='src/lib/rbac-grants-logic.ts' \
      --coverage.include='src/lib/resume-path.ts' \
      --coverage.include='src/lib/components/pull-to-refresh-logic.ts' \
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
      --coverage.include='src/lib/components/tool-cards/ez-draft-card-logic.ts' \
      --coverage.include='src/lib/components/tool-cards/ez-install-card-logic.ts' \
      --coverage.include='src/lib/components/tool-cards/utils.ts' \
      --coverage.include='src/routes/api/extensions/author/install/+server.ts' \
      --coverage.include='src/routes/api/extensions/author/draft/[id]/+server.ts' \
      --coverage.include='src/routes/api/extensions/author/draft/[id]/validate/+server.ts' \
      --coverage.include='src/routes/**/extensions/author/+page.server.ts' \
      --coverage.include='src/routes/**/extensions/[id]/audit/+page.server.ts' \
      --coverage.include='src/lib/components/tool-cards/failure-class.ts' \
      --coverage.include='src/lib/server/author-draft-files.ts' \
      --coverage.include='src/lib/components/tool-cards/GradeDeltaCard.svelte' \
      --coverage.include='src/lib/components/tool-cards/city-conditions-card-logic.ts' \
      --coverage.include='src/lib/components/tool-cards/CityConditionsCard.svelte' \
      --coverage.include='src/lib/components/tool-cards/workflow-run-card-logic.ts' \
      --coverage.include='src/lib/components/tool-cards/WorkflowRunCard.svelte' \
      --coverage.include='src/lib/components/tool-cards/web-context-card-logic.ts' \
      --coverage.include='src/lib/components/tool-cards/WebContextCard.svelte' \
      --coverage.include='src/lib/components/tool-cards/PendingPermissionTray.svelte' \
      --coverage.include='src/lib/components/tool-cards/PendingDecisionsTray.svelte' \
      --coverage.include='src/lib/components/tool-cards/PendingApprovalCard.svelte' \
      --coverage.include='src/lib/stores.svelte.ts' \
      --coverage.include='src/lib/composer-suggest-logic.ts' \
      --coverage.include='src/lib/components/SuggestionPopover.svelte' \
      --coverage.include='src/lib/components/settings/ComposerSuggestSection.svelte' \
      --coverage.include='src/lib/server/scoped-tools.ts' \
      --coverage.include='src/routes/api/composer/suggest/+server.ts' \
      --coverage.include='src/routes/api/composer/suggest/schema.ts' \
      --coverage.include='src/routes/api/composer/suggest/feedback/+server.ts' \
      --coverage.include='src/lib/server/sse-resume-buffer.ts' \
      --coverage.include='src/lib/runtime-event-names.ts' \
      --coverage.include='src/routes/api/conversations/[id]/tool-results/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/caller-tools/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/caller-tools/schema.ts' \
      --coverage.include='src/routes/api/conversations/[id]/messages/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/agent-chat/+server.ts' \
      --coverage.include='src/routes/api/settings/developer/api-keys/+server.ts' \
      --coverage.include='src/routes/api/settings/developer/schema.ts' \
      --coverage.include='src/lib/utils/fetch-policy.ts' \
      --coverage.include='src/lib/chat/page-handlers/stream-resume.svelte.ts' \
      --coverage.include='src/lib/chat/page-handlers/task-hydrate.svelte.ts' \
      --coverage.include='src/routes/api/conversations/[id]/tasks/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/tasks/[taskId]/assign/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/tasks/[taskId]/retry/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/start/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/stop/+server.ts' \
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
      --coverage.include='src/routes/api/memories/+server.ts' \
      --coverage.include='src/routes/api/memories/[id]/+server.ts' \
      --coverage.include='src/routes/api/projects/+server.ts' \
      --coverage.include='src/routes/api/projects/[id]/+server.ts' \
      --coverage.include='src/routes/api/knowledge-base/+server.ts' \
      --coverage.include='src/routes/api/lessons/[id]/+server.ts' \
      --coverage.include='src/routes/api/fs/mkdir/+server.ts' \
      --coverage.include='src/routes/api/ez-actions/[name]/+server.ts' \
      --coverage.include='src/routes/api/context-types/+server.ts' \
      --coverage.include='src/routes/api/workflows/+server.ts' \
      --coverage.include='src/routes/api/workflows/schema.ts' \
      --coverage.include='src/routes/api/workflows/[name]/+server.ts' \
      --coverage.include='src/routes/api/workflows/[name]/run/+server.ts' \
      --coverage.include='src/routes/api/workflows/[name]/fork/+server.ts' \
      --coverage.include='src/routes/api/workflows/[name]/dry-run/+server.ts' \
      --coverage.include='src/routes/api/workflows/[name]/claim/+server.ts' \
      --coverage.include='src/routes/api/workflows/[name]/versions/+server.ts' \
      --coverage.include='src/routes/api/workflows/delegations/+server.ts' \
      --coverage.include='src/routes/api/workflows/delegations/[[]id]/+server.ts' \
      --coverage.include='src/lib/server/delegation-consent.ts' \
      --coverage.include='src/lib/server/agent-config-extension-gate.ts' \
      --coverage.include='src/routes/api/workflows/delegations/preview/+server.ts' \
      --coverage.include='src/routes/api/workflows/delegated-runs/+server.ts' \
      --coverage.include='src/lib/workflow-delegations-logic.ts' \
      --coverage.include='src/lib/extensions/canvas-bridge.ts' \
      --coverage.include='src/lib/extensions/browser-invocation.ts' \
      --coverage.include='src/lib/server/extension-browser.ts' \
      --coverage.include='src/lib/server/extension-document.ts' \
      --coverage.include='src/lib/components/extensions/ExtensionBrowser.svelte' \
      --coverage.include='src/routes/api/extensions/[[]name]/preview/+server.ts' \
      --coverage.include='src/routes/(app)/extensions/[[]id]/preview/+page.server.ts' \
      --coverage.include='src/routes/(app)/extensions/[[]id]/preview/+page.svelte' \
      --coverage.include='src/lib/server/workflow-access.ts' \
      --coverage.include='src/routes/**/pipelines/+page.server.ts' \
      --coverage.include='src/lib/components/WorkflowStepForm.svelte' \
      --coverage.include='src/lib/components/WorkflowBuilder.svelte' \
      --coverage.include='src/routes/api/hooks/[extensionId]/[slug]/+server.ts' \
      --coverage.include='src/routes/api/extensions/[name]/webhooks/[slug]/rotate/+server.ts' \
      --coverage.include='**/active-run/+server.ts' \
      --coverage.include='src/routes/api/service-accounts/+server.ts' \
      --coverage.include='src/routes/api/service-accounts/[id]/+server.ts' \
      --coverage.include='src/routes/api/service-accounts/[id]/daily-cap/+server.ts' \
      --coverage.include='src/lib/components/DelegationConsentDialog.svelte' \
      --coverage.include='**/tool-calls/**/output/+server.ts' \
      --coverage.include='**/mcp-servers/*/+server.ts' \
      --coverage.include='**/auth/invite/*/+server.ts' \
      --coverage.include='**/api/conversations/+server.ts' \
      --coverage.include='**/api/extensions/+server.ts' \
      --coverage.include='src/lib/components/review/DiffStatBar.svelte' \
      --coverage.include='src/lib/components/review/ReviewFileCard.svelte' \
      --coverage.include='src/lib/components/review/ReviewFileTree.svelte' \
      --coverage.include='**/users/[[]id]/+server.ts' \
      --coverage.include='src/routes/api/health/+server.ts' \
      --coverage.include='src/routes/api/providers/[provider]/refresh-models/+server.ts' \
      --coverage.include='src/routes/api/conversations/[id]/export/+server.ts' \
      --coverage.include='src/routes/api/extensions/[id]/reopen/+server.ts' \
      --coverage.include='src/routes/api/__test/seed-extension-author-draft/+server.ts' \
      --coverage.include='src/routes/api/__test/cleanup-extension/+server.ts' \
      --coverage.include='src/lib/tool-output.ts' \
      --coverage.include='src/lib/components/ui/format-map.ts' \
      --coverage.include='src/lib/inline-tool-store.svelte.ts' \
      --coverage.include='src/routes/api/agent-configs/+server.ts' \
      --coverage.include='src/routes/api/agent-configs/[id]/+server.ts' \
      --coverage.include='src/routes/api/agent-configs/generate/+server.ts' \
      --coverage.include='src/routes/api/projects/[id]/tool-permission-mode/+server.ts' ) \
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

# ── web-security coverage leg (FULL LOCAL MODE ONLY) ────────────────────────
# The 9 web/src/lib/server/security/** helpers can be measured by exactly ONE
# producer: scripts/security-coverage.sh. Their bun:test suites re-register
# mocks per `beforeEach` via `mock.module` (bun-only, no hoisted-`vi.mock`
# equivalent), so the node/vitest v8 leg cannot run them, and that leg's
# --coverage.include deliberately omits them. See the NOTE in
# scripts/coverage-config.ts where they were removed from EXCLUDES.
#
# On CI that producer is its own job (`web-security-coverage`) whose
# `lcov-cov-security` artifact the `Per-file coverage gate` merges — so CI has
# always enforced them correctly. FULL LOCAL MODE HAD NO EQUIVALENT: nothing
# here ran security-coverage.sh, so `bun run test:coverage` merged an lcov in
# which those 9 files appeared only via INCIDENTAL instrumentation (they are
# transitively imported by other measured modules, so only the lines reachable
# through that indirect path were counted — 15%-66%). The gate then failed all
# nine locally on a green main. This runs the same producer into
# the registry's cov_security dir so the local merge sees exactly what CI's
# gate does.
#
# Deliberately NOT run in the CI legs-only / host-shard modes: the dedicated
# job already produces this lcov there, and merging it twice would double every
# hit count for no gain.
run_security_leg() {
  # Registered HERE, not alongside the run_legs legs, so the lcov guard expects
  # this leg in exactly the mode that runs it — legs-only mode calls run_legs
  # but never this, and must not be told the security lcov is "missing".
  register_leg web-security cov_security
  mkdir -p "${LEG_COV_DIR[web-security]}"
  (
    set +e
    COV_OUT="$TMPDIR/sec_out" PARALLEL="$PARALLEL" \
      bash "$SCRIPT_DIR/security-coverage.sh" > "$TMPDIR/security.out" 2>&1
    echo "$?" > "$TMPDIR/security.code"
  ) &
}

# Print the security leg's captured output and stage its lcov for the merge.
# Must run AFTER the `wait` inside run_legs (which reaps this leg's subshell
# too). Fail-closed: a leg that dies without writing its exit-code file counts
# as exit 1, exactly like the gating legs in run_legs.
collect_security_leg() {
  echo ""
  echo "── leg output: security ──"
  cat "$TMPDIR/security.out" 2>/dev/null || echo "(no output captured)"
  SECURITY_EXIT=$(cat "$TMPDIR/security.code" 2>/dev/null || echo 1)
  # security-coverage.sh already re-roots SF paths to web/src/... and filters
  # to exactly the 9 files, so this is a straight copy into the merge glob.
  if [ -f "$TMPDIR/sec_out/lcov_security.info" ]; then
    cp "$TMPDIR/sec_out/lcov_security.info" "${LEG_COV_DIR[web-security]}/lcov.info"
  fi
  if [ "$SECURITY_EXIT" != "0" ]; then
    FAILED_FILES+=("web security coverage leg")
    echo "--- FAIL: web security coverage leg (exit $SECURITY_EXIT) ---"
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

# The host-pool pass/fail gate (gate_host_failures) lives in
# lib/test-file-sets.sh next to the set definitions it classifies against —
# see the header there. Both modes that run the host pool call it.

# ── mode dispatch ───────────────────────────────────────────────────────────

if [ -n "$COVERAGE_LEGS_ONLY" ]; then
  echo "== coverage legs-only mode =="
  run_legs
  # Every leg that ran must have produced an lcov. This matters MOST for the
  # two pass/fail-TOLERATED legs (sdk, suggest): a gating leg that dies also
  # reds via its exit code below, but a tolerated one used to exit 0 with no
  # lcov — cov-extras went green, the `Per-file coverage gate` job then merged
  # an artifact silently missing that leg's files, and blamed the PR with one
  # "listed in thresholds but no lcov data" violation per orphaned file.
  LEG_LCOV_EXIT=0
  check_leg_lcov || LEG_LCOV_EXIT=1
  emit_lcov
  echo "  ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | legs"
  # The harness-client (HC_EXIT), ai-kit (AIKIT_EXIT) and node-vitest
  # (VITEST_EXIT) legs GATE here — the SDK + suggest legs stay
  # pass/fail-tolerant (coverage-only; suggest also gates via the residual
  # job). A MISSING LCOV gates for every leg regardless: pass/fail tolerance
  # is about assertions, never about a producer that didn't produce. This is
  # the exit status the cov-extras CI job reports.
  if [ "$VITEST_EXIT" != "0" ] || [ "$HC_EXIT" != "0" ] || [ "$AIKIT_EXIT" != "0" ] || \
     [ "$LEG_LCOV_EXIT" != "0" ]; then exit 1; fi
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
  # Record every file's covdir up front (not just failures) — cheap, and it's
  # the one place that knows run_host_pool's "$TMPDIR/cov_$idx" convention, so
  # recover_missing_coverage below never has to re-derive it.
  HOST_COVDIR["${FILES[$i]}"]="$TMPDIR/cov_$i"
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
    HOST_FAILED_FILES+=("${FILES[$i]}")
  fi
done

# COVERAGE RECOVERY — shared by both host-pool modes so a shard and a full
# local run can never disagree about which files' instrumentation survived,
# exactly like gate_host_failures below is shared for pass/fail. See
# recover_missing_coverage's header (lib/test-file-sets.sh) for the defect
# this closes: a crashed file's plain pass/fail retry never touched its
# --coverage-dir, so the crash's lost lcov used to stay lost even when the
# retry proved the file was fine. This re-runs (bounded attempts) ISOLATED
# WITH --coverage into the SAME dir the pooled run used, so a recovered
# lcov.info needs no special-casing in the merge glob below. Must run BEFORE
# either mode's merge step — see the UNRECOVERABLE_COVERAGE_FILES checks in
# each branch.
recover_missing_coverage

if [ -n "$SHARD_TOTAL" ]; then
  # SHARDED CI form: emit lcov, then gate pass/fail on P-MEMBERSHIP with an
  # isolated retry sweep (the design documented in ci.yml's cov-shard comment
  # and lib/test-file-sets.sh):
  #   - a failing file that belongs to the pass/fail set P is re-run ONCE —
  #     serially, isolated, PLAIN (bun test, NO --coverage, no parallel
  #     siblings). Real breakage fails both runs; an instrumentation/
  #     contention flake passes the clean re-run and is tolerated.
  #   - a P-member still failing after the isolated re-run REDS the shard.
  #   - failures OUTSIDE P are never pass/fail-gated — listed as non-gating
  #     files; the Per-file coverage gate's thresholds remain their only gate.
  #     C\P is now only the scoped web bun:test files; the
  #     docs/extensions/examples suites joined P and DO gate here.
  #
  # COVERAGE-RECOVERY INTEGRITY: checked BEFORE the pre-merge, same placement
  # as the N_LCOV guard just below and for the identical reason — a file
  # recover_missing_coverage could not recover must never let the merge run
  # with that shard's lcov silently missing (its source files would then be
  # measured only by shards that merely import them, reading as a false
  # threshold miss for code nobody touched). This is a hard infrastructure
  # failure, not a threshold violation, so it reds here rather than flowing
  # into check-coverage.ts's percentage math.
  if [ "${#UNRECOVERABLE_COVERAGE_FILES[@]}" -gt 0 ]; then
    for f in "${UNRECOVERABLE_COVERAGE_FILES[@]}"; do
      echo "::error::$f — no coverage evidence recoverable after $COVERAGE_RECOVERY_ATTEMPTS instrumented re-run attempt(s) (infrastructure failure, not a threshold violation)"
    done
    exit 1
  fi
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

  # Classification + isolated retry sweep — shared with full mode so the two
  # can't drift (gate_host_failures above).
  gate_host_failures

  if [ "${#STILL_FAILED[@]}" -gt 0 ]; then
    echo ""
    echo "Shard FAILED: ${#STILL_FAILED[@]} pass/fail-set (P) file(s) failed the pooled run AND the isolated plain re-run:"
    for f in "${STILL_FAILED[@]}"; do echo "  - $f"; done
    exit 1
  fi
  exit 0
fi

# ── full local mode: legs + merge + threshold check ─────────────────────────
# Started BEFORE run_legs so it overlaps them; run_legs' own `wait` reaps it.
run_security_leg
run_legs
collect_security_leg

echo ""
echo "================================"
echo "  ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | $((${#FILES[@]} + 1)) shards"
echo "================================"
if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  echo ""
  # NOT "visibility only" any more. This list used to carry that label while
  # the script exited 0 on the coverage verdict alone — the exact sentence
  # that told a reader with 14 red tests on screen that the suite was fine.
  # Everything here now lands in one of three places: the P-gate below (host
  # files in P), the tolerated list it prints (host files outside P), or a
  # gating leg's own exit code (the named leg entries).
  echo "Failed files:"
  for f in "${FAILED_FILES[@]}"; do echo "  - $f"; done
fi

# Pass/fail verdict for the host pool — the SAME P-membership rule + isolated
# plain retry sweep the CI shards use (gate_host_failures). Runs before the
# producer-integrity guard so its report is not buried under a dead leg's
# fallout, and so a run that dies on a producer still tells you what failed.
gate_host_failures

# PRODUCER INTEGRITY — checked BEFORE the merge, so a dead producer is the
# LAST thing printed instead of being buried under the gate's fallout.
#
# The merge below globs "$TMPDIR"/cov_*/lcov.info: a producer that wrote no
# lcov is simply absent from the union, and check-coverage then reports every
# file it was the only measurer of as "listed in thresholds but no lcov data".
# Measured on a real run: one dead leg dropped 173 files from the merge, 146
# with no other producer, and the gate emitted 126 such violations — none of
# them the actual fault. This never read GREEN (the leg exit codes and the
# gate both still failed the run), so what follows buys DIAGNOSABILITY, not
# correctness: the same run now fails naming the leg that died.
check_leg_lcov || exit 1

# Per-file counterpart of the same guard: recover_missing_coverage (called
# above, shared with shard mode) could not regenerate lcov for one or more
# crashed host files after COVERAGE_RECOVERY_ATTEMPTS isolated, instrumented
# re-runs. Fails here, BEFORE the merge, for the same reason check_leg_lcov
# does — a source file measured only by shards that merely import it would
# otherwise read as a false threshold miss for code nobody touched. Loud and
# named, never a silent percentage.
if [ "${#UNRECOVERABLE_COVERAGE_FILES[@]}" -gt 0 ]; then
  for f in "${UNRECOVERABLE_COVERAGE_FILES[@]}"; do
    echo "::error::$f — no coverage evidence recoverable after $COVERAGE_RECOVERY_ATTEMPTS instrumented re-run attempt(s) (infrastructure failure, not a threshold violation)"
  done
  exit 1
fi

# Host-pool counterpart of the shard branch's N_LCOV guard. Deliberately a
# ZERO check and not a per-file one: full local mode TOLERATES host pass/fail
# (the CI shards own it), so a single killed file must stay a visibility-only
# entry in FAILED_FILES above — but a pool that produced NOTHING is an
# infrastructure failure, exactly as it is in a shard.
N_HOST_LCOV=0
for ((i = 0; i < HOST_COUNT; i++)); do
  if [ -s "$TMPDIR/cov_$i/lcov.info" ]; then N_HOST_LCOV=$((N_HOST_LCOV + 1)); fi
done
if [ "$N_HOST_LCOV" -eq 0 ]; then
  echo "::error::host pool produced no per-file lcov output (infrastructure failure)"
  exit 1
fi

mkdir -p coverage
bun scripts/merge-lcov.ts "$TMPDIR/cov_*/lcov.info" coverage/lcov.info

CHECK_EXIT=0
bun scripts/check-coverage.ts || CHECK_EXIT=$?

# ── the two verdicts ────────────────────────────────────────────────────────
# COVERAGE verdict (exit 1): check-coverage.ts + the vitest leg's integrity +
# the harness-client, ai-kit and web-security legs' pass/fail. SECURITY_EXIT
# gates for the same reason the CI `coverage` job requires
# `web-security-coverage` to have succeeded: a producer that didn't run means
# incomplete coverage data, which must never read green.
#
# TESTS verdict (exit $EXIT_TESTS_FAILED): the host pool's pass/fail, gated on
# P-membership after the isolated plain re-run. It used to be gated NOWHERE
# here, which is what let this command exit 0 with failing tests.
#
# Coverage wins the exit code when both fail: it is the stricter, more
# specific signal (a coverage drop is never "just" a flake) and keeping it at
# 1 means no existing consumer's meaning changes. Both verdicts are always
# PRINTED, whichever code is returned.
COVERAGE_FAILED=0
if [ "$CHECK_EXIT" != "0" ] || [ "$VITEST_EXIT" != "0" ] || [ "$HC_EXIT" != "0" ] || \
   [ "$AIKIT_EXIT" != "0" ] || [ "$SECURITY_EXIT" != "0" ]; then
  COVERAGE_FAILED=1
fi

echo ""
echo "================================"
if [ "${#STILL_FAILED[@]}" -gt 0 ]; then
  echo "  TESTS:    FAILED — ${#STILL_FAILED[@]} pass/fail-set (P) file(s) failed the pooled run AND the isolated plain re-run:"
  for f in "${STILL_FAILED[@]}"; do echo "              - $f"; done
else
  echo "  TESTS:    passed (no pass/fail-set file failed both the pooled run and an isolated re-run)"
fi
if [ "$COVERAGE_FAILED" != "0" ]; then
  echo "  COVERAGE: FAILED (check=$CHECK_EXIT vitest=$VITEST_EXIT harness-client=$HC_EXIT ai-kit=$AIKIT_EXIT security=$SECURITY_EXIT)"
else
  echo "  COVERAGE: passed"
fi
echo "  tolerated (not gated here): sdk=$SDK_LEG_EXIT suggest=$SUGGEST_LEG_EXIT leg exit codes; host files outside P"
echo "================================"

if [ "$COVERAGE_FAILED" != "0" ]; then exit 1; fi
if [ "${#STILL_FAILED[@]}" -gt 0 ]; then
  echo "exit $EXIT_TESTS_FAILED — coverage gate passed, but TESTS FAILED. Do not read this run as a green suite."
  exit "$EXIT_TESTS_FAILED"
fi
exit 0
