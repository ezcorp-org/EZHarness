# Gates: W09e release node stop settlement

Branch `wp/w09e-release-stop`, cut from `integ/w00` at `326e5e725` (W01h landed).
Evidence: `/tmp/factory-platform-evidence/w09e/` (logs under `logs/`, report in `report.txt`).
Brief: `/tmp/factory-platform-evidence/w00/briefs/w09e.md`.

| Commit | What it is |
| --- | --- |
| `19ee79f52` | R1 red first: a user cancel while a release is in flight never ends the run (test) |
| `3725e5b42` | R2: a release's certain stop names its external effect (kernel, SDK enum, orchestrator validation) |
| `4217ab3e0` | R2: the release table records a release's stop and its effect (explicit ALTER migration, schema mirror) |
| `d5bd9ded2` | R2: the cancel route stops a release node under the operation's row lock; R6 not applicable, by test |
| `7f134ad10` | R2d: the run inspection and the run inspector show a stopped release's effect and its deadline |
| `487183a39` | R2: a claimed release whose dispatch has not started stops with no effect |
| `787424f70` | R3, R4, R7: the provider proves a stopped release's effect, bounded by its deadline; late answers are evidence |
| `e604126fd` | R5: a release that cannot move waits a doubling interval (5 s base, 5 min cap) |
| `92bca9a9d` | R2d: the stop line reads in both themes; the console mock names each run's factory |
| `fe2199392` | R2d: a stopped release's deadline never breaks inside its date (390 px screenshot) |

## The defect

A run stopped while its release was in flight stayed `cancelling` for ever. The execution cancel route
resolved every cancel through the attempt queue, which never holds a release, so the cancel was refused
`factory_task_stop_stale`. The release-outcome role also retried a release that waits for consent on every
pass (250 ms idle delay), which is the lane's `factory_release_consent_absent` lines.

## Files owned by other packages

| File | Commit | Change | Ruling |
| --- | --- | --- | --- |
| `packages/@ezcorp/factory-sdk/src/kernel.ts`, `kernel-types.ts`, `index.ts` | `3725e5b42` | `attempt-stopped` carries `effect: "uncertain" \| "published"`; `FACTORY_ATTEMPT_STOP_EFFECTS` names it on the node | design point 3 (explicit, validated enum) |
| `packages/@ezcorp/factory-orchestrator/src/validation.ts` | `3725e5b42` | the inbox refuses an effect outside the enum | design point 3 |
| `packages/@ezcorp/factory-sdk/src/console-types.ts`, `factory-api-response.schema.json` | `7f134ad10` | a run release resource carries `deadlineMs` and `stop` | design point 2 (the projection shows the effect and deadline) |
| `web/src/lib/factory/*`, `web/e2e/factory-live-console.spec.ts` | `7f134ad10`, `92bca9a9d` | the run inspector's stop line, and one e2e test on `/factories` | design point 2 |
| `src/factory/release-adapters.ts`, `release-s3-publication.ts`, `release-github.ts` (unchanged) | `787424f70` | `lookupReceipt` on every provider; S3 manifest's `describePublication` renamed to it | design point 5 (status query by idempotency key) |

## G1 = R1: the reproduction, red first

- Red on `1a80d3977` and again on `326e5e725`: `logs/r1-red.log` (0 pass, 1 fail; sha256 099b99f6434b33d6…),
  `logs/r1-red-326e5e725.log` (0 pass, 1 fail; 3212986602c8a0ee…). The stop is refused `factory_task_stop_stale`
  and the run stays `cancelling`.
- Green at the head: the same case (`W09e R1`) in `tests/postgres/factory-run-lifecycle.test.ts`, 90 pass 0 fail
  (`logs/head/pg-factory-run-lifecycle.log`), and on PGlite 90 pass 0 fail.

## G2 = R2: the stop path

- The cancel route asks `FactoryReleaseStops` first. For a release node it locks the operation row (the lock
  `claim` and the dispatch start take), marks the stop with the cancellation epoch the stop raised, and
  enqueues `attempt-stopped` in the same transaction. The effect is `none` (pending, or claimed with no
  dispatch started), `uncertain` (dispatch started), or `published` (succeeded). The node records
  `RELEASE_EFFECT_UNCERTAIN` or `RELEASE_PUBLISHED_BEFORE_STOP`. The run reaches its terminal without waiting
  for the provider.
- Red: kernel `logs/r2-kernel-red.log` (3 fail); race with the stop's row lock removed
  `logs/r2-race-red-nolock.log` (1 fail); claimed-not-dispatched `logs/r2e-race-red.log` (2 fail) and
  `logs/r2e-lifecycle-red.log` (1 fail); inspection `logs/r2d-console-red.log` (2 fail).
- Green at the head: race `tests/postgres/factory-release-stop-race.test.ts` 4/0 (claim and stop, dispatch
  start and stop, both orders, synchronised on `pg_locks`); lifecycle W09e cases 11/0 inside 90/0; kernel
  236/0; orchestrator 91/0; console 26/0 on PGlite and PostgreSQL; migration old-shape test 1/0.
- Operator view: the e2e test on `/factories?view=runs` passes in both browser projects (see G2d below).

### G2d: the operator sees the effect and the deadline

- First run at `7f134ad10`: 2 fail (`logs/r2d-e2e-first-run.log`): the mock named the long factory for every
  run. The screenshot also showed the amber stop line too light at 11 px. Both fixed in `92bca9a9d`.
- At `92bca9a9d`: the new test passes in chromium and mobile-chromium; 21 passed, 1 failed
  (`logs/r2d-e2e.log`). The failure is an existing test (`inspects a run … at 390px in dark`) whose page never
  set its hydration marker in 20 s; the app stayed on its boot splash, before any factory data. The same spec
  three times over at `92bca9a9d`: 66 passed (`logs/head/e2e-measure-92bca9a9d.log`), so 1 hydration timeout in
  88 runs. In evidence mode with `--repeat-each=3` the vite preview server died once with
  `ERR_STREAM_WRITE_AFTER_END` (`logs/head/e2e-repeat3.log`); a second evidence run passed. Both are reported
  to the coordinator; neither is in W09e's code.
- The 390 px screenshot broke the deadline inside its date; fixed in `fe2199392`.
- Cause of the server crash: the tool directory `/tmp/factory-tools/bun-1.3.14/bun-linux-x64/` has no `bunx`, so
  `bunx` fell through to the system Bun 1.4.2, while the repository pins 1.3.14 (`.bun-version`). The web
  scripts build, preview and test through `bunx`. Under 1.4.2 the preview server crashed in 2 of 4 repeat runs
  (`logs/head/e2e-repeat3.log`, `logs/head/e2e-measure-fe2199392-bun142.log`).
- At `fe2199392` with `bunx` pinned to 1.3.14 (a private link, `/tmp/factory-platform-evidence/w09e/bin/bunx`):
  the web build, the graph-proof runbook (passed), the spec three times over (66 passed, no crash) and the W09e
  test in evidence mode (2 passed) (`logs/pinned-driver.log`, `logs/head/e2e-measure.log`).

## G3 = R3: reconciliation, bounded by the release's own deadline

- `lookupReceipt` is a read-only question by the operation's identity. The role lists a project's stopped
  releases on the same page as its claimable ones and settles each with `settleStopped`: past `deadline_ms`,
  `unknown_at_deadline` by name, the provider not asked; a receipt gives `published`; no receipt plus the
  sender fence and `proveNoEffect` gives `no_effect` and releases the destination; anything else is the named
  transient `factory_release_stop_outcome_unknown`. No provider call or archive write runs inside a
  transaction.
- Red: `logs/r3-lifecycle-red.log` (5 fail on `487183a39`).
- Green at the head: lifecycle 90/0 on PostgreSQL and PGlite; driver unit 44/0; S3 lookup unit 5/0.
- Cost (coordinator ruling, 17:13Z): release spend stays outside the compute budget ledger in W09e; there is no
  entry point beside W03f's `settleAtBound` and no call into W03f. The stop outcome records `{costMicros, source,
  basis}` in `stop_cost_micros`, `stop_cost_source`, `stop_cost_basis`, and a check ties them to `stop_outcome`:

  | Outcome | Cost | Source | Basis |
  | --- | --- | --- | --- |
  | no_effect (stopped before dispatch) | 0 | `proven-no-effect` | proven: no publish started before the stop |
  | no_effect (provider lookup + sender fence) | 0 | `proven-no-effect` | proven: the provider shows no publication and the sender is stopped |
  | no_effect (operator reconciliation) | 0 | `proven-no-effect` | proven: an operator's reconciliation shows no publication |
  | published, receipt carries spend | the spend | `provider-receipt` | measured: the provider receipt's spend |
  | published, no spend on the receipt | the bound | `reserved-bound` | bound: the provider reports no spend |
  | unknown_at_deadline | the bound | `reserved-bound` | unknown: charged at reserved bound; ended by stop |

  The bound is the release's signed `estimated_spend_micros`. The first recorded outcome's cost stays, as the
  outcome does. The run inspection's costs list each stopped release: `held` at the bound under the named hold
  `operation-cost-unknown` while the outcome is unrecorded (the bound in `unknownCostMicros`, `uncertain`), and
  `settled` with source and basis once recorded (the figure in `knownCostMicros`). The run inspector renders the
  three; the e2e test on `/factories?view=runs` asserts them.
- Follow-up recorded by name in `tasks/todo.md`: "release spend into the budget ledger".

## G4 = R4: late answers

- A receipt after the stop sets `late_evidence_json` (kind, source, provider receipt id, digest, time,
  `statusRefusal: factory_release_stopped`). Delivery refuses a stopped release by name. After the deadline,
  `stop_outcome` stays `unknown_at_deadline` and the receipt is only evidence.
- Red: in `logs/r3-lifecycle-red.log` (the deadline case). Green: lifecycle 90/0; delivery unit 6/0.

## G5 = R5: consent back-off

- `FactoryReleaseOutcomeBackoff`: 5 s base, doubling, 5 min cap (`FACTORY_RELEASE_OUTCOME_BACKOFF_BASE_MS`,
  `FACTORY_RELEASE_OUTCOME_BACKOFF_CAP_MS`), keyed by release, in the role's process. Consent not there yet is
  reported `awaiting_consent`.
- The line count: one simulated hour of 250 ms passes gives 17 `awaiting_consent` lines (one per wait), not
  14,400, and one consent read each.
- Red: `logs/r5-red.log` (4 fail with the constants alone). Green: driver unit 44/0, back-off unit 3/0 at 100 %.

## G6 = R6: lock order

- The release stop path locks the operation row only. The statement record proves it locks neither
  `factory_task_stops` nor `factory_attempt_launches`, so `FACTORY_STOP_LAUNCH_LOCK_ORDER` does not apply and no
  pair order is added. The claim/stop and dispatch-start/stop interleavings are driven on PostgreSQL and
  synchronised on `pg_locks` (G2).

## G7 = R7: no hidden publish

- One run: stopped during its publish, the run `cancelled` with `RELEASE_EFFECT_UNCERTAIN`; the publish then
  succeeds; the operation is `succeeded` with `stop_outcome = published` and late evidence; delivery refuses
  it; the run stays `cancelled`. Red: `logs/r3-lifecycle-red.log`. Green: lifecycle 90/0.

## Bun 1.4.2 observation (for the W12e upgrade decision)

Runs whose app server ran under the system Bun 1.4.2 (the tool directory lacked `bunx`) are void: the e2e runs
at `7f134ad10` and `92bca9a9d`, and the repeat measurements that crashed. The record is the rerun under the pin
at `fe2199392` and the runs after it. The preview crash (`ERR_STREAM_WRITE_AFTER_END`) did not reproduce under
1.3.14 (66 of 66); it is recorded in `tasks/todo.md` for W12e, not as a package. The coverage merge at
`92bca9a9d` used web lcov produced by vitest under 1.4.2 (runner only, no app server); disclosed here.

## Legs at the head

At `92bca9a9d`, under the heavy lock, gated before every leg (`logs/head-driver.log`, `logs/head/`).
`fe2199392` changes only the web stop line; its hook ran the two web suites (19/0) and the e2e measure above.

| Leg | Result |
| --- | --- |
| kernel (`packages/@ezcorp/factory-sdk`) | 236 pass, 0 fail |
| orchestrator | 91 pass, 0 fail |
| PGlite lifecycle | 90 pass, 0 fail |
| PGlite unit and integration (14 files) | all 0 fail (release-stops 5, backoff 3, dispatch-composition 44, delivery 6, adapters 5, s3-publication 18 + 18, archive-writer 12 + 10, private-service-composition 19, protected-command-effects 3, migration 1, releases 24, console 26) |
| PostgreSQL task-stops | 29 pass, 0 fail |
| PostgreSQL run-lifecycle, run-lifecycle-s3 | 90 / 90 pass, 0 fail |
| PostgreSQL release suites | releases 23, release-stop-race 4, release-stop-migration 1, release-declare-race 4, all 0 fail |
| PostgreSQL neighbours | stop-lock-order 1, restore 17, checkpoint 12, console 26, private-service 5, schema 2, archive-writer 10, s3-publication 18, all 0 fail |
| coverage vs `326e5e725` | new-file gate passed (3 files); patch gate passed (19 files), with unit, PostgreSQL, SDK, orchestrator and web lcov merged (`logs/head/coverage-gates3.log`) |
| graph-proof runbook `pass mock none` | passed at `92bca9a9d` (`graph/w09e-head.json`) and at `fe2199392` with the pinned `bunx` (`graph/w09e-head-pinned.json`) |
| hook per commit | at most 6 mapped suites per commit, no skip |
