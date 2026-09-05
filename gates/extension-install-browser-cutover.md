# Extension install browser cutover

- [x] Reproduce the four obsolete install tests against the current rendered UI.
  EVIDENCE: `/tmp/lifecycle-install-old-red.log`: all four fail against the shared production preview built from parent `362a0aec`; the removed GitHub/Git inputs and inline review are absent.
- [x] Replace only the final install-flow block with four current source-import and review scenarios.
  EVIDENCE: `Extensions Install + Activate Flow` is the only changed block in `extensions.spec.ts`. The shared source fixture adds optional serialized author-loader data; its existing handoff-only default is unchanged.
- [x] Prove exact source requests, no implicit activation, review cancellation, and visible server denial.
  EVIDENCE: assertions cover repository/ref/subdirectory payloads; rendered source, evidence and exact release digest; the review checkbox; distinct approval and activation calls; unchanged disabled state before activation; leaving review without approval; and HTTP 403 remaining visible with no new extension.
- [x] Run all four tests in an actual browser without skips, fake HTML, or increased deadlines.
  CHECK: cd web && bunx playwright test e2e/extensions.spec.ts --project=chromium --grep 'Extensions Install \+ Activate Flow' --workers=4 --reporter=list
  EXPECT: Four tests pass.
  EVIDENCE: `/tmp/lifecycle-install-final.log`: 4 passed, 0 failed. Existing Chromium preview and real Svelte components are used; API and loader JSON are test fixtures. Scoped Biome, `git diff --check`, and `bun node_modules/typescript/bin/tsc --noEmit -p web/tsconfig.json` pass (`/tmp/lifecycle-install-types.log`).

The retired inline permission-selection dialog and direct Git installer are not preserved behavior. These tests cover their replacement: source snapshots, isolated candidates, and explicit release review. Real worker and database behavior remains covered by the separate real-auth suite; this mock lane validates the actual rendered UI and transport contract.
