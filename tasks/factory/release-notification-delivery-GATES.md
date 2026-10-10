# Factory release notification delivery gates

- [x] G1: An approval request and an uncertain release become durable, visible in-app items through the existing factory notification queue.
- [x] G2: Visibility rechecks the exact current human grant and current approval or operation state; foreign, API-key, and revoked principals see nothing and cannot decide.
- [x] G3: Delivery and restart replay keep one visible item per durable notification identity, and approval decisions use the real assurance store.
- [x] G4: SDK, API, browser UI, e2e, coverage, builds, typechecks, lint, boundaries, and gate integrity pass.

## Receipts

- The shared release suite passes 19 PGlite cases with 120 assertions and 14 isolated PostgreSQL cases with 92 assertions. It proves atomic local delivery, restart deduplication, all three current-state projections, exact category grants, tamper rejection, and denied foreign and revoked approval decisions through `FactoryReleaseApplication` and the real assurance store.
- Focused SDK validation passes 5 cases with 216 assertions. Focused web component, client, route, and server suites pass 32 cases. The Chromium evidence journey passes and the inspected 1440 by 980 screenshot is `/tmp/factory-release-inbox-authorized.png`.
- Final coverage is `/tmp/factory-notification-backend-final.pLLdhf/lcov.info`, `/tmp/factory-notification-sdk-final.mqA29H/lcov.info`, and `/tmp/factory-notification-web.6abrlQ/lcov.info`. The delivery adapter is 8/8, the release application is 49/49, releases are 380/380, and each changed web runtime file is fully measured.
- The SDK build, production web build, all four type-check legs, lint, factory boundaries, OpenAPI and route contracts, patch coverage, and gate integrity pass. Lint reports eight existing informational findings outside this leaf.
