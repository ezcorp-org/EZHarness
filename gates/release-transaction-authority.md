# Release transaction authority

- [x] Reproduce production release resolution inside an existing SQL effect transaction.
- [x] Thread the exact supplied transaction through release state, migration pause and narrow principal authority reads without starting another transaction.
- [x] Hold shared installation, user and membership row locks until the admitted effect commits.
- [x] Prove transaction-local reads and PostgreSQL cross-connection revocation ordering.
- [x] Run focused lifecycle regressions, TypeScript and lint; report final-suite proof separately.

## Evidence

- `/tmp/lifecycle-tx-resolver-red.log`: production resolution inside a PGlite effect transaction blocks on the separate database transaction.
- `/tmp/lifecycle-tx-resolver-full.log`: transaction-local installation, migration pause, user and membership reads pass, including revoked and missing rows. The new narrow authority reader has 100% line coverage.
- `/tmp/lifecycle-publication-order-red.log`: PostgreSQL detects real `40P01` deadlock when publication holds the storage table lock and waits for the installation row while the admitted effect holds that row and needs to write storage.
- `/tmp/lifecycle-publication-order-green.log`: `bun scripts/verify-extension-postgres.ts` passes against disposable pinned PostgreSQL `docker.io/library/postgres@sha256:485935f94cc7165afa896978809c37b592dc07f0a37d2c8f645f12412d0212c8`. Two database clients prove four authority fences. The test observes server-reported blockers, commits the admitted effect, then verifies revocation completes. A later production release resolution denies the disabled installation. Existing lifecycle, migration, event receipt and browser cancellation checks remain intact. The owned container is removed after the run.
- `/tmp/lifecycle-tx-regressions.log`: `bun test ./src/extensions/runtime-transaction-read.test.ts ./src/extensions/v4/lifecycle.test.ts ./src/extensions/v4/data-migrations.test.ts` passes 35 tests and 156 assertions.
- `bun node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json` passes; `/tmp/lifecycle-tx-types.log` is empty. Scoped Biome and `git diff --check` pass.

## Lock order

The supplied-transaction production resolver first takes `extension_storage ROW EXCLUSIVE`, then the installation row `FOR SHARE`. Principal and membership reads use the same transaction and shared row locks. Runtime fence checks and effect writes follow authority checks in the storage, entity and tool-finalization handlers. Publication and storage migration take the storage table lock before the installation update lock. This consistent table-before-row order prevents the reproduced cycle. The repository default is unchanged; no caller receives a new global transaction.

The earlier full 53-test real-auth pass at parent `5fe4b17a` predates these changes. It is not final full-suite proof for this leaf. External effects are not rolled back by SQL cancellation or revocation.
