# Gates: W09h stop during compute admission settles in place

Branch `wp/w09h-admission-stop`, cut from integ/w00 at `e92d34d45` (W09e landed: merge `3f4acd1c5`). The work was
first done on the scratch branch `scratch/w09h-on-w09e` (cut from W09e's accepted head `ef0868738`); the scratch
table below is kept for its receipts, and "The rebase onto integ" maps each scratch commit to its wp commit.
Evidence: `/tmp/factory-platform-evidence/w09h/` (receipts under `receipts/`, logs under `logs/`; `E` below).
Brief: `/tmp/factory-platform-evidence/w00/briefs/w09h.md`. Owner: w19a-graph-proof until 2026-09-28 00:00Z, then w09h-2.

| Commit | What it is | Hook (mapped suites, result) |
| --- | --- | --- |
| `b109144fa` | R2: a stop during compute admission settles in place (kernel `stoppedBefore: "admission"`, STOPPED_BEFORE_ADMISSION, inbox enum, admission stop record migration, pin replaced) | 8 suites, 73/0 (`E/receipts/r2-commit.attempt-1.json`); amend 1 suite, 1/0 |
| `6350b62b3` | R3: a late grant for a stopped attempt is refused by name and released | 2 suites, 21/0 (`r3-commit`) |
| `bbf02876a` | R4, first form: the hold settled through W03e's reserved-bound basis (superseded, see G4) | 2 suites, 11/0 (`r4-commit`) |
| `5d6d398f9` | R4: the hold settles all zero under "no-operations: nothing launched, all zero" (additive CHECK migration) | 5 suites, 22/0 (`r4b-commit`) |
| `f70c06fbe` | R5: stop and late grant take the run lock before the admission row (test only) | 1 suite, 5/0 (`r5-commit`) |

No commit mapped more than 12 suites; no hook was skipped. Every commit is authored and committed by the archy
noreply identity. `b109144fa` was amended once before any report (first form `b0fff51d2`, kept on
`proof/w09h-r2-preamend`); the R1 scratch snapshot `a18691d7f` is kept on `proof/w09h-r1-red-snapshot`.

## The rebase onto integ

`wp/w09h-admission-stop` = `e92d34d45` plus, one commit per rule, each through the hook under the pin
(`E/w09h-rebase.sh`, log `E/logs/wp-rebase-e92d34d45.log`; dry run first, `E/logs/rebase-dry-run-e92d34d45.log`):

| wp commit | Rule | Scratch source | patch-id (scratch = wp) | Hook (mapped suites, result) |
| --- | --- | --- | --- | --- |
| `44359136b` | R2 | `b109144fa` | bfce1254778c4a08 | 8 suites, 0 fail (`wp-R2-commit`) |
| `6ef6b18f3` | R3 | `6350b62b3` | 3e3d8b5a47ef5a65 | 2 suites, 21/0 (`wp-R3-commit`) |
| `d13ab0fd5` | R4 | `bbf02876a` + `5d6d398f9`, squashed | 050009d4f97b1465 | 5 suites, 22/0 (`wp-R4-commit`) |
| `0f503c130` | R5 | `f70c06fbe` | 011b646e47019ca8 | 1 suite, 5/0 (`wp-R5-commit`) |
| `2080af911` | docs | `1ba348e45` | differs: lessons union | 0 suites (`wp-docs-commit`) |
| `ef3f64457` | validator-5 M1 (below) | new | new | 1 suite, 2/0 (`m1-commit`) |

- R4 squash (lead ruling 2026-09-28 00:13Z): `bbf02876a` settled compute at the reserved bound under W03e's basis,
  a false basis for an attempt that never ran (withdrawn by the 2026-09-27 23:30Z ruling); `5d6d398f9` corrected
  it. The squashed commit's diff has the same patch-id as the scratch range `6350b62b3..5d6d398f9`.
- Tree equality at `2080af911`: 23 W09h files are byte-equal to the scratch tip `1ba348e45`; the 6 files integ also
  changed (`.github/workflows/db-postgres.yml`, `scripts/coverage-thresholds.json`, `src/db/migrate.ts`,
  `src/db/schema.ts`, `tasks/lessons.md`, `tasks/todo.md`) carry exactly the same added and removed W09h lines.
  The only conflict was appended entries in `tasks/lessons.md`, resolved by union (both sides whole).

## validator-5 M1: the all-or-none stop CHECK is tested

- [x] M1: no test exercised `factory_compute_admissions_stop_check`. `ef3f64457` adds a PGlite case that re-installs
  the check from the migration and writes rows with each stop column missing alone and set alone, the epoch at 0,
  the time below 0, and a stopped row in state admitted; each is refused by the stop check, and the three valid
  rows are accepted.
  CHECK: `bun test --timeout 300000 ./src/db/migrations/add-factory-compute-admission-stop.test.ts`.
  EXPECT: green at the head; red with any one clause removed from the migration.
  EVIDENCE: green `m1-green` 2/0; red with each of the five clauses removed in turn, `m1-clause-removed-1` to `-5`
  (1 fail each; the removed text of each is in `E/logs/m1-clause-removed-N.check.txt`; removal 4 drops the two
  value bounds, which share a line). For example, removal 1 drops
  `(stop_command_id IS NULL) = (stop_requested_epoch IS NULL)`, and the case fails because the database accepts a
  row it must refuse ("Expected the database to refuse this statement.").

## The defect

When a run stopped while a node was `reserved` (its compute request queued, nothing dispatched), the kernel sent
cancel-node with `attemptCommandId` = the request-admission command. The task stop found no queued attempt and
refused it `factory_task_stop_stale`; nothing sent attempt-stopped, so the run stayed `stopping` for ever and the
budget hold stayed `held`. The stop suite pinned that refusal.

## Files owned by other packages

| File | Commit | Change | Ruling |
| --- | --- | --- | --- |
| `packages/@ezcorp/factory-sdk/src/kernel.ts`, `kernel-types.ts`, `index.ts` | `b109144fa` | `attempt-stopped` may carry `stoppedBefore: "admission"` (certain stop of a task node only, never with `effect`); node error STOPPED_BEFORE_ADMISSION | brief, stop record paragraph |
| `packages/@ezcorp/factory-orchestrator/src/validation.ts` | `b109144fa` | the inbox refuses a `stoppedBefore` outside the enum | brief |
| `src/factory/usage-settlement.ts`, `budgets.ts`, `src/db/schema.ts` | `5d6d398f9` | the second no-operations basis; the budget settle charges compute by the basis it is given | ruling 2026-09-27 23:30Z / 23:35Z |

## G1 = R1: the reproduction, red first

- [x] G1: a run cancelled while its node waits for admission stays `stopping`, the stop is refused
  `factory_task_stop_stale`, and the hold stays `held`.
  CHECK: `bun test --timeout 300000 ./tests/postgres/factory-admission-stop.test.ts` at the base.
  EXPECT: 0 pass 1 fail, with those three facts in the log.
  EVIDENCE: on `a24a619ad` `E/logs/r1-red.attempt-2.log` (0/1, sha256 d9957411f518eb47…); on `ef0868738`
  `E/logs/r1-red-at-w09e.attempt-2.log` (0/1, afba7ee251968a30…). Attempt 1 of each is void and kept: a query
  error in the test itself, and a leg without `./` that ran zero tests (exit 97).
- Green at the head: see "Legs at the head" below.

## G2 = R2: settle in place

- [x] G2: the stop settles the reserved attempt in its own transaction, with no claim and no capacity; the
  admission row records the stop (command, cancellation epoch, time, sealed event; all-or-none CHECK); the kernel
  gets attempt-stopped `stoppedBefore: "admission"`; the run reaches `cancelled` without the pool; a repeat
  answers the recorded event.
  CHECK: the R2 case in `tests/postgres/factory-admission-stop.test.ts`; the stop suite's
  "cancelling during admission" case on PGlite; the kernel and admissions unit suites.
  EXPECT: green with the fix; red with it removed; the old pin red at the base behaviour.
  EVIDENCE: green `r2-green` 1/0, `r2-pin-green-pglite` 1/0, `r2-admissions-unit.attempt-3` 18/0,
  `r2-migration-unit` 3/0, `r2-pg-schema` 3/0; negative control `r2-negative-control` 0/1.
- [x] Pin replaced: the old expectation ("cancelling during admission claims no capacity and leaves no stop to
  settle", refused stale, hold `held`) is red against the fix (`r2-old-pin-red-with-fix` 0/1), and the new
  settle-in-place case is red at the base behaviour (`r2-pin-red-base-behaviour` 0/1).

## G3 = R3: the pool side

- [x] G3: a grant the pool decides while the stop settles is refused `factory_compute_admission_attempt_stopped`
  under the admission row lock, released through the admission worker's existing authority-loss cancel (no new
  trust path), never committed, and never dispatched.
  CHECK: the R3 case in `tests/postgres/factory-admission-stop.test.ts`; `src/__tests__/factory-compute-admissions.test.ts`.
  EXPECT: green with the fix; red with it removed.
  EVIDENCE: green `r3-green` 2/0, `r3-unit-green` 19/0; negative control `r3-negative-control` 1/1.

## G4 = R4: the hold settles all zero, basis "nothing launched"

- [x] G4: in R2's transaction the hold settles cost 0, tokens 0 and compute 0 through the `no-operations` source
  under the basis "no-operations: nothing launched, all zero", proven by the sealed stop's digest; one settlement,
  one usage-settled event before attempt-stopped. The additive migration widens the basis CHECK by one member,
  replacing it only while the one-basis form is installed (no catalog churn on reboot).
  CHECK: the R4 case (PostgreSQL), the stop suite (PGlite), `src/factory/usage-settlement.test.ts`, and the shared
  migration case on PGlite (`src/db/migrations/add-factory-usage-nothing-launched-basis.test.ts`) and PostgreSQL
  (`tests/postgres/factory-usage-basis-migration.test.ts`).
  EXPECT: red before the fix; red with the fix removed; red with the migration's new clause removed; green at the head.
  EVIDENCE: red before the fix `r4b-red-pin-pglite.attempt-2` 0/1 and `r4b-red-pg.attempt-2` 2/1 (compute settled
  7, the reserved bound, not 0); green `r4b-green-pin-pglite` 32/0, `r4b-green-pg` 3/0, `r4b-unit.attempt-1` 9/0,
  `r4b-migration-pglite.attempt-2` 3/0, `r4b-migration-pg.attempt-2` 1/0, `r4b-schema-restart-pglite` 22/0;
  negative control (the budget basis argument removed) `r4b-negative-control-pg` 2/1 and
  `r4b-negative-control-pglite` 31/1, only the R4 case failing in each; clause removed `r4b-clause-removed-pglite`
  0/1 and `r4b-clause-removed-pg` 0/1. `r4b-red-*.attempt-1` are compile-level reds (the export did not exist yet).
- The first R4 commit `bbf02876a` settled compute at the reserved bound under W03e's basis. That basis text is
  false for an attempt that never ran, and the 23:30Z ruling had withdrawn it; `5d6d398f9` corrects it.
- Lead ruling 2026-09-28 00:13Z: at the rebase onto integ, `bbf02876a` and `5d6d398f9` are squashed into one R4
  commit, and this file shows that the squashed tree equals the pre-rebase tip's tree for those files. The scratch
  branch was never a validated head; on `wp/w09h-admission-stop` nothing is squashed or amended after a report.

## G5 = R5: lock order

- [x] G5: the admission row is the stop row and is locked under the run lock. Both contenders take the run row,
  then the lifecycle row, then the admission row. Two real-PostgreSQL cases drive stop-vs-grant in both orders,
  synchronised on the database: a gate transaction holds the lifecycle row, the first contender queues behind the
  gate (`pg_blocking_pids` = the gate), the second queues on the run row behind the first (`pg_blocking_pids` = the
  first), and neither has reached `factory_compute_admissions` while it waits. Both end cancelled, the hold settled
  once at zero, the grant released at the pool once and never committed, no deadlock.
  CHECK: the two R5 cases in `tests/postgres/factory-admission-stop.test.ts`.
  EXPECT: green at the head and over three repeats; red when a contender locks the admission row before the run.
  EVIDENCE: green `r5-green.attempt-2` 5/0, `r5-repeat` 15/0 (`--rerun-each 3`); negative control, the stop
  locks the admission row first: `r5-negative-control` 4/1 (the stop-first case); the grant's commit locks it
  first: `r5-negative-control-grant` 3/2 (both cases). The first draft's red `r5-green.attempt-1` (3/3) was the
  harness, not the code: its waiter probe matched backends by query text (the second contender waits on the run
  row, not the lifecycle row) and a failed probe never released the gate, which hung teardown for 300 s.
  The fixture's four-connection pool was not the cause: the gate, two contenders and the probe fit in it.
- The observed order (run row, lifecycle row, admission row) matches `lockFactoryScope`'s shared order
  (project, installation, run, then lifecycle and other rows). No lock-order finding.

## Legs at the head `ef3f64457`

Base `e92d34d45`. Heavy legs under `flock --close` with `lock_veto w19a-graph-proof` first and the resource gate
before every leg (`E/w09h-legs.sh`), 15:22Z to 15:34Z on 2026-09-28; summary `E/logs/legs-wp-ef3f64457.summary.log`,
one log per leg under `E/logs/legs-wp-ef3f64457/`.

| Leg | Result |
| --- | --- |
| kernel (`packages/@ezcorp/factory-sdk`) | 238/0 |
| orchestrator (`bun run test`) | 91/0 |
| PGlite: task-stops 32, compute-admissions 19, run-lifecycle 92, budgets 13, migrate 8, migration-restart 18, factory-schema 2, usage-settlement 9, admission-stop migration 2, nothing-launched migration 1, no-operations migration 2 | all 0 fail |
| PostgreSQL: task-stops 32, compute-admissions 2, run-lifecycle 92, admission-stop 5, usage-basis-migration 1, stop-lock-order 1, budgets 13, factory-schema 2, migration-restart 18 | all 0 fail |
| PostgreSQL R5 cases, `--rerun-each 3` | 6/0 |
| coverage producers: unit 198, PostgreSQL 145, SDK 238 | all 0 fail |
| coverage-orchestrator | red in this run by the zero-count rule (exit 97); rerun green 91/0 (see below) |
| coverage gates vs `e92d34d45` | new-file PASSED (2 files); patch PASSED (13 files) |
| typecheck, lint, factory boundaries, gate integrity; web build | green |
| graph-proof runbook `pass mock none` | passed (`E/graph/w09h-wp-ef3f64457.json`, outcome "passed") |

- coverage-orchestrator: red in this run by the zero-count rule (exit 97, 0 counted;
  `E/logs/legs-wp-ef3f64457/coverage-orchestrator.log`). The tests ran (the node runner's `test-progress.log`
  said 91/91), but `scripts/factory-orchestrator-coverage.sh` sends the runner's report only to that file, and the
  leg logged only the script's stdout. The defect was the leg, not the counter: the leg now appends this run's
  `test-progress.log` to its log. Rerun of that leg alone at `ef3f64457`, under the lock with
  `lock_veto w19a-graph-proof`, 18:53:33Z to 18:55:56Z: exit 0, 91 tests counted, 17 lcov files
  (`E/logs/orch-leg-ef3f64457.summary.log`, log `E/logs/orch-leg-ef3f64457/coverage-orchestrator.log`, sha256
  72b4ff51599cd8b1…). The rule is unchanged; W18c's `f77a3c112` fixes the producer itself.
- Dirty paths during these runs: the main run at `ef3f64457` started clean (dirty 0); the rerun started with one
  uncommitted path, `tasks/factory/w09h-GATES.md` (this file, docs only), so the code tree equalled `ef3f64457`.

## Legs at the scratch head

Scratch head `f70c06fbe`, base `ef0868738`. Heavy legs under `flock --close` with `lock_veto w19a-graph-proof` first
and the resource gate before every leg (`E/w09h-legs.sh`); lock held 00:51:37Z to 01:01:48Z on 2026-09-28. Summary
`E/logs/legs-scratch-f70c06fbe.summary.log`; one log per leg under `E/logs/legs-scratch-f70c06fbe/`. Every leg
repeats at the rebased `wp/w09h-admission-stop` head before validation, with the graph-proof runbook.

| Leg | Result |
| --- | --- |
| kernel (`packages/@ezcorp/factory-sdk`) | 238/0 |
| orchestrator (`bun run test`) | 91/0 |
| PGlite: task-stops 32, compute-admissions 19, run-lifecycle 92, budgets 13, migrate 8, migration-restart 18, factory-schema 2, usage-settlement 9, the two W09h migrations 1 and 1, W03e's no-operations migration 2 | all 0 fail |
| PostgreSQL: task-stops 32, compute-admissions 2, run-lifecycle 92, admission-stop 5, usage-basis-migration 1, stop-lock-order 1, budgets 13, factory-schema 2, migration-restart 18 | all 0 fail |
| PostgreSQL R5 cases, `--rerun-each 3` | 6/0 |
| coverage producers: unit 197, PostgreSQL 145, SDK 238 | all 0 fail |
| coverage-orchestrator | RED by the zero-count rule (exit 97, 0 tests counted) |
| coverage gates vs `ef0868738` | new-file PASSED (2 files); patch PASSED (13 files) |
| typecheck, lint, factory boundaries, gate integrity | green |

- The coverage-orchestrator leg is red by the zero-count rule and stays red; nothing was loosened. Cause (lead
  ruling 2026-09-28): at this base `scripts/factory-orchestrator-coverage.sh` prints its node test totals only to
  its `test-progress.log`, not to its own output; W18c's `f77a3c112` makes it print them, and W18c lands before the
  rebase. As evidence, not as the count: the node runner's totals for this run were `tests 91, pass 91, fail 0,
  cancelled 0, skipped 0` (`E/logs/legs-scratch-f70c06fbe/coverage-orchestrator.test-progress.log`, sha256
  1cf221cb6726421e…). Its lcov was produced and merged into the patch gate.
- The first queued run (PID 4146423) was withdrawn while waiting, by a watchdog of mine that matched its own command
  line; it held no lock. Re-queued as PID 4168041, which produced these results.
