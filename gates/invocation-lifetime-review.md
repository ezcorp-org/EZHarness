# Invocation lifetime boundary review

- [x] G1: Deterministically test token release, deadline expiry, and runtime kill during the active-binding read.
  CHECK: bun test ./src/extensions/__tests__/release-process.test.ts
  EXPECT: 0 fail after source-owner fix
  EVIDENCE: /tmp/v4-lifetime-binding-red.log — four token/kill broker/page failures, two deadline controls already denied by lock checks. /tmp/v4-lifetime-green.log — all 44 boundary and lock tests pass with root's full synchronous lifetime guard copied locally.
- [x] G2: Inspect post-fence grant and lifetime rechecks at the actual host boundary; report minimal source changes.
  EVIDENCE: /tmp/v4-lifetime-fence-red.log — eight actual SQL accounting races admit effects before fix. Guard object prepares fresh binding after fence accounting, then checks lifetime synchronously before marking effects admitted. Root owns ReleaseProcess source; this leaf owns the approved lock guard API and tests. Cached registry grants and direct page notification handling do not independently close all revocation gaps.
