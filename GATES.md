# Gates: Extension v4 implementation and PR

- [x] G1: Contracts, SDK, Podman runner and durable lifecycle implemented and tested.
  EVIDENCE: Contract 22 tests/278 assertions; SDK 1,023 tests/2,332 assertions; actual runner 36 tests/266 assertions (`/tmp/ez-runner-final-independent.log`). All 50 sealed candidates pass at tree `6e634060ed624549d1d11c17325678860740596c` (`/tmp/ez-all50-final5.jsonl`); the three later changed examples pass separately (`/tmp/ez-candidate-final-three-delta.jsonl`). Actual shared PostgreSQL checks pass (`/tmp/lifecycle-final-postgres.log`). These checks do not claim every candidate capability was exercised.
- [x] G2: Host, harness tools and UI use the shared lifecycle; real authoring loop passes.
  EVIDENCE: `/tmp/ez-extension-v4-real-final10.log` has nine passing actual authenticated/rootless flows, including editor authoring, external control, chat self-build, immutable upgrade, and the protected scanner. See `docs/extension-v4-validation.md` for command results and limits.
- [ ] G3: Security, recovery, migration and complete contribution parity pass.
  EVIDENCE: Runtime security and recovery checks pass. Retired legacy behavior is explicitly mapped rather than claimed as equivalent; maintainer review of the documented compatibility choices remains required.
- [ ] G4: Full required validation passes on the final branch before push.
  EVIDENCE: Runtime checks, full coverage, changed-line coverage, actual browser tests, and production image verification pass. Gate integrity has 84 documented migration findings and still needs maintainer approval. A draft PR is required for that review; this gate is not bypassed or reported green.
- [ ] G5: Reviewed commits pushed, PR opened, CI results checked and reported.
  EVIDENCE: Draft PR https://github.com/ezcorp-org/EZHarness/pull/246 opened at 5cdf49fe. Initial CI found unsupported systemd delegation, fast-uri advisories, missing visual evidence mappings, a Bun/Node fixture difference, and a Hub integration failure. These must be fixed and CI repeated. Maintainer gate-integrity approval remains separate.
