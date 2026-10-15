# Gates: W18a-2 — second complexity pass and the three coverage-key gaps

Scope: split the functions above complexity 30 that wave4c named on the merged
tree, with no behaviour change; gate three files at 100 and make them measure
100; re-measure three named factory files on the fullest local merged lcov; run
the CRAP gate on the whole diff against `origin/main`.

Receipts are under `/tmp/factory-platform-evidence/w18a2/`. Every producer ran
on a clean tree at `868d8c853` (the last source commit plus a docs-only merge of
`integ/w00`). `steps.jsonl` records each step with its head, exit code, and
times. The combined runner is an unchanged copy of
`/tmp/factory-platform-evidence/w00/combined-integration.py`.

The "fullest local merged lcov" is the runner's nine legs plus seventeen
supplementary legs. Each supplementary leg is one suite in its own process
(fifteen bun suites at the root and two web bun suites), so no suite can leak
state into another.

## Gates

- [x] G1: No function above complexity 30 in the six files split here.
  CHECK: `bun /tmp/factory-platform-evidence/w18a2/cx.ts <the six files>` (the counting rules of `scripts/crap-score.ts`)
  EXPECT: worst at or below 30
  EVIDENCE: `complexity.txt`. The worst is now 24, in `wellFormed` in `startup-config.ts`, which this package did not change.
  Before and after: `mappedError` went from 92 to 6. `dispatchFactoryRequest` went from 43 to 7, and its worst group is 15.
  `handle` in private-service went from 59 to 3, and its worst route is 15. `readSealed` went from 54 to 3, and its worst part is 17.
  `parseFactoryOrchestratorProcessConfig` went from 37 to 5. `parseFactoryPoolProcessConfig` went from 44 to 7.
  `parseFactoryStartupConfig` went from 65 to 5. It was not on the brief's list, because W09b took it above 30 after wave4c.

- [x] G2: The splits change no behaviour. The existing tests pass unchanged.
  CHECK: the suites that load each file (see `behavior-*.log`), plus the combined runner's producers
  EXPECT: 0 fail, and no existing test file edited for a split
  EVIDENCE: `behavior-bun-1.log` (165 pass), `behavior-web-vitest-1.log` (34 pass), `behavior-pg-task-stops.log` (18 pass),
  `behavior-node-launcher.log` (5 pass), `behavior-startup-config.log` (198 pass), `behavior-connection.log` (73 pass),
  `behavior-pg-factory-boot.log` (1 pass), and `runner.log` (every producer exit 0).
  Old-versus-new runs of the same functions also agree on every input:
  `mapped-error-differential.txt` (840 error inputs), `parser-differential.txt` (10871 mutated configs),
  `startup-config-differential.txt` (11727 mutated documents, error lists included).

- [x] G3: The three files have threshold keys at 100 and measure 100.
  CHECK: `scripts/coverage-thresholds.json`; `python3 lcov-file.py fullest-lcov.info <file>`
  EXPECT: three keys at 100; 100.00 percent each
  EVIDENCE: `src/factory/private-files.ts` 79/79, `add-factory-projection-attempts.ts` 6/6,
  `repair-transactional-audit-metadata.ts` 4/4. private-files was a real gap (10.67 percent in wave4c). It now has
  a direct suite, `src/factory/private-files.test.ts`, with 18 tests. The two migrations already measured 100 and only lacked keys.

- [x] G4: Re-measure the three named factory files, and name the leg that covers each.
  CHECK: per-leg lcov in `fullest-inputs/`
  EXPECT: 100 percent, with the leg named
  EVIDENCE: `private-files.ts` is 100 in the runner's focused leg, through the new suite that `--auto-extra-base` adds.
  `boot.ts` (`assertFactoryBootConfiguration`) is 100 in the focused leg and in `src/__tests__/factory-boot.test.ts`.
  `factory-service-token.ts` (`exactClaims`) is 100 only in `src/__tests__/factory-service-token.test.ts`. That suite is not in the runner's leg list, and the coordinator is asked to add it.

- [x] G5: The whole-diff CRAP gate exits 0 over the fullest local merged lcov.
  CHECK: `BASE_REF=origin/main bun scripts/crap-score.ts --changed`
  EXPECT: exit 0
  EVIDENCE: `gate-crap-changed.log`: "no touched function exceeds CRAP 30" (4504 functions in 319 files).
  Over the runner's own lcov, six remain (`/tmp/factory-platform-evidence/w18a2-sweep-quality-crap-changed.log`).
  Each is a leg-list gap, and one named suite covers each at 100 percent:
  `assertServiceCapabilities` (`src/__tests__/service-capabilities.test.ts`), `enqueueInTransaction` (`src/extensions/v4/deliveries.test.ts`),
  `runWithFailover` (`src/__tests__/failover.test.ts`), `exactClaims` and `verifyFactoryServiceToken`
  (`src/__tests__/factory-service-token.test.ts`), and `attachBearerAuth` (`web/src/__tests__/security/bearer-auth.test.ts`, a web bun suite that the runner's Vitest-only web leg cannot run).
  Two real local gaps were fixed on the way. `InstallationDataKey.loadExisting` (10 percent) got a direct test. `initPglite`
  (48 percent) had one diff line whose factory branch cannot run, and that line is back to origin/main's text.

- [x] G6: The repository gates this package owns stay green.
  CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/gate-integrity.ts`, `bun scripts/check-factory-boundaries.ts`,
  `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts`, `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
  EXPECT: exit 0 each
  EVIDENCE: `runner.log` (types, lint, gate-integrity, boundaries), `gate-new-file-integ.log`, `gate-patch-integ.log` (7 files).

- [ ] G7: The gates that need the whole repository measured are recorded, not claimed.
  CHECK: `check-global-coverage.ts`, `check-coverage.ts`, `BASE_REF=origin/main check-new-file-coverage.ts`
  EXPECT: recorded as red and not fixable locally
  EVIDENCE: The global floor measures 73.88 percent over 1423 files (`gate-global-floor.log`).
  The origin/main new-file gate names 24 files (`gate-new-file-origin-main.log`): 21 are web routes or Svelte components,
  plus `kernel-types.ts`, `check-factory-runners.ts`, and `check-required-checks.ts`. None of them is a file this package changed.
  The per-file thresholds report 387 misses (`gate-per-file-thresholds.log`), on files the local legs measure only in part or not at all. None of them is a file this package changed.
