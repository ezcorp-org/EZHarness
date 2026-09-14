# Gates: W06 rejection, repair, and replan

Scope: `docs/plans/2026-09-13-composable-factory-platform-completion.md` section 5, W06. Interface
freeze sections 10 (rejection branch), 12, 13, 15, and 16; contracts C04, C07, C09, and the
`reference.code.v1` graph of C10. Receipts live under `/tmp/factory-platform-evidence/w06/`:
`receipts.jsonl` holds one structured record per run (producing commit, dirty and untracked file
hashes, the exact command, exit code, UTC start and end, test and assertion counts, and the log's
SHA-256), and each log sits under `logs/` with a unique name. Written by `receipt.py`, copied from
W05's and retargeted.

Branch `wp/w06-remediation`. Base `integ/w00` at `1dc9a0226`.

## Commits

| Commit | Subject |
| --- | --- |
| `62e1713a9` | `feat(factory-sdk): wait for bounded remediation after a protected rejection` |
| `a558a01d8` | `feat(factory): scan settleable child runs oldest first` |
| `22d0d09ea` | `feat(factory): bound a replan to the authority the run already holds` |
| `58720c5fa` | `feat(factory): give an operator the bounded repair and replan controls` |
| `25e68a4dc` | `chore(factory): drop the unused graph type and mutable draft casts` |
| `607e0fe63` | `fix(factory-sdk): never ask a worker to cancel a decision that has no attempt` |
| `048699845`, `d48838639` | the W06 gate table and review |
| `8f1353fce` | `fix(factory): let the settleable scan enumerate and settle verify` |
| `ec49628a5`, `8a83dff4a` | the corrected commit table and the `settle` failure vocabulary |
| `0df8dbe72` | `fix(factory-sdk): give the durable input descriptor one constant and one schema` |

## Gates

- [x] G1: A protected rejection enters a bounded remediation wait and emits no command.
      CHECK: `bun test --timeout 60000 ./packages/@ezcorp/factory-sdk/src/kernel-remediation.test.ts`
      EXPECT: `10 pass 0 fail`; the acceptance node reads `status: "waiting"`,
      `waitingReason: "remediation"`, every attempt stopped, and the advance returns no commands.
      EVIDENCE: `logs/sdk-tests-final-20260914T074645Z.log`, receipt `sdk-tests-final`.
- [x] G2: Remediation produces a new candidate, a new freeze, every check again, and a new decision.
      CHECK: same file, test "remediation produces a new candidate, refreezes, reruns every check".
      EXPECT: the second `request-acceptance` carries candidate generation 1 with a candidate and an
      evidence set that differ from the rejected ones, and the dispatch trace between the two
      decisions is exactly `generate-private-candidate`, `freeze-complete-git-tree`,
      `protected-checks`. EVIDENCE: same receipt.
- [x] G3: The declared bound is consumed and never exceeded; exhaustion fails the run.
      CHECK: same file, tests "the declared bound is consumed", "an undeclared bound authorizes no
      remediation at all", "a forged plan cannot buy more candidate generations than the launch
      ceiling". EXPECT: `reference.code.v1` reaches decisions at generations 0, 1, 2 and then fails
      with `ACCEPTANCE_BOUND_EXHAUSTED`; three total generations, matching
      `FACTORY_LIMITS.maxCandidateGenerations`; a plan forged to declare 99 repairs still stops at
      three; a contract declaring no bound gets no remediation. EVIDENCE: same receipt.
- [x] G4: No stop path asks a worker to cancel a decision that has no attempt.
      CHECK: same file, test "no stop path asks a worker to cancel a decision". EXPECT: run
      cancellation, run-deadline expiry, an invalid decision output, and an infrastructure failure
      each settle the acceptance in place with no `cancel-node`, while a task in the same graph
      still receives one. EVIDENCE: same receipt.
- [x] G5: The rejection reaches the kernel as an event, never as a retried activity error, and the
      whole remediation replays.
      CHECK: `node --test --experimental-strip-types --test-name-pattern="remediation" packages/@ezcorp/factory-orchestrator/test/temporal-replay.test.ts`,
      and the canonical producer `bash scripts/factory-orchestrator-coverage.sh`.
      EXPECT: the workflow completes; decisions are recorded at generations 0 then 1; no
      `cancel-node` reaches the activity; `Worker.runReplayHistory` replays the history.
      Producer: `80 pass 0 fail`. The producer writes its spec output to
      `coverage-factory-orchestrator/test-progress.log` rather than stdout, so the receipt command
      is `bash scripts/factory-orchestrator-coverage.sh && cat coverage-factory-orchestrator/test-progress.log`.
      EVIDENCE: receipt `fix-orchestrator-replay`, 111 KiB log,
      `logs/fix-orchestrator-replay-20260914T092652Z.log`.
- [x] G6: A repair changes only a declared editable input, and cannot re-ask an unchanged candidate.
      CHECK: `bun test ./packages/@ezcorp/factory-sdk/src/kernel-run-controls.test.ts` and the
      remediation test "a repair cannot re-ask the same contract about an unchanged candidate".
      EXPECT: a repair touching a protected binding throws `protected binding`; a repair naming the
      acceptance node returns unchanged state with no new generation. EVIDENCE: `sdk-tests-final`.
- [x] G7: Sixteen replan widenings are each denied on their own, alongside equality and narrowing.
      CHECK: `bun test --timeout 60000 ./src/factory/run-controls.test.ts`
      EXPECT: `4 pass 0 fail`, 28 assertions. Denied: a different protected contract, a dropped
      claim, a changed input or output boundary, a different interpreter, a longer run deadline,
      more expanded nodes, a deeper scope, a new capability, a new effect, more declared cost,
      tokens, compute, or memory, an undeclared resource class, and demand declared on a second
      node. Admitted: an identical revision and a narrower one. EVIDENCE:
      `logs/run-controls-final-20260914T074739Z.log`, receipt `run-controls-final`.
- [x] G8: Replaced active work stops before the new candidate starts, and prior evidence is immutable.
      CHECK: `bun test ./packages/@ezcorp/factory-sdk/src/kernel-run-controls.test.ts` (replan waits
      for the current child attempt) and the remediation test's `priorCandidates` assertions.
      EXPECT: the replan emits `cancel-node` for the live child attempt and no `run-child` until the
      stop is acknowledged; the prior candidate keeps its own sealed input and output.
      EVIDENCE: `sdk-tests-final`.
- [x] G9: Deadlines, spending, retry counters, and continuation state survive remediation.
      CHECK: remediation test "remediation preserves recorded spending and replays to the same
      command identities". EXPECT: run deadline unchanged; `spentCostMicros` 1500 and
      `unknownCostMicros` 250 carried across the repair, including the root scope; `nextAttempt`
      back to 1 for the new generation; replaying every applied event from a fresh state reproduces
      identical command identities and an identical final state; `assertKernelContinuationState`
      accepts it. EVIDENCE: `sdk-tests-final`.
- [x] G10: The settleable-child scan is bounded, oldest first, and safe to run twice at once.
      CHECK: `bun test --timeout 300000 ./src/__tests__/factory-run-lifecycle.test.ts` and
      `bun test --timeout 600000 ./tests/postgres/factory-run-lifecycle.test.ts`
      EXPECT: `56 pass 0 fail`, 903 assertions on both PGlite and real PostgreSQL. The scan is
      empty before a child is terminal, ordered by start instant across the whole table, resumes
      exactly from a cursor, returns the same page to two concurrent callers, tolerates two
      concurrent settles, rejects a limit of 0, -1, 1.5, or 201, and lets `settle` report a corrupt
      binding for that child alone while the child behind it still settles.
      EVIDENCE: `logs/scan-pglite-rework-20260914T082912Z.log` and
      `logs/scan-postgres-rework-20260914T083006Z.log`, 56 pass and 903 assertions on each.
- [x] G11: The rejection receipt reaches the kernel and consumes no repair it was not granted.
      CHECK: `bun test --timeout 300000 ./src/__tests__/factory-run-lifecycle.test.ts -t "a failing
      required claim"`. EXPECT: one durable `rejected` row, no acceptance decision, and the kernel
      answers with no `cancel-node` and a `bound_exhausted` failure, because that fixture's
      acceptance declares no bound. EVIDENCE: `pglite-run-lifecycle-final`.
- [x] G12: Real PostgreSQL keeps schema parity.
      CHECK: `bun test --timeout 600000 ./tests/postgres/factory-schema.test.ts`
      EXPECT: `2 pass 0 fail`, 2857 assertions. No migration was added by this package.
      EVIDENCE: `logs/postgres-schema-parity-final-20260914T080417Z.log`.
- [x] G13: The production application composes run controls, and an operator can drive them.
      CHECK: `bun test ./src/factory/application.test.ts`, `bun run --cwd web test:component`,
      and `bun run --cwd web test:e2e -- factory-authoring-console.spec.ts`.
      EXPECT: `6 pass` for the application; 34 web factory tests pass; `14 passed` end to end,
      including the two new `@evidence` captures `factory-run-controls-bounded-repair` and
      `factory-run-controls-widening-denied`. EVIDENCE:
      `logs/application-final-20260914T074740Z.log`,
      `logs/web-component-tests-20260914T080537Z.log`,
      `logs/e2e-factory-console-final-20260914T080857Z.log`.
- [x] G16: The durable input descriptor has one constant and one generated schema (freeze
      correction 8). CHECK: `bun test ./packages/@ezcorp/factory-sdk/src/schema.test.ts` and
      `grep -rn '"factory.lazy-input.v1"' --include='*.ts' . --exclude-dir=node_modules --exclude-dir=dist`
      EXPECT: the grep returns three lines only, the constant's own declaration, the interface's
      literal that the schema generator reads, and the test asserting the constant's value; the
      other 25 call sites consume `FACTORY_LAZY_INPUT_SCHEMA_VERSION`. The schema round-trip test
      covers `FactoryDurableInput` against `urn:ezcorp:factory:lazy-input:v1`.
      EVIDENCE: receipt `fix-sdk-tests`, 184 pass and 1344 assertions.
- [x] G17: Every suite that constructed the descriptor by hand still passes on both databases.
      CHECK: `run-inputs.integration.test.ts`, `lazy-commands.test.ts`, `lazy-input.test.ts`,
      `factory-task-stops.test.ts`, and their `tests/postgres` counterparts.
      EXPECT: exit 0 from each. EVIDENCE: receipts `fix-run-inputs-pglite` (5 pass),
      `fix-lazy-commands-pglite` (7 pass), `fix-lazy-input` (3 pass), `fix-task-stops` (14 pass),
      `fix-postgres-run-inputs` (5 pass), `fix-postgres-lazy-commands` (7 pass).
- [x] G14: Typecheck, lint, factory boundaries, and gate integrity are green.
      CHECK: `bun run typecheck`, `bun run lint`, `bun scripts/check-factory-boundaries.ts`,
      `bun scripts/gate-integrity.ts`. EXPECT: exit 0 from each. EVIDENCE: receipts
      `fix-typecheck`, `fix-lint`, `fix-boundaries`, `fix-gate-integrity`.
- [x] G15: Every new file and every changed executable line is covered against the integration base.
      CHECK: `bun scripts/merge-lcov.ts '/tmp/factory-platform-evidence/w06/lcov-flat/*.lcov' coverage/lcov.info`
      then `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and
      `BASE_REF=integ/w00 bun scripts/check-patch-coverage.ts`.
      EXPECT: "New-file coverage gate PASSED: 1 new source file(s) gated." and "Patch coverage gate
      PASSED: all changed executable lines covered (16 file(s))." EVIDENCE: receipts
      `fix-new-file-coverage` and `fix-patch-coverage`.

## Proven

- A `node-failed` carrying `failureKind: "acceptance_rejected"` no longer answers with a
  `cancel-node`. `applyRejection` consumes one declared repair and escalates into the existing
  `"remediation"` wait, or fails the node with `ACCEPTANCE_BOUND_EXHAUSTED` once the bound is spent.
- `FACTORY_LIMITS.maxCandidateGenerations` is three. The declared `AcceptanceNode.maxRepairs` is
  clamped by it in the kernel and bounded by it in the compiler, in `validateCompiledFactory`, and
  in the published JSON schema, so a code pack cannot exceed three total candidate generations and a
  forged compiled plan cannot buy a fourth.
- An absent `maxRepairs` authorizes no remediation. That is the strictest reading of "enforce each
  domain's declared bound", and it is what `reference.catalog.v1` gets today.
- `reference.code.v1` matches C10's stated graph: snapshot, generate, freeze, protected checks,
  acceptance, then bounded repair to a new candidate. The self-judged `bounded-repair` loop that
  ran before the freeze and trusted the generator's own `accepted` flag is gone; that loop was the
  defect the plan names at completion-plan line 66.
- `generate-private-candidate` declares one repairable literal input, `remediation`, so a repair
  seals the rejection's feedback and re-runs the producer. The image and data packs gained the same
  input, which is what makes their declared `maxRepairs: 1` reachable at all.
- A repair may no longer name an acceptance node. Re-asking the same protected contract about an
  unchanged candidate is not remediation and would have burned a generation for nothing.
- `factoryBoundedReplacement` is exported and now also compares declared resource demand across
  every nested node and loop budget, plus resource classes, so a replan cannot move work onto a GPU
  the current revision never asked for.
- `FactoryChildRuns.listSettleableInTransaction` hands W09 a bounded, oldest-first enumeration. It
  takes no lock on purpose: two workers must see the same page, `settle` is already idempotent, and
  locking would serialise workers behind one another's settlement transaction. The scan enumerates
  and `settle` verifies, so a corrupt binding is reported for that child alone.
- The production `FactoryApplication` composes `FactoryRunControls` by default, so
  `/api/factories/projects/:projectId/runs/:runId/control` answers with a receipt instead of
  `factory_control_unavailable`.

## Deviations and findings

- **W06-1, measured and fixed.** Before this package, cancelling a run with an in-flight acceptance,
  or letting that node's deadline expire, emitted a `cancel-node` naming it. The gateway resolves
  that command through the attempt queue (`src/factory/task-stops.ts`), which holds nothing for an
  acceptance, so the activity fails and `workflow.ts` rethrows it as a non-retryable
  `ApplicationFailure` that kills the run. `physicalNode` now settles an acceptance in place on
  every stop path. `kernel-deadlines.test.ts` carried the old expectation and was corrected.
- **W06-2, measured and filed, not fixed.** Approval and release attempts have the identical shape
  and the identical defect: `beginStopping` emits a `cancel-node` for an approval waiting on a human
  decision, and the same command would be unanswerable. Widening `physicalNode` to cover them makes
  four `kernel-partitions.test.ts` cases fail, because they assert the current `"stopping"` shape,
  and it changes cancellation semantics this package does not own. **This is for the coordinator to
  route to the approval and release owners.** The one-line change is `physicalNode` returning
  `kind === "task" || kind === "subfactory"`; the four partition tests and their invalidation
  expectations then need the same correction `kernel-deadlines.test.ts` received.
- **Deviation.** `references.ts` lost the `repairCandidate` runner constant. The declared package
  lock is unchanged, because `@ezcorp/reference-code` is still pinned through `snapshotRepository`
  and `generateCandidate` and the lock dedupes by package name.
- **Deviation.** `src/factory/application.ts` is the coordinator's file in freeze section 12. The
  change is four lines and keeps `createRunControls` as an override seam; it is reported rather than
  filed because the brief assigns "wire the production application" to this package. W09 should
  take it or rebase around it.
- **Cross-package note.** `web/e2e/factory-authoring-console.spec.ts` gained run routes and two
  console selectors were scoped to `factory-console`, because the factories page now carries two
  lists that can name a factory. `web/src/routes/api/factories/_shared.ts` is W14's and was not
  touched; the four `FactoryRunControlError` codes it maps were already complete.
- **Observed flake, not reproduced.** One run of the console spec failed
  `creates and imports through the current membership project` on mobile-chromium with
  `getByLabel('Factory project')` not found, on a box shared with six other agents. Three later runs
  passed: 2/2 in isolation and 14/14 twice. The new section adds one mount-time fetch to that page,
  which plausibly lengthens the hydration window that `web/CLAUDE.md` documents. Recorded for W14
  and W18 rather than silently retried. Failing log:
  `logs/e2e-factory-console-20260914T080451Z.log`.

- **W06-3, found by W09's review, fixed.** The scan first verified each sealed binding inside the
  `map` that built its page, so one corrupt row rejected the whole page and the caller received no
  items at all. A single corrupt binding at the head of the order would then have stalled settlement
  for every child behind it, for good, and no consumer-side per-item handling could reach it because
  no item was ever returned. The scan now enumerates and `settle` verifies, which is where
  verification already was; safety is unchanged, and the loud failure moved from per page to per
  child. `FactorySettleableChild` also dropped `deadlineAtMs`, because an inherited clock is exactly
  what a caller must not read from an unverified row. Commit `8f1353fce`.

## What `settle` can raise, for a settlement driver's classifier

W09's driver classifies each failure as deferred or faulted and defaults an unknown code to faulted,
which is the safe direction. This is the complete reachable vocabulary, so the default is a backstop
rather than the common path.

| Code | Class | Raised when |
| --- | --- | --- |
| `factory_budget_pending` | deferred | The child still holds an unsettled reservation, an open grandchild envelope, or a non-zero allocation. Clears when the hold reconciles. `budgets.ts:245`, reached through `closeEnvelopeInTransaction`. |
| `factory_child_corrupt` | fault | The sealed binding does not verify, the audit head is missing or malformed, or the terminal command disagrees with the recorded run status. |
| `factory_child_conflict` | fault | The child run is not terminal, the binding digest changed under the lock, or its state is neither open nor settled. The scan only returns terminal children, so this means a genuine disagreement, not a race. |
| `factory_child_not_found` | fault | No binding row for that child. |
| `factory_child_forbidden` | fault | No transitions store is composed, or the service identity or tenant does not match. |
| `factory_budget_scope` | fault | The project or installation row is missing. Not contention: `lockFactoryScope` takes `FOR SHARE` and blocks rather than returning. |
| `factory_budget_not_found` | fault | A parent or child envelope is missing. |
| `factory_budget_receipt_invalid` | fault | The settlement digest is malformed. |

A child already settled by another worker is not an error at all: `settle` returns without effect,
both on the unlocked read and on the locked re-check.

## Coordinator fixes applied

The independent validation returned ACCEPT-WITH-FIXES. All four are closed at `0df8dbe72`.

- **A.** The `orchestrator-replay` receipts held 0-byte logs and null counts, so G5's "80 pass 0
  fail" was cited from a file the receipt did not capture. The producer writes its spec output to
  `coverage-factory-orchestrator/test-progress.log`, not stdout. `receipt.py` now also parses
  node's summary and refuses to record a receipt for a command that wrote nothing, so this class of
  empty evidence cannot recur silently. Reran under `flock ... timeout`; the receipt now carries
  111 KiB and `pass: 80, fail: 0`.
- **B.** `coverage-factory-orchestrator/lcov.info`, 3118 lines, was committed by accident in
  `607e0fe63`. Untracked with `git rm --cached` and the directory ignored beside `coverage-shard/`
  and `coverage-python/`.
- **C.** Freeze correction 8 closed. See G16 and G17.
- **D.** G10's stated assertion count corrected from 899 to 903.

Two receipts record exit 1 against suite paths that do not exist, `fix-run-inputs` and
`fix-lazy-commands`. Those are my own mistyped commands, not failures; the real paths are
`src/factory/run-inputs.integration.test.ts` and `src/factory/lazy-commands.test.ts`, and both pass
under `fix-run-inputs-pglite` and `fix-lazy-commands-pglite`. The failed records stay as written.

## Open

- Nothing in the W06 checklist is open. The rejection receipt itself, the `decision` column, and
  `classifyFactoryAcceptanceFailure` landed with W05 at `64d7d470a` and `5c3e8ae57`; this package
  consumed them unchanged, so migration entries 38 and 40 needed no further work here.
- A remediation wait is not visible in the public run projection. `FactoryRunProjectionState`
  (`src/factory/run-lifecycle.ts`) has no reason field and `run-transition-projector.ts` collapses
  every wait to `"waiting"`, so the browser control shows the run's error code rather than naming
  the node that awaits remediation. Adding the reason is a projection change W14 should weigh.

## Interface questions

1. **Should `physicalNode` cover approval and release?** Recommended: yes, in a follow-up owned by
   the approval and release owners, with the four `kernel-partitions.test.ts` corrections. The
   defect is measured, not theoretical.
2. **Should the run projection carry the waiting reason?** Recommended: yes, one optional field on
   `FactoryRunProjectionState`, so an operator can see which node is waiting for a repair without
   reading the kernel state.
