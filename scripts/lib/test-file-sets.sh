#!/usr/bin/env bash
# Shared test-file-set definitions — sourced by scripts/test.sh (pass/fail),
# scripts/test-coverage.sh (coverage), and the CI shard runner so the two sets
# can never drift apart. Each function prints one repo-relative path per line,
# sorted + de-duplicated. Run from the repo root.
#
# Two sets are defined:
#   P (passfail_files)      — the per-file mock.module-isolated backend pool
#                             that CI gates pass/fail on.
#   C (coverage_host_files) — the per-file --coverage pool. It EXCLUDES the
#                             *integration* variants (they load several real
#                             modules whose DA line-set floats the denominator
#                             and false-drops unit-measured files — Bun's
#                             per-line attribution drift) and ADDS the example
#                             suites, the reverse-RPC entry-point shard, and the
#                             scoped web search-helper bun:test files.
#
# The set difference is small and intentional:
#   P \ C = the 4 *integration* files (gated for pass/fail, not for coverage).
#   C \ P = the example suites + a few coverage-only shards (measured for
#           coverage; the example e2e cases fail-by-timeout without Docker, so
#           they are NEVER pass/fail-gated — see the host-shard classifier in
#           test-coverage.sh, which gates pass/fail on P-membership only).

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
    find src/__tests__ -name "*.test.ts"
    # import-wizard endpoint tests live beside their SvelteKit routes (bun:test).
    find web/src/routes/api/import -name "*.test.ts"
    # github-projects integration: unit + integration both run for pass/fail.
    find src/integrations/github-projects/__tests__ -name "*.test.ts"
    find src/extensions/__tests__ -name "github-projects-handler*.test.ts"
    find web/src/routes/api/integrations/github-projects/__tests__ -name "*.test.ts"
    # extension-secrets store + web entry-route tests.
    find src/extensions/__tests__ -name "secrets-*.test.ts"
    find web/src/routes/api/extensions/__tests__ -name "*.test.ts"
    # extension-RBAC grants API route tests.
    find web/src/routes/api/rbac/__tests__ -name "*.test.ts"
  } 2>/dev/null | sort -u
}

# C — the coverage host set (per-file --coverage). See header for the
# include/exclude rationale.
coverage_host_files() {
  {
    # See passfail_files: scoped `set +e` so a missing dir doesn't silently
    # truncate the list under the callers' `set -e`.
    set +e
    find src/__tests__ -name "*.test.ts"
    find docs/extensions/examples -name "*.test.ts"
    find web/src/routes/api/import -name "*.test.ts"
    # *integration* excluded on purpose (Bun attribution drift); they still run
    # for correctness via passfail_files / the CI residual job.
    find src/integrations/github-projects/__tests__ -name "*.test.ts" ! -name "*integration*"
    find src/extensions/__tests__ -name "github-projects-handler*.test.ts" ! -name "*integration*"
    # reverse-RPC entry point lives on ToolExecutor, isolated shard.
    find src/extensions/__tests__ -name "tool-executor.github-projects-rpc.test.ts"
    # ezcorp/rbac-check reverse-RPC entry point (ctx.rbac.check host side) —
    # same isolated-shard rationale as the github-projects shard above.
    find src/extensions/__tests__ -name "tool-executor.rbac-rpc.test.ts"
    find web/src/routes/api/integrations/github-projects/__tests__ -name "*.test.ts"
    find src/extensions/__tests__ -name "secrets-*.test.ts" ! -name "*integration*"
    find web/src/routes/api/extensions/__tests__ -name "*.test.ts"
    # extension-RBAC grants API route tests (coverage for the two rbac
    # +server.ts files pinned at 100 in coverage-thresholds.json).
    find web/src/routes/api/rbac/__tests__ -name "*.test.ts"
    # Scoped web search-helper + route-contract bun:test files. SCOPED on
    # purpose — widening to the whole web/src/__tests__ dir transitively imports
    # dozens of unrelated modules whose zero-hit DA records inflate the
    # denominator on files already pinned at 100%.
    # permission-mode-indicator: the github-projects route tests import
    # $lib/permission-mode (constants only), landing it in the merged lcov at
    # 25% — this suite exercises the functions so the union clears web/src/lib/**.
    printf '%s\n' \
      web/src/__tests__/snippet-sanitize.test.ts \
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
      web/src/__tests__/route-contract.test.ts
  } 2>/dev/null | sort -u
}

# Residual pass/fail files: in P but NOT in C (the *integration* variants that
# coverage excludes). These must still run for pass/fail somewhere — the CI
# `residual-tests` job runs exactly this set (empty is fine: prints nothing).
residual_passfail_files() {
  comm -23 <(passfail_files) <(coverage_host_files)
}

# Select a 1-of-N stride slice of stdin (sorted file list) for CI sharding.
# Usage: some_files | shard_slice "$SHARD_INDEX" "$SHARD_TOTAL"
# Stride (i % total == index) balances cost better than contiguous blocks:
# adjacent files (same dir) tend to have similar runtime, so round-robin keeps
# the slow suites spread across shards instead of clustered in one.
shard_slice() {
  local index="$1" total="$2"
  awk -v idx="$index" -v tot="$total" 'NR % tot == idx'
}
