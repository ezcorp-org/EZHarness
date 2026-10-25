# Gates: candidate evidence lifetime repair

Scope: Keep activated Incus releases usable after their one-hour candidate check expires while preserving exact candidate integrity and live-qualification expiry.

- [x] G1: Active-release resolution and re-publication accept an intact release whose candidate evidence expired after activation.
  EVIDENCE: `src/extensions/__tests__/release-process.test.ts` resolves an expired intact release; `src/extensions/v4/lifecycle.test.ts` retries and acknowledges publication after expiry; `src/extensions/entity-publication.test.ts` publishes an expired intact release through the database transaction. All pass.
- [x] G2: Approval and activation still reject missing, forged, or expired candidate evidence.
  EVIDENCE: `packages/@ezcorp/extension-contract/src/sandbox-presets.test.ts` and `src/extensions/v4/sandbox-preset-qualification.test.ts` reject missing, forged, invalid-interval, and future evidence in integrity mode. `src/extensions/v4/lifecycle.test.ts` rejects stale approval and activation. All pass.
- [x] G3: Feature admission still rejects missing or expired connection-specific live evidence.
  EVIDENCE: `src/extensions/v4/sandbox-preset-qualification.test.ts` permits a release after candidate expiry only with current live evidence and rejects expired live evidence at the same time. All pass.
- [ ] G4: Focused tests, typecheck, lint, and changed-source coverage pass with existing thresholds.
  EVIDENCE: Focused Bun tests pass in isolated files (76 tests across contract, qualification helper, lifecycle, runtime, service, and publication); Biome passes for all 10 owned changed files; per-file LCOV records hits on every changed executable source line. Full `bun run typecheck` currently fails only in parallel live-witness work, `src/infrastructure/incus-host-live-witness.test.ts:31` (unsafe `IncusQualificationStore` cast). Backend, web, and web-e2e typecheck stages pass. Integration must rerun typecheck and the repository coverage gate after the witness repair.
