# Gates: shipping interrupted import

Scope: source acquisition interruption, immutable retry and changed-input candidate isolation.

- [x] I1: Failed later blob acquisition leaves active release, known storage output, workspaces/revisions/operations unchanged.
  CHECK: bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts
  EXPECT: 11 pass, 0 fail, exit 0; later GitHub blob failure preserves complete installation state and persisted known-output.
  EVIDENCE: .cache/terra-shipping/import/source-adoption-d501affd.log
- [x] I2: Identical immutable retry reuses one candidate; changed source creates a distinct candidate without implicit approval.
  CHECK: bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts
  EXPECT: 11 pass, 0 fail, exit 0; immutable source retains one workspace/revision/operation and changed source adds one distinct unapproved workspace/revision/operation.
  EVIDENCE: .cache/terra-shipping/import/source-adoption-d501affd.log
- [x] I3: Real existing authorization integration proves owner deactivation after approval prevents activation/effects.
  CHECK: bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts
  EXPECT: 11 pass, 0 fail, exit 0; updateUserStatus deactivation after human admin approval fails activation and leaves installation disabled.
  EVIDENCE: .cache/terra-shipping/import/source-adoption-d501affd.log
