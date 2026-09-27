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
- Open with w15b-fix: the confirmed record and reader names, how a superseded attempt leaves the
  run's kernel (W05b's clear needs a sealed stop, so after a restore it is a no-op today), and
  which branch carries the joint test on a real W15f-marked hold (whichever merges second).

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
