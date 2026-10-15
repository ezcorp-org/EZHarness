# C03 product budgets

- [x] Persist scoped run and child envelopes with fixed limits and deadlines; reuse SDK decimal validation, product transactions and audit.
- [x] Reserve before compute request, atomically with a required outbox write; reject concurrent over-allocation and changed identity reuse.
- [x] Keep unknown usage holds, settle once with verified receipts, preserve actual overspend and prevent further admission.
- [x] Return unused child allowance only after child reservations settle; no reset on process restart or grant revocation.
- [x] Run shared PGlite and real PostgreSQL conformance including races, response loss and audit/outbox rollback; 100% new source coverage.
- [ ] Wire budget and compute reservation authority into each gateway effect and final settlement.

Store interface: scoped FactoryBudgets(database, tenantId, now); openEnvelope, reserve(required enqueue callback), markRunning, markUncertain, settle, closeEnvelope, inspect. Lock the owning run before any envelope/reservation so all nested writes use one consistent order. Inputs come from trusted product policy, not runner authority fields. Pool capacity is a separate ledger and never changes budget facts.

Store evidence: canonical product coverage producer 57 pass / 0 fail / 10 files, including real Podman and the shared PGlite pool suite. budgets168/168, budgetmigration7/7, outbox130/130 executable lines. Shared real PostgreSQL budget suite7 pass / 0 fail /49 assertions. Canonical four-leg types and focused Biome pass. Logs: /tmp/factory-platform-evidence/product-parent-coverage.log, postgres-factory-budget-parent.log, budgets-types.log. This completes the store leaf only; per-effect compute/budget authority and public application composition remain unchecked.
