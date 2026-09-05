# Gates: Final frozen branch

- [ ] G1: Type checks and Svelte checks pass.
  CHECK: bun run typecheck && bun run --cwd web check
  EXPECT: 0 errors
  EVIDENCE: pending
- [ ] G2: Backend and plain web tests pass.
  CHECK: bun run test && bash scripts/test-web.sh
  EXPECT: 0 fail
  EVIDENCE: pending
- [ ] G3: Web component tests pass.
  CHECK: bun run --cwd web test:component
  EXPECT: Test Files
  EVIDENCE: pending
- [ ] G4: Full coverage and changed-line coverage pass without weakened rules.
  EVIDENCE: pending
- [ ] G5: Real extension E2E, mock CI lane and visual evidence pass on the final source.
  EVIDENCE: pending
- [ ] G6: Final image build, runner isolation, 50 candidates, and external Postgres verification pass.
  EVIDENCE: pending
- [ ] G7: Lint and independent review have no unresolved findings introduced by this change.
  EVIDENCE: pending
