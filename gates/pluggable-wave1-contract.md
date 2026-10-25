# Gates: pluggable infrastructure wave 1 contract

- [x] G1: Provider method/profile declarations are strict, bounded and backward compatible.
  CHECK: PATH=/home/dev/.bun/bin:$PATH /home/dev/.bun/bin/bun test ./src/provider-seam.test.ts ./src/sandbox-presets.test.ts (from packages/@ezcorp/extension-contract)
  EVIDENCE: 2026-09-22 exited 0 on Bun 1.3.14: 17 tests passed, 0 failed, 86 assertions. Preset-only declarations stayed valid; complete contributions required one closed `sandbox.provider.v1` describe/preflight group, canonical schemas, unique private method mappings, supported protocol/host versions, declared permissions and a closed config schema.
- [x] G2: Compatibility and effective-settings resolution are deterministic and reject unsupported combinations.
  CHECK: PATH=/home/dev/.bun/bin:$PATH /home/dev/.bun/bin/bun test ./src/provider-seam.test.ts (from packages/@ezcorp/extension-contract)
  EVIDENCE: 2026-09-22 exited 0 on Bun 1.3.14: 9 tests passed. Reordered equivalent inputs produced identical settings/digests; changed limits or backend versions changed the effective digest; backend API, architecture, storage, isolation, nested Compose, profile/ID mismatch, unknown overrides and out-of-bounds overrides failed without fallback.
- [x] G3: Wire schema, package tests and contract build pass with pinned Bun 1.3.14.
  CHECK: PATH=/home/dev/.bun/bin:$PATH /home/dev/.bun/bin/bun run schema:check && PATH=/home/dev/.bun/bin:$PATH /home/dev/.bun/bin/bun test && PATH=/home/dev/.bun/bin:$PATH /home/dev/.bun/bin/bun run build (from packages/@ezcorp/extension-contract)
  EVIDENCE: 2026-09-22 exited 0 on Bun 1.3.14: schema check 1 pass; full package 34 pass, 0 fail, 321 assertions; `tsc -b tsconfig.build.json` succeeded. `src/wire-schema.json` was regenerated first with the pinned executable.
- [x] G4: Static and live evidence remain separate; no unexecuted SP case is reported as passed.
  EVIDENCE: Candidate evidence remains exactly SP01, SP02, SP03, SP05, SP07 and SP08. Live evidence remains the separate SP01-SP08 type and validator. Resolver results contain settings and digests only, no case results. Focused tests also prove qualification fields remain outside BuildEvidence. No live SP04/SP06 run or pass is claimed.
