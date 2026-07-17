#!/usr/bin/env bash
# Shared test-file-set definitions — sourced by scripts/test.sh (pass/fail),
# scripts/test-coverage.sh (coverage), and the CI shard runner so the two sets
# can never drift apart. Each function prints one repo-relative path per line,
# sorted + de-duplicated. Run from the repo root.
#
# Also home to the shared pool-runner helpers so the pool mechanics can't
# drift between the per-file isolation runners: default_parallel is used by
# all four (test.sh, test-web.sh, test-coverage.sh, security-coverage.sh);
# summary_count by the three that parse bun summaries; collect_pool_results
# by test.sh + test-web.sh (test-coverage.sh has its own P-gate collection).
#
# Two sets are defined:
#   P (passfail_files)      — the per-file mock.module-isolated backend pool
#                             that CI gates pass/fail on. A FULL `src` SWEEP
#                             (wave 3): every src/**/*.test.ts is pass/fail-
#                             gated somewhere — shards for P∩C, the residual
#                             job for P\C.
#   C (coverage_host_files) — the per-file --coverage pool. The same `src`
#                             sweep minus NAMED exclusions (documented at the
#                             find): the github-projects/extensions
#                             *integration* variants (they load several real
#                             modules whose DA line-set floats the denominator
#                             and false-drops unit-measured files — Bun's
#                             per-line attribution drift) and the cov-extras
#                             suggest-leg files (dedicated coverage home). It
#                             ADDS the example suites and the scoped web
#                             search-helper bun:test files.
#
# The set difference is small and intentional:
#   P \ C = the excluded *integration* variants + the suggest-leg files +
#           route-contract.test.ts (the remote-control governance meta-test).
#           These are gated for pass/fail — via the CI `residual-tests` job
#           (RESIDUAL_ONLY=1 → residual_passfail_files → test.sh, real exit
#           code) — but not coverage-measured in the host pool (the suggest
#           leg measures its own files; the rest are excluded from C on
#           purpose). (P∩C files hard-gate INSIDE the coverage shards via
#           test-coverage.sh's P-membership gate + isolated retry sweep; P\C
#           files are the ones the shards never run, so the residual job is
#           their only pass/fail home.)
#   C \ P = the example suites + the scoped web bun:test files (measured for
#           coverage; the example e2e cases fail-by-timeout without Docker, so
#           they are NEVER pass/fail-gated — see the host-shard classifier in
#           test-coverage.sh, which gates pass/fail on P-membership only).
#
# Also defined: the cov-extras LEG sets (suggest / sdk / harness-client /
# ai-kit) — the exact file lists scripts/test-coverage.sh's run_legs executes.
# They live here so the runner and the orphan-drift meta-test
# (src/__tests__/ci-test-set-drift.test.ts) consume ONE definition each and
# can never drift apart.

# P — the pass/fail set.
passfail_files() {
  {
    # `set +e` is essential: the callers run under `set -e`, and a find against
    # a not-yet-created dir (e.g. a feature branch's integration tree) exits
    # non-zero. Without this, the FIRST failing find aborts the whole group
    # subshell SILENTLY (the pipe still exits 0 via sort), truncating every
    # later find + the printf list — a silent test-set loss. The group is the
    # left side of a pipe, so this set +e is scoped to the subshell only.
    set +e
    # FULL src sweep — no exclusions. Wave 3 replaced the old dir allowlist
    # (src/__tests__ + github-projects + secrets-*): 36 deterministic files
    # (extension handlers/provenance/db-isolation, db queries, ez-actions)
    # ran in NO CI job, and two had silently rotted failing assertions. All
    # 36 were verified deterministic (plain per-file run, no Docker/env), so
    # per the header rules the whole tree belongs in P. A genuinely
    # env-dependent future suite must be excluded HERE by name, with its
    # reason — never by silently shrinking back to a dir allowlist.
    find src -name "*.test.ts"
    # import-wizard endpoint tests live beside their SvelteKit routes (bun:test).
    find web/src/routes/api/import -name "*.test.ts"
    # github-projects web route tests.
    find web/src/routes/api/integrations/github-projects/__tests__ -name "*.test.ts"
    # extension web entry-route tests.
    find web/src/routes/api/extensions/__tests__ -name "*.test.ts"
    # extension-RBAC grants API route tests.
    find web/src/routes/api/rbac/__tests__ -name "*.test.ts"
    # Remote-control route-contract governance meta-test — a HARD pass/fail gate
    # (a failing assertion must RED CI, not merely advise). It lives ONLY in P,
    # deliberately kept OUT of the coverage set C below: the set difference P\C
    # lands it in the CI `residual-tests` job, whose `test.sh` run propagates a
    # real exit code with NO --coverage instrumentation and NO retry-sweep
    # flake tolerance (a C∩P file would also hard-gate inside the coverage
    # shards now, but instrumented + one-retry-tolerant — plain residual
    # gating is strictly stronger for this meta-test). It covers only the
    # already-pinned harness-client route table + the unpinned api-registry, so
    # excluding it from C loses no threshold-gated coverage. test.sh's
    # RESIDUAL_ONLY mode asserts this file's presence in P\C, so membership
    # drift (rename / C absorbing it) fails loudly instead of de-gating.
    printf '%s\n' web/src/__tests__/route-contract.test.ts
  } 2>/dev/null | sort -u
}

# C — the coverage host set (per-file --coverage). See header for the
# include/exclude rationale.
coverage_host_files() {
  {
    # See passfail_files: scoped `set +e` so a missing dir doesn't silently
    # truncate the list under the callers' `set -e`.
    set +e
    # src sweep with NAMED exclusions (wave 3 — was a dir allowlist that
    # orphaned 36 files from every CI job):
    #   - *integration* variants in the github-projects + extensions test
    #     dirs: they load several real modules whose DA line-set floats the
    #     denominator (Bun per-line attribution drift). src/__tests__'s own
    #     *integration* files are NOT excluded — they were always part of
    #     this pool and their coverage is load-bearing. Excluded files stay
    #     pass/fail-gated via P (the residual job).
    #   - the suggest-leg files (comm -23 below): their coverage home is the
    #     dedicated cov-extras suggest leg (suggest_leg_files — small
    #     isolated shard dodging the same attribution drift); sweeping them
    #     here too would double-measure. Pass/fail-gated via P (residual).
    find src -name "*.test.ts" \
      ! \( -path "src/extensions/__tests__/*" -name "*integration*" \) \
      ! \( -path "src/integrations/github-projects/__tests__/*" -name "*integration*" \)
    find docs/extensions/examples -name "*.test.ts"
    find web/src/routes/api/import -name "*.test.ts"
    find web/src/routes/api/integrations/github-projects/__tests__ -name "*.test.ts"
    find web/src/routes/api/extensions/__tests__ -name "*.test.ts"
    # extension-RBAC grants API route tests (coverage for the two rbac
    # +server.ts files pinned at 100 in coverage-thresholds.json).
    find web/src/routes/api/rbac/__tests__ -name "*.test.ts"
    # Scoped web search-helper bun:test files. SCOPED on purpose — widening to
    # the whole web/src/__tests__ dir transitively imports dozens of unrelated
    # modules whose zero-hit DA records inflate the denominator on files already
    # pinned at 100%. NOTE: route-contract.test.ts is intentionally NOT in this
    # coverage set — it is a HARD pass/fail gate in P (see passfail_files); it
    # covers only the already-pinned harness-client route table + the unpinned
    # api-registry, so measuring it here would add no threshold-gated coverage.
    # permission-mode-indicator: the github-projects route tests import
    # $lib/permission-mode (constants only), landing it in the merged lcov at
    # 25% — this suite exercises the functions so the union clears web/src/lib/**.
    printf '%s\n' \
      web/src/__tests__/snippet-sanitize.test.ts \
      web/src/__tests__/workflow-builder-logic.test.ts \
      web/src/lib/__tests__/rbac-grants-view.test.ts \
      web/src/__tests__/permission-mode-indicator.test.ts \
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
      web/src/__tests__/extensions-events-route.test.ts
    # The suggest-leg files are subtracted below — ONE definition
    # (suggest_leg_files) serves both this exclusion and the runner.
  } 2>/dev/null | sort -u | comm -23 - <(suggest_leg_files)
}

# ── cov-extras leg sets ─────────────────────────────────────────────────────
# The file lists scripts/test-coverage.sh's run_legs executes (each leg is ONE
# bun/vitest process — mock.module-free suites where bundling preserves
# module-load instrumentation parity). Defined here so the runner and the
# orphan-drift meta-test share a single source of truth.

# Composer-suggest backend leg — dedicated bun-coverage shard feeding the
# `src/suggest/**` + suggestion-feedback threshold keys. Deliberately NOT in
# the host pool (coverage_host_files subtracts this set): the small isolated
# shard dodges Bun's large-suite attribution drift.
suggest_leg_files() {
  {
    set +e
    find src/suggest/__tests__ -name "*.test.ts"
    printf '%s\n' \
      src/db/queries/__tests__/suggestion-feedback.test.ts \
      src/db/queries/__tests__/settings-jsonb-roundtrip.test.ts
  } 2>/dev/null | sort -u
}

# SDK leg: top-level test/ + co-located entities/__tests__/ (the canonical
# coverage for entities/{validate,tools,storage,slug}.ts).
sdk_leg_files() {
  {
    set +e
    find packages/@ezcorp/sdk/test packages/@ezcorp/sdk/src/entities/__tests__ -name "*.test.ts"
  } 2>/dev/null | sort -u
}

# harness-client leg — pass/fail GATES in cov-extras (remote-control contract).
harness_client_leg_files() {
  {
    set +e
    find packages/@ezcorp/harness-client -name "*.test.ts" ! -path "*/node_modules/*"
  } 2>/dev/null | sort -u
}

# ai-kit leg (wave 3): previously these 22 files ran ONLY at release time —
# a rotted SKILL.md drift-guard assertion proved it. unit/ + integration/ are
# deterministic (verified plain, no Docker); the e2e/ files self-skip without
# EZCORP_E2E_BASE_URL (opt-in guard), so they no-op in CI rather than flake.
aikit_leg_files() {
  {
    set +e
    find packages/@ezcorp/ai-kit/test -name "*.test.ts"
  } 2>/dev/null | sort -u
}

# Residual pass/fail files: in P but NOT in C (the *integration* variants that
# coverage excludes). These must still run for pass/fail somewhere — the CI
# `residual-tests` job runs exactly this set (empty is fine: prints nothing).
residual_passfail_files() {
  comm -23 <(passfail_files) <(coverage_host_files)
}

# W — the orphaned web bun-leg set. Plain `web/src/**/*.test.ts` files that are
# NOT matched by vitest's globs (*.component/*.server/*.unit.test.ts, plus the
# one explicitly-listed relative-time.test.ts) AND are not already run for
# pass/fail or coverage by the backend pool (the import/gh-projects/extensions/
# rbac route tests + the scoped web bun:test files in coverage_host_files).
# These ~225 files ran in NO CI job before `web-bun-tests` — silent test-rot.
# The CI `web-bun-tests` job runs exactly this set (per-file isolated, with
# real exit-code capture) via scripts/test-web.sh.
web_bunleg_files() {
  {
    set +e
    # All plain web bun-leg *.test.ts — vitest owns the three suffixes below,
    # so exclude them here (they run in the `Web tests (vitest)` job).
    find web/src -name "*.test.ts" \
      ! -name "*.component.test.ts" \
      ! -name "*.server.test.ts" \
      ! -name "*.unit.test.ts"
  } 2>/dev/null | sort -u | comm -23 - <(
    # Files already run elsewhere: vitest's explicitly-listed
    # relative-time.test.ts + every bun-leg file the coverage/passfail sets
    # already gate. Non-web entries in those sets simply never match a
    # web/src path, so they're harmless here.
    {
      set +e
      printf '%s\n' web/src/__tests__/relative-time.test.ts
      passfail_files
      coverage_host_files
    } 2>/dev/null | sort -u
  )
}

# SEC — the orphaned web security bun:test suites (web/src/__tests__/security/*).
# Their source files use per-`beforeEach` `mock.module` (bun-only), so they run
# under bun, not vitest. Run for pass/fail by `web-bun-tests` (they're a subset
# of web_bunleg_files) and, separately, under `bun --coverage` by
# scripts/security-coverage.sh to feed the 9 un-excluded security source files
# into the coverage gate.
security_test_files() {
  {
    set +e
    find web/src/__tests__/security -name "*.test.ts"
  } 2>/dev/null | sort -u
}

# CRIT — a CURATED set of high-value, deterministic correctness suites gated on
# PASS/FAIL by the CI `backend-critical` job (via scripts/test.sh's CRITICAL_ONLY
# mode). Unlike the coverage shards (which TOLERATE test pass/fail because several
# backend suites are env-flaky under --coverage), this set runs PLAIN (no
# --coverage) and REDS CI on any assertion failure — a real backend correctness
# gate for the security-critical seams. Membership is deliberately narrow:
# security/authz/migration/concurrency invariants that are deterministic under
# per-file isolation. See the ci-test-gating change for the determinism check.
critical_backend_files() {
  {
    set +e
    # RBAC: permission engine + audit/override/fail-closed variants, the
    # extension-rbac resolver, and the ctx.rbac.check reverse-RPC entry point.
    find src/__tests__ -name "permission-engine*.test.ts"
    find src/__tests__ -name "extension-rbac-resolver*.test.ts"
    find src/extensions/__tests__ -name "tool-executor.rbac*.test.ts"
    # Migrations: idempotency + the db-scoped migration suites (safe-migration
    # invariant — re-running migrate() must be a no-op).
    find src/__tests__ -name "migrate-idempotency*.test.ts"
    find src/__tests__ -name "db-*migrat*.test.ts"
    # github-projects concurrency: the partial-unique single-active-per-card
    # queries + the poll-loop daemon (dedupe / re-trigger correctness).
    find src/integrations/github-projects/__tests__ -name "queries*.test.ts"
    find src/integrations/github-projects/__tests__ -name "daemon*.test.ts"
    # Auth + provider-secret encryption + extension-secrets store.
    find src/__tests__ -name "auth-*.test.ts"
    find src/__tests__ -name "provider-encryption*.test.ts"
    find src/extensions/__tests__ -name "secrets-*.test.ts"
    # Server-side mention expansion (slash-command / feature / lesson / agent).
    find src/__tests__ -name "mention-wiring*.test.ts"
  } 2>/dev/null | sort -u
}

# Select a 1-of-N slice of stdin (sorted file list) for CI sharding.
# Usage: some_files | shard_slice "$SHARD_INDEX" "$SHARD_TOTAL"
# Wave 3: greedy LPT over the measured per-file durations in
# scripts/shard-timings.json (see scripts/shard-plan.ts — deterministic:
# sorted input, weight-desc/path-asc ordering, lowest-index tie-break;
# unknown files weigh the median). The old stride slice overloaded shards
# 1+3 by ~35-40s. Fallback layers, both deterministic and never empty:
#   - missing/unparseable/empty manifest → stride INSIDE shard-plan.ts;
#   - bun itself crashing → bash stride below (the input is buffered so it
#     can be replayed).
shard_slice() {
  local index="$1" total="$2"
  local input out
  input=$(cat)
  if out=$(printf '%s\n' "$input" | bun scripts/shard-plan.ts "$index" "$total"); then
    # Guard the empty slice: `printf '%s\n' ""` would emit one EMPTY line,
    # which mapfile callers would read as a phantom file.
    [ -n "$out" ] && printf '%s\n' "$out"
  else
    echo "shard_slice: bun planner failed — stride fallback" >&2
    printf '%s\n' "$input" | awk -v idx="$index" -v tot="$total" 'NR % tot == idx'
  fi
  return 0
}

# ── shared pool-runner helpers ──────────────────────────────────────────────

# Default pool width: 6, capped at the machine's core count. Six concurrent
# bun+PGlite processes on a 2-core CI runner starve each other into hook/test
# timeouts (mass '(unnamed) [10s]' failures). Callers use
# PARALLEL=${PARALLEL:-$(default_parallel)} so an explicit PARALLEL overrides.
default_parallel() {
  local cores
  cores=$(nproc 2>/dev/null || echo 6)
  echo $(( cores < 6 ? cores : 6 ))
}

# Extract the last "N pass" / "N fail" count from a bun test summary.
# Usage: summary_count "$OUTPUT" pass|fail — prints nothing when no summary
# was printed (module-load error, crash, SIGKILL); callers default with :-0.
summary_count() {
  local output="$1" word="$2"
  echo "$output" | awk -v w="$word" \
    '$0 ~ w {for(j=1;j<=NF;j++) if($j ~ /^[0-9]+$/ && $(j+1)==w) print $j}' | tail -1
}

# Collect the per-file pool results written by the run loops into
# $TMPDIR/result_$i + $TMPDIR/code_$i. Takes the NAME of the file-list array;
# updates the caller's TOTAL_PASS / TOTAL_FAIL / FAILED_FILES and prints a
# per-file failure block (the "(fail)" lines, or the output tail when a file
# errored at load / was killed).
#
# A MISSING result/code file is a FAILURE, never a skip: an OOM/SIGKILL-ed
# subshell writes neither file, and `continue`-ing past it silently green-lit
# a killed shard. It is recorded as CODE=1 with reason
# "no result recorded (killed?)" so it is always counted and listed.
collect_pool_results() {
  local -n _cp_files=$1
  local i OUTFILE OUTPUT CODE PASS FAIL DETAIL
  for ((i=0; i<${#_cp_files[@]}; i++)); do
    OUTFILE="$TMPDIR/result_$i"
    if [ -f "$OUTFILE" ]; then
      OUTPUT=$(cat "$OUTFILE")
      CODE=$(cat "$TMPDIR/code_$i" 2>/dev/null || echo 1)
    else
      OUTPUT="no result recorded (killed?) — the subshell wrote no output/exit-code file"
      CODE=1
    fi

    PASS=$(summary_count "$OUTPUT" pass)
    FAIL=$(summary_count "$OUTPUT" fail)

    TOTAL_PASS=$((TOTAL_PASS + ${PASS:-0}))
    # Count at least one failure when bun exited non-zero but printed no
    # parseable "N fail" (module-load error, crash, or kill with no summary).
    if [ "$CODE" != "0" ] && [ "${FAIL:-0}" = "0" ]; then
      FAIL=1
    fi
    TOTAL_FAIL=$((TOTAL_FAIL + ${FAIL:-0}))

    # A file is failing if bun exited non-zero OR the summary reported failures.
    if [ "$CODE" != "0" ] || [ "${FAIL:-0}" != "0" ]; then
      FAILED_FILES+=("${_cp_files[$i]}")
      echo "--- FAIL: ${_cp_files[$i]} ---"
      DETAIL=$(echo "$OUTPUT" | awk '/\(fail\)/')
      if [ -n "$DETAIL" ]; then
        echo "$DETAIL"
      else
        # No per-test "(fail)" line — the file errored at load or was killed.
        # Surface the tail of its output so CI failures are diagnosable instead
        # of printing an empty header (the historical false-positive symptom).
        echo "  (no per-test failures parsed; exit code $CODE — showing output tail)"
        echo "$OUTPUT" | tail -20 | sed 's/^/  /'
      fi
      echo ""
    fi
  done
}
