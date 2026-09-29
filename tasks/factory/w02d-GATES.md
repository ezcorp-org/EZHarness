# Gates: W02d the GPU lease consumer

Branch `wp/w02d-gpu-lease`, cut from `integ/w00` at `a24a619ad` (W01h and W01i are in; W16's provisioning is not).
Evidence: `/tmp/factory-platform-evidence/w02d/`. Brief: `/tmp/factory-platform-evidence/w00/briefs/w02d.md`;
plan and rulings: `w02d/plan.md`.

Status: IN PROGRESS. R1–R9 and R7b are in, R8 and R9 on W09h's basis, with the host tombstone of ruling (A). The
task-stops.ts attestation refresh waits for W03f; the authoritative head run follows it. Validator: validator-6.

| Commit | What it is |
| --- | --- |
| `a2b7b408d` | R1: startup refuses a runner profile whose `gpu-host` is not one whole host |
| `4f347dc14` | R3: the dispatch preflight grants a held GPU lease its recorded devices, or refuses it by name |
| `0f8bdd8c1` | R4: the host refuses a granted device it does not have, before any container exists |
| `d7b3ae94b` | R5: measured; a GPU attempt's lease renews through W01h's loop unchanged, and lapses the same way |
| `3428eba36` | R7: a supervisor-confirmed GPU stop confirms and settles; the host stays held for its reimage |
| `1f7d56010` | R9: a class the pool cannot serve fails its run by name and releases the unused hold |
| `bfa01a41a` | Merge of integ/w00 `e92d34d45` (W16, W01j, W09e landed), list-bound skip ruling; all 74 withheld suites green |
| `d8a20ba03` | R2: the pool grants a GPU host only with its registered profile, and the lease carries it |
| `2a3b7c215` | R7b: a trusted-local GPU host is reused by its one bound tenant without a reimage |
| `e970fe1e9` | R6: one fenced renewal at claim; a lease already reclaimed refuses the launch by name (`lease_revoked`) |
| `70206eca3` | Harness (W19a's): a failed graph-proof pass names the product's refusals and each failing check's values |
| `b2de395af` | R6 test: the red is the wedge P2 measured; a live lease is the negative control |
| `4d95d9158` | R4 completion: a worker the host refused before any container existed is confirmed absent first-hand, and its stop is signed |
| `6cab80e44` | R6 completion: a lease reclaimed before claim ends the attempt failed by name (`RUNNER_LEASE_LOST`, "lease_revoked"), no host stop |
| `db82d8c15` | Harness (W19a's): a graph-proof stack never gives two of its services the same port |
| `5a48b372f` | Harness (W19a's): a check that meets a non-JSON value reports false instead of crashing the verdict |
| `7a499e4e1` | Merge of integ/w00 `ad22592da` (W09h, W18c, C2 landed), list-bound skip ruling; all 89 withheld suites green |
| `31bee42a9` | R9 basis: a rejected admission settles as "nothing launched, all zero" and records the attempt's usage settlement |
| `f01dc399c` | Tombstone (i): a worker this host never saw is tombstoned durably, then signed absent, and refused `worker_stopped` |
| `a0c96ae8c` | Tombstone (ii): a tombstone written by one host process refuses the worker after a process-level restart |
| `8d3ed5eb5` | Tombstone (iii): the negative controls |
| `26951f125` | R8: a dispatch refused after admission releases its lease and hold through the host's signed stop, on W09h's basis |

## Base reproductions (G1), on the real stack

Tree `a2b7b408d` in a detached checkout (`.worktrees/w02d-repro`), W19a's graph proof copied to
`w02d/harness*` with the brief's configuration (one host id is the installation host and the GPU host; `combine`
on class `gpu` = `{cpu 1, gpu-host 1}`). Under the heavy lock; bun and bunx asserted 1.3.14.

| Run | Receipt | Result |
| --- | --- | --- |
| P1 (F1) | `w02d/p1/RECEIPT.txt` | RED: the gpu-host lease launched with `devices: []`; the run succeeded; nothing refused |
| P3 (F4) | `w02d/p3/RECEIPT.txt` | RED: the GPU stop stayed `uncertain` (pool `awaiting-gpu-reimage`); hold `uncertain`; run stayed `running` |
| P5 (R9) | `w02d/p5/RECEIPT.txt` | RED: the pool rejected, the kernel cancelled the denied admission, the run stayed `running`, the hold `held` |
| P2 (R6), p2-base-1 | `w02d/p2/` | VOID as a measurement: the harness's two nodes each reserved costMicros 1000000 against the run's 1000000 limit (web factory-boot), so the second admission was refused `factory_budget_exhausted`; the harness then reported only its teardown error "Unable to connect" (fixed by `70206eca3`) |
| P2 (R6), p2-base-2 | `w02d/p2-2/` | RED, the measurement: fixture reservation 400000 (a legitimate fixture change, coordinator ruling). infer waited ~45 s behind prepare; its pool row went `uncertain / lease-expired` at admission + 30 s; the dispatcher launched on it, the gateway refused the start (HTTP 409), and the run wedged `running` (`runner_outcome_unknown`). verify-head.py p2: 2/7 hold |

## Rules

- R1 (G2): `startup-config.test.ts` red on the base (1 fail), green 50/0.
- R3: `attempt-preflight.test.ts` red (4 fail), green 16/0. `PoolLease.deviceProfile` is optional until R2 fills it;
  until then every `gpu-host` lease is refused `factory_preflight_device_profile_missing` (fails closed).
- R4: supervisor red against the check removed (2 fail), green 13/0; launch route 422 `device_unavailable` red (1),
  green 19/0; remote runtime `RUNNER_DEVICE_UNAVAILABLE`, not retryable, red (1), green 15/0. The tenant check
  (W01i) runs before the device check. `device_unavailable` is an additive freeze-section-6 code.
- R5: measured, no source change: the same renewal count and fence as a CPU attempt; a lapse is `RUNNER_LEASE_LOST`.
- R7: `poolStopConfirmed` in `pool/ledger.ts`, used by the pool's `acknowledgeStopped` and the task stop's confirm.
  Pool red against the old rule (1), green 25/0 on PGlite and PostgreSQL; stop suite red on the base, green 33/0.
- R9: kernel red on the base kernel (1), green 11/0 (SDK 234/0); admission release red (1), green 15/0.
- R2: pool suite on PGlite red 25/1 (a host without a profile was assigned), client red 7/1, process red 9/1; green
  26/0, 8/0, 10/0, profiles 6/0. Negative controls: profile gate removed 25/1; snapshot removed 25/1. The hook ran
  PostgreSQL factory-pool-service 5/0. One parser (`parsePoolDeviceProfile`) for the stored row and the wire.
- R7b: red on a scratch of R2: pool suite 27/3, registry 6/1; green pool 30/0, registry 7/0. Mutants: no reuse
  branch 29/1; no residue filter 29/1; reuse for any tenant 28/2. Live P3 proves same-tenant reuse; the harness has one
  tenant, so the cross-tenant wait is proven by the pool suite only.
- R4 completion (measured at the head, P1 at b2de395af): the host refused `device_unavailable`, then its own stop of
  that never-created worker answered 500 `stop_failed` (an uninspectable worker reads as present), so the GPU lease,
  the hold and the run stayed open. The refusal is now first-hand absence. Red: supervisor-services 22/1 through the
  real router (the 500); green 23/0; negative control (refusal not recorded): 500 again.
- R6 completion (measured at the head, P2 at b2de395af): the claim renewal refused the reclaimed lease, but the
  dispatcher records every runner error as `runner_outcome_unknown`, so the run wedged. The attempt now ends failed by
  name through the lost-result record (`RUNNER_LEASE_LOST`, "lease_revoked: ..."), with no host stop because nothing
  left the process. Red 16/1 (it threw); green 17/0; with the renewal removed, the P2 wedge (409). `lease_lost` stays
  retryable; the runbook graph's nodes have `maxAttempts: 1`, so P2's run fails by name.
- R6: measured RED first (P2, above). Unit red is the wedge: with the claim renewal removed the expired lease launches
  and ends "Error: factory gateway returned HTTP 409" with no named failure (`logs/r6-red-wedge.log`); green 17/0
  (refused `lease_revoked` before anything launches); negative control: a live lease renews once and completes.
  Mutant (renewal failure swallowed) 16/1.
- R6 semantics (from the code, ledger.ts `withLiveFence` -> `expireLocked`): every fenced pool call first reclaims a
  lease past its deadline (`uncertain / lease-expired`, generation + 1). There is no expired-but-renewable state: the
  claim renewal keeps a lease inside its deadline alive, and a lease past it is refused by name. P2 at the head shows
  the reclaimed path (pool rows: prepare `settled / stopped-confirmed`, infer `uncertain / lease-expired`).
- Release after `lease_revoked`: the attempt's terminal stop asks the host, which now tombstones the never-seen worker
  and signs its absence; the pool confirms a reclaimed lease (only the allocation generation moved). The stop has no
  durable fact that nothing launched (the launch row is `terminal` either way, and `RUNNER_LEASE_LOST` also ends a
  launched attempt), so the hold settles at cost zero under the reserved-bound compute basis, not "nothing launched".
  The head run measures this path.
- The renewal is placed after the one-winner claim, before readiness, the attempt token and any launch (not before the
  intent row exists), so a second dispatcher never renews a lease it does not own.

## R8: the refused dispatch (`26951f125`)

- Built red first and parked as `92bdc1f22` (red: stop suite with the recorder a no-op, 2 fail; migration with the
  worker clause removed, 1 fail). Cherry-picked onto the tombstone commits; one conflict in `task-stops.ts`, where
  both sides added a distinct function and both stay.
- On W09h's basis: the refusal stores the node attempt's authority on the stop row (`attempt_authority_json`, tied
  to the `dispatch-refused` source by the CHECK), so the settle records the attempt's usage settlement ("nothing
  launched, all zero", proved by the host's signed stop) and its kernel event. The test applies that event to the
  run's kernel state and gets a known zero for the dispatched attempt. Red: no settlement row
  (`logs/r8d-red.log`). Green: PGlite task-stops 38/0; PostgreSQL task-stops 38/0, compute-admissions 2/0,
  migration 1/0 (`r8-basis/logs/`). A tampered or malformed authority is refused `factory_task_stop_corrupt` and
  never recorded.
- One helper, `settleFactoryNothingLaunchedInTransaction`, serves the three "nothing launched" paths: W09h's
  in-place stop, R9's pool rejection and R8.
- The hook mapped 6 suites, one of them PostgreSQL, so the commit ran under the heavy lock (veto `w01g-fix` first,
  the database URL loaded inside the script): all 6 green.
- Q5 revised (coordinator, 2026-09-27): Q5 said "no stop row". C03 decides it: capacity is freed only on a
  supervisor's signed word, and a held lease does not prove nothing started, because the remote runtime launches
  before acknowledgeStart. So the mechanism that already carries a signed host stop, the stop row and the existing
  stop worker, is the truthful one. The row is of source `dispatch-refused`, with `attempt_id` NULL (the attempt
  foreign keys stay; a NULL skips them, so no synthetic launch or execution row exists), `worker_id`, and
  `cancel_command_id` = the refused `dispatch-node` command, tied together by a CHECK.
- Lock order: the refused-dispatch stop locks only its stop row. There is no launch row, so
  FACTORY_STOP_LAUNCH_LOCK_ORDER (the stop row, then the launch row) holds.
- R9 is on the same basis (`31bee42a9`): the pool's rejection settles the hold "nothing launched, all zero" and
  records the attempt's usage settlement; the admission test expects the events `usage-settled`, `admission-result`.

## Tombstones: a worker the host never saw (ruling (A))

- (i) `f01dc399c`. Red through the real router: the stop of a never-seen worker answered 500 `stop_failed`
  (`logs/r8a-red.log`). Green: one runtime inspect, a signed tombstone line beside the host key, then the signed
  absence; a later launch or attach of that worker is refused 409 `worker_stopped`. The launch is refused from the
  moment the stop reserves the worker, before anything is awaited.
- (ii) `a0c96ae8c`. A spawned host process records the tombstone and exits; the next process loads it and refuses
  the worker. Red with the load removed: 0/1.
- (iii) `8d3ed5eb5`. Refused: a tombstone signed with another key, one for another host, one past its retention (in
  memory and after a restart), 11 malformed or tampered lines; another tenant's worker of the same id is not refused.
  A malformed input is never written; a failed write throws and signs nothing; an oversized file stops the host
  from starting. Never tombstoned: a worker the runtime still shows, a starting worker (the runtime shows nothing
  yet), a live one. A stop naming no tenant for a never-seen worker is 403 `forbidden_tenant`. Each guard removed
  once fails its control (`logs/r8c-red-*.log`). `host-tombstones.ts` is at 100% lines and functions.

### Retention (proposal)

A tombstone is honoured for the longest run deadline plus one day: `FACTORY_LIMITS.maximumRunDeadlineMs` (30 days)
plus `FACTORY_HOST_TOMBSTONE_GRACE_MS` (1 day), 31 days from its write. The reason:

- A launch naming a stopped worker comes only from an attempt of that worker's run. The kernel caps every run's
  deadline at 30 days from its start, and a tombstone is written after its run started. So 30 days from the write
  outlives every deadline that run's attempts can carry, and so the run's terminal record.
- The host does not refuse a launch whose deadline has passed, so the tombstone must cover the whole span itself.
- The day of grace covers clock skew between product and host and the stop's own settlement.
- The retention derives from the SDK's limit, and a test holds it against the kernel's granted deadline, so a
  longer cap raises it. Red with the old value (30 days, no grace): the test fails (`logs/r8e-retention-red.log`).
- Cost: one entry is a few hundred bytes; the file is capped at 16 MiB and the host refuses to start above it.
- Caveat: entries are verified with the current host key. A key rotation makes older entries unverifiable, so they
  are refused and counted; rotate the key only on a host with no open run, or re-sign the live entries first.

## The queued-host case

- W09h landed at `7a499e4e1`: a run stopped while a node waits for compute admission now settles in place. W02d's
  head runs do not rerun that case: P3 is not run (the user's decision (b), below) and P5 has no GPU host.

## Merge of integ/w00 ad22592da (7a499e4e1)

- W09h, W18c and C2's hygiene landed. The hook withheld 89 suites (cap 12) under the list-bound skip ruling; all
  89 ran outside the hook at the merge commit (`w02d/merge-ad22592da/receipts/`): 80 bun, 8 vitest and the
  orchestrator package, 1920 passed, 0 failed, every count nonzero. The typecheck after the merge needed the
  `@ezcorp/sdk` package built first; nothing in the tree changed for it.

## Merge of integ/w00 e92d34d45 (bfa01a41a)

- Conflicts: `tasks/lessons.md` (both sides whole). `packages/@ezcorp/factory-sdk/src/kernel-run-controls.test.ts`
  (integrationFix): both sides appended tests at the end of the file; W02d R9's `singleTaskFactory()` and its test
  first, then W09e's `releasingRun()` and its tests; no existing line changed. The conflict hunk cut W02d's test before
  their shared closing `});`, which the resolution restores. The file alone: 14/0, every test name of both sides.
- The hook mapped 73 suites plus the orchestrator package (cap 12): skipped under the coordinator's list-bound ruling
  (list `w02d/merge-trial-2/hook-list.txt`, sha256 in the commit message; the hook's printed list equal as a set).
- All 74 ran outside the hook at the merge commit (`w02d/merge-e92d34d45/receipts/`): 60 bun 1203, 6 vitest 40,
  orchestrator 91, 7 PostgreSQL (gateway-process 1, installation-bootstrap 17, pool-process 3, pool-service 5,
  provisioning 63, release-stop-migration 1, release-stop-race 4), every count nonzero.
- PostgreSQL attempt 1 (`pg-attempt-1/`): factory-gateway-process 0/1, "DATABASE_URL must name the gateway's database"
  (the test reads DATABASE_URL at module load); db-postgres.yml sets DATABASE_URL and passes it as
  FACTORY_TEST_POSTGRES_URL, and the runner set only the latter. The runner fix is the evidence; attempt 2 is 7/7.
  Attempt 1 ran in a detached checkout of `bfa01a41a` because the first try had refused a dirty tree (below).

## Cross-package changes

| Change | Owner | Why | Tests |
| --- | --- | --- | --- |
| `scripts/factory-graph-proof/diagnostics.ts`, `proof.ts` (`70206eca3`) | W19a | A failed pass hid the product's refusal behind the harness's own teardown error ("Unable to connect" for an admission refused `factory_budget_exhausted`) and listed check names without values | `src/factory/graph-proof-diagnostics.test.ts` (refusal fixture verbatim from p2-base-1's web log; red: failed to load; green 20/0) |
| `src/factory/pool/gpu-host-profiles.ts`, `pool/process.ts` (R2, R7b) | W16 | The pool loaded the profiles and discarded them; the binding needs one tenant id | `pool/gpu-host-profiles.test.ts`, `pool/process.test.ts` |
| `scripts/factory-graph-proof/stack-documents.ts`, `stack.ts` (`db82d8c15`) | W19a | Two stack services got one port (EADDRINUSE on 37819; TLS to plain Temporal), so a stack never came ready | `src/factory/graph-proof-diagnostics.test.ts` (red: failed to load; green 22/0) |
| `scripts/factory-graph-proof/diagnostics.ts`, `proof.ts` (`5a48b372f`) | W19a | A failed node left a value undefined and the proof's comparison threw "Value is not valid I-JSON", replacing every check | `src/factory/graph-proof-diagnostics.test.ts` (red: failed to load; green 23/0) |
| `src/factory/runner/remote-attempt-runtime.ts` (R6) | W01 / W01h | One renewal at claim, and a reclaimed lease ends the attempt failed by name; W01h's loop unchanged | `runner/remote-attempt-runtime.test.ts` |
| `src/factory/runner/host-launch-supervisor.ts`, `supervisor-services.ts` (R4) | W01 | A worker refused before any container is first-hand absent | `runner/supervisor-services.test.ts`, `runner/host-launch-supervisor.test.ts` |
| `src/factory/runner/host-tombstones.ts` (new), `host-launch-supervisor.ts`, `host-launch-service.ts`, `host-stop-service.ts`, `supervisor-services.ts`, `supervisor-process.ts`, `attempt-wire.ts` (tombstone (i)–(iii)) | W01 (changed by W02d under ruling (A)) | A never-seen worker's stop could never be signed; the host now tombstones it durably and refuses it from then on | `runner/host-tombstones.test.ts`, `runner/supervisor-services.test.ts` |
| `src/factory/usage-settlement.ts`, `task-stops.ts`, `compute-admissions.ts` (R8, R9) | W09h (the basis) | One shared "nothing launched" settlement for W09h's stop, R9 and R8 | `__tests__/factory-task-stops.test.ts`, `__tests__/factory-compute-admissions.test.ts`, their PostgreSQL twins |

## Head runs

The head runs execute in a detached scratch of the head with the head's own graph-proof harness and one W02d patch per
run type (`w02d/harness-patch/w02d-*-head.patch`): P1 profile names the absent `/dev/dri/renderD200`; P5 no GPU host;
P2 prepare and infer each 45 s, admitted together, so whichever the dispatcher runs second waits past its lease.
P3 is NOT run live at the head (coordinator ruling (b)): a gpu-host grant must authorize at least one device
(attempt-wire.ts), the shared validator allows only `/dev/kfd` and `/dev/dri/renderD<n>`, and ruling A5 forbids a real
device in a container, so no GPU attempt can run and be cancelled here. R7 and R7b rest on the pool suites (PGlite
and PostgreSQL) and the unit tests. The user decided (b): A5 stands for this wave, no render node enters any
container, and P3 is not run live. `w02d/verify-head.py` judges each pass by its own expectation and prints every
check with expected and seen; `w02d/head-runs.sh` runs a smoke of each type first, stops if any type fails to reach
"ready" (status 200), and exits nonzero on any failed leg.

INTERIM evidence (coordinator ruling, 2026-09-28): the verdicts below re-judge the records of the two-stage run at
`db82d8c15` (`w02d/head-db82d8c15/`, 22:45–23:34Z) with the verifier as corrected AFTER that run (sha256 prefix
`f60b9e8db27a3f35`): P1 read a failure from `factory_execution_terminals`, which holds completed results only (the
durable failure is `factory_task_outcomes.result_json.error`), and P2 now carries the pre-R8 expectation. The
authoritative run is ONE two-stage run at the final head, after R8, R9's basis switch and the attestation refresh,
with the full post-R8 P2 expectation (the run fails and the hold settles at zero); it is the evidence of record for
P1, P2 and P5 together. Output of the interim verdicts: `/tmp/factory-platform-evidence/w02d/head-db82d8c15/rejudged`.

Causes named from that run: P1 records the host's refusal by name at the node (task outcome, launch terminal, the
kernel's `node-failed`); P2 fails the node the dispatcher runs second by name at claim, deterministically in all four
passes, and the run stays `running` because the refused reservation's hold has no host receipt
(`factory_usage_hold_unresolved: no-operation-receipt`) until R8 releases it; `cancel_accepted` on that node is the
product's own stop of the failed attempt.

| Pass | Checks | Failing |
| --- | --- | --- |
| p1-head-1 | 5/5 | all hold |
| p1-head-2 | 5/5 | all hold |
| p1-head-3 | 5/5 | all hold |
| p1-smoke | 5/5 | all hold |
| p2-head-1 | 6/6 | all hold |
| p2-head-2 | 6/6 | all hold |
| p2-head-3 | 6/6 | all hold |
| p2-smoke | 6/6 | all hold |
| p5-head-1 | 4/4 | all hold |
| p5-head-2 | 4/4 | all hold |
| p5-head-3 | 4/4 | all hold |
| p5-smoke | 4/4 | all hold |

## Open

- task-stops.ts attestation refresh after W03f lands (W03g's entry pins the file; R7/R8 change it).
- The authoritative two-stage head run at the final head, after the refresh.
- R6's release basis (above): cost zero under the reserved-bound compute basis; "nothing launched" would need a
  durable claim-time fact on the launch row. The coordinator decides whether that is in scope.
- Design follow-up (coordinator, not this wave): a 30 s lease against a queue wait that can exceed it means every long
  wait ends in a named failure; a queued attempt should re-admit at claim instead.

## Process lessons this round

- A harness patch made against one head can stop applying at the next (the db82d8c15 import line); the wrapper now
  dry-runs every patch before any stack, names the failing hunk, and removes untracked leftovers between passes.
- A proof expectation must match the release path the package has: before R8, a refused reservation's hold cannot
  settle, so P2 is judged on the node's named failure, not on the run's end.
- Never queue a runner that checks tree cleanliness against a worktree where a later commit is staged: it refused
  (exit 4) and ran nothing; the merge-commit suites then ran in a detached checkout of the merge commit.
- A harness copy's fixture can make a measurement impossible (the per-node reservation equal to the run limit);
  read the product's refusal before reading the harness's error.
