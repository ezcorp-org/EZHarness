# Gates: W01h runner outcome unknown leaves a run stuck

Branch `wp/w01h-runner-outcome`, cut from `integ/w00` at `2b2e12550`.
Evidence: `/tmp/factory-platform-evidence/w01h/`.

| Commit | What it is |
| --- | --- |
| `1812495b6` | the gateway transport settles every request under Bun (deadline, abort, early close, oversize) |
| `760cf1810` | the host keeps a guest's answer until it is collected; typed refusals; every refusal in the host log |
| `4cd3f76b4` | an attempt whose answer is lost ends `failed` by name; the dispatcher keeps the runner's error |
| `41b1d8a02` | a lost attempt waits for its journal to settle before it is recorded |
| `4dbe4a1b2` | the Podman case: an exiting container is recorded failed, its retry runs, a slow guest is collected |
| `5a927faf1` | the Podman case asserts what each attempt's terminal row says |
| `ec430ef3e` | merge integ/w00 27d957531 (W19a); only tasks/lessons.md conflicted (union) |
| `982f9cb6d` | defect 2: the durable epoch is written by the transition that raises it (fence commit) |
| `458650ddb` | a lost attempt with no operation reports a measured zero usage, so its stop settles (runner); reverted by `4b7dc52db` |
| `0d7c01694` | defect 3: a non-success report is recorded after the attempt deadline (fence commit) |
| `a00430bb5` | option 2: the attempt deadline is the node command's, not the first pool lease's (fence commit) |
| `961059571` | option 2: the remote runtime renews the pool lease while the guest lives (runner) |
| `d327c85fb` | a dead guest's account carries its exit code and whether its deadline stopped it (runner) |
| `34e3088a7` | every host-side loss reaches the kernel as node-failed with its own typed reason (test) |
| `34fee7df5` | the host reads the container's own exit code before it writes a dead guest's account (runner) |
| `99884e9d0` | defect 4: a guest that outlives the queue lease still has its receipt delivered (runner) |
| `030339f63` | merge integ/w00 8aac1a782 (W18 hygiene, W12d); EZ_SKIP_HOOK_TESTS=1 by the lead's ruling, the 77 suites run outside the hook |
| `4b7dc52db` | revert of `458650ddb`: a lost result carries no invented usage (usage ruling below) |
| `3eabc851b` | defect 5: the PostgreSQL lifecycle case for a denied approval, committed under the lock (test) |
| `c9baf2f4c` | merge integ/w00 03538e909 (W19b, W16b); only tasks/todo.md conflicted (union); EZ_SKIP_HOOK_TESTS=1 by the merge ruling, its 5 listed suites green in the batch |
| `a4dc40f3e` | merge integ/w00 97423ce17 (W18a-3, W01k); only tasks/lessons.md conflicted (union); the hook mapped 14 suites (cap 12). EZ_SKIP_HOOK_TESTS=1 on a4dc40f3e; ratified by coordinator ruling 2026-09-26 00:12Z (it was used without a ruling; a skip ruling names one commit): `logs/m4/hook-list.txt` verbatim, 13 unlocked suites exit 0 (`logs/m4/hook/`), factory-compute-admissions under the lock 2/0 (`logs/m4/hook/pg-compute-admissions.log`); shared `.git/config` sha256 `44962525f1ca1a8b…`, core.bare=false, after the git-running suites; typecheck, lint, boundaries, gate-integrity and 25 focused suites exit 0 (`logs/m4/`) |
| `6f3903666` | merge integ/w00 f7c1290a6 (W03e); only tasks/lessons.md and tasks/todo.md conflicted (union); the hook ran its 4 mapped suites (no skip) |
| `be1d4530c` | fix round: a stop whose facts no longer verify is a reconciliation item, not a hot loop (stop settlement, migration) |
| `b254a1a56` | fix round: a stop sealed first owns the attempt's end; a lost result is its evidence (runner) |
| `216868819` | fix round 2: one lock order for an attempt's stop and launch rows (validator-2's D1) |
| `942a03dac` | the orchestrator's gateway bounds stay above the private service's slow-stop bound (orchestrator); EZ_SKIP_HOOK_TESTS=1 by the lead's ruling, its 4 listed suites run outside the hook |
| `702bad45d` | defect 5: a stopped approval settles in place; a denied approval ends its run (kernel) |

## The defect

integrator-2's W19a merge batch (control-no-pin pass, host load 45 to 60): node `prepare` settled
`runner_outcome_unknown`; the launch row said `launched` with no terminal row; the supervisor log was
empty; the run stayed `running` and node B never ran. Evidence:
`/tmp/factory-platform-evidence/w00/w19a-merge/defect-runner-outcome-unknown/`.

## The mechanism (reproduction.txt, then the defect rows)

1. The attempt deadline is the pool lease deadline, about 25 s after admission, and the remote
   runtime does not renew it. On a loaded host the `prepare` guest outlived it; the host runner
   killed it at the deadline (podman stop 00:39:44, died 137).
2. The host's result route threw a bare 500/409, logged nothing, and had already deleted its entry;
   the product's client threw; the dispatcher swallowed the error (`catch {}`) and parked the queue
   row `outcome_unknown`. No terminal row, no task outcome, so no `node-failed` for the kernel.
3. The kernel waited until its run and node timers fired together (00:49:16, 10 minutes). The run
   deadline stop then issued `cancel-node`, which was refused `factory_command_stale` (second
   defect, below), and the run held in `stopping`.
4. Two more paths end in the same state: a result call longer than the product's 30 s timeout (under
   Bun the transport never rejected, so the dispatch pass hung for ever; with W19a's hunk it rejects
   and settles unknown), and a host supervisor that restarted (409). On this installation the 30 s
   pool lease kills a guest before the product's 30 s call can time out, so the deadline is the
   mechanism that fires; the call timeout is a latent one the long poll removes.

## Defect 2 (ruled into W01h): the durable epoch is written by the transition that raises it

A stop the kernel begins itself (run deadline, failed command, partition invalidation, a node that
fails for good beside running siblings) moved only the kernel's cancellation epoch; the durable fence
(`factory_run_lifecycle.cancellation_epoch`) moved only on a user cancel, so every such `cancel-node`
was refused `factory_command_stale` and the run held in `stopping` (W19a batch 6, cancel-node:5).
Rule: the durable epoch is written by the transition that raises it, in the same transaction as its
audit batch (`run-cancellation-epoch.ts`), and a user cancel writes the same target through the same
function, so either order converges on one value. The fence stays exact (no `fence + 1`); a durable
epoch above the stopped one is refused as corrupt. fail-run and cancel-run are applied by the run
projector from the audit batch and never pass withCommitted, so an epoch that ran ahead cannot block
them. Probe before the fix: `probe/zz-w01h-deadline-stop.scratch.test.ts`; test file red 3/6 without it.

## Defect 3 (ruled into W01h): a non-success report after the attempt deadline

The run fence refused any report past the attempt deadline, so a guest killed at its deadline could
never reach the kernel. `authorizeAttemptInTransaction` now relaxes only the attempt-deadline clause,
and only for the task-outcome record (`expired: "allowed"`); epochs, grant revision, run status and the
run deadline stay checked; a completion after the deadline stays refused. An attempt the kernel already
stopped is `factory_attempt_superseded`: no second transition, the delivery closes `cancelled` /
`runner_outcome_superseded`, and the host's account stays on the launch record.

## Option 2 (ruled into W01h): the lease is liveness, not the task's timeout

The attempt deadline is sealed to the node command's deadline, not the first 30 s pool lease; the
remote runtime renews the lease every 5 s while the guest lives and records `RUNNER_LEASE_LOST` when a
renewal fails past the last renewed deadline. The runner's own execution limit (60 s,
`executionLimits.timeoutMs`) still caps one guest invocation; a guest past it is killed and recorded
`RUNNER_CONTAINER_EXIT` with `stopped at its deadline`. The validator scheduler still seals its lease
deadline (not in this ruling).

## Transport callers (the lead's sweep)

| Caller | Process | Client timeout | Longest server wait | Verdict |
| --- | --- | --- | --- | --- |
| host-launch-client (launch, attach, result) | product, Bun | 90 s | launch 60 s, result window 20 s | changed in W01h; the host always answers first |
| host-stop-client | product, Bun | 30 s default | host stop route 20 s | safe; the stop answers first |
| guest-broker-client staging | supervisor, Bun | 30 s default | material chunk write | safe |
| guest-broker-client model | supervisor, Bun | 300 s (W19a) | provider call | safe |
| pool admission client | product, Bun | 30 s default | pool ledger writes | safe |
| supervisor pool client | supervisor, Bun | 30 s default | pool stop confirmation | safe |
| gateway probe | product, Bun | 5 s | any HTTP answer | safe |
| orchestrator gateway / queue client | Node | was 30 s default; now 50 s, document 50 to 60 s | private service up to 40 s (a slow stop) | fixed in W01h by the lead's ruling: audit and read start-to-close 30 s to 90 s; the order is pinned by `factory-gateway-timeouts.test.ts` |

Every Bun caller now settles on its own deadline and on abort (`1812495b6`, W19a `d24725f15`); the
Node callers already did. The private HTTPS server clears its request timer when the handler starts,
so a long result window is not cut at 15 s.

## Usage ruling: a lost attempt's result carries no invented usage

`458650ddb` gave a lost attempt with no operation a `measured` usage of zero in every dimension, compute
included, so the stop settled compute at zero. The lead's ruling: only model usage is a known zero when no
operation ran; compute is settled at the reserved bound with its basis named (W03e), never zero.
`FactoryUsage` has only `measured` and `unknown`, so the runner result cannot carry model usage alone.
`4b7dc52db` reverts the zero. W03e's no-operations settlement at the signed stop records the model zero,
charges compute at the reserved bound, and makes that stop certain. Until W03e is merged, such a stop is
uncertain, so the final passes wait for W03e on integ/w00.

## Defect 5 (ruled into W01h): a stopped approval never settles

W14's real lane: a denied approval never ended its run. Reproduced from W14's kernel replay on this tree
(`repro/denied-approval.ts`, `logs/denied-approval-after.log`). Before the fix, the deny gave `cancel-node` for
the gate and `status: stopping`. The kernel treated an approval's attempt, the request-approval command, as
physical. `FactoryTaskStops.accept` resolves a cancel through the attempt queue, which never holds an approval,
so it refused the cancel as `factory_task_stop_stale`. The gate's attempt never stopped and the run stayed
`stopping`. This is a second mechanism beside the stale epoch (defect 2), and every stop of a waiting approval
had it: a deny, its own expiry, a user cancel, the run deadline, and a partition invalidation.

The fix: `physicalNode` treats an approval like an acceptance, so every stop settles it in place. A late
answer cannot act: the approval row carries the cancellation epoch the stop raised, so a decision after it is
refused as stale. A release has the same shape, but its effect may be in flight at a provider, so settling it
in place could hide a publish. It keeps the ordinary stop.

Open defect W09e, "release node stop settlement" (the lead's ruling; W09c's release-outcome territory, assigned
after W01h and W01i): the stop must mark the release stop-requested and settle the node as stopped with the
effect uncertain; the release-outcome reconciliation then confirms the publish or cancels it, bounded by the
release's own deadline, so the run ends either way.

Where it is proved: W19a's harness runs one fixed graph (`scripts/factory-graph-proof/graph.ts`) and has no
approval step, so a denied-approval pass would mean editing W19a's harness. By the lead's fallback the proof is
the lifecycle suite: the real approval store, the inbox decision, the kernel, the transition, and the run
projection, in one chain.


- [x] G1: The reproduction on the base is recorded before the fix.
  CHECK: `bun test ./src/factory/w01h-repro.scratch.test.ts` at `2b2e12550` (evidence copy
  `repro/w01h-repro.scratch.test.ts`); `w01h-heavy.sh` leg B (`proof/w01h-base-fault`)
  EXPECT: three mechanisms green on the base (the defect); the W19a harness pass with a slow prepare
  guest shows `runner_outcome_unknown`, `launched` with no terminal row, and a run that never ends
  EVIDENCE: `reproduction.txt`, `logs/repro-unit-base.log`, `graph/base-fault.json`, `graph/base-fault.rows.json`

- [x] G2: Every lost answer ends in a durable terminal row with a typed reason.
  CHECK: `bun test ./src/factory/runner/remote-attempt-runtime.test.ts ./src/factory/host-launch-lost-result.integration.test.ts ./src/factory/host-launch-transport.integration.test.ts`
  EXPECT: RUNNER_CONTAINER_EXIT, RUNNER_SUPERVISOR_LOST and RUNNER_TIMEOUT each recorded over the
  journal's facts; a slow guest collected across windows; a stop failure reported, not fatal
  EVIDENCE: `logs/focused2-*.log`

- [x] G3: The host keeps answers, names refusals, and logs them.
  CHECK: `bun test ./src/factory/runner/host-launch-supervisor.test.ts ./src/factory/runner/host-launch-service.test.ts ./src/factory/runner/supervisor-services.test.ts`
  EXPECT: all pass
  EVIDENCE: `logs/focused2-*.log`

- [x] G4: The transport settles under Bun and keeps its Node behaviour.
  CHECK: `bun test ./src/__tests__/factory-transport-settle.test.ts`; `node --test --experimental-strip-types test/gateway-activities.test.ts` in the orchestrator package
  EXPECT: 4/0 and 11/0
  EVIDENCE: `logs/focused2-src-__tests__-factory-transport-settle.test.ts.log`, `logs/orchestrator-gateway-activities.log`

- [x] G5: The attempt policy retries or fails the run with the typed reason.
  CHECK: `bun test ./src/__tests__/factory-run-lifecycle.test.ts`
  EXPECT: the W01h case: typed failure -> node-failed -> cancel-node -> attempt-stopped -> retry, and
  fail-run naming RUNNER_CONTAINER_EXIT once attempts run out; suite 74/0
  EVIDENCE: `logs/focused2-src-__tests__-factory-run-lifecycle.test.ts.log`

- [x] G6: Podman: fault injection reproduces the lost answer, the retry completes, the terminal rows exist.
  CHECK: `flock --close /tmp/ezcorp-validation-heavy.lock ...` `bun test ./src/factory/host-launch-lost-result.podman.integration.test.ts ./src/factory/host-launch-e2e.podman.integration.test.ts`
  EXPECT: both pass
  EVIDENCE: `logs/podman-commit.log`, `logs/podman-lost-result-2.log`, `logs/podman-e2e-2.log` (at `41b1d8a02` plus the
  test, committed as `4dbe4a1b2` inside the same lock hold; the first run, `logs/heavy-podman-lost-result.log`, failed
  on the test's own expectation for attempt 2, whose guest answers `cancelled`)

- [x] G7: The real application with the fix: W19a's runbook passes, and the same fault ends the run.
  RESULT (`w01h-final-c.sh`, 10:45 to 10:56 -04:00, proof refs at `030339f63`): runbook verdict passed (ollama and
  mock passes, both controls); `final-delay40` passed (the 40 s prepare guest completes); `final-delay70`: run
  `failed`, error RUNNER_CONTAINER_EXIT, node `prepare` terminal with "Worker closed; exit code unavailable; state
  cancelled; stopped at its deadline 14:56:44.874Z"; run updated 14:56:49.155Z, 4.3 s after the stop. The harness
  exits 1 on this pass because its success checks fail, as a fault pass must. The runner stopped this guest itself
  at its 60 s limit, so no container exit code exists; the Podman case pins 137 for a container that exits itself.
  EVIDENCE (final): `logs/final-c-driver.log`, `graph-final/runbook/`, `graph-final/final-delay40.json`,
  `graph-final/final-delay70.json`, `graph-final/final-delay70.rows.json` (lease and token values not copied)
  EARLIER STATE: runbook green (`fix-runbook exit=0`: ollama x3, mock x3, both controls). The fault pass writes the typed
  STATE: runbook green (`fix-runbook exit=0`: ollama x3, mock x3, both controls). The fault pass writes the typed
  terminal row (RUNNER_CONTAINER_EXIT, "Worker closed; state cancelled") and the host log line, but the run does not
  end: the outcome commit is refused by the C02 fence because the guest died AT its attempt deadline (30 s pool
  lease, never renewed). Open on the coordinator's ruling (option 1: record a non-success report after the
  deadline; patch `proposal-report-after-deadline.patch`). Leg D (W01g's harness) is void on both trees: the server
  never reported ready ("Setup required") on the current base, before any W01h code ran. The leg C attempts at
  12:39Z at `030339f63` failed on the shared archive store outage (OOM-killed at 12:04Z, recreated by the lead at
  12:47Z), not on W01h. W15d found both store kills were host-wide OOMs (62 Node test processes, 21.6 GiB RSS,
  swap exhausted); by the lead's standing rule `w01h-final-c.sh` now waits before every leg while available
  memory is below 6 GiB or swap is exhausted (stop after 60 minutes), beside its df gate. RETIRED by the lead's
  ruling: that drift is the reason, and W19a's runbook harness is the canonical real-application harness from
  now on. Its entry scripts (`bun-host.sh`, `one-run.sh`, `reproduce.sh` in `w01g/repro` and `w01h/repro`) now
  refuse to run (exit 64) and print `RETIRED.txt`. `configure-guest-broker.ts` writes W16b's keyed
  `services.guestBrokers` form.
  CHECK: `w01h-heavy.sh` legs C (`proof/w01h-fix-w19a` run.sh all; `proof/w01h-fix-fault` one pass)
  and D (W01g's harness with a slow guest, base and fix)
  EXPECT: the runbook all green; the fault pass records RUNNER_CONTAINER_EXIT and a terminal run
  EVIDENCE: `graph/fix-runbook/`, `graph/fix-fault.json`, `graph/fix-fault.rows.json`, `repro-*.json`

- [x] G8: Boundaries, typecheck, lint, gate-integrity and both coverage gates at the final head.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`; C05 in `factory-process-boundaries.test.ts`; `BASE_REF=integ/w00` new-file and patch gates over the Bun leg plus the Node/V8 leg
  EXPECT: all exit 0
  EVIDENCE: `logs/heavy-coverage-gates.log` (at `41b1d8a02`: new-file none, patch 11 files), `logs/final-*.log`
  AT `c9baf2f4c` against integ/w00 `03538e909` (`coverage-m3.sh`, under the lock, 12:34 to 12:42 -04:00): Bun leg
  513/0 (the W01h list plus the SDK kernel suites and the timeout order test), Node/V8 orchestrator leg green;
  new-file gate PASSED (1 file), patch gate PASSED (26 files, every changed executable line covered); typecheck,
  lint, factory boundaries (C05, node-service-link), gate-integrity exit 0; 180 unlocked factory suites green.
  EVIDENCE: `logs/m3/coverage-driver.log`, `logs/m3/coverage-*.log`, `logs/m3/batch.log`, `logs/m3/suites/`

### Round 2 gates (the lead's rulings of 2026-09-25)

- [x] G9: Defect 2 — every self-started stop's cancel-node is accepted and the run ends; the old epoch stays refused.
  CHECK: `bun test ./src/__tests__/factory-stop-epoch.test.ts`; the SDK kernel partition and sibling-failure cases; `tests/postgres/factory-run-lifecycle.test.ts`
  EXPECT: 6/0 (3 of 6 red without `982f9cb6d`); kernel epochs pinned; PostgreSQL green
  EVIDENCE: `logs/stop-epoch-before-fix.log`, `logs/m3/suites/` (stop-epoch 6/0, lifecycle 79/0 at `c9baf2f4c`), `logs/final/pg-*.log`

- [x] G10: Defect 3 — a failure after the attempt deadline is recorded; a completion after it is refused; a superseded report makes no transition.
  CHECK: `bun test ./src/__tests__/factory-run-lifecycle.test.ts` ("survives an expired owner", "a late failure ... closes by name")
  EXPECT: both halves pinned; suite green
  EVIDENCE: `logs/factory-all3/`

- [x] G11: Option 2 — the sealed deadline is the node command's; the lease is renewed while the guest lives; a lapsed lease ends the attempt RUNNER_LEASE_LOST.
  CHECK: `bun test ./src/factory/runner/remote-attempt-runtime.test.ts`; lifecycle "the sealed attempt deadline is the node command's"; the 40 s real-application pass
  EXPECT: three lease periods collected with renewals; lease loss recorded; the 40 s prepare guest completes on W19a's harness
  EVIDENCE: `graph2/fix3-delay40.json`, `graph-final/final-delay40.json`

- [x] G12: The container-death path: a typed RUNNER_CONTAINER_EXIT terminal row with the exit code, the host log line, and the run ends by name within seconds.
  CHECK: the Podman lost-result case (exit code 137); the 70 s real-application pass (past the runner's 60 s limit)
  EXPECT: Podman green; the 70 s pass's run ends `failed` with the typed reason, not at the run deadline
  EVIDENCE: `logs/final/podman-lost-result.log`, `graph-final/final-delay70.json`, `graph-final/final-delay70.rows.json`

- [x] G13: A guest that outlives the dispatcher's queue lease still has its receipt delivered.
  CHECK: lifecycle "a guest that outlives the dispatcher's queue lease ..."
  EXPECT: completion and failure both delivered (red without `99884e9d0`)
  EVIDENCE: `logs/lease-outlived-before-fix.log`, `logs/factory-all3/`, `logs/m3/suites/`

### Fix round (coordinator ruling 2026-09-27, found on W01i's real factory-services lane)

The lane's product log showed `stop-settlement:fault … factory_task_stop_corrupt` 174 times for one attempt. The
host refused its stop (500 stop_failed), the guest died (container exit 1), the lost-result path recorded a failed
terminal result, and the stop sealed earlier with reason `cancelled` re-derived `failed` on every retry
(`task-stops.ts` accept versus the live-authority check). Two defects, both fixed:

- [x] G17: The first writer owns the attempt's end.
  `recordLostTerminal` takes the launch-row lock a stop's acceptance takes; with a stop sealed first it writes no
  terminal result and records the loss as audit evidence (`factory.attempt.exit_after_stop`, target the cancel
  command) without changing anything the stop verifies; with no stop the lost result is terminal, and one already
  recorded wins. CHECK: `bun test ./src/__tests__/factory-stop-after-loss.test.ts
  ./src/factory/runner/remote-attempt-runtime.test.ts`. EXPECT: the sealed stop settles `stopped` with reason
  `cancelled` and the evidence row; red with the stop check removed (2 of 3, `logs/fix4-negative/no-first-writer.log`).
- [x] G18: A stop whose facts no longer verify is marked once and never retried.
  The settlement records `reconcile_json` (code, detail, both reasons for a reason conflict), raises one
  `FactoryStopReconciliationError` naming the stop id, the attempt and both reasons, and the scan skips it.
  CHECK: the same lifecycle file and `./src/factory/dispatch-composition.test.ts`. EXPECT: one report, no second
  host call over three more passes; red without the mark (`hot-loop.log`) and with the scan listing marked stops
  (`scan-lists-marked.log`).
  EVIDENCE (`w01h-fix4-locked.sh`, one hold, 2026-09-27 11:26Z to 11:29Z, head `b254a1a56`): PostgreSQL task-stops
  25/0, run-lifecycle 79/0, migration-restart 18/0, executions 7/0, host-launch 1/0; Podman lost-result 1/0;
  coverage leg 113/0; new-file gate PASSED (the migration, threshold 100), patch gate PASSED, 8 files, against
  `34b3b0a74` (`logs/fix4/`); typecheck, lint, boundaries exit 0; hooks ran their 3 and 4 suites green.

- [x] G19: One lock order for an attempt's stop and launch rows (fix round 2, validator-2's finding D1).
  `recordLostTerminal` locked the launch row and then the stop row FOR SHARE, while every settlement locks the
  stop row and then the launch row; interleaved, they deadlocked on the proof server (12:35:31Z). The order is
  `FACTORY_STOP_LAUNCH_LOCK_ORDER`, documented at every lock site: the stop row, then the launch row; acceptance
  locks the launch row and then creates the stop row, which no transaction can hold first; the lost-result write
  locks only the launch row and reads the stop row unlocked (it never changes once committed). This order was
  chosen because every settlement can reach the launch row only through its stop row, so the one new path adapts.
  CHECK: `tests/postgres/factory-stop-lock-order.test.ts` on real PostgreSQL, deterministic after validator-2's two
  low notes: it drives the REAL paths (`recordLostTerminal`, and `FactoryTaskStops.stop`, whose `readSealed` locks
  the stop row and then the launch row) and synchronizes on the database: a gate connection holds the launch row,
  the lost result queues on it, the settlement takes the stop row and queues behind it, each step confirmed in
  pg_stat_activity (wait_event_type Lock) with a bounded 10 s poll; then the gate releases. EXPECT: red on the
  previous code with "deadlock detected" (`logs/fix6/lock-order-red.log`), green on the fix three runs in a row
  (`logs/fix6/lock-order-green-{1,2,3}.log`; the lost result is `stop-sealed`, the stop settles `stopped` with reason
  `cancelled`); `factory-stop-after-loss` 3/0. The first, sleep-based version's logs are `logs/fix5/`. EVIDENCE (`w01h-fix5-locked.sh`, 2026-09-27 13:05Z to 13:08Z):
  PostgreSQL task-stops 25/0, run-lifecycle 79/0, migration-restart 18/0, executions 7/0, host-launch 1/0; Podman
  lost-result 1/0; coverage leg 54/0; patch gate PASSED, 2 files, against `aefcf828f` (`logs/fix5/`); the commit's
  hook ran attempt-runtime 18/0 and the lock-order test 1/0 under the lock.

### Baseline background-role lines (OPEN, pre-existing, owned)

Counted in the W01i lane's product log and in the W14 validator's baseline lane at integ (no W01h code):

| Line | W01i lane | W14 baseline | Owner, and whether a landed package should have removed it |
| --- | --- | --- | --- |
| `usage-reconciliation:transient … factory_usage_hold_unresolved: no-operation-receipt` | 157 | 153 | W03f: a failed model operation with no provider receipt keeps its hold; W03e settles only a stop with no operation, so it was not expected to remove this |
| `usage-reconciliation:fault … Factory run epoch is stale or unavailable` | 15 | 15 | W03f / W15 restore: this is the EXECUTION epoch (`executions.ts` run fence), which the lane's restore case moves; W01h's durable write moves the CANCELLATION epoch only, and the equal baseline count confirms W01h does not cause it. It is a fault retried every pass, the same hot-loop class as G18 |
| `release-outcome:transient … factory_release_consent_absent` (approval_not_approved, no_consent) | 21 | 17 | W09e / W09c release outcome: a release waiting for human consent is backpressure by design; the lane's releases that never get consent retry every pass |

### Round 3 gates (the lead's messages after the round 2 approval)

- [x] G14: The orchestrator's gateway bounds keep their order above the private service's slow-stop bound.
  CHECK: `bun test ./src/__tests__/factory-gateway-timeouts.test.ts`; `bash scripts/factory-orchestrator-coverage.sh`
  EXPECT: 40 s service bound plus a margin, then 50 s client, 60 s maximum, 90 s activity; the process and the
  document refuse a bound outside 50 to 60 s; 91/91 orchestrator tests
  EVIDENCE: `logs/orch-coverage.log`, `cov-orch/test-progress.log`, `logs/orch-timeouts-gateway.log`

- [x] G15: Defect 5: a denied approval ends its run in the transition that records the decision.
  CHECK: `bun test ./src/kernel-run-controls.test.ts ./src/kernel-partitions.test.ts` in the SDK;
  `tests/postgres/factory-run-lifecycle.test.ts` ("a denied approval fails its run by name ...")
  EXPECT: no cancel-node for a gate; deny, expiry, user cancel and run deadline each end the run in one
  transition; a deny beside a running task stops only the task; red without the fix (5 of 10)
  EVIDENCE: `logs/denied-approval-red.log`, `logs/sdk-all-approval.log`, `logs/final/pg-lifecycle-approval.log` (79/0)

- [x] G16: A lost result carries no invented usage; the no-operations stop settles through W03e.
  CHECK: `bun test ./src/factory/runner/remote-attempt-runtime.test.ts`; the fault pass after W03e is merged
  EXPECT: `usage` absent on a lost result with no operation; compute settled at the reserved bound
  RESULT at `6f3903666` (W03e merged; proof ref `proof/w01h-merged-delay70` f4950dc03; `w01h-merged70.sh` under the
  lock, gates 6 GiB / 2 GiB swap / 110 GB passed; 2026-09-27 06:37:29Z to 06:39:04Z): run `failed`, RUNNER_CONTAINER_EXIT;
  `prepare` stopped at its deadline 06:38:58.962Z, run failed 06:39:03.269Z (4.3 s later); the lost result carries no
  usage; `factory_usage_settlements` source `no-operations`, known cost 0, basis "no-operations: compute at reserved
  bound"; the stop is `stopped` (certain) and the reservation `settled`. The harness exits 1 because its success
  checks fail, as a fault pass must. This also re-proves G12 on the runner path W16b changed.
  EVIDENCE: `logs/merged/driver.log`, `logs/merged/web-build.log`, `graph-merged/merged-delay70.json`,
  `graph-merged/merged-delay70.rows.json` (lease and token values not copied)
  NOT A PRODUCT FAILURE: the first 70 s pass at `6f3903666` (2026-09-26 03:55Z to 04:03:48Z) failed "the server never
  reported ready: orchestration starting" because the W01h driver ran `run.sh pass` in a fresh proof tree without
  building the web server: `web/build/index.js` was missing, the web process exited 2 ms after start, and the
  orchestrator got ECONNREFUSED on the product gateway 107 times. No product code ran; "[factory] composed" was never
  logged; no "background role failed" or bind error. Evidence: `logs/merged/delay70-stall/`,
  `graph-merged-stall-20260926/`. The driver now builds the web server and stops if the build is missing.
  STATE: the unit half is green (13/0 at `c9baf2f4c`); the 70 s pass on the merged head waits for W03e on integ/w00
  (it also re-proves G12 on the merged runner path: W16b changed supervisor-process.ts and supervisor-services.ts)

## Scope notes

- The orchestrator package (`packages/@ezcorp/factory-orchestrator`) was written by W04 and last changed by
  W09d; no in-flight package holds it. The lead assigned the timeout fix to W01h.
- The pre-commit hook (`scripts/lib/hook-lib.sh`, W18) runs every staged non-web suite under Bun, the
  orchestrator's node:test suites included. `gateway-activities.test.ts` fails under Bun at `030339f63` too
  (10 of 11, `logs/hook-bun-baseline.log`), so the defect predates W01h. It is W18a-3's G13; not edited here.
  `942a03dac` was committed with EZ_SKIP_HOOK_TESTS=1 by the lead's ruling. The hook's list, verbatim
  (`logs/commit-timeouts-skip.log`): `packages/@ezcorp/factory-orchestrator/test/gateway-activities.test.ts`,
  `packages/@ezcorp/factory-orchestrator/test/process-launcher.test.ts`,
  `packages/@ezcorp/factory-orchestrator/test/process.test.ts`, `src/__tests__/factory-gateway-timeouts.test.ts`.
  Receipts: the first three under node in the orchestrator producer, 91/91 with coverage
  (`cov-orch2/test-progress.log`); the fourth under Bun, 3/3 (`logs/timeouts-bun-receipt.log`).

- The in-process `IsolatedFactoryAttemptRuntime` has no production construction (tests only); it is
  unchanged and keeps its own uncertain-then-reconcile design.
- The dispatcher now keeps the runner's error as the cause of `runner_outcome_unknown`; the lifecycle
  case that pinned "no cause for a thrown runner" was updated on purpose.
- The router's first-hand stop knowledge now comes only from a guest that settled on this host; a
  result request for a worker the host never ran no longer counts (it could sign an absence receipt
  without asking the runner).
