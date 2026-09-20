# Local-first workspace routing foundation

`project_workspace_bindings` is host-owned policy. No row means the existing
local checkout remains active. A sandbox row stores only a project ID, opaque
binding ID, revision, and activation state. It never stores a host path.

`resolveProjectBuiltinTools()` resolves that row before it creates the seven
built-in project tools. Sandbox tools use a host-injected dispatcher. Until a
reviewed provider configures that dispatcher, every sandbox operation denies;
there is no local fallback. Client `workingDir` is not part of selection.

For this MVP, one dedicated sandbox project is one feature work unit. The
binding is project-scoped by design; multiple sandbox workspaces per project
are not supported yet. The existing host-validated `workingDir` remains the
tool root for local dispatched worktrees only.

This slice does not add a write API, provider activation, remote preview,
Git/PR, MCP, attachment, mention-search, or guest-worker support. Those paths
remain inventory items and must either gain the same target policy or deny
sandbox-bound projects before a sandbox claim can be made.

The code-agent executor now denies its direct host shell/file adapters when
the persisted project policy is sandbox-bound. Native EZHarness remains the
only supported agent runtime.

## W01 inventory still open

This foundation only routes the seven chat tools and denies direct code-agent
adapters. Sandbox binding activation must stay unavailable until each path has
an equivalent target check or an explicit deny:

- `src/runtime/commands/discovery.ts` and `registry.ts` read local project
  command files. Gate: resolve target and deny sandbox projects.
- `src/extensions/project-access.ts`, `project-git-broker.ts`,
  `project-pr-broker.ts`, and `project-pull-request-broker.ts` require a local
  project path. Gate: retain denial for sandbox projects until the approved
  local provider supplies Git/PR operations.
- `src/extensions/virtual-filesystem.ts` and
  `src/extensions/tool-executor/executor.ts` expose local project content to
  extensions. Gate: target-aware adapter or deny.
- `web/src/routes/api/mentions/search/+server.ts`, import routes, extension
  upload/event routes, and feature scan routes read local roots. Gate:
  target-aware implementation or deny.
- `src/runtime/preview/*` starts host UID/netns processes. Gate: a separate
  local-sandbox preview bridge; do not use its host process model for a bound
  sandbox.
