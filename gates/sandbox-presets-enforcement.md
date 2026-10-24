# Gates: sandbox preset host enforcement

Scope: Fail closed before activation/use when a declared sandbox preset lacks current passing qualification.

- [x] G1: A pure host gate compares every declared preset/profile with evidence bound to release and preset digests.
  CHECK: bun test ./src/extensions/v4/sandbox-preset-qualification.test.ts
  EXPECT: /pass/
  EVIDENCE: Pinned Bun 1.3.14: 4 pass, 0 fail, 29 expect() calls; measured source coverage is 35/35 lines and 7/7 functions.

- [x] G2: Missing, failed, skipped, stale, duplicate, extra, or mismatched candidate evidence denies release qualification; a separate Ready assertion requires all SP01–SP08.
  CHECK: bun test ./src/extensions/v4/sandbox-preset-qualification.test.ts
  EXPECT: /pass/
  EVIDENCE: Pinned Bun 1.3.14: 4 pass, 0 fail, including exact static cases and separate live SP01-SP08 checks.

- [x] G3: Existing non-sandbox extension lifecycle behavior remains valid.
  CHECK: bun test ./src/extensions/v4/lifecycle.test.ts
  EXPECT: /pass/
  EVIDENCE: Pinned Bun 1.3.14: 9 pass, 0 fail. Ordinary lifecycle tests pass beside build, approval, activation, interrupted reconciliation, and acknowledged stale-evidence denials.

- [x] G4: The gate is integrated at the reviewed release/activation boundary and cannot be bypassed by direct API input.
  CHECK: bun test ./src/extensions/__tests__/release-process.test.ts ./src/extensions/entity-publication.test.ts
  EXPECT: /pass/
  EVIDENCE: Pinned Bun 1.3.14 isolated runs: release runtime 25 pass and entity publication 10 pass. Production candidate-verifier tests also pass 12/12 and explicitly reject sandbox releases until the C06 conformance runner exists.

## Four-pass review

- Pass 1 — Implemented the pure release and Ready assertions plus every required host boundary.
- Pass 2 — Re-read the digest, expiry, approval, reconciliation, publication, and runtime behavior; fixed type defects and kept ordinary manifests as a no-op.
- Pass 3 — Exercised the denial matrix, direct publication/runtime bypasses, related lifecycle regressions, typecheck, lint, and measured coverage.
- Pass 4 — Rechecked the final diff for DRY, exact bindings, live-evidence overclaims, unrelated edits, and gate completeness.
