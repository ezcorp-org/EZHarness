# Gates: Extension v4 implementation and PR

- [x] G1: Contracts, SDK, Podman runner and durable lifecycle implemented and tested.
  EVIDENCE: Contract 22 tests/278 assertions; SDK 1,023 tests/2,332 assertions; actual runner 36 tests/266 assertions (`/tmp/ez-runner-final-independent.log`). All 50 sealed candidates pass at tree `6e634060ed624549d1d11c17325678860740596c` (`/tmp/ez-all50-final5.jsonl`); the three later changed examples pass separately (`/tmp/ez-candidate-final-three-delta.jsonl`). Actual shared PostgreSQL checks pass (`/tmp/lifecycle-final-postgres.log`). These checks do not claim every candidate capability was exercised.
- [x] G2: Host, harness tools and UI use the shared lifecycle; real authoring loop passes.
  EVIDENCE: `/tmp/ez-extension-v4-real-final10.log` has nine passing actual authenticated/rootless flows, including editor authoring, external control, chat self-build, immutable upgrade, and the protected scanner. See `docs/extension-v4-validation.md` for command results and limits.
- [ ] G3: Security, recovery, migration and complete contribution parity pass.
  EVIDENCE: Earlier runtime security and recovery checks pass, but the complete browser lane exposed missing live event registration and review found missing immutable workflow discovery. Both fixes and their authority checks remain pending. Retired legacy behavior is explicitly mapped rather than claimed as equivalent; maintainer review remains required.
- [ ] G4: Full required validation passes on the final branch before push.
  EVIDENCE: Prior snapshots passed full coverage and the nine extension browser specifications, but the exact 53-test authenticated lane failed. New changes require the full lane, coverage, build and image checks again. Gate integrity has 84 documented migration findings and still needs maintainer approval. This gate is not bypassed or reported green.
- [ ] G5: Reviewed commits pushed, PR opened, CI results checked and reported.
  EVIDENCE: Draft PR https://github.com/ezcorp-org/EZHarness/pull/246 is published through 5e7d4ee4. The second CI run passes initial portability fixes but finds a hydration import, Ubuntu monitor OOM reporting and complete browser-lane failures. Local fixes are in progress and remain unpushed until validated. Maintainer gate-integrity approval remains separate.
