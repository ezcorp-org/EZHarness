# Gates: Incus feature lifecycle service

Scope: A host service prepares a pinned project binding and uses durable admission and provider receipts for lifecycle operations.

- [x] F1: Prepare fails closed unless the active Incus release, connection revision, preset, and live qualification match.
  EVIDENCE: `IncusFeatureService.prepare` resolves the active release and encrypted exact connection revision, validates the preset digest and host-produced live SP01–SP08 qualification, then persists immutable binding pins. Focused tests deny missing qualification and revoked connection.
- [x] F2: Create, start, stop, and destroy use admission and durable controller dispatch, with stable idempotency keys and provider readback.
  EVIDENCE: The service reserves preset resources, derives provider expected generation from `lifecycle.inspect`, uses `SandboxController` with `IncusSandboxProviderDispatcher(new IncusMethodCaller())` by default, and releases compute/disk only after succeeded observations. A PGlite lifecycle test covers all four operations, replay, and reservation transitions.
- [x] F3: Expired qualification cannot start new work but does not block stop or destroy; a destroy replay does not inspect an absent guest.
  EVIDENCE: Cleanup validates the exact active release, connection, and persisted binding while skipping expired live qualification. A focused test confirms STOP/DESTROY and idempotent DESTROY replay after inspection is unavailable.
- [x] F4: A disabled or retired provider release can perform host-authorized cleanup of a stopped retained guest.
  EVIDENCE: The admin session route exposes an explicit `destroyRetired` action with the same exact project, binding, and idempotency checks as normal destroy. `IncusFeatureService.destroyRetired` reads back the exact stopped guest, journals DESTROY, and uses the normal controller and reconciliation path. `IncusMethodCaller` permits only DESTROY and its inspection for a retained journal. `callRetiredIncusCleanup` runs reviewed host transport without a release worker and accepts only inspect, destroy, and inspectOperation. The separate credential resolver requires the original consumed approval, release digest, installation, connection, and revision; rotated or revoked credentials deny dispatch. PGlite, fake-transport, and route tests cover exact scope, unknown outcomes, replay, and stale journal denial. Running guests remain outside this path; they must be stopped while the release is active or need a separately reviewed stop policy.

Verification: Bun 1.3.14 focused PGlite, fake transport, and route tests passed. `bun run typecheck` and `bun run lint` passed. Focused Bun coverage reports 100% lines for `incus-retired-cleanup.ts`; the exact 100% threshold is registered.
