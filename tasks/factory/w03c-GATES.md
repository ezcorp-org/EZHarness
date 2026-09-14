# Gates: W03c composition inputs for W09's stop and usage roles

Branch `wp/w03c-composition-inputs`, cut from `integ/w00` at `f30da62fa`. Receipts under
`/tmp/factory-platform-evidence/w03c/`; each `<label>.json` records the producing commit, dirty and
untracked file hashes, the exact command, the exit code, UTC start and end, test counts, and the
log's SHA-256.

| Commit | Subject |
| --- | --- |
| `7c837d20b` | `feat(factory): supply the two composition inputs W09's stop and usage roles need` |
| this commit | `docs(factory): record the W03c gates` — its own SHA is reported to the coordinator |

W09 verified both gaps against the merged tree. Neither role could compose.

## 1. A tenant can confirm a supervisor's stop

`FactoryTaskStops` requires a `FactoryPoolStopAcknowledger`, and `PoolAdmissionClient` had no such
method. `confirmStopped` now exists on the client over the pool's private HTTPS transport with the
tenant peer identity `acknowledgeStart` uses, backed by `PoolAdmissionService.acknowledgeStopped`
and `POST /v1/pool/requests/:id/confirm-stopped`.

**It releases nothing, and that is the design.** C03 says local CPU, memory, and GPU capacity is not
returned until the trusted supervisor confirms process death. The tenant gateway holds a host-signed
receipt it verified itself, but the pool cannot verify that signature, so a tenant's word must never
free a holder's capacity. Only the supervisor route mutates the ledger; this one reads the settled
result and fails closed until that has happened. Because it writes nothing, a lost response and a
repeat are the same call, and a concurrent pair agrees.

A GPU reservation stays unacknowledged after its stop: it reaches `uncertain` awaiting a verified
reimage receipt rather than `settled`. That is the contract, not an omission, and the test drives it
through `confirmReimage` to settlement.

## 2. A listed hold can be reconciled

`FactoryUsageReconciliation.resolve` maps a `FactoryUncertainHold` to the four facts `reconcile`
needs, every one read from evidence the journal already sealed, or to a typed unknown result. It
never synthesizes a usage and never reads an absent receipt as a zero cost: an unresolved hold stays
held, which is the point of C03's fail-closed unknown-usage rule.

The operation it reads is the one that caused the hold. The journal marks exactly that one
`uncertain`, and that state is the only one whose provider receipt digest is mandatory, so a receipt
attached to some other operation is never mistaken for this hold's evidence.

## A real defect this surfaced

The pool records a host only for an allocation that binds a whole one, so a CPU reservation has
none. Three layers compared it strictly, which meant **a CPU attempt could never settle against a
real pool**: `FactoryTaskStops.confirm` required `acknowledged.hostId === receipt.hostId`, and
`FactoryPoolLedger.confirmStopped` refused any supplied host for a hostless row. The W03 stop suite
never saw it because its acknowledger was a stub that echoed the host back; only composing against
the real service did. All three now treat a recorded host as something that must not contradict the
caller, while absence is no opinion. The GPU case still refuses a foreign host, and both are proven.

## Ownership crossings

| File | Section 12 owner | Why it changed |
| --- | --- | --- |
| `src/factory/pool/client.ts` | not named in section 12 | The `confirmStopped` client method W09 composes against. |
| `src/factory/pool/service.ts` | not named in section 12 | `acknowledgeStopped`, and the host comparison fix. |
| `src/factory/pool/service-routes.ts` | not named in section 12 | The tenant route. |
| `src/factory/pool/ledger.ts` | Sol lifecycle (W03) | The host comparison fix. |
| `src/factory/task-stops.ts` | Sol lifecycle (W03) | The host comparison fix. |
| `src/factory/usage-settlement.ts` | Sol lifecycle (W03) | `resolve` and the widened journal seam. |
| `src/__tests__/helpers/factory-run-lifecycle-suite.ts`, `src/__tests__/factory-compute-admissions.test.ts` | W06 / W03 | Their `PoolAdmissionClient` stubs gain the new method. |

## Gates

- [x] G1: A tenant confirms a supervisor's stop and can never stand in for one.
  CHECK: `bun test --timeout 120000 ./src/factory/pool/ledger.integration.test.ts` and
  `tests/postgres/factory-pool.test.ts`
  EXPECT: exit 0 on both engines; before the supervisor confirms, the acknowledgement is refused and
  the holder is still running; after it, the tenant reads the settled fact; a repeat and a
  concurrent pair are identical and move the ledger not at all; a stale generation, another tenant,
  an unknown reservation, a malformed field, and a supervisor certificate on the tenant route are
  each refused
  EVIDENCE: `focused.json` (146 pass), `postgres.json` (61 pass).

- [x] G2: A GPU stop stays unacknowledged until its host is proven reimaged, and a foreign host is
  refused where the pool knows one.
  CHECK: `bun test --timeout 120000 ./src/factory/pool/ledger.integration.test.ts -t "proven reimaged"`
  EXPECT: exit 0; the supervisor's stop leaves `uncertain` awaiting reimage, the acknowledgement
  fails closed, and only `confirmReimage` makes it acknowledgeable
  EVIDENCE: `focused.json`, `postgres.json`.

- [x] G3: The transport works over real mutual TLS, and a lost response is a repeat.
  CHECK: `bun test --timeout 240000 ./tests/postgres/factory-pool-http.test.ts`
  EXPECT: exit 0; 409 before the supervisor confirms, the settled status after, an identical retry,
  a concurrent pair, 409 on a stale generation, 403 for another tenant's certificate, and 400 for a
  malformed body
  EVIDENCE: `postgres.json`.

- [x] G4: A listed hold resolves to the sealed facts, or stays unknown.
  CHECK: `bun test --timeout 300000 ./src/__tests__/factory-task-stops.test.ts` and
  `tests/postgres/factory-task-stops.test.ts`
  EXPECT: exit 0 on both engines; no receipt yet stays unknown, a receipt on a different settled
  operation is not borrowed, a receipt without measured usage is still unknown, a tampered digest
  and a tampered usage are refused with distinct codes, the resolved facts settle exactly once with
  one settlement row, resolving twice gives the same answer, and the hold leaves the list
  EVIDENCE: `focused.json`, `postgres.json`.

- [x] G5: Static gates and diff-scoped coverage.
  CHECK: `bun run typecheck && bun run lint && bun scripts/check-factory-boundaries.ts && bun scripts/gate-integrity.ts`,
  the C13 inventory and suite-registration tests, then
  `BASE_REF=integ/w00 bun scripts/check-new-file-coverage.ts` and `check-patch-coverage.ts`
  EXPECT: exit 0 for each
  EVIDENCE: `static.json` (43 pass), `coverage-gates.json`. Six changed files, every changed
  executable line covered. All six modules at 100% lines in the merged report: `pool/client.ts`
  144/144, `pool/service.ts` 52/52, `pool/service-routes.ts` 96/96, `pool/ledger.ts` 445/445,
  `task-stops.ts` 310/310, `usage-settlement.ts` 216/216.

No new `tests/postgres` suite was added, so `db-postgres.yml` needs no entry; the registration gate
confirms it. No compose or store management was run, and no shared store was modified.

## Open

- **`FactoryTaskStops` still needs a `FactoryPhysicalStopper`.** This leaf supplies the pool
  acknowledger and the hold resolver. The host-stop transport exists
  (`createFactoryHostStopClient`), but nothing composes runtime, transport, and stop service into
  one live chain; that remains W09's, as recorded in `w03-GATES.md`.
