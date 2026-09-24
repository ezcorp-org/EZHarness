# W09d-2 — named refusals on the executions route

Owner: coordinator-added package, W09d's follow-up. Branch `wp/w09d2-named-refusals` from
`wp/w02c-quarantine` at `daf5203cc`. Evidence: `/tmp/factory-platform-evidence/w09d2/`.
Report: `/tmp/factory-platform-evidence/w09d2/report.txt`.

The defect (W02c validation F1): a refusal raised on the executions route (`dispatch-node`) reached
the orchestrator as an opaque HTTP 500, because W09d's named-refusal wrapper covered only the
effects. W02c's run B therefore never ended.

## What changed

- **One named-refusal answer, in the router.** `FactoryPrivateCommands.execute` answers a
  `factory_…` refusal on the executions route (`dispatch-node`, `cancel-node`) and on every effect as
  a kernel event that carries the name. W09d's per-effect wrapper in
  `private-service-composition.ts` is removed, not copied. Any other error still throws and stays
  an opaque 500, and the reporter still receives it. Commands off those two routes are unchanged.
- **The name alone did not end run B (measured).** At `7b27324f1` run B still stayed `running`.
  The kernel answers a failed dispatch with `cancel-node`. The stop path refused that cancel as
  `factory_task_stop_stale`, because no attempt was ever queued, so the run waited in `stopping`
  for ever. A kernel replay showed the same sequence.
- **An atomic "nothing queued" decision.** Coordinator ruling 2026-09-24: approved, on condition
  that the certainty is established atomically with the refusal and never by a later lookup.
  `FactoryTaskExecutionAdmission.dispatch` runs the admission under a savepoint inside its
  run-locked transaction. A named refusal rolls back to the savepoint. The queue is read in the
  same transaction under the same lock, which answers `{ refused, queued }`.
- **The kernel ends such a node in place.** `factoryAdmissionRefusedEvent` builds `node-failed`
  with `failureKind: "admission_denied"` (existing vocabulary) and the refusal's name. For a running
  task node the kernel marks the attempt stopped and fails the node with that name, with no cancel.
  The router sends it only when `queued` is false. A refusal after an attempt was queued, a refusal
  raised before the savepoint, a lost response, and a router without `dispatch` all keep
  `command-failed` and the kernel's ordinary stop.

## Files outside W09d's ownership, each ruled or disclosed

- `packages/@ezcorp/factory-sdk/src/kernel.ts`, `index.ts` (owner Sol controls):
  `factoryAdmissionRefusedEvent` and the in-place `admission_denied` branch for a running task node.
  Coordinator ruling 2026-09-24: approved as an extension of the W09d command-failed ruling.
- `src/factory/private-commands.ts` (owner: the private command dispatch package,
  `tasks/factory/private-command-dispatch-GATES.md`): the one named-refusal answer and the optional
  `execution.dispatch` store. Coordinator ruling 2026-09-24: disclose under its own gate file.
- `src/factory/task-execution-admission.ts` (owner W01): `dispatch()` and the extraction of the
  unchanged admission body into `admitInTransaction`. `admit()` behaves byte for byte as before.
- `src/__tests__/helpers/factory-run-lifecycle-suite.ts` (owner W06): test cases only, the
  real-store `dispatch` cases in the existing execution admission test.
- `packages/@ezcorp/factory-orchestrator/test/temporal-replay.test.ts` (owner W09): one test case.

## Gates

- [x] G1: Reproduction at the base: W02c's run B never ends.
  CHECK: `W02C_REPO=.worktrees/w09d2-base flock --close /tmp/ezcorp-validation-heavy.lock timeout 1800 bash /tmp/factory-platform-evidence/w09d2/repro/run-proof.sh base` (base worktree at `daf5203cc`, clean)
  EXPECT: the check "run B ... ended failed with the typed reason factory_package_quarantined" does not hold
  EVIDENCE: `/tmp/factory-platform-evidence/w09d2/proof/receipt-base.json` at `daf5203cc`: that check is false, run B's status stays `running`, and the orchestrator logs the dispatch as `GatewayStatusError: factory gateway returned HTTP 500`. The other nine checks hold.

- [x] G2: At the head, run B ends failed with `factory_package_quarantined` on the real server.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock timeout 7200 bash /tmp/factory-platform-evidence/w09d2/repro/heavy.sh` (its third step)
  EXPECT: `outcome: passed`, all ten checks hold
  EVIDENCE: `proof/receipt-head.json` and `record-head.json` at `295ced6b8` (clean): passed, 10/10. Run B ended `failed` with `{"code":"FACTORY_RUN_FAILED","message":"factory_package_quarantined"}`, and no cancel or stop was issued for it. Earlier heads are kept: `attempts/head-7b27324f1/` (the name alone: B stays `running`, red) and `attempts/head-2f2b47a17/` (the later-lookup version: green, replaced for the safety condition).

- [x] G3: The executions route answers a named refusal by name, and anything else stays an opaque 500.
  CHECK: `bun test ./src/factory/private-service-composition.test.ts ./src/factory/private-commands.test.ts`
  EXPECT: a named `dispatch-node` refusal with nothing queued is answered 200 with `node-failed admission_denied` carrying the name, and nothing is reported. A non-refusal error is a 500 with exactly `{"error":"request_failed"}` and no internal text, and it reaches the reporter. The router pins every other case.
  EVIDENCE: `/tmp/factory-platform-evidence/w09d2/receipts/light-legs.txt` (7 router and 18 composition tests)

- [x] G4: The safety condition: the in-place end rests only on an atomic "nothing queued".
  CHECK: the execution admission case in `./src/__tests__/factory-run-lifecycle.test.ts` (PGlite) and `./tests/postgres/factory-run-lifecycle.test.ts`; the router cases
  EXPECT: a named refusal raised after the admission wrote its queue row rolls back to the savepoint and answers `queued: false` with no row left. A refusal after the attempt was queued answers `queued: true`, and the router keeps `command-failed`, so the kernel cancels. An unnamed error throws. A lost response, which is the workflow's own `command-failed`, still cancels (kernel test).
  EVIDENCE: `receipts/light-legs.txt`, `receipts/postgres.txt` (lifecycle 66/66 on PostgreSQL and S3)

- [x] G5: Kernel and Temporal replay of the new in-place failure.
  CHECK: `bun test ./packages/@ezcorp/factory-sdk/src/kernel.test.ts`; the orchestrator node leg in `heavy.sh`
  EXPECT: `admission_denied` on a running task fails it in place with the name and no cancel. A lost response and an execution failure still cancel. The Temporal case ends failed with `factory_package_quarantined`, issues no cancel-node, and its history replays.
  EVIDENCE: `receipts/light-legs.txt` (kernel 27), `coverage-orchestrator/test-progress.log` (87 of 87, the new case included)

- [x] G6: The W09d and W02c suites are unchanged and green.
  CHECK: `bash /tmp/factory-platform-evidence/w09d2/repro/light-legs.sh`; the PostgreSQL step of `heavy.sh`
  EXPECT: every file exits 0
  EVIDENCE: `receipts/light-legs.txt` (20 files), `receipts/postgres.txt` (11 files: lifecycle, lifecycle-s3, validator materials, multiclaim, boot, schema, private service, package fence, migration restart, task stops, package preparation)

- [x] G7: Coverage and static gates.
  CHECK: `bash /tmp/factory-platform-evidence/w09d2/repro/final-gates.sh` (`BASE_REF=wp/w02c-quarantine`, 32 merged LCOV inputs); `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`
  EXPECT: all exit 0
  EVIDENCE: `receipts/final-gates.txt` (new-file 0, patch 0 over 5 changed files); static gates exit 0 at `295ced6b8`

## Open, with owners

- [ ] O1 (measured, not fixed here): a dispatch refused after its compute was admitted leaves the pool lease and the budget hold behind. In the head run, run B's `factory_compute_admissions` row stays `admitted`, its `dispatch-node` budget reservation stays `running`, and the root envelope stays `open` with the allocation held. Neither the cancel path nor this one releases them. Releasing the pool lease needs a remote pool call, which cannot be atomic with the refusal's transaction, so it is not included here. Owners: the pool lease W02, the budget hold W03. Evidence: `record-head.json`, `journey.runBFacts`.
