# Gates: pluggable infrastructure wave 1 workspace routing

- [x] G1: Workspace targets are explicit and host-owned.
  - `WorkspaceTarget` is a frozen `local` or `sandbox` discriminated union.
  - The sandbox binding carries the exact project, workspace, connection,
    provider, preset, release, preset and effective-settings identities on
    every backend request.
  - `setupTools` accepts the target only through its host-owned runtime
    options. Project paths, working directories, models and tool inputs do not
    select or weaken a sandbox target.
- [x] G2: Sandbox-required work cannot use local read, write or process fallback.
  - The production built-in factory replaces all seven workspace tool
    executors for a sandbox target: read, list, tree, edit, shell, grep and
    glob.
  - A missing or failed sandbox backend returns
    `sandbox_workspace_unavailable` with `localFallbackDenied: true` and does
    not call local filesystem, preview or process primitives.
  - `proveSandboxLocalFallbackDenied` runs the production read, edit and shell
    route against AMD-local canaries and returns the exact frozen SP05 receipt.
    Candidate conformance compares the complete binding, cases and unchanged
    host result before it records SP05.
  - Controlled removal of the routing boundary and controlled AMD canary
    mutation both make the proof fail.
- [x] G3: Existing local projects remain compatible through an explicit local target.
  - Dispatch-pinned working directories still override local project roots.
  - Explicit local targets retain read, edit and shell behavior. Existing
    string-path factory callers remain supported.
- [x] G4: Production-seam tests, typecheck and lint pass with pinned Bun 1.3.14.
  - Affected integration command: 115 tests passed, 0 failed, 482 assertions
    across workspace routing, candidate verification, conformance, Incus
    setup, all built-in workspace tools, preview and existing sandbox seams.
  - Focused workspace coverage: `host-routing-proof.ts` 54/54 lines and
    `target.ts` 62/62 lines.
  - `bun run typecheck`: passed backend, web, backend tests and web E2E.
  - `bun run lint`: exit 0. It reported eight informational notices in
    existing files outside this leaf and made no fixes.
  - `git diff --check`: passed.

## Commands

All commands used `/tmp/bun1314/bun` or placed `/tmp/bun1314` first in
`PATH`; `bun --version` reported `1.3.14`.

```text
bun test --timeout 30000 <13 affected workspace/conformance/Incus files>
bun test --timeout 30000 --coverage --coverage-reporter=lcov ./src/runtime/workspaces/target.test.ts
bun run typecheck
bun run lint
git diff --check
```

## Remaining routing scope

This wave establishes the M0 target seam and denial proof. Live Incus workspace
transport and durable project target persistence remain open. Preview serving,
attachments, Git/PR operations, child/workflow inheritance, project-bound MCP
placement and the admin filesystem route still require explicit target routing
in later W02-W04 work.
