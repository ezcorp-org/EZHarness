# Gates: the package quarantine fence (W02c)

Branch `wp/w02c-quarantine`, created at `integ/w00` `578692e8a`; `integ/w00` advanced to `943b9fa0c`
(CI and validation docs only) and was merged at `43d224900`. Head of record: `1d06a7394`. Receipts: `/tmp/factory-platform-evidence/w02c/`
(`sweep-final/receipts/*.json`, `proof/receipt-*.json`, `proof/record-*.json`). Full report:
`/tmp/factory-platform-evidence/w02c/report.txt`.

## What was wrong at base

W02 recorded `quarantined` and `revoked` as trust revisions, and the three launch reads (dispatcher claim,
preflight, runtime open) already refused a blocked package. Four things were missing:

- **Nothing stopped live work.** `FactoryPackageTrusts` exposed a stop seam (`FactoryPackageQuarantineFence`).
  No production implementation existed, and every production composition built the store without one. A
  quarantined package's running attempts ran to their own end.
- **Admission did not read trust.** `FactoryNativeRunnerPolicy` checked the lock file only, so a quarantined
  package still admitted new attempts. The launch read then denied them.
- **Refusals carried no generation.** `factory_package_quarantined` was a bare code, and the dispatcher
  recorded the generic `runner_package_denied`.
- **No record of affected runs existed.** W14's preview recomputes live runs from lock-file text. After a
  quarantine has stopped the work, that list is empty.

## Commits

| SHA | Subject |
| --- | --- |
| `083d6b7f4` | refactor(factory): one in-transaction run cancellation for operator and system callers |
| `f33739a78` | test(factory): share the live-attempt fixture the stop suite built inline |
| `4c74721ad` | test(factory): move the stop harness helpers into the shared live-attempt fixture |
| `ffebd0a23` | feat(db): the package fence's affected-run record |
| `af25914d3` | feat(factory): the package quarantine fence |
| `21cb97465` | docs(tasks): W02c plan |
| `43d224900` | Merge branch 'integ/w00' into wp/w02c-quarantine |
| `ce7c6cc4b` | test(factory): prepare the package before racing a launch against a quarantine |
| `1d06a7394` | ci(factory): run the package fence suite on real PostgreSQL |

## Gates

- [x] G1: Reproduce at base in the real application.
  CHECK: `W02C_REPO=<base worktree at 578692e8a> W02C_HARNESS=/tmp/factory-platform-evidence/w02c/repro-base flock --close /tmp/ezcorp-validation-heavy.lock timeout 1800 bash repro-base/run-proof.sh base`
  EXPECT: after the quarantine, run A is not cancelled or stopped; run B is admitted, then denied at launch as `runner_package_denied`; no affected-run record exists.
  EVIDENCE: `proof/receipt-base.json` and `proof/record-base.json` (commit `578692e8a`, 06:26 to 06:36 local). Run A: status `running` at the quarantine; its inbox holds only `admission-result`, with no cancel; `factory_task_stops` is empty; the run never reached a terminal status. The server-kill leg then left A's queue row `outcome_unknown` (`worker_lease_expired`). Run B: admitted (journal row `admitted`), queue row `cancelled` with `runner_package_denied`, run stuck `running`, not relaunched after the lift. `affectedRuns: {available: false}`. Two earlier attempts failed for infrastructure reasons and are preserved: `proof/failed-base-attempt2/` (execution gateway not ready, transient) and `proof/failed-base-attempt3-disk-full/` (host disk full; S3 writes answered 500).
- [x] G2: The fence is read at admission, preflight and launch, and refuses by name with the generation that blocked it.
  CHECK: `bun test --timeout 120000 ./src/__tests__/factory-package-fence.test.ts`
  EXPECT: 16 pass, 0 fail. The cases "admission refuses ... by name" and "an admitted attempt that has not launched is refused at launch by name" assert `FactoryPackageBlockedError { code, trustRevision: 2, installationGeneration: 1 }` from the runner policy, the dispatcher (queue failure code `factory_package_quarantined`), the preflight and the readiness read.
  EVIDENCE: `sweep-final/receipts/focused-coverage.json` (198 pass, 0 fail, 1958 assertions over the ten focused files); `sweep-final/receipts/postgres-coverage.json` (real PostgreSQL, 112 pass, 0 fail, 4484 assertions, fence suite included); `sweep-final/receipts/postgres-s3-coverage.json` (package-preparation on PostgreSQL and S3, 22 pass). All at `1d06a7394`, clean tree.
- [x] G3: Quarantine stops launched attempts through W03's stop path with the typed reason, idempotently, and records each affected run.
  CHECK: the case "quarantine stops a launched attempt through the ordinary cancel and W03's stop path ..." in the same file.
  EXPECT: run `cancelling`; one kernel `cancel` with reason `factory_package_quarantined`; `cancel-node` settled by `FactoryTaskStops.stop` to `stopped`; kernel `stopReason` is the typed reason; one sealed record with disposition `cancel-requested`. The lost-response and double-quarantine cases show one cancel and one record.
  EVIDENCE: as G2.
- [x] G4: Lifting a quarantine re-admits only new attempts; stopped attempts stay stopped with their reason.
  CHECK: the case "admission refuses a quarantined package by name; lifting it re-admits only new attempts ..."
  EXPECT: after `publish` at revision 3, the waiting run admits one attempt; the stopped run keeps its single cancel and its reason; no record at revision 3.
  EVIDENCE: as G2.
- [x] G5: Concurrency, lost response, crash, stale generation, cross-tenant, corruption, fail-closed.
  CHECK: the remaining fence cases, plus the restart suite case "repeated migration keeps every package fence record ...".
  EXPECT: one winner in each race; the replay returns the same record; a mid-fence failure rolls back the trust revision, the cancel and the record; a crash mid-stop keeps the record and the restarted stop settles; a stale revision fences nothing; a later installation generation does not lift a quarantine; another tenant is refused; a tampered record is refused; a store without a fence refuses to quarantine.
  EVIDENCE: as G2; restart suite on PGlite and PostgreSQL in the same receipts.
- [x] G6: Real-server proof, three passes: a run whose package is quarantined mid-attempt is cancelled with the typed reason, its guest is stopped, and it appears in the affected-run list; the product server is killed mid-stop; run B is refused by name while quarantined; a new run C launches after the lift.
  CHECK: `W02C_REPO=<proof worktree at 1d06a7394> W02C_HARNESS=/tmp/factory-platform-evidence/w02c/repro-v2 flock --close /tmp/ezcorp-validation-heavy.lock timeout 1800 bash repro-v2/run-proof.sh v2-pass-N` for N = 1, 2, 3 (driver `repro-v2/three.sh`).
  EXPECT: `outcome: passed`, all nine checks held, in each receipt. Two checks decided by surfaces W02c does not own are reported under `outsideScope` and do not count toward the verdict (see Open).
  EVIDENCE: `proof/receipt-v2-pass-{1,2,3}.json` and `proof/record-v2-pass-*.json` at `1d06a7394`, 08:44 to 08:57 local: each `passed`, 9/9. Both `outsideScope` checks are false in every pass: run A stays `cancelling` (W03 reconciliation), and run B's workflow ended on the refused admission (orchestrator). The first harness version (`proof/receipt-pass-{1,2,3}.json`, 06:36 to 07:09) counted those two as checks and expected B itself to relaunch after the lift, so it reported 6/9 in all three passes. The fence's own checks were identical.
- [x] G7: Static gates and coverage at the merged head.
  CHECK: `W02C_REPO=<proof worktree> flock --close /tmp/ezcorp-validation-heavy.lock timeout 7200 bash repro/sweep.sh final` (focused and PostgreSQL coverage, full backend pool, typecheck, lint, boundaries, gate integrity, merged LCOV, `BASE_REF=integ/w00` new-file and patch coverage).
  EXPECT: every leg exits 0.
  EVIDENCE: `sweep-final/receipts/*.json` at `1d06a7394`, clean tree, 07:09 to 07:25 local: every leg exits 0. Backend pool 28111 pass, 0 fail, 1896 files. New-file gate: 2 new source files gated. Patch gate: all changed executable lines covered (10 files). A preliminary sweep at `43d224900` (`sweep-prelim-43d224900/`) found the unregistered PostgreSQL suite (fixed in `1d06a7394`) and the launch race gap (fixed in `ce7c6cc4b`).

## Decisions a reviewer should see

1. **The stop path is consumed exactly as written.** Freeze section 3 recommends a second, W03-owned
   authority path for package stops, which does not exist. The fence does not need one. It cancels each
   affected run through the operator's own cancel (`requestFactoryRunCancellationInTransaction`, extracted
   from `FactoryRunLifecycle.cancel` with no behaviour change). The kernel then issues `cancel-node`, and W03's
   stop path settles it unchanged. The physical stop receipt therefore says `cancelled`, not the freeze's
   suggested `lease-revoked`. The typed reason is the run's stop reason and its public error message.
2. **Files outside W02's set.** `run-lifecycle.ts` (W06): the extraction above. `attempt-dispatcher.ts`
   (W01): the failure code for a blocked package. `native-runner-policy.ts` (W01): an optional admission
   fence. `private-service-composition.ts` (coordinator): passes that fence. `factory-task-stops-suite.ts`
   (W03 tests): now uses the shared fixture. Its 18 tests and 146 assertions are unchanged from base.
   `migrate.ts`, `schema.ts` and the restart suite (coordinator): one appended migration, its model, and its case.
3. **Fail closed.** A trust store without a fence refuses `quarantine` and `revoke` with
   `factory_package_fence_unavailable`. W14's console currently builds one without a fence. W14 was told to
   use `createFactoryPackageTrusts`.
4. **An admission refusal waits.** A quarantined package's `dispatch-node` admission fails, and the
   orchestrator retries it until the quarantine lifts or the run is cancelled (C05: "wait for remediation or
   fail explicitly"). The private service maps it to 500 and reports it; it has no typed mapping.

## Open

- **A stopped run does not finish (W03).** In every pass, run A is cancelled with the typed reason and
  its guest is stopped. The run then stays `cancelling`. Its attempt was stopped before its first operation,
  so the stop leaves the budget hold `uncertain`, and usage reconciliation refuses it on every pass with
  `factory_usage_hold_unresolved: no-operation-receipt`. An operator's cancel of a running attempt takes the
  same path. Needed from W03: a settlement rule for a stopped attempt whose journal has no operation.
  Evidence: `proof/*pass-*-process-web-restarted.log`.
- **A refused admission kills the run's workflow (orchestrator).** The orchestrator runs each effect once
  (`retry: { maximumAttempts: 1 }` in `workflow.ts`), so a refused `dispatch-node` fails the workflow, and the
  run stays `running`. At base the same run was admitted, then denied at launch, and was equally stuck. C05
  says an affected run waits or fails explicitly. Needed from the owner of the effect protocol: a refusal
  path to the kernel (for example a typed node failure). The fence then ends such runs with the reason.
- C05 also blocks new acceptance and release claims for already accepted candidates. That is the release
  fence (W09c/W09d surface) and is not in this package.
