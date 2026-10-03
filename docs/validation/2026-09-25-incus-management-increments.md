# Incus management implementation checks

These checks cover source changes for PR #303. They do not replace live provider qualification.

## Verified increments

- The management API uses an admin human session, returns explicit non-secret fields, and selects a verified setup only for the current provider release and connection revision. Six API tests and one migrated PGlite integration test pass. The API increment reached 100% line coverage.
- Project preparation creates a user project, owner membership, preset quota, and approved sandbox binding in one transaction. Replay, conflicting input, capacity failure, and revoked authority are tested. A sandbox project has an empty remote workspace and an inert local path.
- The retained Incus 0.1.2 inspection schema is restored exactly. Host journal identity stays inside the host transport. Strict manifest validation remains enabled. Focused tests, lint, typecheck, and generated-schema checks pass for `3fabab012`, integrated as `66e1fa2a5`.
- A checksum-verified copy of the actual stopped database supplied the saved 0.1.2 manifest. The installed validator reproduced the startup rejection; the corrected validator accepted the same manifest. This check made no live provider call.
- Bundle tests reject writable release files and prove that a non-root HTTP smoke leaves the staged runtime placeholder empty. The smoke correction has 15 passing tests.
- The local fast suite passed before the final UI and compatibility changes: 27,131 backend/example tests, 3,645 web Bun tests, and 7,508 Vitest tests. Typecheck, lint, boundaries, gate integrity, manifest lock, route contract, Svelte checks, and production web build passed. Full coverage and browser gates were not part of that fast run.

## Still required

- Finish capacity-panel and page review, measure coverage, and capture the integrated browser flow.
- Verify and smoke the exact combined release bundle, including actual startup against an isolated copy of the retained database.
- Recover the existing CREATE, then finish guest execution, Compose, stop/resume, and cleanup through EZHarness.
- Pass live qualification and the normal project workspace flow against Incus.
- Run final checks and hosted CI on the pushed PR head.

The [active ledger](../../tasks/todo.md) records milestone completion. The [530 deployment receipt](2026-09-25-effectful-create-recovery-530-execution.md) records the live startup stop and preserved guest identity.

## Recovery build

The recovery-only build at source `fc59035d12513d1ae4f69d3118e0d3904763b882` includes the compatibility and bundle-smoke fixes, plus main's chat sidebar merge. Strict verification passes for all 76,120 bundle entries. Non-root startup returns HTTP 200 as UID 1001 and leaves the runtime placeholder empty. Manifest SHA-256: `3d05e326c5cf1754f3955e6b19f1094e99c6ce1e34cfeff717ace7458278145e`. Verifier SHA-256: `4e621540e76bd10d471adf2e84867fae40579a310e2465b06463eb4565875462`.

This build is for recovering and completing the existing guest fixture. The management page and the newly found chat-route correction are not part of it. The route currently rejects an Incus project as a local workspace; its correction is a separate implementation gate before the normal project chat test.
