#!/usr/bin/env bash
# Per-file --coverage runner for the host/example pool plus package, provider,
# API-client, and Worker legs. The canonical Web Vitest V8 producer runs here
# only in full local mode; CI receives its three receipts from test-web-shard.
# Each host file runs in its own bun process
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
#       Run ONLY the package, provider, API-client, and Worker coverage legs
#       and emit their lcov into $COV_OUT. No host files, no
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
#      code (harness-client / ai-kit / provider / API-client / Worker /
#      web-security), or a
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
# Runs before any mode (full/host-shard/legs-only) branches below — a wrong
# bun corrupts coverage instrumentation, not just timing. No-op on CI: every
# workflow installs bun from the same .bun-version this reads. No-op fallback
# defined FIRST, then overridden by sourcing the real helper only if it
# exists — see scripts/lib/bun-version-check.sh's REGRESSION note.
check_bun_version_skew() { return 0; }
# shellcheck source=scripts/lib/bun-version-check.sh
[ -f "$SCRIPT_DIR/lib/bun-version-check.sh" ] && source "$SCRIPT_DIR/lib/bun-version-check.sh"
check_bun_version_skew

# Pool width: min(nproc, 6) — see default_parallel in lib/test-file-sets.sh.
PARALLEL=${PARALLEL:-$(default_parallel)}
# The independent coverage producers each instrument a complete test surface.
# Keep their process count below the measured CI-safe ceiling; host-pool work
# uses its separate PARALLEL scheduler and never shares this mode.
COVERAGE_LEG_MAX_JOBS=${COVERAGE_LEG_MAX_JOBS:-3}
if ! [[ "$COVERAGE_LEG_MAX_JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "COVERAGE_LEG_MAX_JOBS must be a positive integer (got $COVERAGE_LEG_MAX_JOBS)" >&2
  exit 2
fi
COV_OUT=${COV_OUT:-}
TOTAL_PASS=0
TOTAL_FAIL=0
FULL_VITEST_EXIT=0
PROVIDER_EXIT=0
WORKER_EXIT=0
WEB_VITEST_SOURCE_GUARD_EXIT=0
BROWSER_RECEIPT_EXIT=0
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

# ── Package, provider, API-client, and Worker legs ─────────────────────────
run_legs() {
  # Producers use disjoint covdirs and run through a bounded scheduler. Each
  # leg's combined stdout/stderr is captured to its own file and printed
  # SEQUENTIALLY after the wait, so logs never interleave. Exit-code
  # semantics: the suggest leg is pass/fail-tolerated here because its tests
  # also gate in the residual job. The SDK (SDK_LEG_EXIT), harness-client
  # (HC_EXIT), ai-kit (AIKIT_EXIT), provider, API-client, and Worker legs gate. A
  # leg that dies without writing its
  # exit-code file counts as exit 1 for the gating legs (fail-closed).
  local legs="$TMPDIR/legs" running=0
  mkdir -p "$legs"

  await_leg_slot() {
    while [ "$running" -ge "$COVERAGE_LEG_MAX_JOBS" ]; do
      # Producers persist their result code. This wait only frees capacity;
      # the explicit verdict below still fails closed on every failed leg.
      wait -n || true
      running=$((running - 1))
    done
  }

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
  register_leg providers cov_providers
  register_leg api-client cov_api_client
  register_leg empty-node-shim cov_empty_node_shim
  register_leg worker cov_worker
  # Full local coverage needs the canonical Web Vitest receipt. CI publishes
  # the same producer from its existing three test-web shards, so it is never
  # registered in legs-only mode.
  if [ -z "$COVERAGE_LEGS_ONLY" ]; then
    register_leg web-vitest-full cov_vitest_full
  fi

  # Leg file lists come from lib/test-file-sets.sh (sdk_leg_files & co) —
  # ONE definition shared with the orphan-drift meta-test, so a leg's set
  # can never drift from what the meta-test credits it with running.

  # SDK: top-level test/ + co-located entities/__tests__/ (the canonical
  # coverage for entities/{validate,tools,storage,slug}.ts). mock.module-free,
  # so bundling preserves the 100% module-load instrumentation parity.
  # Pass/fail gates. SDK tests include runtime and rootless isolation contracts;
  # coverage output is not a substitute for their assertions passing.
  # DIR args are LOAD-BEARING: bun discovers test/ before entities/__tests__
  # here; feeding the same files as a sorted explicit list reorders entities
  # first and 12 entities tests fail (order-dependent state in the bundled
  # process — a latent coupling, documented not fixed). sdk_leg_files()
  # mirrors exactly these dirs for the drift meta-test's crediting.
  await_leg_slot
  (
    set +e
    bun test $TEST_TIMEOUT_FLAG --coverage --coverage-reporter=lcov --coverage-dir="${LEG_COV_DIR[sdk]}" \
      ./packages/@ezcorp/sdk/test/ ./packages/@ezcorp/sdk/src/entities/__tests__/ ./packages/@ezcorp/sdk/src/v4/ ./packages/@ezcorp/sdk/src/browser/ \
      > "$legs/sdk.out" 2>&1
    echo "$?" > "$legs/sdk.code"
  ) &
  running=$((running + 1))

  # harness-client — its own mock.module-free shard. Unlike the SDK leg above,
  # its pass/fail GATES: the event-name parity test + the route-table
  # meta-assertions in index.test.ts are part of the remote-control contract, so
  # a failure must red CI, not merely report. The real exit code lands in
  # HC_EXIT below (checked in the mode dispatch). Dir arg mirrored by
  # harness_client_leg_files() for the drift meta-test.
  await_leg_slot
  (
    set +e
    bun test $TEST_TIMEOUT_FLAG --coverage --coverage-reporter=lcov --coverage-dir="${LEG_COV_DIR[harness-client]}" \
      ./packages/@ezcorp/harness-client/ \
      > "$legs/hc.out" 2>&1
    echo "$?" > "$legs/hc.code"
  ) &
  running=$((running + 1))

  # Composer-suggest backend leg — dedicated bun-coverage shard feeding the
  # `src/suggest/**` + suggestion-feedback threshold keys. The host-shard set
  # (coverage_host_files) subtracts exactly this set; small isolated suites
  # also dodge Bun's large-suite attribution drift. Pass/fail is tolerated
  # like the SDK leg (thresholds are the gate); the suites are also
  # pass/fail-gated in P via the CI residual job.
  await_leg_slot
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
  running=$((running + 1))

  # ai-kit leg (wave 3): these 22 files previously ran ONLY at release time —
  # a rotted SKILL.md drift-guard assertion proved the gap. unit/ +
  # integration/ are deterministic (verified per-file AND bundled, no
  # Docker); e2e/ self-skips without EZCORP_E2E_BASE_URL. Pass/fail GATES
  # like the harness-client leg (AIKIT_EXIT) — deterministic package suites
  # have no instrumentation-flake excuse.
  await_leg_slot
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
  running=$((running + 1))

  # Providers are a Bun-only canonical producer: each suite runs in its own
  # process and the resulting lcov is filtered to src/providers/**.
  await_leg_slot
  (
    set +e
    COV_OUT="${LEG_COV_DIR[providers]}" bash "$SCRIPT_DIR/provider-coverage.sh"       > "$legs/providers.out" 2>&1
    echo "$?" > "$legs/providers.code"
  ) &
  running=$((running + 1))

  await_leg_slot
  (
    set +e
    COV_OUT="${LEG_COV_DIR[api-client]}" bash "$SCRIPT_DIR/api-client-coverage.sh" > "$legs/api-client.out" 2>&1
    echo "$?" > "$legs/api-client.code"
  ) &
  running=$((running + 1))

  # This tiny browser alias is intentionally measured by its direct Bun
  # contract: page CDP coverage cannot observe the audio Worker that imports
  # it. Its tagged receipt is canonical, so incidental browser or host imports
  # cannot borrow incompatible source-map counters.
  await_leg_slot
  (
    set +e
    COV_OUT="${LEG_COV_DIR[empty-node-shim]}" bash "$SCRIPT_DIR/empty-node-shim-coverage.sh" \
      > "$legs/empty-node-shim.out" 2>&1
    echo "$?" > "$legs/empty-node-shim.code"
  ) &
  running=$((running + 1))

  # Worker/index.ts has an HTTP-boundary suite that is its canonical source
  # of truth. Keep its filtered receipt separate from incidental host imports.
  await_leg_slot
  (
    set +e
    COV_OUT="${LEG_COV_DIR[worker]}" bash "$SCRIPT_DIR/worker-coverage.sh" \
      > "$legs/worker.out" 2>&1
    echo "$?" > "$legs/worker.code"
  ) &
  running=$((running + 1))

  if [ -z "$COVERAGE_LEGS_ONLY" ]; then
    await_leg_slot
    (
      set +e
      bash "$SCRIPT_DIR/web-vitest-coverage.sh" --output "${LEG_COV_DIR[web-vitest-full]}" \
        > "$legs/vitest-full.out" 2>&1
      echo "$?" > "$legs/vitest-full.code"
    ) &
    running=$((running + 1))
  fi

  wait

  # Print each leg's captured output sequentially (no interleaving), then
  # tally + collect exit codes with the pre-parallel gating semantics.
  local leg
  local printed_legs=(sdk hc suggest aikit providers api-client empty-node-shim worker)
  if [ -z "$COVERAGE_LEGS_ONLY" ]; then printed_legs+=(vitest-full); fi
  for leg in "${printed_legs[@]}"; do
    echo ""
    echo "── leg output: $leg ──"
    cat "$legs/$leg.out" 2>/dev/null || echo "(no output captured)"
  done
  # Tally the bun legs (as before the parallelisation; the vitest
  # summary format never matched the bun "N pass" parser).
  for leg in sdk hc suggest aikit; do
    tally "$(cat "$legs/$leg.out" 2>/dev/null)"
  done

  SDK_LEG_EXIT=$(cat "$legs/sdk.code" 2>/dev/null || echo 1)
  if [ "$SDK_LEG_EXIT" != "0" ]; then
    FAILED_FILES+=("sdk coverage leg")
    echo "--- FAIL: sdk coverage leg (exit $SDK_LEG_EXIT) ---"
  fi

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

  PROVIDER_EXIT=$(cat "$legs/providers.code" 2>/dev/null || echo 1)
  if [ "$PROVIDER_EXIT" != "0" ]; then
    FAILED_FILES+=("provider coverage leg")
    echo "--- FAIL: provider coverage leg (exit $PROVIDER_EXIT) ---"
  fi

  API_CLIENT_EXIT=$(cat "$legs/api-client.code" 2>/dev/null || echo 1)
  if [ "$API_CLIENT_EXIT" != "0" ]; then
    FAILED_FILES+=("api client coverage leg")
    echo "--- FAIL: api client coverage leg (exit $API_CLIENT_EXIT) ---"
  fi

  EMPTY_NODE_SHIM_EXIT=$(cat "$legs/empty-node-shim.code" 2>/dev/null || echo 1)
  if [ "$EMPTY_NODE_SHIM_EXIT" != "0" ]; then
    FAILED_FILES+=("empty Node shim coverage leg")
    echo "--- FAIL: empty Node shim coverage leg (exit $EMPTY_NODE_SHIM_EXIT) ---"
  fi

  WORKER_EXIT=$(cat "$legs/worker.code" 2>/dev/null || echo 1)
  if [ "$WORKER_EXIT" != "0" ]; then
    FAILED_FILES+=("worker coverage leg")
    echo "--- FAIL: worker coverage leg (exit $WORKER_EXIT) ---"
  fi

  # The suggest leg is pass/fail-gated by the residual job. Keep its local
  # tolerance visible instead of silently discarding the written exit code.
  SUGGEST_LEG_EXIT=$(cat "$legs/suggest.code" 2>/dev/null || echo "?")
  echo "tolerated leg exit code (not gated here): suggest=$SUGGEST_LEG_EXIT"

  if [ -z "$COVERAGE_LEGS_ONLY" ]; then
    FULL_VITEST_EXIT=$(cat "$legs/vitest-full.code" 2>/dev/null || echo 1)
    if [ "$FULL_VITEST_EXIT" != "0" ]; then
      FAILED_FILES+=("web full-vitest coverage leg")
      echo "--- FAIL: web full-vitest coverage leg (exit $FULL_VITEST_EXIT) ---"
    fi
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

# Browser routes are canonical only after their broad exclusion is removed.
# A full backend run must then consume a receipt produced from this exact HEAD;
# it never launches another browser suite. Re-converting the raw CDP ranges and
# comparing LCOV makes a hand-written or stale report fail before the merge.
browser_route_coverage_required() {
	bun -e 'import { isExcluded } from "./scripts/coverage-config.ts"; process.exit(isExcluded("web/src/routes/+page.svelte") ? 1 : 0)'
}

verify_browser_coverage_receipt() {
	register_leg browser cov_browser
	if [ -z "${BROWSER_COVERAGE_RAW:-}" ] || [ -z "${BROWSER_COVERAGE_LCOV:-}" ]; then
		echo "::error::browser route coverage is required: set BROWSER_COVERAGE_RAW and BROWSER_COVERAGE_LCOV" >&2
		return 1
	fi
	if [ ! -s "$BROWSER_COVERAGE_RAW" ] || [ ! -s "$BROWSER_COVERAGE_LCOV" ]; then
		echo "::error::browser route coverage receipt is missing or empty" >&2
		return 1
	fi
	local regenerated="$TMPDIR/browser-recomputed.lcov"
	bun scripts/verify-browser-coverage-receipt.ts "$BROWSER_COVERAGE_RAW" "$BROWSER_COVERAGE_LCOV" || return 1
	bun scripts/browser-coverage-to-lcov.ts "$BROWSER_COVERAGE_RAW" "$regenerated" || return 1
	mkdir -p "${LEG_COV_DIR[browser]}"
	cp "$regenerated" "${LEG_COV_DIR[browser]}/lcov.info"
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
  # historically pass/fail-tolerated legs: a gating leg that dies also reds
  # via its exit code below, but a tolerated one used to exit 0 with no
  # lcov — cov-extras went green, the `Per-file coverage gate` job then merged
  # an artifact silently missing that leg's files, and blamed the PR with one
  # "listed in thresholds but no lcov data" violation per orphaned file.
  LEG_LCOV_EXIT=0
  check_leg_lcov || LEG_LCOV_EXIT=1
  emit_lcov
  echo "  ${TOTAL_PASS} pass | ${TOTAL_FAIL} fail | legs"
  # The SDK (SDK_LEG_EXIT), harness-client (HC_EXIT), ai-kit (AIKIT_EXIT) and
  # provider, API-client, and Worker legs GATE here. Suggest stays pass/fail-tolerant
  # because it also gates via the residual job. A MISSING LCOV gates for every
  # leg regardless: pass/fail tolerance
  # is about assertions, never about a producer that didn't produce. This is
  # the exit status the cov-extras CI job reports.
  if [ "$SDK_LEG_EXIT" != "0" ]; then
    echo "::error::sdk coverage leg failed (exit $SDK_LEG_EXIT)"
    exit 1
  fi
  if [ "$HC_EXIT" != "0" ] || [ "$AIKIT_EXIT" != "0" ] || \
     [ "$PROVIDER_EXIT" != "0" ] || [ "$API_CLIENT_EXIT" != "0" ] || [ "$WORKER_EXIT" != "0" ] || [ "$LEG_LCOV_EXIT" != "0" ]; then exit 1; fi
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
    # Print the pooled failure before either recovery path can hide it. A clean
    # instrumented or plain retry may tolerate the flake, but its first error
    # is the only evidence needed to diagnose the original CI failure.
    echo ""
    echo "--- pooled coverage failure: ${FILES[$i]} (exit $CODE) ---"
    if [ -n "$OUTPUT" ]; then
      printf '%s\n' "$OUTPUT"
    else
      echo "(no pooled output captured)"
    fi
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
run_legs
# Security is deliberately outside run_legs' PID accounting. Start it only
# after that bounded pool has drained so `wait -n` cannot reap an uncounted
# child and admit a fourth coverage producer.
run_security_leg
wait
collect_security_leg
if browser_route_coverage_required; then
	verify_browser_coverage_receipt || BROWSER_RECEIPT_EXIT=1
fi

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

# Full local coverage must fail before the aggregate gate when V8 omitted one
# executable shared library source. CI runs this same guard after merging its
# three existing Web tests shard artifacts; it is deliberately absent from
# legs-only mode because cov-extras does not own that producer.
bun scripts/check-web-vitest-coverage.ts "${LEG_COV_DIR[web-vitest-full]}/lcov.info" || WEB_VITEST_SOURCE_GUARD_EXIT=1

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
if [ "$CHECK_EXIT" != "0" ] || [ "$SDK_LEG_EXIT" != "0" ] || [ "$FULL_VITEST_EXIT" != "0" ] || [ "$WEB_VITEST_SOURCE_GUARD_EXIT" != "0" ] || [ "$BROWSER_RECEIPT_EXIT" != "0" ] || [ "$HC_EXIT" != "0" ] || \
   [ "$AIKIT_EXIT" != "0" ] || [ "$PROVIDER_EXIT" != "0" ] || [ "$API_CLIENT_EXIT" != "0" ] || [ "$WORKER_EXIT" != "0" ] || [ "$SECURITY_EXIT" != "0" ]; then
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
  echo "  COVERAGE: FAILED (check=$CHECK_EXIT sdk=$SDK_LEG_EXIT vitest_full=$FULL_VITEST_EXIT vitest_sources=$WEB_VITEST_SOURCE_GUARD_EXIT browser_receipt=$BROWSER_RECEIPT_EXIT harness-client=$HC_EXIT ai-kit=$AIKIT_EXIT providers=$PROVIDER_EXIT worker=$WORKER_EXIT security=$SECURITY_EXIT)"
else
  echo "  COVERAGE: passed"
fi
echo "  tolerated (not gated here): suggest=$SUGGEST_LEG_EXIT leg exit code; host files outside P"
echo "================================"

if [ "$COVERAGE_FAILED" != "0" ]; then exit 1; fi
if [ "${#STILL_FAILED[@]}" -gt 0 ]; then
  echo "exit $EXIT_TESTS_FAILED — coverage gate passed, but TESTS FAILED. Do not read this run as a green suite."
  exit "$EXIT_TESTS_FAILED"
fi
exit 0
