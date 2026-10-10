# W03d — the operation provider receipt digest takes the C02 bare form

Branch `wp/w03d-receipt-digest`, cut from `integ/w00@cfbc3c767`.
Worktree `.worktrees/w03-stop`. Evidence `/tmp/factory-platform-evidence/w03d/`.

## The defect this leaf closes

W01e's validation found a collision on two frozen surfaces.

- The SDK's `validateFactoryRunnerResult`
  (`packages/@ezcorp/factory-sdk/src/validation.ts:626`, `validDigest(value, false)`),
  the generated `FactoryRunnerResult` schema, and the Python validator
  (`src/factory/runner/python/factory_validation.py:335`) all require an
  operation's `providerReceiptDigest` as BARE 64-character lowercase hex.
- `FactoryExecutionJournal.verifyRunnerResultInTransaction` requires a terminal
  result to mirror the journal row exactly.
- W03's settlement store required `sha256:` + 64 hex, at the builder, at the
  stored-receipt lookup, at `resolve`, and at `reconcile`.

So a row that could settle a cost could not pass the terminal check, and one
that could pass it could not settle. No attempt that called a model could both
settle and complete.

Coordinator ruling, 2026-09-20: the C02 bare form is canonical, because three
frozen surfaces already enforce it. The prefixed form is REFUSED, never
normalized.

## What changed

| File | Change |
|---|---|
| `src/factory/journal-validation.ts` | New exported `isFactoryProviderReceiptDigest`, the ONE definition of the form. `validateFactoryOperationSettlement` now checks the shape as well as the presence, under the new issue code `factory_operation_provider_receipt_invalid`. |
| `src/factory/usage-settlement.ts` | Imports that predicate instead of keeping its own `RECEIPT_DIGEST_PATTERN`. Four call sites: the builder, `readByReceiptInTransaction`, `resolve`, `reconcile`. |
| `src/factory/usage-settlement.ts` (`reconcile`) | The budget receipt is now the settlement's own `settlementDigest`, not the provider's digest. `FactoryBudgets.settleInTransaction` requires `sha256:` + 64 hex, and the budget row records the sealed evidence that justified the settlement, which already carries the provider receipt inside its canonical bytes. |
| `src/db/migrations/add-factory-usage-receipt-c02-form.ts` (new) | Replaces the `factory_usage_settlements_receipt_check` CHECK with the bare form. Idempotent, drops only while the definition still contains `sha256:`, and RAISES rather than relaxing the constraint if any stored digest still needs the old rule. |
| `src/db/migrate.ts`, `src/db/schema.ts` | Registration after `addFactoryUsageSettlements`; the Drizzle model mirrors the new CHECK. |
| `scripts/coverage-thresholds.json` | Key for the new migration at 100. |
| `docs/plans/2026-09-13-composable-factory-platform-interfaces.md` | The ruling as a dated line in freeze section 16. |

Digests this product seals itself are unaffected and stay `sha256:`-prefixed:
the physical stop receipt digest, the settlement digest, the event digest, and
the budget settle receipt. Both patterns now live side by side in
`journal-validation.ts` with a comment saying which is which.

## Drift guards, so the two surfaces cannot part again

Every one of these fails on the old code.

- `src/factory/journal-validation.test.ts` — "takes an operation receipt only in
  the C02 bare form": the predicate refuses the prefixed form, uppercase hex,
  63 and 65 characters, non-hex, leading space, empty, and three non-strings;
  and all three settlement states refuse a prefixed digest with
  `factory_operation_provider_receipt_invalid`.
- `src/factory/usage-settlement.test.ts` — the builder refuses the prefixed
  form, uppercase, and an over-long digest.
- `src/__tests__/helpers/factory-task-stops-suite.ts` — `reconcile` refuses a
  prefixed digest; `resolve` refuses four tampered stored digests, prefixed
  among them, rather than handing any of them to the reconciler.
- `src/db/migrations/add-factory-usage-receipt-c02-form.test.ts` — the column
  itself, after the migration, accepts a bare digest and refuses the prefixed
  form, uppercase, 63 characters, and a trailing space.
- `src/__tests__/helpers/factory-migration-restart-suite.ts` — across two extra
  boots the CHECK keeps its definition AND its catalog oid, and a probe table
  accepts only the bare form.

## Fixtures that carried the prefix, now corrected

`factory-task-stops-suite.ts` (three receipts), `factory-budgets-suite.ts`
(the scan case), `factory-migration-restart-suite.ts` (the revision case),
`usage-settlement.test.ts`, `journal-validation.test.ts`. Nothing else in
`src`, `packages`, or `tests` carried a prefixed provider receipt.

One fixture bug found while doing it: a tamper case wrote
`providerReceiptDigest.toUpperCase()` where the digest was all `7`s, so the
"uppercase" value equalled the original and the case asserted nothing. It now
uses letters.

## Verification

This leaf is ONE commit, the head of `wp/w03d-receipt-digest`; its hash is not
written here because the file is inside it. The test and static producers ran
at `cfbc3c767` with this tree; the two coverage gates ran against the commit, because they diff
`BASE_REF...HEAD` and read an uncommitted tree as an empty diff. Receipts and
logs under `/tmp/factory-platform-evidence/w03d/`.

| Producer | Result |
|---|---|
| PGlite sweep, 135 factory test files | 1240 pass, 0 fail (`factory-pglite.log`) |
| Focused coverage producer, 8 files | 65 pass, 0 fail (`focused-coverage.json`) |
| Real PostgreSQL, 5 shared suites under `flock /tmp/ezcorp-validation-heavy.lock timeout 1800` | 52 pass, 0 fail, 3301 expect calls (`postgres.json`) |
| `scripts/check-factory-boundaries.ts` | passed (F07, F13) |
| `scripts/gate-integrity.ts` | passed |
| `scripts/factory-c13-inventory.test.ts` + `scripts/factory-postgres-suite-registration.test.ts` | 18 pass, 0 fail |
| `bun run typecheck` | passed, including both locked mypy projects |
| `bun run lint` | no errors (8 pre-existing infos) |
| New-file coverage, `BASE_REF=integ/w00` | passed, 1 new source file gated; the new migration is 9/9 lines |
| Patch coverage, `BASE_REF=integ/w00` | passed, all changed executable lines covered across 5 files |

Real-PostgreSQL suites: `factory-migration-restart`, `factory-schema`,
`factory-task-stops`, `factory-budgets`, `factory-executions`. The URL is
assembled inside `/tmp/factory-platform-evidence/w03d/postgres.sh` and never
appears in an argument vector; the log and the receipt were scanned against the
credential and are clean. No store management and no `compose up` was run. No
new `tests/postgres` suite was added, so `db-postgres.yml` is unchanged.

## Disclosed crossing

`validateFactoryOperationSettlement` in `src/factory/journal-validation.ts` is a
shared freeze section 8 surface. The coordinator's brief named only
`usage-settlement.ts`, but leaving the journal able to STORE a form the runner
result can never carry would have left the collision half open, so the shape
check went to the shared validator and the settlement store imports it. This
adds one issue code, `factory_operation_provider_receipt_invalid`, which W14
should map alongside the other journal issue codes. Journal issue codes are
free-form strings, so no frozen union changed.

## Filed elsewhere

- W14: HTTP mapping for `factory_operation_provider_receipt_invalid`.
- W01e rebases onto this branch; its fixtures must use the bare form.


## Validation

Independent validator verdict: ACCEPT at `de9abfd07`. Report: `/tmp/factory-platform-evidence/w03d-validation/report.md`. Merged to `integ/w00` by the coordinator; W01e emits the C02 form on its next round.
