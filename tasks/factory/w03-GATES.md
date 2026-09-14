# Gates: W03 physical stop, cancellation, and budget settlement

Scope: `docs/plans/2026-09-13-composable-factory-platform-completion.md` section 5, W03. Interface
freeze surfaces 3, 4, and 8, plus the C03 scheduling audit lead. Receipts live under
`/tmp/factory-platform-evidence/w03/`; each `<label>.json` records the producing commit, dirty and
untracked file hashes, the exact command, the exit code, UTC start and end, test counts, and the
log's SHA-256. Raw logs sit beside them as `<label>.log`.

Branch `wp/w03-stop-settlement`. Base `integ/w00` at `88effb159`.

## Commits

| Commit | Subject |
| --- | --- |
| `f1e396948` | `feat(factory): share journal fact validation` (freeze section 8) |
| `683f26f35` | `feat(factory): type live stop authority` (freeze section 3) |
| `1d591eeaa` | `feat(factory): type usage settlement` (freeze section 4) |
| `a947c3853` | `fix(factory): end each pool round so no tenant starves` |
| `c11899dcc` | `feat(factory): stop a live attempt and terminate its sandbox` |
| `1a4ab1e65` | `feat(factory): authenticate the host stop transport` |
| `1688d5263` | `test(factory): cover recovery after a pool release and cancellation during admission` |
| `cfb9a3a8c` | `chore(factory): declare the stop and settlement C13 reuse edges` |
| `c2d6f27d1` | `fix(factory): stop the pool suite spinning on an undriven lazy SQL query` |
| `9c28eda43` | merge `integ/w00` |
| `741faf6c6` | `feat(factory): type validator admission origin` (cherry-pick of W05's `1e6a95668`) |
| `310d3da5f` | `fix(factory): share one root envelope between the restart cases` |
| `97fb7ab16` | **`feat(factory): admit a protected validator origin`** — the commit W05 is waiting on |
| `a957835f7` | `docs(factory): record the W05 checkpoint, the lock incident, and the merge` |
| this commit | `docs(factory): cross-tabulate ownership crossings and correct two overclaims` — the ACCEPT-WITH-FIXES items W03-1, W03-4, and W03-5. Its own SHA is reported to the coordinator, since a commit cannot contain its own hash. |

## Four defects found by running the contracts

1. **The pool round never ended, and every tenant but one starved.** Measured before any change,
   three persistently queued tenants at weights 1, 3, and 2 with capacity released each round: the
   admitted trace over nine rounds was a, b, c, a, a, a, a, a, a. `isRoundEligible` let a served
   tenant run again whenever no peer was still unserved, so once every tenant had taken its turn
   the round-member reset never fired. Ordering then fell to the dominant service score, which
   counts only active service and returns to zero as work finishes, and finally to the tenant id.
   The sixteen existing tests never saw it because none releases capacity. Fixed in `a947c3853`;
   the trace afterwards is exactly round-robin.
2. **The guest shim discarded every graceful stop.** A container's PID 1 gets no default signal
   action, so the C02.14 abort reached nothing: 41 cleanup observations and the full ten-second
   grace, then a kill. The shim now forwards SIGTERM to the extension, which is not PID 1. The same
   real-Podman case finishes in 6.4 s with no kill, and the whole Podman suite still passes 27/27.
3. **Every launch read failed on real PostgreSQL.** `rowIntent` decoded `jsonb` only in its PGlite
   object form; the real engine's driver returns a string, so the stored request validated as a
   JSON string literal and raised `RUNNER_REQUEST_SCHEMA`. A sibling reader in the same file
   already handled both.
4. **A cancelling run could not be stopped.** `authorizeRunInTransaction` allowed only
   `queued|running|waiting`, so the moment an operator cancelled a run, nothing could stop its
   attempt. C02 requires a cancelling attempt to keep its stop authority until its stop event
   commits, and settlement continues after new dispatch stops.

## Incident: the pool PostgreSQL suite spun for 50 minutes holding the shared heavy lock

The coordinator stopped `bun test ./tests/postgres/factory-pool.test.ts` (pid 3540823) after it
ran 44 minutes of CPU in state R with zero output, holding `/tmp/ezcorp-validation-heavy.lock`
while W02, W05, and W09 queued behind it.

**Root cause, reproduced.** Not the fairness code. `Bun.sql` returns a lazy `SQLQuery` that
executes only when something adopts it, and handing one straight to `expect(...)` does not adopt
it. Measured against the real engine on Bun 1.3.14:

| form | result |
| --- | --- |
| `await expect(sql.unsafe("SELECT 1/0")).rejects.toThrow()` | state R, 100% CPU, CPU time 10 s at t=10 s and 25 s at t=25 s, no output, never completes |
| `await Promise.resolve(sql.unsafe("SELECT 1/0")).then(ok, err)` | rejects in 6 ms |

The spinning assertion was the vocabulary-drift test, which asserts the durable CHECK constraint
refuses `requested`. It burned its 300-second timeout at full CPU, and the orphaned process kept
the inherited `flock` descriptor after its wrapper was killed, which is why the lock stayed held
long after the run was stopped. PGlite hands back a real promise, so this never reproduced there
and only the real-engine lane saw it.

**The coordinator's hypothesis is excluded by evidence.** `src/factory/pool/ledger.ts` contains no
`while`, no `for (;;)`, no `do`/`while`, and no `setInterval`; all eighteen `for` loops iterate
finite collections. The round-robin change cannot spin.

**Permanent guard.** `src/factory/pool/lazy-sql-assertions.test.ts` parses the pool suite and the
pool test files and fails on any `expect(<x>.unsafe(...))` or `expect(<x>.begin(...))`. It is
static on purpose: the failure mode is a hang, a runtime guard would have to race a clock, and a
spinning test is worse than a failing one. Verified both ways by restoring the pre-fix line: the
guard fails in 27 ms on the old code and passes on the fixed code.

**After the fix**, the same suite under the lock with a 120-second per-test timeout finishes in
**3.0 seconds**, 21 pass, 0 fail (`pool-postgres-after-spin-fix.json`). Heavy runs are now issued
one at a time.

## Note on the shared `core.bare` breakage

The coordinator repaired `core.bare` in this worktree at 21:30 EDT. No W03 commit or producer
failed in that window: the tree was clean at every commit boundary, all ten commits landed, and
the fifteen uncommitted files the coordinator saw were work in flight that committed normally
afterwards. Nothing was retried and no receipt is affected.

## Landed deviations from the freeze, and why

1. **`validateFactoryStopReceipt` takes `FactoryPhysicalStopExpectation`, not `FactoryTaskStopRequest`.**
   Section 8 is a wave-A checkpoint and section 3 is wave B, so the section 8 module cannot import
   the stop store's request type without inverting the wave order. The expectation is the exact
   sealed subset the validator compares, and `FactoryTaskStopRequest extends` it, so every call
   site passes its whole sealed request unchanged.
2. **Migration registry position.** The freeze numbers `add-factory-task-stops` 34 and
   `add-factory-usage-settlements` 36. W04's entry 37 landed first and `src/db/migrate.ts` is
   append-only, so both W03 entries are appended after it. The only real ordering constraint,
   running after `add-factory-attempt-launches`, holds.
3. **`FactoryLiveStopAuthority` gains `terminalResult`.** Freeze section 16 moved the durable
   terminal result onto `factory_attempt_launches`, which the sketch did not anticipate. A live
   cancellation whose guest finished before the stop can therefore settle a measured cost with no
   outcome row.
4. **`stop()` short-circuits only on a settled stop.** The Phase B form returned any stored
   receipt, which made durable uncertainty terminal and unretryable. Uncertainty is now retryable
   and reuses the sealed request, so a retry mints no second stop identity.
5. **No second authority path for quarantine and revocation.** Freeze open question 8 recommends
   one for W02. `factory_task_stops` is keyed by its cancel command and carries a foreign key to
   `factory_transition_commands`, so a quarantine stop with no `cancel-node` command needs its own
   record shape, not a second branch in `withCurrentCancellation`. Filed to W02 below.

### Files changed outside W03's owned set

`c11899dcc` is the only commit that crosses an ownership boundary. Every crossing, against freeze
section 12's table:

| File | Section 12 owner | Why it changed here |
| --- | --- | --- |
| `src/factory/executions.ts` | Terra runtime (W01) | The stop needs `cancelInTransaction`, `acceptCancellationInTransaction`, `confirmStoppedInTransaction`, and `readAuthorityInTransaction`, so it can name the holder it is fencing without the dispatch command. Section 12 already says "W03 files the usage type change" against this file. |
| `src/factory/run-lifecycle.ts` | Sol controls (W06) | `authorizeRunInTransaction` allowed only `queued\|running\|waiting`, so an operator cancellation made its own attempt unstoppable. Gains `allowCancelling`, passed by the cancellation path only. |
| `src/factory/runner/attempt-runtime.ts` | Terra runtime (W01) | `readFactoryAttemptLaunchFacts` for the sealed stop facts, the `storedJson` correction that made every launch read fail on the real engine, and the three-phase C02.14 stop. |
| `packages/@ezcorp/extension-contract/src/types.d.ts` | Terra runtime | One optional `Runner.abort`. Section 12 scopes this file to "`StartRequest.devices` only", so this is a widening of that scope. |
| `packages/@ezcorp/extension-runner/src/podman.ts` | Terra runtime (C13 shared) | Implements `abort`, and gives the guest shim the SIGTERM handler without which a container's PID 1 discards every graceful stop. |

Two further files W03 does not own changed in later commits: `src/db/factory-schema.ts` and
`src/db/migrate.ts` (Coordinator), for the two W03 migrations and the validator-admission event
constraint, and `src/__tests__/helpers/factory-migration-restart-suite.ts` (Coordinator), which
section 12 says every new migration adds a case to.

## Filed to other owners

- **W14 (`web/src/routes/api/factories/_shared.ts`).** `FactoryTaskStopCode` is a union of eleven
  members exported as `FACTORY_TASK_STOP_CODES`, and `FactoryUsageSettlementCode` a union of eight
  exported as `FACTORY_USAGE_SETTLEMENT_CODES`. Neither maps to an HTTP status, so a stop failure
  surfaces as a 500. This closes freeze correction 6 on the producing side. Recommended statuses:
  `factory_task_stop_scope` 403; `factory_task_stop_key_invalid` 500;
  `factory_task_stop_invalid` 400; `factory_task_stop_corrupt` 500;
  `factory_task_stop_not_found` 404; `factory_task_stop_conflict` 409;
  `factory_task_stop_stale` 409; `factory_task_stop_pool_mismatch` 409;
  `factory_task_stop_proof_invalid` 422; `factory_task_stop_clock_invalid` 422;
  `factory_task_stop_timeout` 504. For settlement: `_scope` 403, `_not_found` 404, `_conflict` and
  `_regressed` and `_state` 409, `_invalid` and `_receipt_invalid` 400, `_corrupt` 500.
- **W09 (`src/factory/private-https.ts`).** C03 requires HTTP 429 **with a `Retry-After` header**.
  The 429 status now ships and the body carries `retryAfterSeconds`, but `FactoryPrivateResponse`
  has no response-header field and `respond()` writes a fixed header block. The exact two-step
  change is written in `docs/factory-pool-admission.md`. The pool client already prefers a
  `Retry-After` delta-seconds header over the body, proven against a real header-capable TLS
  server, so no client work follows.
- **W02 (package quarantine and revocation authority).** A quarantine or lease-revocation stop has
  no `cancel-node` command, so it cannot use `factory_task_stops`, whose primary key is the cancel
  command and which has a foreign key to `factory_transition_commands`. It needs its own sealed
  record, or a nullable cancel command plus a second source member. W03 owns
  `command-authority.ts` and will land whichever shape W02 asks for.
- **W01/W05 (journal cursor versus SDK cursor for a lone uncertain operation).** The journal sets
  `journal_cursor` to `MAX(operation_index)` once nothing is prepared or dispatched, while
  `validateFactoryRunnerResult` requires an uncertain operation's index to exceed the cursor. A
  terminal result whose only operation is `uncertain` therefore cannot be both journal-consistent
  and SDK-valid. W03 worked around it by using the `uncertain` terminal status, which carries the
  held cost with no operations. Evidence: `final-focused.log`.

## W05 unblocking checkpoint: `97fb7ab16`

W05 stated the requirement exactly in its own gate file and did not guess at it. Landed as asked:

- `command-authority.ts` gains `withCurrentAdmission`, which routes one poll by origin. A
  `protected-validator` origin is authorized through the same acceptance path every other
  acceptance effect uses; everything else keeps the exact execution path it had.
- `compute-admissions.ts` keys a validator reservation with `factoryReservationIdForOrigin` and
  requires the origin's `acceptanceCommandId` to be the live acceptance command. Ordinary task work
  is still keyed from its committed context, and a carried `dispatch-node` origin must agree with
  it, so an origin can never re-key a live run.
- No `admission-result` for a validator origin: none is built, none is enqueued, none is stored.

That last point needed a durable rule, not just a code path. The pre-existing constraint said a
settled admission always carries an event, so a validator admission could not settle at all.
`add-factory-validator-admission-event` replaces it with a conditional one that is **tightened**:
a validator admission may never carry an event in any state, and every other origin still must once
it settles. The original was unnamed inside `CREATE TABLE`, so a fresh database and an upgraded one
had different names for it; the migration finds it by definition and installs one named
replacement.

`src/factory/admission-origin.ts` came from W05's `1e6a95668`, cherry-picked because it is not yet
in `integ/w00`. Two edits to that commit's content, both because the surrounding files differ here:
the threshold key for `allow-factory-validator-multiclaim.ts` is dropped, since that migration is on
W05's branch and not in this tree, and `expectedIndexes` gains only the index that commit creates.

**A collision the cherry-pick exposed.** W05's restart case and mine were written in different
packages against the same fixture run, and each minted its own parentless budget envelope.
`factory_budget_root` allows one per run, so whichever ran second failed. Both now join the run's
single root envelope, so neither depends on the other's position (`310d3da5f`).

## Gates

- [x] G1: The outcome, stop, and usage rules live in one module, and the journal boundary is typed.
  CHECK: `bun test --timeout 30000 ./src/factory/journal-validation.test.ts`
  EXPECT: exit 0; `src/factory/journal-validation.ts` at 100% lines and functions
  EVIDENCE: `final-focused.json`. `FactoryOperationSettlement.usage` is `FactoryUsage` and
  `workspaceCheckpoint` is `FactoryCheckpointReference`; terminal cost is compared as `BigInt`,
  proven with a value above `Number.MAX_SAFE_INTEGER`.

- [x] G2: A stop row exists without a terminal outcome, and never without a sealed launch.
  CHECK: `bun test --timeout 60000 ./src/db/migrations/add-factory-task-stops.test.ts ./src/__tests__/factory-migration-restart.test.ts`
  EXPECT: exit 0; a `sealed-launch` row with a NULL `attempt_command_id` inserts, a
  `terminal-outcome` row without one is refused, and a stop for an unlaunched attempt is refused
  EVIDENCE: `final-focused.json`; real-PostgreSQL schema parity in `final-postgres.json`.

- [x] G3: One idempotent `usage-settled` event per revision, enqueued with `attempt-stopped` in one
  transaction, and an unknown provider cost is never settled as zero.
  CHECK: `bun test --timeout 120000 ./src/factory/usage-settlement.test.ts ./src/__tests__/factory-budgets.test.ts`
  EXPECT: exit 0; a rollback leaves no inbox event, no settlement row, and the full hold
  EVIDENCE: `final-focused.json`, `final-postgres.json`.

- [x] G4: A still-running attempt with no terminal result is stopped from its sealed admission plus
  launch record, and no outcome is ever fabricated.
  CHECK: `bun test --timeout 180000 ./src/__tests__/factory-task-stops.test.ts`
  EXPECT: exit 0; `factory_task_outcomes` is empty for the run, the stop row is
  `source = 'sealed-launch'` with a NULL `attempt_command_id`, and the execution reaches `stopped`
  EVIDENCE: `final-focused.json` (14 cases), `final-postgres.json` (same suite on the real engine).

- [x] G5: Only a configured supervisor key can assert a physical stop, and the pool must agree
  before any release.
  CHECK: `bun test --timeout 180000 ./src/__tests__/factory-task-stops.test.ts -t "only a configured supervisor"`
  EXPECT: exit 0; a foreign key, an unknown key id, a forged `processGroupAbsent`, a pool that does
  not answer `settled`, and a stale allocation generation each leave durable uncertainty
  EVIDENCE: `final-focused.json`. The receipt is verified before `confirmStopped` is called, and
  the atomic settlement runs only after the pool agrees.

- [x] G6: The host stop transport is authenticated by mutual TLS, rotates its key without a
  restart, and refuses every other caller.
  CHECK: `bun test --timeout 180000 ./src/factory/host-stop-transport.integration.test.ts`
  EXPECT: exit 0 against a real `startFactoryPrivateHttps` listener
  EVIDENCE: `final-focused.json`. A foreign client certificate is 401 before any stop is attempted;
  another host is 403; replacing the key files rotates the next signature and the retired key no
  longer verifies it, while both configured keys stay admissible; malformed, oversized, and
  half-written key material is refused.

- [x] G7: C02.14 against a real rootless Podman sandbox: abort, at most ten seconds of cleanup,
  then kill the whole sandbox and confirm absence from the runtime.
  CHECK: `flock /tmp/ezcorp-validation-heavy.lock bun test --timeout 900000 ./src/factory/runner/sandbox-stop.podman.integration.test.ts`
  EXPECT: exit 0; a cooperative sandbox is cleaned with zero kills, one that cannot be signalled is
  killed and re-observed, and `unknown` is never treated as absence
  EVIDENCE: `final-podman.json`; the pre-fix measurement is in `sandbox-abort-ignored.log`.

- [x] G8: A bounded stop timeout leaves durable uncertainty and holds, and a later valid receipt
  settles the original operation only.
  CHECK: `bun test --timeout 180000 ./src/__tests__/factory-task-stops.test.ts -t "bounded stop timeout"`
  EXPECT: exit 0; the pool is never acknowledged during the uncertain window, the reservation stays
  `uncertain`, the execution stays `cancel_accepted`, and `confirm` later settles once
  EVIDENCE: `final-focused.json`, `final-postgres.json`.

- [x] G9: Trusted later usage reconciliation emits one idempotent settlement, and a receipt already
  consumed by another attempt is refused.
  CHECK: `bun test --timeout 180000 ./src/__tests__/factory-task-stops.test.ts -t "reconciles a trusted"`
  EXPECT: exit 0; a replay returns the same settlement with no second event, a different amount
  under the same receipt is a conflict, and an unverified digest is refused before the journal
  EVIDENCE: `final-focused.json`.

- [x] G10: A pool acknowledgement that outlives a failed product transaction settles exactly once.
  CHECK: `bun test --timeout 180000 ./src/__tests__/factory-task-stops.test.ts -t "outlives a failed product transaction"`
  EXPECT: exit 0; the stop degrades to uncertainty with its hold retained, and the retry produces
  one settlement row, one `usage-settled` event, and one `settled` reservation
  EVIDENCE: `final-focused.json`.

- [x] G11: C03 round-robin service, the thirty-second oldest-first lane, reserved minima, atomic
  whole-vector admission, infeasible rejection, the outstanding limits with HTTP 429, and the
  skewed workload where a small tenant progresses.
  CHECK: `bun test --timeout 120000 ./src/factory/pool/ledger.integration.test.ts ./src/factory/pool/service-routes.test.ts ./src/factory/pool/client.test.ts`
  EXPECT: exit 0; the captured allocation trace matches the contract's one-feasible-allocation-per-
  tenant-per-round rule, ordered inside a tenant by priority, ready sequence, then node identity
  EVIDENCE: `fixes-pool-and-static.json` (37 pass) and `fixes-pool-postgres.json` (22 pass) at the
  head of this branch, plus `final-focused.json`, `final-postgres.json`, and the pool receipts under
  `/tmp/factory-platform-evidence/w03/pool/`. The outstanding bounds are injectable and can only be
  tightened; the defaults are asserted to be 10,000 and 100,000 and the real comparison runs at a
  small configured bound.
  Two corrections from validation finding W03-5. The ten-tenant test is renamed to what it proves,
  round-robin service with one allocation per tenant per round, because every score in its trace
  tied at zero service and the weight never changed its outcome. A genuinely weight-sensitive case
  replaces the missing proof: two tenants at weights 1 and 3 holding 2 and 3 units score 2 and 1,
  so the tenant holding MORE absolute capacity is served first, and swapping only the weights
  inverts the trace. It also records the rule the first attempt got wrong: round membership decides
  who is eligible and always outranks weight, which orders only those who already are.

- [x] G12: The reservation vocabulary cannot drift from C03 again.
  CHECK: `bun test --timeout 120000 ./src/factory/pool/ledger.integration.test.ts -t "documented C03 mapping"`
  EXPECT: exit 0; the exported state set, the documented mapping, the doc table, and the durable
  CHECK constraint all agree, and `requested` is refused by the constraint
  EVIDENCE: `final-focused.json`; the decision and mapping are in `docs/factory-pool-admission.md`.
  The durable names stay: `queued` is also the wire value of `PoolDecision.status`, read by files
  W03 does not own, so a rename is a wire break across packages for one word.

- [x] G13: Cancellation during admission claims no capacity and leaves no stop to settle.
  CHECK: `bun test --timeout 180000 ./src/__tests__/factory-task-stops.test.ts -t "cancelling during admission"`
  EXPECT: exit 0; the kernel does emit `cancel-node` naming the admission command, the physical
  stop refuses it as stale because there is no sealed launch, and the reservation never leaves
  `held`
  EVIDENCE: `final-focused.json`.

- [x] G14: Diff-scoped coverage gates pass against the base.
  CHECK: `bun scripts/merge-lcov.ts '/tmp/factory-platform-evidence/w03/lcov/all/*.lcov' coverage/lcov.info`
  then `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and
  `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`
  EXPECT: exit 0 for both
  EVIDENCE: `final-coverage-gates.json`. Eight new source files gated; every changed executable
  line covered across 23 files. The merged report is the union of the focused bun run, the
  dependent bun run, the Podman bun run, and the Node/V8 orchestrator producer, which is the
  canonical producer for `packages/@ezcorp/factory-transport/src/index.ts`. `bun scripts/check-coverage.ts`
  is NOT green on this report and is not claimed: it reports 1481 files below threshold because a
  targeted run loads only the suites this package touches, and none of those 1481 is a W03 file.
  The whole-repo verdict belongs to `bun run test:coverage` at integration.

- [x] G16: A protected validator is admitted through its acceptance command and tells no kernel node.
  CHECK: `bun test --timeout 300000 ./src/__tests__/factory-compute-admissions.test.ts` and
  `bun test --timeout 180000 ./tests/postgres/factory-compute-admissions.test.ts`
  EXPECT: exit 0 on both engines; the admitted receipt carries no `event`, the inbox holds no
  `admission-result`, and the stored row's `event_json` is NULL
  EVIDENCE: `validator-origin-pglite.json` (108 pass), `validator-origin-postgres.json` (12 pass),
  `head2-focused.json` (222 pass). The matrix covers a lost response, a concurrent poll where
  exactly one wins, a restart that recovers the same sealed result and still emits nothing, a
  cancellation when the acceptance command is gone that leaves the hold at `held`, one reservation
  per validator identity, a different claim set keying a different reservation, a forged acceptance
  id refused, and a malformed origin that never reaches a durable row.

- [x] G17: The durable rule matches the code path on both the fresh and the upgraded schema.
  CHECK: `bun test --timeout 120000 ./src/__tests__/factory-migration-restart.test.ts`
  EXPECT: exit 0; an event on a validator admission is refused in any state, a settled dispatch-node
  admission without one is refused, and exactly one constraint governs the rule
  EVIDENCE: `head2-focused.json`, `validator-origin-postgres.json`.

- [x] G15: Every gate script stays green on the branch.
  CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
  `bun scripts/gate-integrity.ts`, `bun test ./scripts/factory-c13-inventory.test.ts ./scripts/factory-postgres-suite-registration.test.ts`
  EXPECT: exit 0 for each
  EVIDENCE: `final-static.json`. The C13 inventory found two undeclared reuse edges that
  `check-factory-boundaries.ts` alone did not catch; both are declared in `cfb9a3a8c`.

## Open, and why

- **`Retry-After` header.** The status is 429 and the interval is in the body, but the header needs
  the W09 seam described above. Filed, not worked around.
- **Nested cancellation is architecturally enabled but untested.** `authorizeRunInTransaction`
  propagates `allowCancelling` to ancestors, which is what lets a child's stop reach a cancelling
  parent, and `assertLiveAncestors` threads the same allowance. No test exercises it: nothing on
  this branch builds a parent and child run, and grepping the suites for `factory_child_stale`,
  `factory_child_corrupt`, or `allowCancelling` returns nothing. Treat it as a reviewed code path,
  not a proven one. It needs W06's run-controls fixtures, which are not on this branch.
- **Losing join branches has no coverage here**, for the same reason: the stop service sees only a
  `cancel-node` for one attempt, and the join is kernel behaviour.
- **One-slot parent/child execution has no coverage anywhere in the repo.** An earlier draft of
  this file cited the pool suite's last-capacity-unit race as covering it. That was wrong and is
  withdrawn: that test races two unrelated tenants for one pool unit, which is not the plan's
  parent-and-child-sharing-one-slot concept.
- **The end-to-end host-stop chain is not composed.** Each piece is proven on its own: the mTLS
  transport (G6), the real Podman kill (G7), and the gateway orchestration class (G4, G5). Nothing
  wires them together in `application.ts` or `boot.ts`, no production class implements
  `FactoryHostStopSupervisor`, and `new FactoryTaskStops(` appears nowhere outside tests. That
  composition is W09's. Freeze section 16 asked W03 to reconcile
  `FactoryHostLaunchProtocol.stop`'s `FactoryPhysicalStopRequest` with `FactoryTaskStopRequest`;
  that sentence is superseded rather than fulfilled, because W03 introduced a separate
  `FactoryPhysicalStopper` seam instead of widening W01's signature, and `FactoryHostLaunchProtocol.stop`
  still takes the original type.
- **Partitioned survivors** are covered by the bounded-timeout gate (G8): the gateway cannot reach
  the host, the stop degrades to uncertainty, capacity and charge are retained, and a later receipt
  settles the original operation. A partition that also loses the pool response is covered by G10.

## Independent validation (Sonnet validator, 2026-09-14)

Verdict: ACCEPT-WITH-FIXES at `a957835f7`; report `/tmp/factory-platform-evidence/w03-validation/report.md`. Five low or informational findings; three were fixed in `d093d8670` (ownership cross-table, nested-cancellation wording, weighted test name). The end-to-end host-stop composition is routed to W09 and the NUL literals in `admission-origin.test.ts` to W05.

## Addendum, 2026-09-14: work-list scans for W09's held roles — `6da1f67cd`

W09's composition could not register the stop-settlement and usage-reconciliation roles because
nothing enumerated their work. Branch merged `integ/w00` at `1d3edf5b0` first, which fast-forwarded
`wp/w03-stop-settlement`: every earlier W03 commit is already an ancestor.

`6da1f67cd` adds two bounded, oldest-first, tenant-scoped scans.

- **`FactoryTaskStops.listStoppableInTransaction`** returns accepted cancellations that have not
  reached a settled stop, each carrying the cancel command reference `stop` itself takes. Ordered by
  the acceptance clock with the cancel command breaking ties. It takes no row locks: exclusion
  belongs to `stop`, which locks the row it settles, so two workers may list the same work and only
  one commits it.
- **`FactoryBudgets.listUncertainWithCostInTransaction`** returns reservations whose cost is still
  held and which no settlement has resolved. A settlement still carrying an unknown amount leaves
  the hold listed; one that resolves it does not.

Two decisions worth stating rather than leaving to a reader:

1. `factory_budget_reservations` carries no timestamp, so "oldest first" is by the run's creation,
   with `run_id` and `reservation_id` breaking ties. The order is total and temporal only to the
   resolution of the run, which is what the table can support without a migration.
2. Both scans are fail-closed, not fail-quiet. A zero cost is excluded in SQL, but a non-canonical
   amount is deliberately let through the filter so it reaches `decode` and throws, instead of
   disappearing from a worker's list where nobody would notice. The stop scan refuses a row whose
   state or source is outside its union; that path is normally unreachable behind a durable CHECK,
   so the test lifts the constraint, corrupts the column, asserts the refusal, and restores both.

- [x] G18: The two scans enumerate exactly their worker's work, page without repeat or gap, and
  refuse every malformed input.
  CHECK: `bun test --timeout 300000 ./src/__tests__/factory-budgets.test.ts ./src/__tests__/factory-task-stops.test.ts`
  and the same suites on the real engine through `tests/postgres/`
  EXPECT: exit 0 on both engines; empty tenant, held and running reservations excluded, a settled
  stop leaving the list, pages partitioning the work, a cursor past the end returning nothing,
  concurrent scans agreeing, and every bound and malformed cursor refused
  EVIDENCE: `scans-coverage.json` (115 pass), `scans-postgres.json` (28 pass),
  `scans-static.json` (20 pass), `scans-coverage-gates.json`. `src/factory/budgets.ts` 245/245 lines
  and `src/factory/task-stops.ts` 310/310 lines in the merged report; both diff-scoped gates pass
  against `integ/w00` with two changed files fully covered.

Only rows these tests create are removed; nothing pre-existing in a shared store is deleted.
