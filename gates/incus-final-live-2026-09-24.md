# Gates: first EZHarness-owned Incus sandbox

Scope: finish the isolated app's real Incus feature flow and make only verified release claims.

- [x] G1: The live database readback gate has a consistent snapshot and confirms the actual CREATE/fixture state.
  EVIDENCE: `gates/incus-live-db-readback.md` is 4/4 met. Root-only detached PGlite SELECTs confirmed CREATE `62633686-a1bc-4b93-b87a-54fdbc96c2fd` OUTCOME_UNKNOWN, fixture `live-fixture-20260924`, and binding/instance IDs; the restored app's authenticated status returned 200 for the same record. See `docs/validation/2026-09-24-isolated-db-readback.md`.
- [ ] G2: The isolated app runs under dedicated identities with sealed settings and a tested rollback path.
  EVIDENCE: pending
- [ ] G3: The confirmed unknown effect is repaired only with an active, independent fence and two readbacks.
  EVIDENCE: pending
- [ ] G4: EZHarness creates a guest, runs a process in its workspace, reconnects, and cleans up or retains it by policy.
  EVIDENCE: pending
- [ ] G5: Guest isolation, limits, and negative access tests pass on the real server.
  EVIDENCE: pending
- [ ] G6: PR #303 final source and hosted CI pass; support claims match actual tests.
  EVIDENCE: pending
