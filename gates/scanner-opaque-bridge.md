# Gates: Scanner opaque-frame bridge

Scope: Preserve scanner camera and scan-tool flows through the trusted host bridge, without session access or arbitrary HTTP.

- [x] G1: Reproduce the existing scanner failure in the real opaque app frame.
  EVIDENCE: Chromium loaded the original app/lib/db.js in an allow-scripts opaque frame; listCards failed with IndexedDB SecurityError. /tmp/v4-scanner-opaque-red.log

- [x] G2: Scanner unit tests prove private-port tool calls without caller authority IDs, denied untrusted messages, and no automatic camera start.
  CHECK: PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH bun test ./docs/extensions/examples/graded-card-scanner/app/bridge.test.ts
  EXPECT: 0 fail
  EVIDENCE: /tmp/v4-scanner-private-source.log — all six bridge tests pass, including host revocation clearing the last camera frame.

- [x] G3: The complete scanner source suite and sealed candidate build pass.
  EVIDENCE: /tmp/v4-scanner-private-source.log — 262 tests, 2732 assertions; /tmp/v4-scanner-lifecycle-private-port.jsonl — sealed candidate verified, artifact 7144133417c4e2f9b0292dd6f62d3f9901d81ab1e330bb2cc2cecf17730a7d03. Catalog verification does not claim live network/storage exercise.

- [ ] G4: Real browser camera and scan flow pass through the host bridge; desktop/mobile screenshots pass visual review.
  EVIDENCE: Production host bridge proof pending with runner owner. Controlled opaque-frame feature suite passes eight desktop/mobile tests, including real barcode pixels from upload and host camera frames: /tmp/v4-scanner-private-browser.log. Desktop list and mobile list/detail screenshots reviewed at /tmp/scanner-final-{1,3,4}.png; corrected missing fixture viewport before review. Controlled fixture is not production authorization evidence.

- [x] G5: Source metadata lock is current and the integrated typecheck passes.
  EVIDENCE: regenerate-manifest-lock --check passes; /tmp/v4-scanner-private-types.log — complete typecheck passes.
