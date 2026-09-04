# Extension v4 implementation

Base: bb19b8be7a6669f61e41e4e9baa3658026e87b8a. Full requirements: docs/extension-system-v4-plan.md. User authorized implementation, separate worktree, all validation before push, and a PR. The review-only restriction in the copied historical plan is superseded by that authorization.

## Shared contracts

- @ezcorp/extension-contract owns v4 wire types and runtime data validators. It must not import host, DB, or SDK runtime code.
- Preserve the current extension contribution vocabulary; v4 metadata uses schemaVersion: 4 and otherwise retains existing manifest fields where possible. Define ExtensionManifestV4, WorkspaceFiles (Record<string,string>), Diagnostic, ResourceLimits, BuildResult, ReleaseRecord, OperationRecord, ApprovalRecord, InvocationContext and Runner interface there. Host-computed SHA-256 digests bind source, artifacts, image, policy, and evidence. Unknown wire data is validated.
- Runner operations accept immutable source/artifact data and host-issued IDs, never caller-controlled host paths or raw Podman options. Runner has build, start, cancel, inspect, and artifact collection. An execution exposes request(method, params), notifications, and close; host reverse RPC is explicitly wired. All errors are structured. The contract and runner owners coordinate exact TypeScript signatures before either depends on them.
- SDK v4 owns defineExtension/serve protocol, metadata discovery, cancellation and schemas. Host only consumes data-only metadata. Legacy SDK API can exist temporarily during migration but final cutover removes host execution of config and bypasses.
- Host lifecycle exports ExtensionLifecycle with workspace, build, inspect, requestApproval, approve (human-authenticated host only), activate, disable, rollback, uninstall. Durable repository interface must be injectable; production uses existing DB, not a JSON file. Host installation IDs and user data are preserved.
- Workspace revisions use atomic expected-revision edits and source snapshots. Builds/activation use durable operation IDs and idempotency. Approval binds exact release, grants, principal, scope, runner profile and expected active release. No model self-approval. Validate/recheck before active pointer commit.
- Public harness and HTTP adapters, existing runtime bridge, security integration, UI and migration are integrated on the parent branch after module leaves.

## Ownership and leaves

1. contracts-sdk: packages/@ezcorp/extension-contract/**; packages/@ezcorp/sdk/src/v4/** and its subpath export; associated tests. Coordinate exports with runner and lifecycle. No host edits.
2. podman-runner: packages/@ezcorp/extension-runner/**; associated unit and real Podman tests; runner service deploy files under deploy/extension-runner/**. No host/SDK edits.
3. lifecycle: src/extensions/v4/** and src/db/queries/extension-releases.ts, src/db/migrations/add-extension-releases.ts; associated tests. Do not edit central schema/migrate until parent integration; export migration function for parent to register.
4. parent integration: central exports/deps/migration wiring, runtime/authoring routes/tools/UI, first-party migration, release gates, full validation and PR.

Every leaf runs in its own worktree. No edits to primary checkout. Do not revert others. No worker push/PR; workers commit owned code for integration. Read primary tasks/lessons.md and applicable instructions. Report actual test output, gaps and integration needs. Never replace unmet requirements with stubs or fake tests.

## Root gates

- [ ] Module tests, protocol contract and real Podman tests pass.
- [ ] End-to-end create/edit/build/repair/approval/activate/invoke/upgrade works through the real harness and UI.
- [ ] Exact approval, isolation, tokens, concurrency, recovery and data migration gates pass.
- [ ] All retained contribution types and bundled/reference extensions migrated with parity tests.
- [ ] Old unsafe load/install/automatic fallback paths removed.
- [ ] Lint, type checks, backend/SDK/web tests, build, coverage, real E2E and visual checks pass before push.
- [ ] Independent review addressed; refreshed base validated; commits pushed; PR opened and CI checked.

## Status

- Worktree created from fetched origin/main; original dirty checkout preserved.
