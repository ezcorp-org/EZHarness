# Gates: Scanner opaque-frame bridge

Scope: Preserve scanner camera and scan-tool flows through the trusted host bridge, without session access or arbitrary HTTP.

- [x] G1: Reproduce the existing scanner failure in the real opaque app frame.
  EVIDENCE: Chromium loaded the original app/lib/db.js in an allow-scripts opaque frame; listCards failed with IndexedDB SecurityError. /tmp/v4-scanner-opaque-red.log

- [x] G2: Scanner unit tests prove exact tool calls without caller authority IDs, denied untrusted messages, and no automatic camera start.
  CHECK: PATH=/tmp/ez-extension-bun-1.3.14/bun-linux-x64:$PATH bun test ./docs/extensions/examples/graded-card-scanner/app/bridge.test.ts
  EXPECT: 0 fail
  EVIDENCE: Five bridge/client tests pass; host origin, frame source, nonce, request id, camera session, bounded frames, private saved cards, and denial propagation asserted. /tmp/v4-scanner-bridge-coverage2.log

- [x] G3: The complete scanner source suite and sealed candidate build pass.
  EVIDENCE: 261 tests pass across 19 files; isolated lifecycle candidate verified with no diagnostics. /tmp/v4-scanner-source-commit.log and /tmp/v4-scanner-lifecycle-commit.jsonl

- [ ] G4: Real browser camera and scan flow pass through the host bridge; desktop/mobile screenshots pass visual review.
  EVIDENCE: pending

- [x] G5: Source metadata lock is current and the integrated typecheck passes.
  EVIDENCE: Data-only lock regenerated; full backend/web/tests/E2E typecheck passes in /tmp/v4-scanner-types-final-source.log.
