# Gates: shipping interrupted import

Scope: source acquisition interruption, immutable retry and changed-input candidate isolation.

- [x] I1: Failed later blob acquisition leaves active release, known storage output, workspaces/revisions/operations unchanged.
  EVIDENCE: CHECK `bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts`; EXPECT the later GitHub blob failure to preserve the complete installation state and the persisted `known-output` value; RESULT 11 pass, 0 fail, exit 0 (`.cache/terra-shipping/import/source-adoption-final.log`).
- [x] I2: Identical immutable retry reuses one candidate; changed source creates a distinct candidate without implicit approval.
  EVIDENCE: CHECK `bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts`; EXPECT repeated immutable source to retain one workspace/revision/operation and changed source to add one distinct workspace/revision/operation with no approval; RESULT 11 pass, 0 fail, exit 0 (`.cache/terra-shipping/import/source-adoption-final.log`).
- [x] I3: Real existing authorization integration proves owner deactivation after approval prevents activation/effects.
  EVIDENCE: CHECK `bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts`; EXPECT existing `updateUserStatus` deactivation after human admin approval to produce a failed activation and leave the installation disabled; RESULT 11 pass, 0 fail, exit 0 (`.cache/terra-shipping/import/source-adoption-final.log`).
