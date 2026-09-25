# Gates: Incus PR validation

Scope: finish source and release evidence without equating unit tests with a working guest.

- [ ] G1: Local lint, typecheck, relevant tests, and release bundle verification pass at the final source head.
  EVIDENCE: At head `d0d7ea3`, pinned Bun 1.3.14 lint and typecheck pass; focused post-bundle recovery and SSH gate tests pass (3 Bun, 9 and 13 Python). `/opt/ezharness` verifies its 76,066-file bundle, but its manifest source is `0b81c087e`, and executable code changed before the current PR head. A final-head bundle and smoke are still pending. See `docs/validation/2026-09-24-pr303-ci-audit.md`.
- [ ] G2: Hosted CI checks pass at the final PR #303 head.
  EVIDENCE: GitHub PR #303 head was `d0d7ea3`. Latest readback: 46 checks passed, `Production proof (resources)` and `Per-file coverage gate` failed, and `Production proof (content)` was running. The resources job timed out observing 28 bundled builds. A local exact-image rerun with the proposed progress-aware observer passed 28/28 bootstrap builds and the R4 resources proof (10 cycles, 100 reconnects), with owned cleanup verified. The fix is uncommitted and not hosted-verified. See `docs/validation/2026-09-24-pr303-ci-audit.md`.
- [x] G3: Validation notes and support matrix state precisely which live profiles and controls passed.
  EVIDENCE: `docs/validation/2026-09-24-pr303-ci-audit.md` gives per-surface evidence and limits: earlier local journey, two Incus offline preset fixtures, direct guest canary, and host/network controls; neither Incus preset has a complete live SP01–SP08 qualification or an EZHarness-owned feature flow.
