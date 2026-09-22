# Gates: pluggable infrastructure

Scope: minimal local native-EZHarness MVP, per final user direction. One persistent sandbox per dedicated task project, seven tools, retained state, tests/logs/cancel/cleanup, existing approvals. R4, Infisical, second backend, Compose qualification and external networking are deferred.

- [x] G1: Isolated worktree on refreshed source base.
  EVIDENCE: Branch feat/pluggable-infrastructure at origin/main 550b7c67e; source local changes preserved.
- [x] G2: Independent Sol/Terra gap reviews resolved into an execution plan.
  EVIDENCE: Plan section 11 records D25–D31, refreshed base, local-first scope and guest-worker exclusions. Sol owns provider contract, Terra owns persisted workspace routing, independent Sol owns real local runtime probe, second Terra owns sensitive dispatch denial.
- [x] G3: Minimal local production provider, persisted routing, usable selection/status and lifecycle implemented.
  EVIDENCE: Implemented local provider, persisted routing, seven tools, reviewed lifecycle, and usable settings panel; docs/validation/pluggable-local-mvp.md.
- [x] G4: Changed executable lines and new files fully covered; canonical repository tests and build pass.
  EVIDENCE: Final candidate 0d74fc441: 26,652 coverage tests and 7,450 web Vitest tests pass; 32 new files at 100% line coverage, all changed executable lines in 52 files covered; 2,187 browser tests, static checks, production build, and integrity gate pass.
- [x] G5: Real local provider, security, resource and recovery qualification passes; unsupported controls remain unavailable.
  EVIDENCE: Real rootless resource-control, separate-client recovery, and three interrupted FUSE disposal phases pass; receipts linked from docs/validation/pluggable-local-mvp.md.
- [x] G6: Local end-to-end create/use/test/disconnect/restart/cancel/cleanup workflow passes on the final candidate.
  EVIDENCE: Real app journey at 8ea169e05 passes tools/test/disconnect/app restart/cancel/dispose, four inspected desktop/mobile images, and zero leftover resources. Final candidate proves identical production sources.
