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
  EVIDENCE: `final-focused.json`, `final-postgres.json`, and the pool receipts under
  `/tmp/factory-platform-evidence/w03/pool/`. The outstanding bounds are injectable and can only be
  tightened; the defaults are asserted to be 10,000 and 100,000 and the real comparison runs at a
  small configured bound.

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

- [x] G15: Every gate script stays green on the branch.
  CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
  `bun scripts/gate-integrity.ts`, `bun test ./scripts/factory-c13-inventory.test.ts ./scripts/factory-postgres-suite-registration.test.ts`
  EXPECT: exit 0 for each
  EVIDENCE: `final-static.json`. The C13 inventory found two undeclared reuse edges that
  `check-factory-boundaries.ts` alone did not catch; both are declared in `cfb9a3a8c`.

## Open, and why

- **`Retry-After` header.** The status is 429 and the interval is in the body, but the header needs
  the W09 seam described above. Filed, not worked around.
- **Losing join branches and one-slot parent/child execution.** These are kernel and scheduler
  behaviours: the stop service sees only a `cancel-node` for one attempt. The pool suite proves a
  one-slot race and the skewed workload; the join and nested-run cases need W06's run-controls
  fixtures, which are not on this branch. The settlement-scoped run authority this package added
  is what makes a nested cancellation reach a cancelling parent, and it propagates to ancestors.
- **Partitioned survivors** are covered by the bounded-timeout gate (G8): the gateway cannot reach
  the host, the stop degrades to uncertainty, capacity and charge are retained, and a later receipt
  settles the original operation. A partition that also loses the pool response is covered by G10.
