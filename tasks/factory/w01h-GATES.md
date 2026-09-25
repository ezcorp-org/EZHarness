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

## Second defect, reported and not fixed here

A stop the kernel begins itself (run deadline) moves only the kernel's cancellation epoch; the durable
fence (`factory_run_lifecycle.cancellation_epoch`) moves only on a user cancel, so every such
`cancel-node` is refused `factory_command_stale`. Probe:
`/tmp/factory-platform-evidence/w01h/probe/zz-w01h-deadline-stop.scratch.test.ts`. Owner ruling asked
of the coordinator.

## Gates

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

- [ ] G7: The real application with the fix: W19a's runbook passes, and the same fault ends the run.
  STATE: runbook green (`fix-runbook exit=0`: ollama x3, mock x3, both controls). The fault pass writes the typed
  terminal row (RUNNER_CONTAINER_EXIT, "Worker closed; state cancelled") and the host log line, but the run does not
  end: the outcome commit is refused by the C02 fence because the guest died AT its attempt deadline (30 s pool
  lease, never renewed). Open on the coordinator's ruling (option 1: record a non-success report after the
  deadline; patch `proposal-report-after-deadline.patch`). Leg D (W01g's harness) is void on both trees: the server
  never reported ready ("Setup required") on the current base, before any W01h code ran.
  CHECK: `w01h-heavy.sh` legs C (`proof/w01h-fix-w19a` run.sh all; `proof/w01h-fix-fault` one pass)
  and D (W01g's harness with a slow guest, base and fix)
  EXPECT: the runbook all green; the fault pass records RUNNER_CONTAINER_EXIT and a terminal run
  EVIDENCE: `graph/fix-runbook/`, `graph/fix-fault.json`, `graph/fix-fault.rows.json`, `repro-*.json`

- [x] G8: Boundaries, typecheck, lint, gate-integrity and both coverage gates at the final head.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`; C05 in `factory-process-boundaries.test.ts`; `BASE_REF=integ/w00` new-file and patch gates over the Bun leg plus the Node/V8 leg
  EXPECT: all exit 0
  EVIDENCE: `logs/heavy-coverage-gates.log` (at `41b1d8a02`: new-file none, patch 11 files), `logs/final-*.log`

## Scope notes

- The in-process `IsolatedFactoryAttemptRuntime` has no production construction (tests only); it is
  unchanged and keeps its own uncertain-then-reconcile design.
- The dispatcher now keeps the runner's error as the cause of `runner_outcome_unknown`; the lifecycle
  case that pinned "no cause for a thrown runner" was updated on purpose.
- The router's first-hand stop knowledge now comes only from a guest that settled on this host; a
  result request for a worker the host never ran no longer counts (it could sign an absence receipt
  without asking the runner).
