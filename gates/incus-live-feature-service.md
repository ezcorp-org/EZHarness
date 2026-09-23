# Gates: Incus feature lifecycle service

Scope: A host service prepares a pinned project binding and uses durable admission and provider receipts for lifecycle operations.

- [x] F1: Prepare fails closed unless the active Incus release, connection revision, preset, and live qualification match.
  EVIDENCE: `IncusFeatureService.prepare` resolves the active release and encrypted exact connection revision, validates the preset digest and host-produced live SP01–SP08 qualification, then persists immutable binding pins. Focused tests deny missing qualification and revoked connection.
- [x] F2: Create, start, stop, and destroy use admission and durable controller dispatch, with stable idempotency keys and provider readback.
  EVIDENCE: The service reserves preset resources, derives provider expected generation from `lifecycle.inspect`, uses `SandboxController` with `IncusSandboxProviderDispatcher(new IncusMethodCaller())` by default, and releases compute/disk only after succeeded observations. A PGlite lifecycle test covers all four operations, replay, and reservation transitions.
- [x] F3: Expired qualification cannot start new work but does not block stop or destroy; a destroy replay does not inspect an absent guest.
  EVIDENCE: Cleanup validates the exact active release, connection, and persisted binding while skipping expired live qualification. A focused test confirms STOP/DESTROY and idempotent DESTROY replay after inspection is unavailable.
- [ ] F4: A disabled or retired provider release can perform host-authorized cleanup.
  EVIDENCE: blocked by `ReleaseProcess.callIncusSandboxOperation` requiring `resolveActiveRelease`. The service fails closed; a separate host-only retired-release cleanup policy is required before disabling a release with retained guests.

Verification: Bun 1.3.14 `bun test ./src/infrastructure/incus-feature-service.test.ts` passed (3 tests, 24 assertions). Backend `tsc --noEmit -p tsconfig.typecheck.json`, `bun scripts/typecheck-tests.ts`, and Biome checks on the new service and tests passed.
