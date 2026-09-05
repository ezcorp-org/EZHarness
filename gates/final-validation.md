# Gates: Final frozen branch

- [x] G1: Type checks and Svelte checks pass.
  CHECK: bun run typecheck && bun run --cwd web check
  EXPECT: 0 errors
  EVIDENCE: `/tmp/ez-types45.log` passes all four typecheck lanes. `/tmp/ez-svelte-final2.log` reports zero errors and 13 warnings in five files.
- [ ] G2: Backend and plain web tests pass.
  CHECK: bun run test && bash scripts/test-web.sh
  EXPECT: 0 fail
  EVIDENCE: pending
- [x] G3: Web component tests pass.
  CHECK: bun run --cwd web test:component
  EXPECT: Test Files
  EVIDENCE: `/tmp/ez-extension-v4-vitest11.log`: 543 files and 7,024 tests pass. Later production changes only remove duplicate CSS padding; the final protected browser test verifies the resulting geometry.
- [x] G4: Full coverage and changed-line coverage pass without weakened rules.
  EVIDENCE: `/tmp/ez-coverage-parent-final3.log`: 25,657 pass, zero failures, 1,239 enforced source files pass. `/tmp/ez-new-file-coverage-final3.log`: 126 new source files gated. `/tmp/ez-patch-coverage-final3.log`: all changed executable lines in 338 files covered. No threshold was lowered or exclusion added. The separate test-migration policy review still requires maintainer approval.
- [x] G5: Real extension E2E, mock CI lane and visual evidence pass on the final source.
  EVIDENCE: `/tmp/ez-extension-v4-real-final10.log`: all nine actual authenticated/rootless extension flows pass, including desktop and mobile scanner camera consent, isolation, cancellation, revoke, upgrade, imports, and binary assets. `/tmp/ez-mock-gate-final2.log`: 210 pass and 12 pre-existing skips. Desktop and mobile screenshots were opened and reviewed; actual preview gutters are 24px with no horizontal overflow. The final preview-only CSS change is covered by the actual browser flow.
- [x] G6: Final image build, runner isolation, 50 candidates, and external Postgres verification pass.
  EVIDENCE: Final image `815764c0a0adc87d7206f1fe8cf0ae2ac7a85791700488d1e2fd88f5b7cd271b` passes all eight production checks in `/tmp/ez-container-final-verify3.log`. Runner suite: 36 tests/266 assertions; final stricter host-path probe: one test/two assertions. All 50 candidates pass at the recorded baseline, followed by successful verification of the three changed example snapshots. Pinned real PostgreSQL checks pass. See root GATES.md and container.md for exact logs and limits.
- [x] G7: Lint and independent review have no unresolved blocking code findings introduced by this change.
  EVIDENCE: `/tmp/ez-lint20.log` exits zero with 105 warnings and 11 informational findings; this is not warning-free. Independent durable browser and file-organizer authorization reviews found no remaining blocker after actual red/green regressions. All 84 gate-integrity findings are mapped for maintainer review; that policy approval is not self-issued.
