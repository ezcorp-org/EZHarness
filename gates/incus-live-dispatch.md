# Gates: Durable provider dispatch

Scope: Durable sandbox controller calls an exact approved provider release and can reconcile uncertain Incus effects.

- [x] D1: Dispatch binds installation, release, connection, project, resource, and generation from host-owned records.
  EVIDENCE: `src/sandboxes/incus-dispatcher.ts` builds caller scope from the persisted binding and operation, pins connection revision and create preset fields, derives sandbox ID from binding ID, and rejects null or mismatched pins. `incus-dispatcher.test.ts` asserts the exact scope and rejects a changed preset or injected sandbox ID.
- [x] D2: Start/create/destroy receipts map to durable controller states without blind retries after unknown effects.
  EVIDENCE: Accepted mutation receipts become `PROVIDER_PENDING` with the provider operation ID. Reconciliation calls `lifecycle.inspectOperation`; a missing ID, failed inspection, revoked readback, or lost reply stays `OUTCOME_UNKNOWN`. The Incus adapter's `INTERNAL` result for a lost mutation without a provider ID also stays unknown. PGlite tests assert no second mutation call.
- [x] D3: PGlite and PostgreSQL focused tests pass with revoked, stale, and lost-response cases.
  EVIDENCE: Bun 1.3.14 `bun test ./src/sandboxes/incus-dispatcher.test.ts ./src/sandboxes/migration-postgres.test.ts` passed (10 tests, 51 assertions). `bun scripts/typecheck-tests.ts`, backend `tsc --noEmit -p tsconfig.typecheck.json`, and Biome check on the three edited sandbox files passed.
