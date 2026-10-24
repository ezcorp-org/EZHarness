#!/usr/bin/env bash
# mutation-lane-leg.sh (integrator-5, 2026-10-17; team-lead's hold leg (c)): the hosted mutation lane on the merge's changed files, in the
# hosted job's own command (ci.yml "Mutation (changed files)": BASE_REF=origin/main bun scripts/mutation.ts --changed --report-only), then
# w00/mutation-tested-check.ts (a copy of W4H-33b's leg1-check.ts, generalized) on the report the run wrote. Run from the repo root of the tree
# under test. MUTATION_BASE_REF overrides BASE_REF (tests only). A report or receipt older than this run's start is never read.
#   red by name: mutation.ts exits non-zero; the report has a mutant that no test ran against, or no mutant; neither a fresh report nor
#   a fresh skipped receipt (coverage/quality/mutation-summary.json: --changed touched nothing mutatable, a named PASS).
set -u
CHECK=${MUTATION_TESTED_CHECK:-evidence/w00/mutation-tested-check.ts}
R=coverage/quality/mutation.json; K=coverage/quality/mutation-summary.json
M=$(mktemp /tmp/mutation-lane-start.XXXXXX); trap 'rm -f "$M"' EXIT; sleep 1
BASE_REF=${MUTATION_BASE_REF:-origin/main} bun scripts/mutation.ts --changed --report-only; rc=$?
[ $rc = 0 ] || { echo "RED: scripts/mutation.ts exit $rc"; exit 1; }
if [ -f "$R" ] && [ "$R" -nt "$M" ]; then bun "$CHECK" "$R" || { echo "RED: mutation tested check failed"; exit 1; }; echo "mutation-lane: PASS (report checked)"; exit 0; fi
if [ -f "$K" ] && [ "$K" -nt "$M" ]; then echo "mutation-lane: PASS (no mutatable change: fresh skipped receipt $K)"; exit 0; fi
echo "RED: no fresh $R and no fresh $K after the run"; exit 1
