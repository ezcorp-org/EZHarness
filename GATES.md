# Gates: Extension v4 implementation and PR

- [x] G1: Contracts, SDK, Podman runner and durable lifecycle implemented and tested.
  EVIDENCE: Contract 22 tests/278 assertions; SDK 1,023 tests/2,332 assertions; actual runner 36 tests/266 assertions (`/tmp/ez-runner-final-independent.log`). All 50 sealed candidates pass at tree `6e634060ed624549d1d11c17325678860740596c` (`/tmp/ez-all50-final5.jsonl`); the three later changed examples pass separately (`/tmp/ez-candidate-final-three-delta.jsonl`). Actual shared PostgreSQL checks pass (`/tmp/lifecycle-final-postgres.log`). These checks do not claim every candidate capability was exercised.
- [ ] G2: Host, harness tools and UI use the shared lifecycle; real authoring loop passes.
  EVIDENCE: pending
- [ ] G3: Security, recovery, migration and complete contribution parity pass.
  EVIDENCE: pending
- [ ] G4: Full required validation passes on the final branch before push.
  EVIDENCE: pending
- [ ] G5: Reviewed commits pushed, PR opened, CI results checked and reported.
  EVIDENCE: pending
