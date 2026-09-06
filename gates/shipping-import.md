# Gates: shipping interrupted import

Scope: source acquisition interruption, immutable retry and changed-input candidate isolation.

- [x] I1: Failed later blob acquisition leaves active release, known storage output, workspaces/revisions/operations unchanged.
  CHECK: bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts && echo IMPORT_SHIPPING_VERIFIED
  EXPECT: IMPORT_SHIPPING_VERIFIED
  EVIDENCE: Parent replay at 8fe66a0f, pinned Bun 1.3.14: 11 pass, 0 fail, 65 assertions, exit 0. .cache/terra-shipping/parent/import-independent.log; test source SHA-256 11eca7303a2a00ccf0f731ef1222bcdc5d2f4cf7bb0fc10b935e36c92a92032a.
- [x] I2: Identical immutable retry reuses one candidate; changed source creates a distinct candidate without implicit approval.
  CHECK: bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts && echo IMPORT_SHIPPING_VERIFIED
  EXPECT: IMPORT_SHIPPING_VERIFIED
  EVIDENCE: Parent replay at 8fe66a0f, pinned Bun 1.3.14: 11 pass, 0 fail, 65 assertions, exit 0. .cache/terra-shipping/parent/import-independent.log; test source SHA-256 11eca7303a2a00ccf0f731ef1222bcdc5d2f4cf7bb0fc10b935e36c92a92032a.
- [x] I3: Real existing authorization integration proves owner deactivation after approval prevents activation/effects.
  CHECK: bun test --timeout 30000 ./src/extensions/__tests__/source-adoption.test.ts && echo IMPORT_SHIPPING_VERIFIED
  EXPECT: IMPORT_SHIPPING_VERIFIED
  EVIDENCE: Parent replay at 8fe66a0f, pinned Bun 1.3.14: 11 pass, 0 fail, 65 assertions, exit 0. .cache/terra-shipping/parent/import-independent.log; test source SHA-256 11eca7303a2a00ccf0f731ef1222bcdc5d2f4cf7bb0fc10b935e36c92a92032a.
