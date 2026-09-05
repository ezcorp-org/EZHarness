# Durable Event Admission

- [ ] Add a transactional admission receipt for owner-scoped action keys, including zero-recipient events.
- [ ] Reject changed payload or scope on replay; keep distinct user actions distinct.
- [ ] Keep receipts for at least 30 days and do not remove receipts while referenced deliveries remain pending or uncertain.
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
