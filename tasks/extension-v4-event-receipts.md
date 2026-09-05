# Durable Event Admission

- [x] Add a transactional admission receipt for owner-scoped action keys, including zero-recipient events.
- [x] Reject changed payload or scope on replay; keep distinct user actions distinct.
- [x] Keep receipts for at least 30 days and do not remove receipts while referenced deliveries remain pending or uncertain.
- [x] Commit accepted ask-user answers before bus delivery; state explicitly that pending question processes remain transient.
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

Admission has fixed limits of 10,000 retained receipts per owner and 100,000 globally. A shared database row lock makes the quota check atomic across processes; equal retries remain allowed at capacity. Missing quota-lock state fails closed. The existing host maintenance daemon runs bounded cleanup each tick and logs cleanup errors. If that daemon is disabled or unhealthy, cleanup stops and new actions eventually fail with capacity errors; retention is never shortened to make space. Restore maintenance rather than deleting live or uncertain history. Empty-recipient receipts retain only an answer digest, not the answer text; they do not recover an interrupted host question or turn.

Receipt SQL tests: `/tmp/lifecycle-receipts-final.log`, 6 tests and 41 assertions pass. Migration and query line coverage are 5/5 and 40/40, respectively, with required 100% threshold keys. Queue recovery uses a new queue instance over committed SQL. Existing SIGKILL tests prove the shared database transaction boundary. These receipts are not yet connected to every producer listed above.

Actual PostgreSQL 16 proof: `/tmp/lifecycle-postgres-receipts.log`. `scripts/verify-extension-postgres.ts` now checks shared domain-state/receipt/queue rollback, committed recovery, hidden payload stripping, changed-payload conflict, cross-owner receipt isolation, zero-recipient replay, and retention, in addition to the existing lifecycle CAS, migration, JSON fidelity, and delivery fencing tests. The disposable rootless PostgreSQL container was removed after the passing run.

## Ask-user Admission

The answer route now calls `acceptAskUserAnswer`, which binds the question to the current active conversation owner and current project membership. Receipt admission and extension delivery insertion commit before the host bus event. A repeated equal answer does not emit again. A changed answer returns HTTP 409, including after the in-memory pending question entry is removed. Invalid bodies return 400; foreign, inactive, or revoked owners return 404; persistence failures are not acknowledged as success.

The pending question map and its waiting process remain transient. Unknown collapsed questions still return an optimistic no-op; these receipts do not restart an interrupted question after server loss. The new guarantee applies to accepted answer event delivery, not to resuming an entire LLM turn.

Quota proof: `/tmp/lifecycle-receipt-quota-final.log` has 36 tests and 123 assertions, including actual SQL last-slot races, both quotas, missing-lock denial, and production maintenance cleanup. `/tmp/lifecycle-postgres-quota.log` passes the full PostgreSQL 16 script with two independent SQL connections competing for the final owner slot. Exactly one commits; global capacity is enforced. The test container is removed after the run.

Proof: `/tmp/lifecycle-answer-final.log` has 4 actual SQL tests and 22 assertions. `/tmp/lifecycle-answer-route-final.log` has 12 boundary tests and 35 assertions. The real admission module has 29/29 covered lines and a required 100% threshold. `/tmp/lifecycle-answer-lint.log` reports no changed-file lint errors.
