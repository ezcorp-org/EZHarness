# Gates: sandbox protocol wave 2

- [x] C1: One authoritative bounded schema covers lifecycle, files, processes and endpoints.
  - `types.d.ts` and generated `wire-schema.json` define the frozen `sandbox.provider.v1` discovery, lifecycle, file, process, and optional endpoint methods. `sandboxProviderMethodSchemas` extracts every method schema from that one generated source; `validateSandboxProviderMethodValue` and `validateSandboxProviderMethodExchange` reuse the existing AJV/compiler seam.
  - The protocol test executes one valid bounded exchange for all 19 methods. Snapshot, restore, suspend, PTY, and resize are capability identifiers only and are not added to the stable v1 method surface.
- [x] C2: Invalid bounds, unknown fields, unsafe paths and ambiguous retry outcomes fail closed.
  - Tests cover closed objects, group completeness, distinct method names, stable scoped IDs, idempotency receipts, desired/observed state, operation inspection, safe integer limits, revision-bound file ranges, canonical 64 KiB base64 chunks, atomic revision compare, path traversal, argv/cwd/user/env bounds, process versus RPC deadlines, cursor scope and output gaps, HTTPS endpoint expiry, and capability denial.
  - `OUTCOME_UNKNOWN` is valid only for a mutating operation, requires an operation ID, cannot request blind retry, and must remain `outcome_unknown` when inspected.
- [x] C3: Existing manifests and the wave 1 provider seam remain compatible.
  - Preset-only declarations and legacy complete contributions with only `describe`/`preflight` continue to pass. Capabilities require a complete contribution; stable-capability providers must map the complete lifecycle/file/process groups, and endpoint methods must exactly match `endpoints.v1`.
- [x] C4: Schema generation, package tests, typecheck and diff checks pass on Bun 1.3.14.
  - Evidence time: `2026-09-22T17:16:29Z`. Worktree base: `4689134bcd23d493d590435567488a21b01069f5`. Bun: `1.3.14 (0d9b296a)` from `/nix/store/7hqaibb70a221fg6gk01qm8w662lci8k-bun-1.3.14/bin`.
  - `bun run schema:generate`: exit 0. `bun run schema:check`: 1 pass, 0 fail, exit 0.
  - `bun test` in `packages/@ezcorp/extension-contract`: 41 pass, 0 fail, 377 assertions, exit 0.
  - `bun run build` in `packages/@ezcorp/extension-contract`: exit 0.
  - Root `bun run typecheck`: backend, web, backend tests, and web E2E type checks pass, exit 0.
  - Scoped `bunx biome check` on the changed TypeScript files: no findings, exit 0.
  - `git diff --check -- packages/@ezcorp/extension-contract gates/pluggable-wave2-contract.md`: exit 0.

Live provider qualification remains open. This gate proves the offline contract and compatibility behavior only; it does not claim live SP04/SP06 or Incus lifecycle qualification.
