# Pluggable infrastructure execution contract

Source: docs/plans/2026-09-20-pluggable-infrastructure-tasks.md. The active scope is the bare minimum local EZHarness MVP. All R4 features, Claude/Codex guest workers, external networking, Infisical, second-provider qualification, and Compose services are deferred or removed as specified in the source plan.

## Shared rules

Use the existing v4 contract, schema generator, approval engine, broker and test selectors. No local fallback for sandbox-required projects. No secret bytes in normal outputs. No support claims from mocks. Preserve current local behavior. Interfaces are frozen per work package before implementation delegation.

## Ownership and sequence

1. Parent: source baseline, integrated plan, gap decisions, integration and evidence.
2. Sol: independent contract/security audit in ../pluggable-sol; later assigned bounded implementation leaves.
3. Terra: independent runtime/test audit in ../pluggable-terra; later assigned bounded implementation leaves.
4. Contract and runtime foundations precede durable control and adapters. UI follows stable production APIs.
5. Parent reruns agent checks and inspects integration. Heavy checks use /tmp/ezcorp-validation-heavy.lock.

## Acceptance gates

gates/pluggable-root.md tracks review, repository implementation, verification and live acceptance. tasks/todo.md retains every backlog item. No task is closed merely because a subset passes.

## Implementation history

The entries below record intermediate findings. Final status is in the integrated local candidate section and [validation report](../validation/pluggable-local-mvp.md).

- 2026-09-20: Fetched origin/main and created three worktrees. Sol and Terra reviews running. Requested test connection locations, original PRD and optional scope.

- 2026-09-20 user scope correction: no AMD/Xeon, Incus or Infisical deployment exists. Build and validate locally first. External-host networking and deployment follow after local proof. Preserve the eventual R1–R3 backlog, but local completion requires real locally available runtimes and explicit unsupported capabilities.

- 2026-09-20: User removed Claude/Codex guest workers (N01/N02). Native EZHarness only. Other R4 choices under discussion.

## First implementation leaves

| Leaf | Owner | Files | Proof |
| --- | --- | --- | --- |
| Provider contributions | Sol contract | extension-contract package; SDK type exports | Shared schema parity, invalid declarations, full changed-line coverage, build |
| Workspace routing | Terra runtime | runtime/workspace, tools factory, setup, DB binding migration | Persisted target, seven tools, no local fallback, stale target denial |
| Sensitive dispatch denial | Terra boundary | release-process and own tests | Sensitive calls never start ordinary worker; controlled boundary fault fails |
| Local runtime qualification | Sol infrastructure | scripts/pluggable-infrastructure and own docs/tests | Actual bounded temporary runtime, recovery, cleanup, honest unsupported controls |

Parent owns integration, shared coverage registration and final verification. Agents commit isolated changes; parent reviews and reruns checks. No first-wave result closes the full local milestone by itself.

## Active MVP scope

User selected the bare minimum local MVP. This supersedes the initial R1–R3 implementation scope. See the final scope section in the source backlog. Contract and routing foundations remain; optional protocols, Infisical, second-provider proof, external networking and full Compose qualification are deferred.

- C01 integrated as `9802fef2e`: additive provider declarations, generated schema, fixed MVP method groups and sensitive classification. Agent receipt reports contract tests, builds and 100% changed-line coverage; parent rerun in progress.
- Local runtime feasibility: rootless Podman on this extfs host cannot enforce overlay disk quota. Owned fixed-size filesystem/FUSE proof stopped guest writes at ENOSPC and retained data after remount. Final recipe must avoid unsupported journal handling and prove recovery/cleanup; this is not yet full profile qualification.
- Work unit model: each MVP sandbox uses a dedicated project. Existing source-index feature rows are not execution identities. Local host-validated workingDir behavior remains intact; sandbox binding overrides it.

- Parent C01 verification passed: schema parity, 21 contract tests, package build and 100% changed executable-line coverage. Receipt path normalization required the canonical root-invoked test command. See gates/pluggable-contract.md.

- Parent W02 verification: 9 tests passed, 44 assertions; target and binding migration each have 100% measured executable-line coverage. `/tmp/pluggable-routing-parent.log` and the root-produced lcov record provide the evidence. Full integrated coverage and runtime acceptance remain open.
- Parent review rejected the first replay journal implementation: temp-file rename did not atomically claim an idempotency key across concurrent instances. A concurrency test and exclusive publication are required before integration.

- Native tool reuse: seven existing implementations now share a catalog; the fixed read-only sandbox helper bundles to 0.79 MB. Parent tests: 5 passed, 28 assertions, four new modules each 100% measured line coverage. Real offline Podman helper executed a Bun test successfully; owned container inventory is empty afterward. Receipt `/tmp/pluggable-native-guest-proof.json`. This is helper evidence, not full controller/restart acceptance.
- Parent local file/journal/lifecycle focused checks: 17 passed, 252 assertions. Exact runtime identity, cleanup reconciliation and process supervision remain open; the driver is not activated.

## Integrated local candidate

The candidate includes the reviewed local provider, dedicated project bindings,
rootless runtime, contained file methods, native tool dispatch, durable process
state and output, cancellation, and explicit terminal disposal. It reserves one
retained workspace. The provider approval check uses the existing broker grant
projection and the persisted installation approval shape.

Focused controller, invoker, runtime, startup, route, and UI tests pass. The real
runtime control receipt and separate production-driver recovery receipt are in
`tasks/evidence/pluggable-local/`. The live application journey, full coverage, browser suites, production build,
and gate-integrity checks passed. All 32 new source files have 100% measured
line coverage; all changed executable lines across 52 files are covered.
See the [final validation report](../validation/pluggable-local-mvp.md) for exact
revisions, results, and limits. External infrastructure and all optional R4
features remain deferred.
