#!/usr/bin/env bash
# Run the PR CI gates locally, in roughly the same order CI does, with a
# single PASS/FAIL summary at the end. This runs the source checks, test pools,
# coverage, and Chromium browser lanes. Separate CI jobs also check the
# production image, kernel controls, Firefox/WebKit, secrets, dependencies,
# and external Postgres. Those jobs and the GitHub review rules must be
# checked separately before claiming complete CI validation.
#
# Usage:
#   bash scripts/ci-local.sh           # local suite (coverage + gated e2e)
#   bash scripts/ci-local.sh --fast    # pre-push sanity (~5 min: skips
#                                      # coverage merge/gates + playwright)
#   BASE_REF=origin/main               # diff base for the diff-scoped gates
#                                      # (gate-integrity, visual-evidence,
#                                      # new-file/patch coverage). Default
#                                      # origin/main — matches CI.
#
# Worktree caveat (historical): `biome check .` used to resolve 0 files in an
# agent worktree, because a `!**/<segment>` ignore glob matched a component of
# the worktree's own absolute path. `bun run lint` now passes EXPLICIT paths,
# which is immune to that; the Lint step still refuses to pass vacuously if
# biome ever reports zero files again.
#
# Flake caveat: the "Backend + example tests" step is `bun run test`, whose
# full pool includes a few timing/env-sensitive suites that CI runs under
# the tolerant sharded jobs (thresholds are the real backend gate there).
# If that step fails on files you did not touch, re-run the named file
# solo and compare against a clean main checkout before treating it as
# your regression — smoke-run precedent: mock-cleanup-coverage,
# chat-memory-e2e, agent-configs rate-limit.
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# Shared with .githooks/* so the biome worktree vacuous-pass guard lives in one
# place (see scripts/lib/hook-lib.sh).
. "$HERE/lib/hook-lib.sh"

BASE_REF=${BASE_REF:-origin/main}
FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

RESULTS=()
FAILED=0

run_step() {
  local name="$1"
  shift
  echo ""
  echo "════════════════════════════════════════════════════════════"
  echo "══ $name"
  echo "════════════════════════════════════════════════════════════"
  local start=$SECONDS
  if "$@"; then
    RESULTS+=("PASS  ${name}  ($((SECONDS - start))s)")
  else
    RESULTS+=("FAIL  ${name}  ($((SECONDS - start))s)")
    FAILED=1
  fi
}

lint_step() {
  # Vacuous-pass guard for worktrees (see header). run_biome_full does the
  # single biome run + classification (shared with the hooks); ci-local's
  # policy is to FAIL the vacuous case so you re-run from a primary checkout.
  run_biome_full
  local rc=$?
  if [ "$rc" = "2" ]; then
    echo "biome resolved 0 files — you are likely in a git worktree; lint explicit paths or run from the primary checkout."
    return 1
  fi
  return "$rc"
}

git fetch origin main --quiet 2>/dev/null || true

# ── Fast, always-on gates (mirror the cheap CI jobs) ────────────────────────
run_step "Typecheck" bun run typecheck
run_step "Lint (biome)" lint_step
run_step "Dependency boundaries" bun scripts/check-boundaries.ts
run_step "Gate integrity (vs $BASE_REF)" env BASE_REF="$BASE_REF" bun scripts/gate-integrity.ts
run_step "Visual evidence (vs $BASE_REF)" env BASE_REF="$BASE_REF" bun scripts/check-visual-evidence.ts
run_step "Manifest lockfile drift" bun run scripts/regenerate-manifest-lock.ts --check
run_step "Route contract" bash -c 'cd web && bun test ./src/__tests__/route-contract.test.ts'
# The orphaned Bun pool is disjoint from the Vitest producer and from the
# coverage host set (see web_bunleg_files in test-file-sets.sh). Keep it in
# both modes: browser/Vitest coverage cannot prove these Bun-only tests.
run_step "Web tests (bun-leg orphans)" bash scripts/test-web.sh
run_step "Svelte check" bash -c 'cd web && bun run check'
run_step "Backend + example tests (pass/fail pool)" bun run test

# Fast mode intentionally stays coverage-free. The full path below runs the
# same Vitest suite under Node/V8 and builds the mapped browser artifact once.
if [ "$FAST" = "1" ]; then
  # Vitest coverage runs in Node because coverage-v8 needs node:inspector.
  # Keep the fast component/server check on that runtime so a Bun-only pass
  # cannot hide a Node failure in the coverage producer.
  run_step "Web tests (vitest, Node)" bash -c 'cd web && npx vitest run'
  run_step "Web production build" bash -c 'cd web && bun run build'
fi

# ── Heavy gates (coverage merge + thresholds + diff gates + e2e) ────────────
if [ "$FAST" = "0" ]; then
  # Route coverage is one complete five-lane run against one source-mapped
  # build. test:coverage consumes the raw + LCOV it produced; it must not
  # launch a second browser sweep or accept a hand-written receipt.
  BROWSER_COVERAGE_OUTPUT=$(mktemp -d "${TMPDIR:-/tmp}/ezcorp-ci-local-browser-coverage.XXXXXX") || {
    echo "ci-local: could not create an isolated browser coverage receipt directory." >&2
    exit 1
  }
  cleanup_browser_coverage() {
    if [ "$FAILED" = "1" ]; then
      echo "ci-local: retained browser coverage receipts after failed run: $BROWSER_COVERAGE_OUTPUT" >&2
    else
      rm -rf "$BROWSER_COVERAGE_OUTPUT"
    fi
  }
  trap cleanup_browser_coverage EXIT
  run_step "Browser route coverage (mandatory Chromium lanes)" \
    env EZCORP_BROWSER_COVERAGE_OUTPUT="$BROWSER_COVERAGE_OUTPUT" bash scripts/run-browser-route-coverage.sh
  # Full mode merges every shard into coverage/lcov.info AND enforces
  # coverage-thresholds.json — the local twin of CI's "Per-file coverage gate".
  # The strict receipt verifier checks both paths against this checkout's
  # mapped manifest before adding regenerated browser LCOV to the merge.
  run_step "Coverage + per-file thresholds" \
    env BROWSER_COVERAGE_RAW="$BROWSER_COVERAGE_OUTPUT/merged/merged.json" \
    BROWSER_COVERAGE_LCOV="$BROWSER_COVERAGE_OUTPUT/merged/lcov.info" bun run test:coverage
  # Both diff gates read the coverage/lcov.info the previous step produced.
  run_step "New-file coverage (vs $BASE_REF)" env BASE_REF="$BASE_REF" bun scripts/check-new-file-coverage.ts
  run_step "Patch coverage (vs $BASE_REF)" env BASE_REF="$BASE_REF" bun scripts/check-patch-coverage.ts
else
  RESULTS+=("SKIP  Coverage + per-file thresholds / new-file / patch coverage / gated E2E  (--fast)")
fi

echo ""
echo "════════════════ ci-local summary ════════════════"
for line in "${RESULTS[@]}"; do echo "  $line"; done
echo "═══════════════════════════════════════════════════"
if [ "$FAILED" = "1" ]; then
  echo "ci-local: FAILED — fix the steps above before pushing."
else
  echo "ci-local: all executed gates PASSED."
fi
exit "$FAILED"
