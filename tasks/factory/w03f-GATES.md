# Gates: a typed provider error settles, so the run ends failed with its reason (W03f)

Branch `wp/w03f-provider-settle`, from `integ/w00` `d2bc674c7`. Receipts:
`/tmp/factory-platform-evidence/w03f/` (`receipts/*.json`, `logs/*.log`, `proof/`).

## The defect

W19a's `control-missing-model` disclosed it: a guest's model call that a provider refused
(Ollama's 404 for a missing model) left its run held forever. The one-hop provider threw a plain
error and dropped the usage the provider's error answer reported; the broker settled the operation
`failed` with a generic code and no usage; the guest's failed result therefore could not claim a
measured total; the stop found one operation, so W03e's no-operations rule did not apply, and it
kept the reservation uncertain; reconciliation, which settles only `uncertain` operations carrying
a provider receipt, named `factory_usage_hold_unresolved: no-operation-receipt` on every pass.

## The fix

- SDK: `provider_auth_failed` and `provider_rate_limited` beside `provider_unavailable`; a refused
  model response may carry the settled `operation`, which the guest copies into its result.
  Generated schema and Python validator follow.
- Provider: an error answer becomes a typed failure (401, 403 to auth; 429 to rate limit; anything
  else, including an unclassifiable message, to `provider_unavailable`) carrying the provider's own
  measured usage and a digest of the answer. An aborted stream or an unsettleable cost carries none.
- Broker and journal: the failed operation carries the typed code and that evidence.
- Stop: a confirmed stop of an attempt that did not complete settles from its journal, never from
  the guest's claimed usage. No operation: W03e's `no-operations` zero. Every operation completed or
  failed with measured usage: source `operations`, the journal's model cost and tokens, compute at
  the reserved bound, basis `provider-error: ...` or `operations: ...`. Otherwise, or when the result
  reports a held cost, the hold stays.
- Migration `add-factory-usage-operations` widens the three settlement CHECKs, after the fence and
  regrant migrations, before recovery.
- Graph proof: both W19a controls end `failed`, settled; `eb7b8b8c5`'s guest-claimed zero is superseded.
- Kernel (finding (a), lead ruling): a node failed with `provider_auth_failed` is not retried while
  attempts remain; `provider_rate_limited` and `provider_unavailable` keep the retry and its backoff.
- Late answers (finding (b), lead ruling): a hold whose operations are still prepared or dispatched
  names them (`operation-not-settled` with their ids). A provider that answers after the attempt's
  stop was confirmed parks its receipt and usage on the dispatched operation through
  `reconcileLate`; reconciliation settles it and W05b clears the kernel. No evidence: the hold stays, named.
- Closes the W01e/W03 follow-up "settled operation evidence on the model response" (handoff
  2026-09-24): a provider refusal carries the operation the host settled, and the guest copies it.

## Gates

- [x] G1: M1, W14's quarantine-under-live-attempt hold is identified by path.
  CHECK: `w14-repro.sh` under the heavy lock (the 12-test lane, then the product database read before the stack stops)
  EXPECT: the quarantined run's stop is `no-operations` settled (W03e path), and web.log names no hold
  EVIDENCE: `receipts/m1-w14-repro.attempt-2.json` at `1c8a9a23e`: 12/12; run `b9525101`'s stop `sealed-launch`
  `stopped`, one settlement `no-operations` with its basis, known 0; every reservation settled; 0 holds.
  Attempt 1 (log evidence only: 12/12, 0 holds against 158 before W03e) had a void read, below.

- [x] G2: Lifecycle cases per error class, with the negative control on today's behaviour.
  CHECK: `bun test ./src/__tests__/factory-task-stops.test.ts`; `negative-control.sh`
  EXPECT: all pass at the head; with only the base `task-stops.ts`, exactly the five W03f expectations fail
  EVIDENCE: `receipts/negative-control.attempt-1.json` (29/5 base, 34/0 head at `4ba07e94f`)

- [ ] G2b: Findings (a) and (b), red first.
  CHECK: `retry-red.sh` and `hold-red.sh` before the fix; the kernel and stop suites after; the guest-model-journal unit test
  EXPECT: red on exactly the new cases (auth retried; hold unnamed, then the late hold refused); green after
  EVIDENCE: `receipts/retry-red.attempt-1.json`, `logs/retry-red-kernel-recheck.log`, `receipts/hold-red.attempt-{1,2}.json`; PostgreSQL rerun in the next session

- [ ] G2d: Rulings B and C, red first.
  CHECK: `bound-red.sh` before the change; the stop suite, the provider test, the driver test and the migration tests after
  EXPECT: red on exactly the three new cases (bound, deadline abort, bound after abort); green after
  EVIDENCE: `receipts/bound-red.attempt-1.json`; PostgreSQL rerun in the next session

- [ ] G2c: A guest that rebuilds or alters the settled failed operation is refused as a journal mismatch.
  CHECK: the guest-model route suite
  EXPECT: the pre-W03f rebuild, a lowered usage and a changed receipt each pass result validation and are refused by the journal
  EVIDENCE: next session's `pg-factory-guest-model-route` and the coverage leg

- [ ] G3: Real PostgreSQL producers and schema parity, and the reference-data guest (two-packer rule).
  CHECK: `tests/postgres/factory-task-stops`, `factory-migration-restart`, `factory-schema`, `factory-guest-model-journal`, `factory-guest-model-route`, `factory-reference-data`; `reference-data/journey.integration` on Podman; all under the heavy lock
  EXPECT: all pass
  EVIDENCE: `receipts/pg-*.attempt-*.json`, `receipts/reference-journey.attempt-*.json`. At `1c8a9a23e` (before (a) and (b)):
  task-stops 34/0, migration-restart 19/0, schema 2/0, guest-model-journal 2/0, guest-model-route 17/0 (attempt 1).

- [ ] G4: The graph proof, both controls ending failed.
  CHECK: `run.sh all` under the heavy lock
  EXPECT: both modes three of three; `control-no-pin` and `control-missing-model` pass, each run `failed`, never held, settled at the reserved compute bound; forced-failure control as before; `summary.json` passed
  EVIDENCE: `receipts/graph-proof.attempt-*.json`, `proof/summary.json`

- [ ] G5: Coverage and static checks.
  CHECK: the coverage leg; `BASE_REF=d2bc674c7` new-file and patch gates; typecheck, lint, boundaries, gate integrity; `python-quality.sh test`
  EXPECT: 100 percent of the new migration and every changed line; all exit 0
  EVIDENCE: `receipts/cov-*.json`, `receipts/gate-*.json`, `receipts/static-*.json`

## What bounds a model call (coordinator ruling B plus C)

Coordinator ruling, recorded as the C03 reading change: settle an unknown cost only at the bound
the tenant accepted, named. An unknown is never settled at zero and never at a guest's claim.

- C, the one timer: the product's provider call carries the attempt's signed deadline. At the
  deadline the stream is aborted and the call fails `provider_unavailable` with no evidence
  ("The provider did not answer before the attempt's deadline.").
- The host's guest-broker transport still waits at most 300 s for the product's answer; that is
  the host side only, and the product's call ends at the attempt's deadline, not there.
- Every hold names what it waits on: `operation-not-settled` (prepared or dispatched) or
  `operation-cost-unknown` (failed with no measured usage), with the operation ids.
- A provider answer after the stop is parked for reconciliation (finding (b)) and settles from its
  receipt while the hold is still open.
- B: once the stop is confirmed and the attempt's signed deadline has passed, reconciliation
  resolves a named hold as `bound` and `settleAtBound` charges the reserved bound: settlement
  source `reserved-bound`, basis `unknown: charged at reserved bound`, proven by the stop receipt;
  W05b clears the kernel in the same transaction. Before the deadline the hold stays named and
  unsettled. A provider receipt that arrives after the bound settlement is kept in the journal and
  its reconciliation is refused (`factory_usage_settlement_state`): never settled twice.
- Coordinator ruling (approving a stated deviation from the first wording): the budget charges the
  vector's tokens at the reserved bound too, the same tenant-accepted maximum; the settlement
  record carries only costs and claims no measured token count, which keeps the truth visible. A
  nullable token count would change the budget schema and the envelope sums for no gain.

## Coordination with W15f (w15b-fix), the reservation hold after a restore

Agreed shape (lead accepted, recorded in both gates files):
- W15f owns a new nullable column on `factory_budget_reservations` (proposed `stale_epoch_hold BIGINT`,
  the execution epoch at which the hold was marked). W03f never reads it.
- W15f owns the skip rule inside `listUncertainWithCostInTransaction`: a marked row is skipped while
  its epoch is unchanged and the old attempt is not terminal. Once the attempt is terminal and past
  its signed deadline it is listed again, and W03f's `resolve`/`settleAtBound` take it.
- Migration order: W03f's `add-factory-usage-operations` after `allow-factory-artifact-regrant`,
  W15f's immediately after it, `add-factory-recovery` last. Different tables, no dependency.
- Coordinator ruling: a signed restore that moves the execution epoch marks the old epoch's
  attempts terminal as superseded, with the restore's digest as proof, in the same transaction.
  B accepts either proof of an attempt's end, named in the basis: "unknown: charged at reserved
  bound; ended by stop" (`stop_receipt_digest`) or "...; ended by restore supersession"
  (`restore_digest`, a new column with its own CHECK).
- W03f side built against the proposed reader `FactoryAttemptSupersessionReader`
  (`readAttemptSupersessionInTransaction(transaction, reservationId)` returning project, run,
  interpreter, attempt and `restoreDigest`), passed to `FactoryTaskStops` as its last argument.
  Red first: `receipts/restore-red.attempt-1.json`; the stop suite's case with a reader double
  settles at the bound with the supersession as proof, and a late answer is parked and refused.
- Coordinator rulings on the three open points:
  1. Names: w15b-fix picks the record and reader names; W03f renames to match on their reply.
  2. Kernel: W15f's supersession record is a sealed end for the old-epoch attempt, like a sealed
     stop. It carries the kernel event payload (attempt superseded, reason restore, both epochs, the
     restore digest), written in the restore's transaction. W05b's clear re-sends that event exactly
     as it re-sends a sealed stop's; any generalization of the clear to read either record goes in
     W15f with W05b's tests kept green. B emits no event of its own.
  3. The joint test on a real W15f-marked hold lives on whichever branch merges second; the other
     keeps its double.

## The integ/w00 9da0ed9ec merge (5cf78799c) and the hook-cap ruling

The coordinator's ruling, verbatim (issued 12:48Z per validator-4's review; the ruling's own text
names 12:52Z for the commit message):

> Ruling granted for this one commit only: the merge of integ/w00 9da0ed9ec into wp/w03f-provider-settle. Conditions: the commit message names it ("hook cap skip by coordinator ruling 2026-09-27 12:52Z; 26 mapped suites run outside the hook under the lock; receipts under /tmp/factory-platform-evidence/w03f/"); the hook's printed list of 26 recorded verbatim before committing; all 26 run as the first leg of your locked session with GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE and GIT_COMMON_DIR cleared and GIT_CONFIG_NOSYSTEM=1, the PostgreSQL ones against the proof database with the URL built inside the script, one receipt each, and a nonzero test count asserted per file (a leg that runs zero tests is red); the shared .git/config sha256 (44962525f1ca1a8b) recorded before and after; any red is a defect on your head, not a gap. Never raise EZ_PRECOMMIT_TEST_MAX.

The merge commit's message carries the text the ruling prescribed, word for word, including
"12:52Z" (validator-4 withdrew L2, which had called it a paraphrase). The conditions and their evidence:
- The hook's list, recorded verbatim before the commit (`logs/merge-hook-list-verbatim.log`):
  `scripts/factory-graph-proof/guest-package.test.ts`
  `src/extensions/v4/blobs-s3.test.ts`
  `src/factory/guest-sdk-closure.test.ts`
  `src/factory/installation-startup.test.ts`
  `src/factory/reference-code/guest.test.ts`
  `src/factory/runtime-composition.test.ts`
  `src/factory/service-probes.test.ts`
  `src/__tests__/cov-fix-connection-postgres.test.ts`
  `src/__tests__/db-connection.test.ts`
  `src/__tests__/factory-boot.test.ts`
  `tests/postgres/factory-archive-writer.test.ts`
  `tests/postgres/factory-artifact-materials.test.ts`
  `tests/postgres/factory-child-artifacts.test.ts`
  `tests/postgres/factory-encryption-s3.test.ts`
  `tests/postgres/factory-guest-material-broker.test.ts`
  `tests/postgres/factory-legacy-workflow.test.ts`
  `tests/postgres/factory-package-preparation.test.ts`
  `tests/postgres/factory-private-service.test.ts`
  `tests/postgres/factory-reference-data.test.ts`
  `tests/postgres/factory-run-inputs.test.ts`
  `tests/postgres/factory-run-lifecycle-s3.test.ts`
  `tests/postgres/factory-s3-publication.test.ts`
  `tests/postgres/factory-storage-cleanup.test.ts`
  `tests/postgres/factory-validator-materials.test.ts`
  `tests/postgres/migrate-lock.test.ts`
  `web/src/__tests__/factory-boot.server.test.ts`
- All 26 ran as leg 0 of the locked session with git's environment cleared and
  `GIT_CONFIG_NOSYSTEM=1`, one receipt each (`receipts/hook-*.attempt-*.json`); 24 green on the first
  attempt with a nonzero count. Two first attempts were my runner errors, rerun green:
  - `db-connection` (16/3): the session exported `DATABASE_URL` (`--pg`) to suites that require
    none; rerun without it, 19/0.
  - `web/src/__tests__/factory-boot.server` (10/3): a vitest file run under `bun test`; rerun with
    `bunx vitest run`, 13 passed. Its receipt first read 0/0 because the tool parsed only bun output;
    it is regenerated from the unchanged log with the shared counter (validator L3), and the tool
    now counts bun, vitest and node output through `/tmp/factory-platform-evidence/w00/test-count.sh`
    and makes a zero-count test leg red (exit 97).
- Shared `.git/config` sha256 `44962525f1ca1a8b` before and after the commit and the session.
- The session's one real red was W03f's: the route suite compared the whole provider options object
  after ruling C added the deadline signal; fixed test-only in `0ac18b37d`, rerun 18/0 on PostgreSQL.

## Validator-4 findings at 0ac18b37d

- L1: `parkLate` parked on any settle refusal. It now parks only on the liveness refusal
  (`isFactoryAttemptNotLive`: `factory_attempt_not_live`, `factory_run_stopped`,
  `factory_run_fence_changed`); a lost connection on a live attempt propagates as itself, nothing is
  parked, and the operation stays dispatched in a named hold that B settles. Red first:
  `receipts/l1-red.attempt-1.json` against `0ac18b37d`'s journal. That receipt predates the L3 tool
  and so has no `testsRan` field; its log shows 3 pass, 1 fail. Validator-4 reproduced it in a fresh
  worktree (3/1 at `0ac18b37d`'s journal, 4/0 at the head). L1 closed.
- L2: withdrawn by validator-4 (above). L3: closed.

## W15f names (from w15b-fix, their head 5afafa64b)

- The reservation mark is W15f's `factory_budget_reservations.epoch_stale_json` (JSONB), with the
  skip rule in `listUncertainWithCostInTransaction`; W03f never reads it.
- Record `factory_attempt_supersessions`; reader
  `readAttemptSupersessionInTransaction(transaction, tenantId, reservationId)` in
  `src/factory/attempt-supersessions.ts`. W03f's `FactoryAttemptSupersessionReader` takes that
  signature and shape (a null `interpreterId` yields no scope: no inbox to settle into).
- The clear for a superseded attempt is W15f's `clearResolvedSupersessionInTransaction`, reached
  through W05b's clear; B emits no event.
- The operations of a superseded attempt are read through W15f's
  `supersededOperationsInTransaction` (the live read refuses the old epoch). W03f calls it for a
  restore-proven scope; without it the hold stays named `superseded-operations-unreadable`.
- Migration order: W03f's `add-factory-usage-operations`, then W15f's
  `add-factory-usage-epoch-stale` and `add-factory-attempt-supersessions`, `add-factory-recovery` last.

## The integ/w00 94edd1e30 merge (W15f landed), the final step

Six conflicts, resolutions accepted by the coordinator (ruling 19:02Z):
- `scripts/coverage-thresholds.json`: both keys kept.
- `src/db/migrate.ts`: W01h's `add-factory-task-stop-reconciliation`, then W03f's
  `add-factory-usage-operations`, then W15f's `add-factory-usage-epoch-stale` and
  `add-factory-attempt-supersessions`, then `add-factory-recovery` last.
- `src/factory/dispatch-composition.ts` and its test: W15f's and W01h's changes kept; W03f's bound and
  named-hold logic sits inside W15f's stale-epoch catch; both sides' tests kept.
- `src/factory/task-stops.ts`: imports (W03f's settlement imports plus W15f's supersession exports).
- `src/__tests__/helpers/factory-task-stops-suite.ts`: the snapshot's version (integ's side equals W15f's).
The consumer and both joint cases come from snapshot `e8d9a55df` (write-tree/commit-tree, no hooks,
no refs). Where integ's file equals W15f's `930c90331` the snapshot version was taken (20 files); for
every other merged file W03f's delta against integ was checked equal to the snapshot's delta against
`930c90331`. The transitional `superseded-operations-unreadable` path and W03f's own reader type are
gone: the bound path calls W15f's `readAttemptSupersessionInTransaction` and
`readSupersededOperationsInTransaction` directly (refusing by name if the read names another attempt
or another restore digest); a null interpreter is named `superseded-without-interpreter`. Red then
green on the branch: `receipts/joint-red-green.attempt-1.json` (41/2 with the interim settlement
module, 43/0 with the consumer). Hook-cap ruling 19:02Z: `EZ_SKIP_HOOK_TESTS=1` for this one commit;
the 74 mapped files plus the factory-orchestrator package suite are listed verbatim in the commit
message and in `logs/final-merge-hook-list-verbatim.log`, and run as leg 0 of the final leg.

## task-stops.ts:370, a proven-executed line Bun 1.3.14 does not credit (pending the user's ruling)

Superseded (2026-09-29): after the custody merges the statement is line 373 and is re-attested in `1e8f08279`;
see "Custody: the W09h and W03g merges and the re-added attestation" below.

The final leg at `9c954b11a` is green except the patch-coverage gate (`BASE_REF=94edd1e30`), which
reports one uncovered changed line: `src/factory/task-stops.ts:370`,
`return factoryJournalStopSettlement(await this.journal.operations(liveAuthority.authority));`, the
last statement of `stopSettlement` and the single call site of `factoryJournalStopSettlement`.

That line executes. Evidence:
- `receipts/attribution-before.attempt-2` (one-file stop-suite coverage under the lock, Bun 1.3.14, at
  `9c954b11a`): 43/0, eight named passing tests settle `no-operations` or `operations`, which only
  that call produces; the lcov gives DA:370 = 0 while DA:369 (176) exceeds DA:366 (159), the line it
  follows.
- validator-4, independently (`/tmp/factory-platform-evidence/w03f-validation/logs/attr/`): the line
  replaced by a throw fails 34 of 43 cases while Bun credits it 0; and six code shapes at `9c954b11a`
  (the original, the `.then` form, a braced early return, a synchronous helper in three lines and in
  one, and two statements on one line) all leave the final statement's line at 0. Lint is clean on
  every form, so no suppression applies.
- W03f's own attempts, parked on proof refs and not on the branch:
  `proof/w03f-two-statement-refactor` (`a4c07dca5`): the await line credited (DA:370 = 156), the
  statement after it not (DA:371 = 0), `receipts/attribution-after.attempt-1`, patch gate red on 371
  (`logs/cov-final.out`); `proof/w03f-then-refactor` (`86330b87c`): the `.then` line at 0,
  `receipts/attribution-after.attempt-2`, patch gate red (`logs/cov-final2.out`). A refactor only
  moves the uncredited line, so the branch keeps the original form, unchanged since `4ba07e94f`.
- Bun 1.4.2 (the W12e upgrade question, an observation, not W03f evidence): the same one-file run at
  `a4c07dca5` in a scratch worktree with the system Bun 1.4.2 (`bun test v1.4.2 (744846f84)`) gives
  43/0 with DA:370 = 156 and DA:371 = 0 (`logs/w12e-bun142-probe.log`). The upgrade does not clear it.

So `src/factory/task-stops.ts:370` is a proven-executed line that Bun 1.3.14 credits to the line before
it. The patch gate is red on that one line, pending the user's ruling (a one-line exception, or
another route); nothing on the branch works around it.

The legs that stand from `9c954b11a` (this docs commit changes no code):
- leg 0: the 74 hook-mapped files and the factory-orchestrator package suite, 75 receipts, 1326
  tests, none red, none at zero;
- PostgreSQL: task-stops 43/0, guest-model-route 18/0, guest-model-journal 2/0, usage-epoch 6/0;
- coverage leg 210/0, cov-merge 0, new-file gate 0 (patch gate as above);
- the web build and the runbook mock pass (outcome passed);
- shared `.git/config` sha256 `44962525f1ca1a8b` before and after every leg.

Bun pin disclosure. Every `bun test` leg ran 1.3.14 (the final leg's 76 banners). The pinned
directory had no `bunx` until 19:36Z, so four steps ran the system `bunx`, Bun 1.4.2: the final leg's
three web vitest files and its web build, and the earlier `hook-web-factory-boot-server.attempt-2`.
All four reran green under the fixed pin at `a4c07dca5`, whose code differs from `9c954b11a` only in
the two lines of `stopSettlement` (vitest 1, 1 and 16 tests; web build exit 0). The runbook mock
pass used the earlier build; per the coordinator the graph proof stands. `receipt.sh` asserts both
`bun --version` and `bunx --version` against `.bun-version`.

## Custody: the W09h and W03g merges and the re-added attestation (w09h-2, 2026-09-29)

W03f's owner was gone; w09h-2 took custody (lead ruling). Evidence: `/tmp/factory-platform-evidence/w03f/custody/` (receipts under `receipts/`, logs under
`logs/`; `C` below). Identity: every commit below is authored and committed by archy noreply.

| Commit | What it is | Hook |
| --- | --- | --- |
| `f5a93ffd0` | merge integ/w00 `ad22592da` (W09h landed, receipts): seven conflicts resolved, the combined basis CHECK | EZ_SKIP_HOOK_TESTS=1 by the lead's ruling (`C/ruling-hook-skip-merge-ad22592da.txt`), 169 suites run outside: 169/169 green |
| `ef99d1120` | merge integ/w00 `afbca4d88` (W03g landed, receipts): no conflicts; the attestation file arrives as `[]` | 4 suites, 293/0 |
| `1e8f08279` | the task-stops.ts attestation re-added at line 373 | 0 suites |

### The W09h merge (`f5a93ffd0`)

- Conflicts: `tasks/lessons.md` by union; `usage-settlement.ts` (a no-operations settlement names one of its two bases,
  the reserved bound by default or W09h's "no-operations: nothing launched, all zero"; operations names one of its two;
  reserved-bound derives its own); `budgets.ts` (`settleWithoutOperationsInTransaction` keeps W09h's basis argument:
  "nothing launched" settles all zero, anything else W03f's compute-bound settle); `schema.ts` (the combined CHECK
  mirrored); `usage-settlement.test.ts`, `factory-task-stops-suite.ts` and `task-stops.ts` (both sides kept).
- The shared basis CHECK (lead ruling 2026-09-28): W09h's landed migration replaced the CHECK while "nothing launched"
  was missing and W03f's while "restore supersession" was missing, each installing its own form, so the two swapped
  the CHECK on every boot. W03f's `add-factory-usage-operations` now installs the union of every basis and replaces the
  CHECK while either marker is missing; W09h's migration then finds its marker and changes nothing. W09h's shared
  migration suite (PGlite and PostgreSQL) carries five cases: fresh boot, a W09h-shaped database, both registration
  orders, a repeated boot keeping the same `pg_constraint` oid, and a W03f-only CHECK (on no landed installation)
  converging.
  EVIDENCE: red first `C/receipts/combined-red-pglite` 2/5 (W03f's own migrate() case included); green
  `combined-green-pglite` 9/0; each added clause removed: `combined-clause-removed-1` (the nothing-launched value) 1/6,
  `-2` (the nothing-launched marker condition) 6/1, `-3` (the restore-supersession marker condition) 5/2.
- The 169 hook-mapped suites outside the hook (`C/receipts/hook-list-f5a93ffd0.jsonl`, 3346 tests): 168 green in the
  locked run; `src/__tests__/db-connection.test.ts` was red because the runner exported DATABASE_URL to every suite
  (the test asserts it absent); the runner now sets both URL variables only for `tests/postgres/*`, and the suite
  alone is 21/0 (`C/receipts/hook-list-db-connection-rerun.attempt-1.json`; cause in
  `C/receipts/hook-list-f5a93ffd0.CAUSE.txt`). Printed set == ruled set at commit time; shared git config
  `44962525f1ca1a8b` before and after.

### The W03g merge (`ef99d1120`) and the re-added attestation (`1e8f08279`)

- The attested statement `    return factoryJournalStopSettlement(await this.journal.operations(liveAuthority.authority));`
  is line 373 (was 370); `src/factory/task-stops.ts` sha256 `ee44eb3570d88a8a82eb01c14c23b4782b67b411bbe65e981c322088acfc4e19`.
- Re-probe under the lock, Bun 1.3.14, at the staged merge of `ae3240dd7` (the same code tree as `ef99d1120`;
  `afbca4d88` adds docs only), `C/w03f-probe.sh`, `C/logs/probe-merge-ae3240dd7/`: the stop suite with coverage 43/0
  on PGlite and on PostgreSQL, `DA:372,176` then `DA:373,0` on both (lcov kept); the line replaced by a throw fails
  34 of 43 on both; the file restored by checksum.
- Red first, the patch gate `BASE_REF=origin/main` on the re-probe lcov: with `[]` task-stops.ts lists 15 uncovered
  changed lines including 373 (`C/logs/attest-red-probe-lcov.log`); with the entry it prints
  "src/factory/task-stops.ts:373 attested (Bun 1.3.14 coverage defect)" and 373 leaves the list
  (`C/logs/attest-green-probe-lcov.log`). That input covers the stop suites only, so the gate is red for unrelated
  files in both runs: it is the attestation proof, not the gate result (below).
- Gate integrity check 11 names `scripts/coverage-attestations.json` ("needs the gate-change-approved label"). The
  finding is expected; the decision file `/tmp/factory-platform-evidence/w00/w03f-merge/gate-change-decision.txt`
  covers it at the integ merge. Nothing on the branch applies or simulates the label.

## Legs at the head `1e8f08279`

Base `afbca4d88`. Under the lock with `lock_veto w19a-graph-proof` first and the gate before every leg
(`C/w03f-head-legs.sh`), 02:44Z to 02:56Z on 2026-09-29; summary `C/logs/legs-head-1e8f08279.summary.log`, one log per
leg under `C/logs/legs-head-1e8f08279/`. Dirty 0 at start; shared git config `44962525f1ca1a8b` before and after.

| Leg | Result |
| --- | --- |
| SDK (`packages/@ezcorp/factory-sdk`) | 245/0 |
| orchestrator (`bun run test`) | 91/0 |
| PGlite, 25 files (guest-model 5+11+12+4+18+4, usage-settlement 12, task-stops 43, compute-admissions 19, budgets 13, run-lifecycle 92, migrate 8, migration-restart 19, factory-schema 2, the four settlement and admission migrations 2+5+2+2, dispatch-composition 50, usage-epoch 6, attempt-supersessions 1, attestation 26, rule 11 12) | all 0 fail |
| PostgreSQL, 12 suites (task-stops 43, guest-model-route 18, guest-model-journal 2, usage-epoch 6, admission-stop 5, usage-basis-migration 5, compute-admissions 2, run-lifecycle 92, budgets 13, schema 2, migration-restart 19, stop-lock-order 1) | all 0 fail |
| coverage producers: unit 368, PostgreSQL 81, SDK 245, orchestrator 182 (counted from the runner's own report) | all 0 fail |
| new-file coverage gate vs `afbca4d88` | PASSED (1 file) |
| patch coverage gate vs `afbca4d88`, full merged lcov | PASSED (14 files); `src/factory/task-stops.ts:373 attested (Bun 1.3.14 coverage defect)` printed |
| typecheck, lint, factory boundaries; web build | green |
| gate integrity vs `afbca4d88` | 1 finding, expected: check 11 on `scripts/coverage-attestations.json` (decision file above) |
| graph-proof runbook `pass mock none` | passed (`C/graph/w03f-head-1e8f08279.json`) |

## Disclosed

- Credential misdirection (lead ruling, record it): M1 attempt 1's `w14-repro.sh` sourced a file
  that sets `PGPORT` without exporting it, so `psql` presented the proof database's credentials to
  the other PostgreSQL on 127.0.0.1:5432 (the user's application container). It stayed on this
  host and failed authentication. The script now exports `PGPORT` and, before any password is
  presented, checks that it equals the proof container's published port; otherwise it exits.
- The graph-proof leg of the first session failed at the guest build (TS2307 on
  `console-types.ts`), a regression from the W14 merge in `guest-package.ts`, not W03f. It reruns
  once W14b lands.
- Retry rule scope: only `provider_auth_failed` is non-retryable, as ruled. `model_pin_mismatch` is
  refused before any claim and fails the same way on a retry too; the graph proof's nodes allow one
  attempt, so it is unchanged here.
