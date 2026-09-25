# Gates: operator-run Incus fixture API

Scope: Give the isolated EZHarness app an authenticated, durable path to create and clean up one qualification guest through the existing controller and fixture service.

- [x] G1: Admin endpoint creates and destroys a fixture for an exact active installation, release, connection, and preset, with a stable operator-supplied operation ID and origin check.
  EVIDENCE: `web/src/routes/api/infrastructure/incus/qualification/+server.ts` requires an admin session, exact same-origin JSON, exact fields, and a bounded operation ID. `IncusQualificationFixtureService.create` uses `authorizeFixture`, admission, and the durable controller. Start/stop use a separate bounded power operation ID.
- [x] G2: Status reads only the matching fixture and returns its durable operation/binding state without exposing an unrelated project or plaintext credentials.
  EVIDENCE: `status` checks the saved fixture, qualification project, and pinned binding scope, then projects only safe fields. Focused status and route tests check scope denial and response shape.
- [x] G3: Missing qualification setup, inactive release, forged scope, duplicate mismatched operation, and non-admin calls fail before provider effects.
  EVIDENCE: Fixture-service tests deny missing image/inactive release before dispatch, reject mismatched scope and reused power identity; route tests deny anonymous, API-key, non-admin, cross-origin, malformed, and extra-authority requests before service calls.
- [ ] G4: Focused tests, typecheck, lint, and unchanged coverage gates pass; no duplicate controller logic or test-only backdoor is introduced.
  EVIDENCE: Focused fixture and route tests pass (22 tests, 127 assertions); owned-file Biome and full `bun run typecheck` pass. Root integration owns the full coverage gate. Fixture actions call existing controller and admission services.
