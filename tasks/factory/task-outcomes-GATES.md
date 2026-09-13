# Durable task outcomes gates

## Scope

- Bind every queued attempt to its exact compute reservation.
- Verify failed, cancelled, and uncertain C02 results against the immutable request, operation journal, and cursor.
- Commit the non-success receipt, workflow event, budget uncertainty, and queue acknowledgement in one product transaction.
- Recover sealed historical outcomes without another runner call.
- Retain all failed and cancelled holds until a separate trusted physical stop.

## Required proof

- PGlite lifecycle, queue, migration, rollback, corruption, transition, and recovery cases.
- Real PostgreSQL and S3 lifecycle, queue, and schema parity cases.
- New source and migration at 100% line coverage; changed-line coverage for shared journal, budget, queue, dispatcher, admission, and completion code.
- SDK build, all four type checks, lint, boundary checks, registration failure injection, and gate integrity.

## Review

- PGlite focused coverage: 44 tests, 707 assertions, exit 0. `task-outcomes.ts` is 118/118 lines and 17/17 functions. Its migration is 4/4 lines and 2/2 functions.
- Real PostgreSQL and S3: 45 tests, 2,832 assertions, exit 0.
- Backend source and backend-test type checks, lint, boundaries, registration failure injection, and gate integrity: exit 0.
- The combined type script reached an unrelated baseline web API type mismatch; backend, backend-test, and web-e2e legs pass. Parent integration owns the newer web contract fixes.
- Physical stop, usage settlement, pool release, and native/Python launch remain separate open C02 work.
