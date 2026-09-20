# Gates: pluggable infrastructure

Scope: minimal local native-EZHarness MVP, per final user direction. One persistent sandbox per feature, seven tools, retained state, tests/logs/cancel/cleanup, existing approvals. R4, Infisical, second backend, Compose qualification and external networking are deferred.

- [x] G1: Isolated worktree on refreshed source base.
  EVIDENCE: Branch feat/pluggable-infrastructure at origin/main 550b7c67e; source local changes preserved.
- [x] G2: Independent Sol/Terra gap reviews resolved into an execution plan.
  EVIDENCE: Plan section 11 records D25–D31, refreshed base, local-first scope and guest-worker exclusions. Sol owns provider contract, Terra owns persisted workspace routing, independent Sol owns real local runtime probe, second Terra owns sensitive dispatch denial.
- [ ] G3: Minimal local production provider, persisted routing, usable selection/status and lifecycle implemented.
  EVIDENCE: pending
- [ ] G4: Changed executable lines and new files fully covered; canonical repository tests and build pass.
  EVIDENCE: pending
- [ ] G5: Real local provider, security, resource and recovery qualification passes; unsupported controls remain unavailable.
  EVIDENCE: pending
- [ ] G6: Local end-to-end create/use/test/disconnect/restart/cancel/cleanup workflow passes on the final candidate.
  EVIDENCE: pending
