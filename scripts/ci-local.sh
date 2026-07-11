#!/usr/bin/env bash
# Run the PR CI gates locally, in roughly the same order CI does, with a
# single PASS/FAIL summary at the end. Every CI job in .github/workflows/ci.yml
# is a thin wrapper around a repo script, so local parity is near-total; the
# only things this CANNOT reproduce are the GitHub-side pieces (branch
# protection rollup, PR bots, the visual-evidence PUBLISH workflow) and the CI
# runner's exact environment (a handful of timing-sensitive suites flake
# differently across machines).
#
# Usage:
#   bash scripts/ci-local.sh           # full parity (~15-30 min: coverage + e2e)
#   bash scripts/ci-local.sh --fast    # pre-push sanity (~5 min: skips
#                                      # coverage merge/gates + playwright)
#   BASE_REF=origin/main               # diff base for the diff-scoped gates
#                                      # (gate-integrity, visual-evidence,
#                                      # new-file/patch coverage). Default
#                                      # origin/main — matches CI.
#
# Worktree caveat: `biome check .` resolves 0 files in a git WORKTREE
# (vcs.useIgnoreFile + `.git`-is-a-file); the Lint step below reports this
# instead of passing vacuously — lint from a primary checkout, or lint
# explicit paths.
#
# Flake caveat: the "Backend + example tests" step is `bun run test`, whose
# full pool includes a few timing/env-sensitive suites that CI runs under
# the tolerant sharded jobs (thresholds are the real backend gate there).
# If that step fails on files you did not touch, re-run the named file
# solo and compare against a clean main checkout before treating it as
# your regression — smoke-run precedent: mock-cleanup-coverage,
# chat-memory-e2e, agent-configs rate-limit.
set -u

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
  # Vacuous-pass guard for worktrees (see header).
  local checked
  checked=$(bunx biome check . 2>&1 | tail -2)
  echo "$checked"
  if echo "$checked" | grep -q "Checked 0 files"; then
    echo "biome resolved 0 files — you are likely in a git worktree; lint explicit paths or run from the primary checkout."
    return 1
  fi
  bun run lint
}

git fetch origin main --quiet 2>/dev/null || true

# ── Fast, always-on gates (mirror the cheap CI jobs) ────────────────────────
run_step "Typecheck" bun run typecheck
run_step "Lint (biome)" lint_step
run_step "Gate integrity (vs $BASE_REF)" env BASE_REF="$BASE_REF" bun scripts/gate-integrity.ts
run_step "Visual evidence (vs $BASE_REF)" env BASE_REF="$BASE_REF" bun scripts/check-visual-evidence.ts
run_step "Manifest lockfile drift" bun run scripts/regenerate-manifest-lock.ts --check
run_step "Route contract" bash -c 'cd web && bun test ./src/__tests__/route-contract.test.ts'
run_step "Web tests (vitest)" bash -c 'cd web && bunx --bun vitest run'
run_step "Web tests (bun-leg orphans)" bash scripts/test-web.sh
run_step "Backend + example tests (pass/fail pool)" bun run test

# ── Heavy gates (coverage merge + thresholds + diff gates + e2e) ────────────
if [ "$FAST" = "0" ]; then
  # Full mode merges every shard into coverage/lcov.info AND enforces
  # coverage-thresholds.json — the local twin of CI's "Per-file coverage gate".
  run_step "Coverage + per-file thresholds" bun run test:coverage
  # Both diff gates read the coverage/lcov.info the previous step produced.
  run_step "New-file coverage (vs $BASE_REF)" env BASE_REF="$BASE_REF" bun scripts/check-new-file-coverage.ts
  run_step "Patch coverage (vs $BASE_REF)" env BASE_REF="$BASE_REF" bun scripts/check-patch-coverage.ts
  run_step "E2E (mock, playwright)" bash -c 'cd web && bunx playwright test'
else
  RESULTS+=("SKIP  Coverage + per-file thresholds / new-file / patch coverage / E2E  (--fast)")
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
