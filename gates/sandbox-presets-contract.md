# Gates: sandbox preset contract

Scope: Add a bounded shared contract and tests for deterministic sandbox presets and qualification evidence.

- [x] G1: Existing manifests remain valid, while sandbox provider declarations require complete immutable presets.
  CHECK: bun test ./packages/@ezcorp/extension-contract/src/sandbox-presets.test.ts
  EXPECT: /pass/
  EVIDENCE: 2026-09-22 pinned Bun 1.3.14 contract run exited 0: 8 preset tests pass. The suite accepts an unchanged v4 manifest and rejects empty, unknown, credential-bearing, moving, duplicate, invalid, incomplete, and storage-contradicting preset declarations.

- [x] G2: Wire schema is regenerated and matches the authoritative TypeScript declarations.
  CHECK: bun run --cwd packages/@ezcorp/extension-contract schema:check
  EXPECT: /pass/
  EVIDENCE: 2026-09-22 pinned Bun 1.3.14 run exited 0: `wire schema matches the authoritative data types`; 1 pass, 0 fail. `src/wire-schema.json` was regenerated with `bun run schema:generate` before this check.

- [x] G3: Contract package builds and its full test suite passes.
  CHECK: bun test --cwd packages/@ezcorp/extension-contract && bun run --cwd packages/@ezcorp/extension-contract build
  EXPECT: /pass/
  EVIDENCE: 2026-09-22 pinned Bun 1.3.14 final run: 25 tests passed, 0 failed, followed by a successful `tsc -b tsconfig.build.json` build.

- [x] G4: Contract validation rejects credentials, moving required image references, invalid limits, duplicate identities, incomplete profiles, and stale/failed/mismatched evidence.
  EVIDENCE: 2026-09-22 pinned focused tests for invalid presets and invalid candidate evidence passed. Separate live tests require SP01-SP08, while the build-evidence test rejects qualification fields.
