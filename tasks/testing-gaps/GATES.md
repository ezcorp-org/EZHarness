# Gates: EZHarness coverage gap closure

- [ ] I1: Every leaf passes with independently checked evidence and no silently abandoned gap.
  EVIDENCE: pending

- [ ] I2: Combined discovery, type, lint, boundary, coverage and integrity checks pass without weakened enforcement.
  EVIDENCE: pending

- [ ] I3: All newly enabled browser cases and real Postgres paths pass; retained first failures are resolved.
  EVIDENCE: pending

- [ ] I4: Record before/after run-time evidence, bounded concurrency, and effective CI scheduling; added coverage is practical.
  EVIDENCE: pending

- [ ] I5: Review final diff, preserve primary checkout, and publish a precise local report with all remaining limits.
  EVIDENCE: pending


- [x] I6: Updated scheduler weights preserve every file and improve modeled shard balance using actual CI measurements.
  CHECK: PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH bun tasks/testing-gaps/check-shard-performance.ts && PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH bun test src/__tests__/shard-plan.test.ts
  EVIDENCE: tasks/testing-gaps/shard-performance-comparison.json; modeled four-worker maximum235825ms→191999ms; shard-plan-test.log:18pass0fail.
