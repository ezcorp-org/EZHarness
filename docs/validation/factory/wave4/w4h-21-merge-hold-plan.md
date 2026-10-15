# W4H-21 merge: hold plan (integrator-5, 2026-10-10; lock-free prep; nothing committed). W4H-21 merges FIRST, then W4H-22.

Merge: wp/w4h-21-orchestrator-fail-loud b21eb4c57 (FROZEN; 4 archy commits on fe445d241) onto integ/w00 fdc1a2de9. Folder: /tmp/factory-platform-evidence/w00/w4h-merge/w4h-21-orchestrator-fail-loud

## 1. Trial (prep.sh rc 0)
trial tree 5c864b47d4f3784cc696b7c37d5b67078894d0e9, clean; 7 files: .github/workflows/ci.yml (+9, the always() upload step),
scripts/factory-orchestrator-coverage.sh (27 lines), scripts/factory-orchestrator-registration.test.ts (+66), scripts/lib/test-totals.sh (5 lines),
src/__tests__/test-totals.test.ts (5 lines), tasks/factory/w4h-21-GATES.md (+110), tasks/todo.md (+10).
Hook maps 2: scripts/factory-orchestrator-registration.test.ts, src/__tests__/test-totals.test.ts.
Sourcers of scripts/lib/test-totals.sh (git grep at the trial tree): scripts/factory-orchestrator-coverage.sh, scripts/security-coverage.sh, the test.

## 2. Commit (on the ACCEPT and the merge order)
commit.sh under the lock (commit-locked.sh form, TC_IN_LOCK=1); the hook runs the 2 suites.

## 3. Hold: w4f-merge/hold-w4f.sh through gated-flock (exit file, timeout 7200, GATED_FLOCK_START_MEM_GIB=12)
(a) unit.txt 2c6143641820617c, 17 lcov legs: the 2 hook-mapped suites plus the 15 tests that read .github/workflows / ci.yml / db-postgres.yml /
    ci-registration and are NOT in the guard set (git grep at the trial tree; the other workflow readers run in the guard set).
(b) extra-legs.sh 5a167f99b732568d:
    - factory-temporal-producer: the REAL producer exactly as the combined runner's manifest leg runs it (scripts/combined-runner-legs.json
      factory-temporal: "COV_OUT=coverage-shard bash scripts/factory-orchestrator-coverage.sh"), FACTORY_TEMPORAL_TEST_SERVER = the pinned
      /tmp/factory-tools/temporal-test-server 1.38.0 (preflight sha daa58458d32f6254). coverage-shard/ is git-ignored: cleared before, its lcov copied
      into the hold's coverage dir after. BINDING (factory-temporal-producer-result): "tests 92", "pass 92", "fail 0" and no non-zero "cancelled" (a timed-out test counts as cancelled) in the producer's output, and
      the LCOV SF set equal to the previous producer output (wave4i-3-lcov-inputs/node.lcov, wave4i-3's node-coverage leg at 6b9ff91ac: 17 SF,
      sha fd4044394ca7cdc5; paths compared from packages/ on).
    - web-security-producer: the other sourcer of test-totals.sh, its manifest command verbatim ("COV_OUT=coverage-shard bash
      scripts/security-coverage.sh"); its lcov joins the merge.
    - actionlint-compare (W4H-15's script, 5d5dcfda93cd368e): actionlint 1.7.7 without the labels config at the first parent and the merge; only the
      3 known label findings, 0 new. The labelled actionlint (0 errors) is hold-w4f.sh's standard leg for a workflow change.
    - typecheck-all via tc_leg (the fixed tc-gate.sh 7678da69afb1c809).
(c) standard legs: prune scan, attestation, guard set, builds, web-server-lcov, coverage-merge, web build, graph mock pass, CRAP vs the first parent.
(d) merge-commit-gates vs fdc1a2de9, BINDING (MCG_COVERAGE_INFORMATIONAL not set). scripts/ is outside SOURCE_GLOBS (test-totals.sh and the
    producer are gate tooling): new-file and patch read vacuous; the per-file lcov of the changed lines (lcov-changed-lines.py over the hold's merged
    lcov) goes into the receipts. gate-integrity watches gate tooling: the base leg must stay clean (a new finding is a STOP, like any other).
(e) gate-integrity: base clean; origin/main@e3309906d = exactly the 8, else STOP.
Not run: the full combined run (lead's ruling). Risk named in the receipts: a producer script, its helper, one ci.yml upload step and tests; the
hold runs the real producer as the runner does (92/92, same LCOV set), the other sourcer's producer, every workflow reader, actionlint both ways,
the typecheck and the gates; nothing else is re-measured since wave4i-3; the next hosted run is the final proof of the ci.yml step.
