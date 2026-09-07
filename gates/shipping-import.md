# Gates: shipping interrupted import

Scope: source acquisition interruption, immutable retry and changed-input candidate isolation. The test uses deterministic GitHub API-shaped fetch responses with the actual acquisition and database paths. It does not claim a live GitHub network interruption.

- [x] I1: Failed later blob acquisition leaves active release, known storage output, workspaces/revisions/operations unchanged.
  CHECK: bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts && echo IMPORT_SHIPPING_VERIFIED
  EXPECT: IMPORT_SHIPPING_VERIFIED
  EVIDENCE: Parent replay at f2532665, pinned Bun1.3.14: 14 pass, 0 fail, 97 assertions, process exit0. Durable log: docs/validation/extension-v4-shipping/parent/final-focused-source-adoption.log; exact command/source: focused-provenance.json in the same directory. Parent rechecked current test bytes at d2222840: SHA256 3f2d4ac2a9e24e830c5ffd084d711becbaec492e9c3707fdb9a22f2900ed447d, unchanged from that replay.
- [x] I2: Identical immutable retry reuses one candidate; changed source creates a distinct candidate without implicit approval.
  CHECK: bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts && echo IMPORT_SHIPPING_VERIFIED
  EXPECT: IMPORT_SHIPPING_VERIFIED
  EVIDENCE: Parent replay at f2532665, pinned Bun1.3.14: 14 pass, 0 fail, 97 assertions, process exit0. Durable log: docs/validation/extension-v4-shipping/parent/final-focused-source-adoption.log; exact command/source: focused-provenance.json in the same directory. Parent rechecked current test bytes at d2222840: SHA256 3f2d4ac2a9e24e830c5ffd084d711becbaec492e9c3707fdb9a22f2900ed447d, unchanged from that replay.
- [x] I3: Real existing authorization integration proves owner deactivation after approval prevents activation and leaves the installation disabled.
  CHECK: bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts && echo IMPORT_SHIPPING_VERIFIED
  EXPECT: IMPORT_SHIPPING_VERIFIED
  EVIDENCE: Parent replay at f2532665, pinned Bun1.3.14: 14 pass, 0 fail, 97 assertions, process exit0. Durable log: docs/validation/extension-v4-shipping/parent/final-focused-source-adoption.log; exact command/source: focused-provenance.json in the same directory. Parent rechecked current test bytes at d2222840: SHA256 3f2d4ac2a9e24e830c5ffd084d711becbaec492e9c3707fdb9a22f2900ed447d, unchanged from that replay.
