# Gates: focused-batch cross-file isolation (wave4a)

Scope: the nine failures in the coordinator's combined integration run (prefix `wave4a`), which put
222 test files into ONE `bun test` process. Every one of the nine passes when its file runs alone.
These gates cover the state four earlier files leave behind, and the repair of that state at its
source. No product behaviour changes.

Toolchain for every command: `PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH`.
The batch file list is rebuilt exactly as `combined-integration.py` lines 28–37 build it, by
`/tmp/factory-platform-evidence/w00-focused-triage/tools/build-batch-list.py`
(`--auto-extra-base c6ac529d2` plus the coordinator's six `--focused-extra` paths). The runner
environment is assembled inside `tools/run-batch.sh`; the PostgreSQL URL is never in argv and never
printed.

- [ ] G1: The batch reproduces the nine failures before the fix.
  CHECK: `bash tools/run-batch.sh baseline-full`
  EXPECT: `2723 pass | 9 fail` across 222 files
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/baseline-full.receipt.txt`

- [ ] G2: Each leak reproduces in TWO files — the named predecessor plus its victim — and each
  victim passes alone.
  CHECK: `bash tools/bisect.sh`
  EXPECT: every `*-alone` step 0 fail; `v47-after45`/`v47-after46` 1 fail; `v88-after87` 3 fail;
  `v110-after99` 1 fail (unhandled `SyntaxError`); `v126-after125` 4 fail; `v126-after102` 0 fail
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/bisect-steps.txt`

- [ ] G3: `bundled-v4-bootstrap.test.ts` restores the modules it mocks.
  CHECK: `bash tools/run-batch.sh fx-v88-after87 ./src/__tests__/bundled-v4-bootstrap.test.ts ./src/__tests__/bundled-wiring-activation.test.ts`
  EXPECT: 62 pass, 0 fail
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/verify-pairs.txt`

- [ ] G4: The trusted-local runner module is handed back unconfigured.
  CHECK: `bash tools/run-batch.sh fx-v126-after125 ./src/__tests__/trusted-local-runner-in-process.integration.test.ts ./src/__tests__/trusted-local-runner-wiring.test.ts`
  EXPECT: 9 pass, 0 fail
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/verify-pairs.txt`

- [ ] G5: The SDK bundle is built at most once per process, and the provision suite measures the
  builds its own three toolchain roots cause — never the process's first.
  CHECK: `bash tools/run-batch.sh r2-v47-runnerpkg <the six extension-runner suites in batch order>`
  EXPECT: 40 pass, 0 fail, no `EISDIR`
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/verify-pairs2.txt`

- [ ] G6: A `$server/*` alias mock no longer changes what a later file sees.
  CHECK: `bash tools/run-batch.sh r3-v110-after99 ./src/__tests__/executor-slash-command-expansion-e2e.test.ts ./src/__tests__/installer-idempotent-local.test.ts`
  EXPECT: 21 pass, 0 fail
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/r3-v110-after99.log`

- [ ] G7: The shared mock-cleanup helper keeps its own meta-test green.
  CHECK: `bash tools/run-batch.sh r3-mockcleanup-meta ./src/__tests__/mock-cleanup-coverage.test.ts`
  EXPECT: 16 pass, 0 fail
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/r3-mockcleanup-meta.log`

- [ ] G11: The lifecycle services singleton is handed back uninitialised, so the trusted-local
  service suite still owns the initialisation it asserts.
  CHECK: `bash tools/run-batch.sh r4-v102-after88 ./src/__tests__/bundled-wiring-activation.test.ts ./src/__tests__/extension-lifecycle-service-trusted-local.test.ts`
  EXPECT: 7 pass, 0 fail
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/r4-v102-after88.log`

- [ ] G8: The whole batch is green in one process.
  CHECK: `bash tools/run-batch.sh fixed-full`
  EXPECT: 0 fail, and a pass total sixteen higher than the baseline's, because
  `installer-idempotent-local.test.ts` now links and runs its sixteen tests
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/fixed-full.receipt.txt`

- [ ] G9: The shared helpers this changes still hold for the per-file pool CI runs.
  CHECK: `PARALLEL=3 bun run test` (twice)
  EXPECT: no failure in any file this branch changed. NOT MET as "0 fail": run 1 was 27575 pass / 1
  fail and run 2 was 27573 pass / 3 fail, a DIFFERENT untouched real-subprocess suite each time
  (`docs/extensions/examples/sample-loop/index.integration.test.ts`, then
  `src/__tests__/production-image-lifecycle-launch.integration.test.ts`), each green alone at the
  same host load, on a box running several other agents' pools at load 21 and 36.
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/pool-test.log`, `pool-test-2.log`,
  `pool-failure-isolation.txt`, `sample-loop-contention.txt`, `sample-loop-import-graph.txt`,
  `source-change-hunks.txt`

- [ ] G12: The four other suites that register `$server/db/connection` themselves no longer hijack
  it. Each is paired with `installer-idempotent-local.test.ts`, which reaches the alias through a
  `web/` route, and each must be green alone AND with that victim.
  CHECK: `bash tools/run-batch.sh sweep2-<suite>-withvictim ./src/__tests__/<suite>.test.ts ./src/__tests__/installer-idempotent-local.test.ts`
  EXPECT: phase-2b-e2e 24, mentions-search-workflow-branch 34, mentions-search-symlink-integration
  29, scratchpad-e2e 21 — all 0 fail; before the fix the first three were 2, 1 and 1 fail
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/sweep-before.txt`,
  `sweep-after-pairs.txt`

- [ ] G10: Static gates stay green.
  CHECK: `bun run typecheck && bun run lint && bun scripts/gate-integrity.ts`
  EXPECT: all three pass
  EVIDENCE: `/tmp/factory-platform-evidence/w00-focused-triage/static-checks.log`
