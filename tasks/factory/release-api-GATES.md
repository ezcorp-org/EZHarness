# Release API gates

- [x] G1: Public contract applies the C01 scope map and sanitized resources; no effect claim, dispatch, candidate, evidence, archive, sender token, or raw release material surface.
- [x] G2: Every mutation binds Idempotency-Key and If-Match to a store-owned transaction, and cached responses reauthorize through FactoryMutations.
- [x] G3: SDK schemas, shared handler, registry, browser client, and real release/assurance stores agree under focused tests and exact error mappings.
- [x] G4: SDK builds, all four typechecks, lint, boundary checks, focused coverage, and changed-source patch coverage pass.

## Receipts

- Backend store/application coverage: `/tmp/factory-release-api-backend-1963307/lcov.info` (38 tests, 206 assertions; assurance 160/160, releases 313/313, application 94/94, release application 40/40).
- Final S3 adapter coverage: `/tmp/factory-release-api-adapter-final-2032646/lcov.info` (3 tests, 26 assertions).
- Final SDK coverage: `/tmp/factory-release-api-sdk-final-2057424/lcov.info` (all added executable validation lines covered, including verified provider receipts).
- Final web coverage: `/tmp/factory-release-api-web-final-2030796/lcov.info` (27 tests; shared handler 214/214, client 80/80, each new route 100%).
- Route, OpenAPI, and session-scope suites pass 50 tests with 115 assertions. SDK, harness-client, and transport builds, all four typechecks, production web build, lint, factory boundaries, gate integrity, and `git diff --check` pass.
