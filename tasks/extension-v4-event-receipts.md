# Durable Event Admission

- [x] Add a transactional admission receipt for owner-scoped action keys, including zero-recipient events.
- [x] Reject changed payload or scope on replay; keep distinct user actions distinct.
- [x] Keep receipts for at least 30 days and do not remove receipts while referenced deliveries remain pending or uncertain.
- [x] Commit accepted ask-user answers before bus delivery; state explicitly that pending question processes remain transient.
- [x] Send stable idempotency keys from shared browser event clients and enforce them at the server.
  EVIDENCE: Generic Hub/custom HTTP proof below; `/tmp/lifecycle-custom-isolated.log`:5 tests,37 assertions. Specialized host built-ins remain explicitly excluded.
- [x] Move task snapshot and assignment state plus notifications into the same transaction.
  EVIDENCE: Task state gates below;52 SQL/RPC/recovery tests and1 real concurrent-worker test pass.
- [x] Cover remaining terminal run producers and audit retained state events.
  EVIDENCE: `/tmp/terminal-final.log`:118 tests,380 assertions. The current durable/transient producer matrix is in `tasks/extension-v4-domain-outbox.md`; it does not classify every UI notice as durable.
- [x] Prove SQL rollback, concurrent replay, restart recovery, cross-user isolation, and changed-payload rejection.
  EVIDENCE:6 receipt SQL tests,41 assertions, plus actual PostgreSQL proof below and `/tmp/lifecycle-final-postgres.log`.

## Immediate Regression Work

- [x] Reproduce failed durable tool persistence in legacy unit sinks.
- [x] Keep production persistence failures fatal; use an explicit unit persistence seam instead of swallowing database errors.
- [x] Seed valid conversation, message, and extension records in actual SQL integration suites.
- [x] Reproduce and fix worker startup before asynchronous RPC wiring completes.
- [x] Finish combined regression and changed-file type checks.

Evidence: `/tmp/lifecycle-unit-persist-red.log` has 28 failing registry/executor tests before the fixture change. `/tmp/lifecycle-persist-sql.log` has 21 passing tests and 76 assertions against actual PGlite. `/tmp/lifecycle-async-wire-red.log` reproduces the host wiring race.

All 14 unit suites pass individually. `/tmp/lifecycle-async-wire-green.log` proves 16 passing tests and 70 assertions across queue dispatch and the real rootless lessons worker. `/tmp/lifecycle-boot-isolated-final.log` adds the real lazy boot/restart case: 4 tests, 40 assertions. A runtime restart does not repeat an old delivery; each new event starts one owner-bound isolated worker. `/tmp/lifecycle-persist-types.log` is a completed TypeScript run with no errors in this leaf's changed files; global unrelated errors remain.

The receipt and producer follow-up proofs below supersede this initial fixture stage. This file is not proof of universal event durability or final integrated coverage.

## Receipt Contract

`admitEventInTransaction(transaction, {principalId, namespace, key, scope, payload}, publish)` admits one owner-scoped action and runs its existing-queue publisher in the same transaction. It returns the original receipt on equal retries, including when the first action had no recipients. The authenticated host must resolve principal and scope before calling it; child RPC payloads cannot set them. The raw payload is not retained in the receipt.

Keys are 1–128 printable ASCII characters. New user actions must use new keys, even if their payloads match. Reusing a key with a different payload or scope returns `event_conflict`. The published event identity is a digest of the owner, namespace, and action key. Pending, uncertain, or missing referenced deliveries prevent receipt deletion. Cleanup deletes at most 1,000 eligible receipts per transaction after 30 days; this is the minimum retry window, not a forever exactly-once promise. Normal uninstall retains these records.

Admission has fixed limits of 10,000 retained receipts per owner and 100,000 globally. A shared database row lock makes the quota check atomic across processes; equal retries remain allowed at capacity. Missing quota-lock state fails closed. The existing host maintenance daemon runs bounded cleanup each tick and logs cleanup errors. If that daemon is disabled or unhealthy, cleanup stops and new actions eventually fail with capacity errors; retention is never shortened to make space. Restore maintenance rather than deleting live or uncertain history. Empty-recipient receipts retain only an answer digest, not the answer text; they do not recover an interrupted host question or turn.

Receipt SQL tests: `/tmp/lifecycle-receipts-final.log`, 6 tests and 41 assertions pass. Migration and query line coverage are 5/5 and 40/40, respectively, with required 100% threshold keys. Queue recovery uses a new queue instance over committed SQL. Existing SIGKILL tests prove the shared database transaction boundary. Later producer coverage and explicit exclusions are recorded below and in the domain outbox matrix.

Actual PostgreSQL 16 proof: `/tmp/lifecycle-postgres-receipts.log`. `scripts/verify-extension-postgres.ts` now checks shared domain-state/receipt/queue rollback, committed recovery, hidden payload stripping, changed-payload conflict, cross-owner receipt isolation, zero-recipient replay, and retention, in addition to the existing lifecycle CAS, migration, JSON fidelity, and delivery fencing tests. The disposable rootless PostgreSQL container was removed after the passing run.

## Ask-user Admission

## Hub Action Gates

- [x] Real HTTP actions reach a fresh isolated worker, with no conversation required for a declared global page action.
  CHECK: cd web && bun test ./src/__tests__/hub-isolated-action.integration.test.ts
  EXPECT: 4 tests pass.
  EVIDENCE: /tmp/lifecycle-hub-real4.log: 4 tests, 28 assertions pass with real PGlite, Podman, production route and broker.
- [x] Equal retries return the existing result; changed payloads conflict; rejected or uncertain worker execution is not HTTP success and does not repeat.
  EVIDENCE: The same real HTTP test checks worker counts, retained receipts, HTTP 409 and failed worker responses.
- [x] Caller payload paths do not grant project access. Only a current human-approved host binding supplies project scope; revocation prevents queued execution.
  EVIDENCE: The real test checks global provenance has no project fields, and binding revocation prevents another worker start.
- [x] Runtime failure paths have full line coverage.
  CHECK: bun test ./src/extensions/__tests__/delivery-runtime.test.ts --coverage
  EXPECT: 14 tests pass; delivery-runtime.ts line coverage is 100%.
  EVIDENCE: /tmp/lifecycle-hub-runtime-coverage2.log: 14 tests, 51 assertions; 100% runtime lines.

The browser adds one bounded `Idempotency-Key` per logical extension action. An explicit key survives transport wrappers. The route requires the key for Hub actions, validates the declared page and own event namespace, and waits for durable delivery completion. Current grants and host project approval are checked again before the worker starts. Receipts use the same owner quota and retention rules as other admitted actions.

Specialized host-rendered file-organizer actions remain outside the generic extension receipt guarantee. They have proposal/configuration state semantics, not an exactly-once extension delivery promise. Their separate authorization bypass is fixed and tested in `tasks/extension-v4-file-organizer-authority.md`; that fix does not add action receipts. These Hub tests use a trusted sealed release fixture; the separate author control-flow E2E proves the human approval UI.

## Conversation Custom Actions

## Task State Gates

- [x] Snapshot storage and all matching task deliveries share one SQL transaction; injected publication failure leaves neither changed state nor a bus event.
  CHECK: bun test ./src/__tests__/task-state-publication.test.ts
  EXPECT: Real SQL rollback, committed restart recovery, assignment merge, and source ownership cases pass.
- [x] Host assignment start, terminal callbacks, retry/stop routes and boot recovery use the shared writer, not a best-effort subscriber to persist state.
  EVIDENCE: /tmp/lifecycle-task-host-regressions-final.log: 184 tests, 659 assertions. Same-boot recovery after rejected terminal admission passes in the actual SQL publication suite; another tick emits nothing.
- [x] RPC task events persist the validated host-scoped task state before acknowledgement.
  EVIDENCE: /tmp/lifecycle-task-writer-final.log: 52 tests, 161 assertions; task writer, RPC handler and recovery each have 100% line coverage. /tmp/lifecycle-task-isolated-serialized.log: real rootless workers, 1 test, 15 assertions; both concurrent changes persist under host locks without lost updates.

Task source and host behavior: /tmp/lifecycle-task-final-coverage.log has 141 tests and 499 assertions. The source tests include an already committed terminal assignment, duplicate delivery, and a host-committed spawn result that must not be overwritten by an old source snapshot. Recovery limits and default hourly maintenance cadence are documented in `docs/extension-task-state-durability.md`.

Remaining task fixture audit: `/tmp/lifecycle-task-cohort-final.log` has 44 passing tests and 123 assertions, with no skips. Real SQL fixtures now supply the active conversation owner, current project membership and task store installation. The wire-only fixture uses the shared revision-checking task-event persistence port, not an acknowledgement with no state commit. The previously skipped assignment-completion test runs with all original auto-advance assertions. The global loop notice test explicitly asserts `durable:false`; global content-free notices do not claim durable scoped delivery.

Web task API fixtures: `/tmp/lifecycle-web-task-fixture-final.log` has 57 tests and 240 assertions passing. Both suites use the shared task publication port and include the assignment writer export. Completion callbacks settle their asynchronous task-state publication before asserting that the next child stream starts. Existing ownership, stop/retry, parent-message and continuation assertions remain intact. Scoped lint passes.

- [x] The generic conversation card event route admits a receipt and all eligible deliveries before HTTP success or UI bus emission.
  CHECK: cd web && bun test ./src/__tests__/hub-isolated-action.integration.test.ts
  EXPECT: 5 tests pass.
  EVIDENCE: /tmp/lifecycle-custom-isolated.log: 5 tests, 37 assertions. The runtime stops before admission, restarts after commit, and executes one real worker despite repeated equal HTTP requests. Changed payloads return 409.
- [x] Custom event admission rejects platform namespace forgery, missing source extensions, foreign owners, and revoked project membership. Zero-recipient retries remain deduplicated.
  CHECK: bun test ./src/extensions/domain-event-outbox.test.ts ./src/__tests__/ask-user-answer-durable.test.ts --coverage
  EXPECT: 21 tests pass; both production modules have 100% line coverage.
  EVIDENCE: /tmp/lifecycle-custom-coverage.log: 21 tests, 97 assertions; publisher and ask-user module each 100% lines.

Only a registered event in the enabled source extension's own namespace may enter this route. Each recipient must have that namespace and the exact current, scoped, and sealed event grant. Conversation ownership and current project membership are read inside the admission transaction. HTTP success means accepted durable delivery, not completed worker execution; the Hub action route remains the explicit synchronous completion API. Both use the same bounded owner receipt policy. Specialized append/finalize handlers keep their separate state transaction contracts.

The answer route now calls `acceptAskUserAnswer`, which binds the question to the current active conversation owner and current project membership. Receipt admission and extension delivery insertion commit before the host bus event. A repeated equal answer does not emit again. A changed answer returns HTTP 409, including after the in-memory pending question entry is removed. Invalid bodies return 400; foreign, inactive, or revoked owners return 404; persistence failures are not acknowledged as success.

The pending question map and its waiting process remain transient. Unknown collapsed questions still return an optimistic no-op; these receipts do not restart an interrupted question after server loss. The new guarantee applies to accepted answer event delivery, not to resuming an entire LLM turn.

Quota proof: `/tmp/lifecycle-receipt-quota-final.log` has 36 tests and 123 assertions, including actual SQL last-slot races, both quotas, missing-lock denial, and production maintenance cleanup. `/tmp/lifecycle-postgres-quota.log` passes the full PostgreSQL 16 script with two independent SQL connections competing for the final owner slot. Exactly one commits; global capacity is enforced. The test container is removed after the run.

Proof: `/tmp/lifecycle-answer-final.log` has 4 actual SQL tests and 22 assertions. `/tmp/lifecycle-answer-route-final.log` has 12 boundary tests and 35 assertions. The real admission module has 29/29 covered lines and a required 100% threshold. `/tmp/lifecycle-answer-lint.log` reports no changed-file lint errors.
