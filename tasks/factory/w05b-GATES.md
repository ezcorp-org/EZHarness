# Gates: a reconciled hold lets the cancelled run end (W05b)

Branch `wp/w05b-reconcile-clear`, created from `wp/w03e-usage-settle` at `c6dbc321c`, which holds the
settlement code and the harness. Coverage gates use `BASE_REF=wp/w03e-usage-settle`. Receipts:
`/tmp/factory-platform-evidence/w05b/`. Report: `/tmp/factory-platform-evidence/w05b/report.txt`.

## Defect

W03e's open item 1: a run whose uncertain operation is later settled by reconciliation, from a provider
receipt, stays `cancelling` for ever. The kernel clears an attempt it holds as stopped-and-uncertain only
when a later `attempt-stopped` event says `uncertain: false`, and the reconciliation path never sent one.
A second defect has the same cause and shows up in the reverse order. When reconciliation settles the
cost while the physical stop is still unconfirmed, the stop that confirms later fails
`factory_task_stop_stale`, because the reservation is no longer uncertain. That stop then stays uncertain
for ever.

## Commits

| SHA | Subject |
| --- | --- |
| `d14a98658` | test(factory): a reconciled hold must let the cancelled run end, once |
| `90396066a` | fix(factory): reconciliation tells the kernel the stopped attempt is no longer uncertain |

## Gates

- [x] G1: Reproduce at base in the real application with W03e's harness.
  CHECK: `W05B_REPO=<worktree at c6dbc321c> W05B_HARNESS=/tmp/factory-platform-evidence/w05b/harness-base flock --close /tmp/ezcorp-validation-heavy.lock timeout 1800 bash harness-base/run-proof-w05b.sh base`
  EXPECT: run U is cancelled, its stop leaves the attempt uncertain, reconciliation settles the hold, and run U stays `cancelling`, with no clearing event.
  EVIDENCE: `proof/receipt-base.json` and `proof/record-base.json` (`c6dbc321c`, 02:01 to 02:03 local). Five checks held, among them "reconciliation settled the hold from the receipt, once, and the reservation is settled". Two failed: "exactly one clearing event ... reached the kernel" and "run U reached the terminal cancelled status". Run U stayed `cancelling`.
- [x] G2: The tests are red at base and green at head.
  CHECK: `bun test --timeout 120000 ./src/__tests__/factory-task-stops.test.ts`, with the head's tests over the base source, then at head.
  EXPECT: at base, the two clearing cases fail (the reverse order fails stale). At head, all pass.
  EVIDENCE: `logs/red-base-final.log` (25 pass, 3 fail at `c6dbc321c`: the two clearing cases, and the listing case, which fails because the reverse-order stop is left pending); at head, `sweep-final/receipts/focused-coverage.json` (94 pass, 0 fail).
- [x] G3: The clearing is exactly once, and a hold left uncertain is not cleared.
  CHECK: the stop suite cases "a reconciled hold clears ...", "a hold whose usage is still unknown ..." and "reconciling a hold whose physical stop is still unconfirmed ...", plus the kernel test "a usage-resolved stop clears the uncertain attempt once ...".
  EXPECT:
  - One `<cancel>:usage-resolved` event with `uncertain: false`, at the settlement's time.
  - Folded through the real kernel, the run reaches `cancelled`, and a replayed reconcile or stop adds nothing.
  - Unknown usage is not reconciled and not cleared.
  - An unconfirmed stop gets no clearing event. The later confirmation clears the uncertainty itself, and the run reaches `cancelled`.
  - Kernel replay is deterministic, and a redelivered event is a no-op.
  EVIDENCE: `sweep-final/receipts/focused-coverage.json` (94 pass, 0 fail, 568 assertions: stop suite, settlement unit, guest-model journal, SDK kernel, dispatch composition); `sweep-final/receipts/postgres-coverage.json` (real PostgreSQL: stops, guest-model journal, budgets, assurance; 60 pass, 0 fail).
- [x] G4: Real-server proof, three passes.
  CHECK: `W05B_REPO=<worktree at 90396066a> flock --close /tmp/ezcorp-validation-heavy.lock timeout 1800 bash harness/run-proof-w05b.sh pass-N`, for N = 1, 2, 3.
  EXPECT: `outcome: passed` and 7 of 7 checks in each receipt. Run U ends `cancelled` with the operator's reason, with exactly one clearing event.
  EVIDENCE: `proof/receipt-v2-pass-{1,2,3}.json` at `90396066a`, 03:25 to 03:27 local: each `passed`, 7 of 7. Both orders ran on the real server. In pass 1 the reconciliation's `:usage-resolved` event cleared the attempt after a confirmed stop. In passes 2 and 3 the host stop first timed out, reconciliation settled the cost, and the confirming stop's own `uncertain: false` event cleared it.
  The first three passes (`proof/v1-narrow-check/`, 02:03 to 02:05) counted only `:usage-resolved` events. That check was too narrow: passes 1 and 3 took the reverse order, cleared exactly once through the stopped event, and were marked failed although run U ended `cancelled`. The check now counts any `uncertain: false` after the first uncertain stop, and still requires exactly one.
- [x] G5: The W03e and W05 suites are unchanged and green; the static gates and coverage pass.
  CHECK: `W02C_REPO=<worktree> ... bash repro/sweep.sh final` (focused and PostgreSQL coverage, backend pool, typecheck, lint, boundaries, gate integrity, and `BASE_REF=wp/w03e-usage-settle` new-file and patch coverage).
  EXPECT: every leg exits 0.
  EVIDENCE: `sweep-final/receipts/*.json` at `90396066a`, clean tree. Every leg except the backend pool exited 0: typecheck, lint, boundaries, gate integrity; new-file gate: no new source files; patch gate: all changed executable lines covered (2 files).
  The pool failed two tests for an environmental reason. The shared `.git/config` changed to `core.bare = true` at 02:10, and this worktree had no per-worktree `core.bare = false`, so git refused to run `git grep` and `git check-ignore` there. Both tests fail identically at `c6dbc321c`. After setting `core.bare = false` for this worktree only (`logs/pool-failures-rerun.log`: 17 pass, 0 fail), the pool was rerun: `logs/backend-pool-rerun.log`, 28200 pass, 0 fail, at `90396066a`, clean tree.

## Files owned by other packages (disclosed)

- **W03 (Sol lifecycle):** `src/factory/task-stops.ts` and `src/factory/usage-settlement.ts`.
  - The interface `FactoryUsageSettlementAuthority` gains the optional `clearResolvedStopInTransaction`, which the production stop store implements. It is optional so the two test doubles, in the W03e and W05 suites, stay unchanged.
  - `stopEventFor` gains the phase `usage-resolved`.
  - The stop's finalize and its re-derivation accept a stop confirmed after reconciliation.
- **Sol controls:** `packages/@ezcorp/factory-sdk/src/kernel.test.ts` gains one replay test. `kernel.ts` is unchanged, because the kernel already folds `uncertain: false` (W03e). W09d-2 (`wp/w09d2-named-refusals`) edits `kernel.ts` for another case, and this package does not touch that file.
- **W03 tests:** `src/__tests__/helpers/factory-task-stops-suite.ts` gains three cases. The existing cases are unchanged.
- **Harness-supplied fact:** the real proof's guest has no gateway mount, so the harness records the one uncertain operation through the product's own `FactoryExecutionJournal`, which it constructs with an authorizer that admits every attempt. The receipt states this.
