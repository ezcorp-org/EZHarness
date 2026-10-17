# Incus live sandbox vertical slice

Branch: `feat/pluggable-infrastructure-v1`, isolated worktree `.worktrees/pluggable-infrastructure-v1`.

## Contract and ownership

The approved Incus release is the control adapter. The host broker resolves its fixed, encrypted connection revision and executes only declared Incus actions. The durable controller owns intent, generation, receipts, and reconciliation. The runtime consumes a host-selected sandbox workspace binding; project tool arguments never select host paths or provider credentials. Keep the existing local sandbox path and existing local projects working.

One request has a host-owned installation/release/connection scope, a binding and generation, a deadline, and a stable operation identity. Resource names are derived from the binding, not trusted from the worker payload. A lost mutation response is unknown until readback proves its outcome. The guest helper owns descriptor-safe files and supervised processes. No host fallback is allowed for a sandbox-bound project. The native EZHarness agent loop is the only runtime in this milestone.

| Leaf | Owner | Files | Gate |
| --- | --- | --- | --- |
| Host Incus lifecycle | Sol agent | `src/infrastructure/incus-transport/` only | `gates/incus-live-lifecycle.md` |
| Guest workspace transport | Sol agent | New `src/infrastructure/incus-guest/` and its tests only | `gates/incus-live-guest.md` |
| Durable provider dispatch | Sol agent | `src/sandboxes/` and its tests only | `gates/incus-live-dispatch.md` |
| Native workspace bridge | Sol agent | `src/runtime/workspaces/`, `src/runtime/stream-chat/setup-tools.ts`, `src/runtime/tools/index.ts` and adjacent tests | I2 in `gates/incus-live-integration.md` |
| Guest Incus transport | Sol agent | New `src/infrastructure/incus-transport/guest.ts` and tests | `gates/incus-live-guest-transport.md` |
| Reviewed guest image | Sol agent | `scripts/incus/` recipe, image/bootstrap, and tests | `gates/incus-live-image.md` |
| Workspace provider caller | Sol agent | New `src/infrastructure/incus-workspace-caller.ts` and tests | `gates/incus-live-workspace-caller.md` |
| Integration | Root | Broker, extension release RPC, startup wiring, server fixture, CI/PR, task notes | `gates/incus-live-integration.md` |

Agents share the worktree. They must not revert others' edits. Interface changes to owned files outside their leaf require a message to root first. Each leaf should finish its tests and gate evidence; root will rerun focused checks and run cross-module checks.

## Status log

- 2026-09-22: Plan created. Current PR has setup and probe only; no live guest claim.
- 2026-09-22: Four disjoint Sol leaves started. Root added nullable connection and preset pins to the binding schema so legacy rows fail closed.
- 2026-09-22: Follow-up leaves added for guest RPC, image installation, and the host workspace caller. No server configuration has changed.
