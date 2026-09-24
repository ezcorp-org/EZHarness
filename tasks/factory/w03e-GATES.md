# Gates: settle a stopped attempt that has no usage operations (W03e)

Branch `wp/w03e-usage-settle`, from `integ/w00` `39a7189e0`; `integ/w00` `d5ee52309` merged at
`9f331af30`. Receipts: `/tmp/factory-platform-evidence/w03e/` (`receipts/*.json`, `proof/*.json`,
`logs/*.log`). The real-application proof runs W02c's harness, copied to `harness/`, against a
scratch worktree `.worktrees/w03e-proof` that merges this branch with `wp/w02c-quarantine`, because
the package fence is not yet in `integ/w00`.

## The defect

An attempt stopped before its first model or tool operation, by the package fence or by an operator
cancel, stayed `cancelling` forever. The stop found no terminal usage, marked the reservation
`uncertain`, and emitted `attempt-stopped` with `uncertain: true`. Reconciliation then refused the hold
on every pass with `factory_usage_hold_unresolved: no-operation-receipt`, because there was no
operation to reconcile. A second defect sat under it: the kernel folds a later certain stop into an
attempt it already holds as uncertain only when the event says `uncertain: false`, and no product path
ever emitted that, so even a late stop receipt never cleared the attempt.

## The fix

- C02 journals every operation before its possible effect, and an accepted cancellation can never
  prepare another one. So after a signed physical stop, an empty journal proves no provider was
  charged. `FactoryTaskStops.confirm` reads the frozen journal, and `finalize` then settles in the
  same transaction: a settlement typed `no-operations` carrying the signed stop receipt digest, exactly
  one `usage-settled` event, and a budget settle at zero cost and zero tokens, with compute charged at
  its reserved bound because a killed process reports no measured compute.
- Any journaled operation, even one only prepared, keeps the existing uncertain-hold path.
- A certain stop that follows a durable `stop-uncertain` event carries `uncertain: false`. A stored
  stop's certainty is re-derived from the typed settlement.
- Migration `add-factory-usage-no-operations` admits the source, adds `stop_receipt_digest`, and
  CHECKs the exact shape: that source and only that source carries a stop receipt, and it is only ever
  a known zero with nothing held and no provider receipt.

## Gates

- [x] G1: Reproduce on the real application at W02c's head `daf5203cc` (`.worktrees/w03e-base`).
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock … harness/run-proof-w03e.sh base-v2`
  EXPECT: both runs stopped with no operation journaled; neither reaches a terminal.
  EVIDENCE: `proof/receipt-base-v2.json` (and `receipt-base.json`): run O (operator cancel) and run A
  (quarantine, `factory_package_quarantined`) stay `cancelling`, reservations `uncertain`, no
  settlement, and the server log shows `factory_usage_hold_unresolved: no-operation-receipt`. The first
  attempt at 13:4x hit the ordinary-store outage and is kept as `proof/readiness-failure-base.json`.
- [x] G2: Each cause is pinned by tests that fail on the unfixed stop store.
  CHECK: `bun test ./src/__tests__/factory-task-stops.test.ts` with `task-stops.ts` restored from base.
  EXPECT: every new-behaviour test fails; the preserved uncertain-hold test passes.
  EVIDENCE: `logs/mutant-task-stops.log`: 7 fail, 17 pass.
- [x] G3: PGlite and real PostgreSQL suites at the merged head.
  CHECK: stop suite, restart suite, schema parity, settlement and migration unit tests.
  EXPECT: 0 fail.
  EVIDENCE: `receipts/final-pg-factory-task-stops.json` 24/0, `final-pg-factory-migration-restart.json` 16/0,
  `final-pg-factory-schema.json` 2/0; `receipts/final-cov-*.json` all 0 fail. An earlier PostgreSQL run
  failed two new tests on a BIGINT-as-string read (`receipts/pg-factory-task-stops.json`, 22/2),
  fixed in `145a02f17`.
- [x] G4: Real-application proof, three passes at the merged head with W02c (`6d027172f`).
  CHECK: `final-hold.sh` passes 1 to 3.
  EXPECT: 10 of 10 checks each: both runs reach `cancelled` (run A with `factory_package_quarantined`),
  each settles exactly once as a typed `no-operations` zero with one `usage-settled` event and a settled
  reservation, and run A survives a SIGKILL of the server mid-stop.
  EVIDENCE: `proof/receipt-final-pass-{1,2,3}.json`, all passed. Earlier passes at `e37b3e928`:
  `receipt-v2-pass-{1,2,3}.json` all passed; the harness-v1 set is kept (`*-harness-v1.json`), where one
  pass was scored failed by a harness check that wrongly required `uncertain: false` after a stop that
  was never uncertain; the run itself reached `cancelled` with one zero settlement.
- [x] G5: Backend pool at the merged head.
  CHECK: `timeout 5400 bun run test` under the heavy lock.
  EXPECT: 0 fail. EVIDENCE: `receipts/final-backend-pool.json`, 28195 pass, 0 fail, 1901 files.
- [x] G6: Static gates. CHECK: typecheck, lint, check-boundaries, check-factory-boundaries, gate-integrity.
  EXPECT: exit 0. EVIDENCE: `receipts/final-*.json` at `9f331af30`.
- [x] G7: Coverage and complexity. CHECK: `BASE_REF=integ/w00` new-file and patch coverage over the merged
  lcov; `crap-score.ts --changed`. EXPECT: pass.
  EVIDENCE: `receipts/final-gate-new-file-coverage.json` (1 new file at 100%),
  `final-gate-patch-coverage.json` (6 files, all changed lines covered), `final-crap-changed.json`
  (no touched function above CRAP 30).
- [x] G8: The no-operations settlement names its basis (lead ruling, 2026-09-24).
  CHECK: settlement unit test, stop suite, migration and restart suites, PostgreSQL producers, focused coverage and both coverage gates at `7ad032681`.
  EXPECT: a no-operations row carries `basis = 'no-operations: compute at reserved bound'`, derived from the source and covered by the settlement digest; the CHECK refuses a missing basis, another basis, and a basis on any other source.
  EVIDENCE: at `7ad032681` (only this gate file was uncommitted during the run): `receipts/basis-pg-factory-task-stops.json` 24/0,
  `basis-pg-factory-migration-restart.json` 16/0, `basis-pg-factory-schema.json` 2/0, `basis-backend-pool.json` 28195 pass 0 fail
  1901 files, `basis-cov-{1..7}.json` all 0 fail, `basis-gate-new-file-coverage.json` and `basis-gate-patch-coverage.json` passed
  (6 files), `basis-crap-changed.json` passed. The real-application passes were not rerun for this commit: it changes only the
  record's content, which the PostgreSQL suites exercise.

## Disclosed gaps (owners per the lead, 2026-09-24)

- A hold that reconciliation later resolves from a provider receipt settles usage but never clears the
  kernel's uncertain attempt, so that run also stays `cancelling`. Owner: the run kernel's owner
  (W05/W09), as a follow-up package. Suggested change: after `FactoryUsageReconciliation.reconcile`
  settles, enqueue the sealed stop's `attempt-stopped` with `uncertain: false`.
- A reservation whose reserved cost is zero is never listed by `listUncertainWithCostInTransaction`, so
  it can never be reconciled. Owner: W03. The no-operations case no longer reaches this path.
