# Extension host

Use the v4 lifecycle for all extension creation, source import, build, approval, activation, update, and uninstall. Read [Authoring](../../docs/extensions/AUTHORING.md) before changing harness authoring behavior, and [Security](../../docs/extensions/security.md) before changing execution or authority.

## Boundaries

- `extension-control.ts` owns the five shared harness control tools. Keep CLI, HTTP, and harness callers on that contract; do not add a second installer.
- `v4/` owns immutable revisions, operations, releases, approval, activation, and delivery state. Database transitions and their audit or event records must commit together.
- `packages/@ezcorp/extension-contract` owns wire schemas and types. Reuse its validators; do not duplicate manifest or transport rules.
- `packages/@ezcorp/sdk` owns scaffolding and runtime registration. Extension authors must not implement framing or inspect host directories.
- `packages/@ezcorp/extension-runner` owns isolated build and execution. Missing isolation fails closed. Never import extension config, run extension postinstall code, or fall back to a host process.
- `release-process.ts` binds workers and reverse calls to the exact live invocation. Recheck authority before effects; payload identity cannot grant access.

## Feature changes

Register contributions from a verified, acknowledged active release. First-party code follows the same human approval boundary. A source lock is integrity evidence, not approval.

Use host storage and virtual `/project` or `/data` paths. Read [Storage](../../docs/extensions/data-storage.md) before changing persistence or concurrency. A local mutex cannot protect state shared by separate workers.

Keep page caches principal-scoped and recheck live authority. Page pushes are invalidations, not global private content. Panel SSE must use the host-issued principal.

Durable source changes publish subscriber events in the same transaction, then notify the UI after commit. Accepted HTTP actions use bounded owner-scoped receipts. Do not turn queue failure into successful acknowledgment or automatically retry uncertain external effects.

For source import and migration, read [Imports](../../docs/extensions/v4-imports.md). Preserve exact installation ownership and data. Uninstall does not implicitly purge files or history.

## Host utilities

Import `getProjectRoot` from `project-root.ts`. Keep that module free of database and registry dependencies. Host installation paths are not worker authority.

Use `extensionLogger(name, component?)` for new host extension logs. Keep secrets and invocation tokens out of logs. See [Logging](../../docs/extensions/logging.md).

## Proof

Follow the root coverage, worktree, and test gates. Add real runner and broker tests for isolation or capability changes; add real browser evidence for user-facing changes. Exercise denial, cross-user access, revocation, crash recovery, and a failed update retaining the active release. Do not replace an unmet parity requirement with a mock-only test or a weaker gate.
