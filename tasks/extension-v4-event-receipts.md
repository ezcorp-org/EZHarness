# Durable Event Admission

- [x] Add a transactional admission receipt for owner-scoped action keys, including zero-recipient events.
- [x] Reject changed payload or scope on replay; keep distinct user actions distinct.
- [x] Keep receipts for at least 30 days and do not remove receipts while referenced deliveries remain pending or uncertain.
- [ ] Commit accepted ask-user answers before bus delivery; state explicitly that pending question processes remain transient.
- [ ] Send stable idempotency keys from shared browser event clients and enforce them at the server.
- [ ] Move task snapshot and assignment state plus notifications into the same transaction.
- [ ] Cover remaining terminal run producers and audit retained state events.
- [ ] Prove SQL rollback, concurrent replay, restart recovery, cross-user isolation, and changed-payload rejection.

## Immediate Regression Work

- [x] Reproduce failed durable tool persistence in legacy unit sinks.
- [x] Keep production persistence failures fatal; use an explicit unit persistence seam instead of swallowing database errors.
- [x] Seed valid conversation, message, and extension records in actual SQL integration suites.
- [x] Reproduce and fix worker startup before asynchronous RPC wiring completes.
- [x] Finish combined regression and changed-file type checks.

Evidence: `/tmp/lifecycle-unit-persist-red.log` has 28 failing registry/executor tests before the fixture change. `/tmp/lifecycle-persist-sql.log` has 21 passing tests and 76 assertions against actual PGlite. `/tmp/lifecycle-async-wire-red.log` reproduces the host wiring race.

All 14 unit suites pass individually. `/tmp/lifecycle-async-wire-green.log` proves 16 passing tests and 70 assertions across queue dispatch and the real rootless lessons worker. `/tmp/lifecycle-boot-isolated-final.log` adds the real lazy boot/restart case: 4 tests, 40 assertions. A runtime restart does not repeat an old delivery; each new event starts one owner-bound isolated worker. `/tmp/lifecycle-persist-types.log` is a completed TypeScript run with no errors in this leaf's changed files; global unrelated errors remain.

The remaining receipt and producer gates are not complete. This file is not proof of full event durability.

## Receipt Contract

`admitEventInTransaction(transaction, {principalId, namespace, key, scope, payload}, publish)` admits one owner-scoped action and runs its existing-queue publisher in the same transaction. It returns the original receipt on equal retries, including when the first action had no recipients. The authenticated host must resolve principal and scope before calling it; child RPC payloads cannot set them. The raw payload is not retained in the receipt.

Keys are 1–128 printable ASCII characters. New user actions must use new keys, even if their payloads match. Reusing a key with a different payload or scope returns `event_conflict`. The published event identity is a digest of the owner, namespace, and action key. Pending, uncertain, or missing referenced deliveries prevent receipt deletion. Cleanup deletes at most 1,000 eligible receipts per transaction after 30 days; this is the minimum retry window, not a forever exactly-once promise. Normal uninstall retains these records.

Receipt SQL tests: `/tmp/lifecycle-receipts-final.log`, 6 tests and 41 assertions pass. Migration and query line coverage are 5/5 and 40/40, respectively, with required 100% threshold keys. Queue recovery uses a new queue instance over committed SQL. Existing SIGKILL tests prove the shared database transaction boundary. These receipts are not yet connected to every producer listed above.

Actual PostgreSQL 16 proof: `/tmp/lifecycle-postgres-receipts.log`. `scripts/verify-extension-postgres.ts` now checks shared domain-state/receipt/queue rollback, committed recovery, hidden payload stripping, changed-payload conflict, cross-owner receipt isolation, zero-recipient replay, and retention, in addition to the existing lifecycle CAS, migration, JSON fidelity, and delivery fencing tests. The disposable rootless PostgreSQL container was removed after the passing run.
