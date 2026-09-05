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

### Integrated validation, 2026-09-05 UTC

- Snapshot c36932a2: plain web suite 4,222 pass; mock browser lane 210 pass and 12 pre-existing skips. The long-host permission display first failed its real geometry test, then passed after wrapping was fixed; screenshot inspected.
- Snapshot 4d442b73: web component/server suite 6,961 tests in 534 files pass. SDK tool, skill, agent and multi scaffolds now build and verify in the actual isolated runner.
- Snapshot 03f1592d: source import uses a selected project credential, with current account, membership and exact repository checks before each request. Real Git and controlled network regression tests pass; real encrypted-store lookup, rotation, deletion and suspended-account checks pass.
- Backend run 5, type check 17 and four real browser extension flows run against frozen 03f1592d. No claim of final validation while later leaves remain unmerged.
- New bounded completion leaves: lifecycle owns transactional domain-event enqueue; runner owns native MCP network proxy; contract/SDK owns binary source representation and round-trip behavior; integration owns remaining legacy cohorts and removal of the stale modifiable flag from immutable lifecycle operations. All require executable security and parity checks before integration.

- Worktree created from fetched origin/main; original dirty checkout preserved.
- Real rootless-runner editor and external-client flows pass. A third real chat-loop test creates source and submits an isolated build. These results do not replace the final full-suite gate.
- Full backend rerun: 23,404 passed and 526 failed across 1,486 files. Remaining failures include legacy install/registry expectations and integration gaps. Log: `/tmp/ez-extension-v4-backend2.log`.
- Full web Vitest run: 522 files passed and 4 failed. The three legacy API files now pass after migration; webhook publication exposed missing production reconciliation and is being fixed.
- All 50 first-party candidates were built through the lifecycle: 32 passed, 18 failed, none untested. Dependency archive, strict type checking, and source fixes are under retest. Log: `/tmp/extension-candidate-current-all.jsonl`.
- Container build passed. First production boot exposed a missing bundled pgvector asset; externalizing its package fixes the asset path. The rebuilt image is under boot validation.
- Security review found legacy grant-write routes, stale Bun environment caching, missing transactional lifecycle audit, and caller overrides that could outlive a grant. Each has an explicit owner and regression test work. No push or PR until the final gates pass.

### Integration review, 2026-09-04 evening

- Production publication now commits catalog, entity seeds, webhook secrets and schedules under one generation fence. Cache invalidation runs only after commit. Exact durable grants are checked again before publication.
- Workspace editing, inspection and empty delivery polling work without a runner. Execution still fails closed if the authenticated runner is absent.
- Queued work snapshots the host project and approval ID. Revocation, rebind, owner change or membership loss prevents dispatch. The project broker checks authority again before an effect.
- Library and detail pages no longer submit legacy permission changes. They open the exact installation's release review. Uninstall retains history and data; the UI no longer offers an unsupported destructive choice.
- Backend run 3: 23,416 passed, 469 failed, 1,497 files. This was an integration run while commits changed, not final-head evidence. Several failures came from the temporary SDK merge conflict; many legacy installer suites still require migration. Log: `/tmp/ez-extension-v4-backend3.log`.
- Web Vitest run 2: 526 files passed, four failed; 6,918 tests passed and 42 failed. Remaining files test old MCP mutation behavior. Log: `/tmp/ez-extension-v4-web-vitest2.log`.
- The real auto-note subprocess suite now passes all 13 tests, with 40 assertions. Production framing replaces the obsolete custom transport that left failed requests pending.
- A second security review reproduced host config execution through six legacy loader, author-route and draft-RPC paths. The root-cause removal and regression tests are in progress. The earlier install rejection did not close these paths. Do not report the security gate complete.
- Full coverage is running on frozen commit `a8c4a9af`. Do not edit its executing script or merge source changes until it finishes. Later commits require another final-head validation.
- The real UI test reached release approval, activation, detail review and disable. Its new uninstall step used the wrong button name; correct the locator and rerun. No product success is inferred from that failed test.
- No branch push or PR has occurred. All root gates remain open.

### Integration review, 2026-09-04 late evening

- Coverage run 2 completed: coverage failed in 21 files and 62 backend pass/fail files still failed their isolated retry. Freeze lifted after completion. Log: `/tmp/ez-extension-v4-coverage2.log`.
- All 50 first-party lifecycle candidates now pass actual rootless compilation, tests and discovery; none were approved or activated by that sweep. Evidence: `/tmp/extension-candidate-final-sealed.jsonl`.
- Legacy host config evaluation is removed from loaders, author install/validate and draft RPC. Six real owned-draft regression paths pass. Reopen now forks exact immutable release source, not host files.
- Actual production image verification passes boot, file-based runner credentials, isolated build, human approval, activation, tool invocation, disable denial and retained history. The Compose namespace mismatch is fixed. Repeat with `bash scripts/verify-extension-container.sh <local-image>`.
- The production runner test found a declaration-only package export regression after the SDK change. Provisioning now distinguishes runtime exports from type declarations and includes their declaration closure. Actual runner startup and authenticated build pass.
- Real editor, external harness and chat build tests pass: three specs, no failures. Desktop/mobile review and uninstall-retention screenshots inspected. Log: `/tmp/ez-real-fifth.log`.
- Full web Vitest run 3 found two remaining old-author suites (42 failed tests). Both are now migrated: 29 focused tests pass; the legacy settings mock also now passes all 42 tests. Another full run is in progress.
- Backend typecheck run 11 passed. Later changes require another full run. Lint passed with 119 warnings and 13 informational findings; this is not a warning-free result.
- Origin was fetched again and the branch is not behind main. No push or PR. Remaining gates include host integration, metadata/test migration, coverage, project review integration and final frozen validation.

### Integration review, 2026-09-05 UTC

- Coverage run 3 completed on c0de12b8 and failed. Six threshold gaps remain; legacy test migrations and atomic persistence fixtures are assigned. No threshold was lowered.
- Merged canonical binary assets, streamed HTTP body limits, browser-safe source codec, native MCP HTTP/CONNECT proxy, explicit raw credential grants, and exact-owner legacy source adoption.
- Parent native network checks pass, including actual rootless HTTP/TCP/TLS, direct network refusal, revoked grants and raw credential refusal. Log: `/tmp/ez-native-parent1.log`.
- Parent source adoption, strict input and binary release roundtrip tests pass. Log: `/tmp/ez-binary-adoption-parent1.log`.
- Startup diagnostics: seven tests pass. Subscription candidate matrix: 49 tests pass. Visible release evidence registration: seven tests pass. These are intermediate checks, not final-head proof.
- Review found and fixed scoped event disclosure and an async host-wiring race. Remaining state/event receipt producers are not complete.
- Latest fetch found no missing main commits. No push or PR. Maintainer approval for legitimate test/gate migration remains required.
## Current closure work

The final source is not frozen. Host-fenced locks, candidate SDK helpers, atomic task publication, sealed browser builds, and the private browser client are integrated. Actual rootless cancellation proves that a cancelled worker does not stop a concurrent worker or later calls. Remaining leaves are post-await effect admission, harness run-signal propagation, and the real protected scanner/camera workflow. Each must pass real host/worker or browser tests before final full-suite validation. Documentation and `extensions_describe` now point to the shared v4 schema, scaffold, runtime helpers, and browser client.

Types34 and lint12 pass (lint has warnings). Backend9 is running. Web6 and component8 found task and browser fixture failures; their fixes are merged, but full reruns remain required. The all-50 candidate run found an actual scanner response-type error; explicit response guards are merged and isolated verification is being repeated. No failed gate is treated as complete. Gate-integrity reports 84 migration findings that require maintainer review; no push or PR has occurred.
