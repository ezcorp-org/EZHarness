# Gates: Factory C09 release and assurance idempotency

Scope: Route public human release and assurance mutations through the shared durable mutation receipt protocol.

- [x] G1: Prepare, policy create/revoke, approval request/decision, contract approval, and reconciliation require bounded idempotency keys and reject the same key with a different canonical payload.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test ./src/factory/releases.integration.test.ts ./src/factory/assurance.test.ts
  EXPECT: /0 fail/
  EVIDENCE: 2026-09-13 focused PGlite suite passed 26 tests and 115 assertions; same-key changed request, policy, contract, approval, decision, and reconciliation payloads return idempotency_conflict, and an empty key returns invalid_idempotency_key.

- [x] G2: Cached retries recheck current authority and return the original stable resource without duplicating policy use, approval notifications, archive publication, reconciliation, or audit facts.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test ./src/factory/releases.integration.test.ts ./src/factory/assurance.test.ts
  EXPECT: /0 fail/
  EVIDENCE: The same PGlite run proves stable prepare/approval/decision/policy/reconciliation retries, one notification and reconciliation row, no repeated archive or absence-proof calls, and denial of a cached prepare/approval after grant revocation.

- [x] G3: The same idempotency and authorization cases pass against an isolated PostgreSQL database through the shared helper.
  CHECK: test -n "$FACTORY_TEST_POSTGRES_URL" && PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun test ./tests/postgres/factory-releases.test.ts ./tests/postgres/factory-assurance.test.ts
  EXPECT: /0 fail/
  EVIDENCE: FACTORY_TEST_POSTGRES_URL focused run passed 26 tests, 0 failed, and 115 assertions in isolated databases created by setupFactoryPostgres.

- [x] G4: Changed release, assurance, and shared receipt source has complete measured line coverage, with SDK builds, all typechecks, lint, boundaries, and gate integrity green.
  CHECK: PATH=/tmp/factory-tools/bun-1.3.14/bun-linux-x64:$PATH bun scripts/check-factory-boundaries.ts
  EXPECT: /Factory boundary checks passed/
  EVIDENCE: /tmp/factory-release-idempotency-coverage-1536494/lcov.info measures releases 305/305, assurance 151/151, and mutations 39/39 lines. SDK and transport builds, all four typecheck legs, lint (8 existing infos, no errors), boundaries, gate integrity, and git diff check pass.
