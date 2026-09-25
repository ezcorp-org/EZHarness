# Gates: Workspace provider caller

Scope: EZHarness-native workspace tools call the exact approved Incus release through the host broker.

- [x] C1: Every file/process action rechecks project binding, release, connection revision, generation, and provider method before dispatch.
  EVIDENCE: `IncusWorkspaceCaller.call` reads the host binding on every action, verifies every workspace pin and RUNNING state, resolves the active release, decrypts the exact connection revision through `ProviderConnectionStore.resolveForHost`, and verifies the declared canonical method. `ReleaseProcess.callIncusSandboxOperation` performs broker checks again before invoking the provider.
- [x] C2: Mutation IDs are stable and distinct per tool action; no host path or raw credential is selected by tool arguments.
  EVIDENCE: Mutation request IDs hash binding ID, generation, action, and the per-action tool call suffix. Tests show replay uses the same ID, the next action gets a different ID, the approved guest user replaces the runtime placeholder, and the raw private key never enters provider input.
- [x] C3: Focused tests cover forged scope, stale release/connection, and normal action result; unsupported actions fail closed.
  EVIDENCE: Bun 1.3.14 `bun test ./src/infrastructure/incus-workspace-caller.test.ts` passed (5 tests, 24 assertions). The process deadline regression covers 10-second shell, 30-second grep, and a longer process timeout. Backend `tsc --noEmit -p tsconfig.typecheck.json`, `bun scripts/typecheck-tests.ts`, and Biome check passed.
