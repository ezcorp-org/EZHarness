# Workspace routing inventory

Checked on 2026-09-22 against `feat/pluggable-infrastructure-v1`.

## Routing rule

A project operation must use the `WorkspaceTarget` selected by the host. A
local target contains an absolute host root. A sandbox target contains the
qualified binding and an optional live backend. A missing or failed sandbox
backend must not retry against the local project path.

The live backend is an in-process handle. Only
`WorkspaceTargetReference` is safe to store or send across a durable boundary.

## Implemented paths

| Project access path | Entry points | Current route | Failure behavior |
| --- | --- | --- | --- |
| Built-in read, list, tree, edit, shell, grep, and glob | `src/runtime/stream-chat/setup-tools.ts`, `src/runtime/tools/index.ts` | `WorkspaceTarget` is resolved once for the turn. Local targets keep the existing root. Sandbox targets send the exact binding to `SandboxWorkspaceBackend.execute`. | Missing and failed sandbox backends return `sandbox_workspace_unavailable`; no host file or process primitive runs. |
| Code-agent file and shell providers | `src/runtime/executor.ts`, `src/runtime/workspaces/target.ts` | `createSandboxAgentProviders` adapts the code-agent provider surface to the same backend and binding. | Missing and failed sandbox backends throw; local providers are not called. |
| Nested child agents | `AgentContext.run` in `src/runtime/executor.ts` | The child inherits the same `WorkspaceTarget` object and binding. | The child uses the same closed failure path as its parent. |
| Assignment child turns | `src/runtime/orchestration-host.ts`, `src/extensions/tool-executor/executor.ts`, `src/extensions/spawn-assignment-handler.ts`, `src/runtime/start-assignment.ts` | The per-turn executor passes the host-selected target through reverse RPC into `startAssignment`, which supplies it on each child turn. | A caller-supplied parent run ID cannot select another run's target. A sandbox target never changes to `workingDir` or the project path. This is live-process propagation only. |
| Workflows, nested workflows, agent steps, loops, and workflow tool steps | `src/runtime/tools/run-workflow.ts`, `src/runtime/workflow-tools-host.ts`, `src/runtime/workflow-executor.ts`, `src/runtime/workflow-tool-runner.ts` | `WorkflowRunOptions.workspaceTarget` flows through each nested run and the production `ToolExecutor`. | Failed agent-provider or extension routing does not retry locally. |
| Extension reverse-RPC Git reads | `src/extensions/project-git-broker.ts`, `src/runtime/workspaces/project-command-runner.ts` | Local targets keep the existing realpath and command runner. Sandbox targets send fixed, host-authored Git commands through the sandbox shell backend with the exact binding. | Missing or failed backend returns the broker's closed error. It does not call `realpath` or local Git. |
| Extension open-PR request | `src/extensions/project-pr-broker.ts` | Local behavior is unchanged. Sandbox use is denied until Git and credential placement have a supported remote implementation. | Denial happens before token lookup and before local Git or PR execution. |
| Durable pull-request review proposals | `src/extensions/project-pull-request-broker.ts` | The proposal scope stores `WorkspaceTargetReference`. Observation requires the caller target to match the stored reference, and authorization uses the stored scope. Local proposals keep existing behavior. | A target mismatch is rejected before authorization. A stored sandbox reference is rejected before local Git, project-root comparison, credential use, or GitHub effects. It cannot drift local after approval. |
| Project MCP tools | `src/extensions/tool-executor/executor.ts` | The per-turn `ToolExecutor` receives the target. Local MCP behavior is unchanged. Sandbox MCP placement is denied until a guest MCP transport exists. | Denial happens before registry client or subprocess lookup. |

## Inventoried remaining paths

The first three paths have a selected-target guard and remain unavailable for
production sandbox projects until a live provider capability is injected. The
other paths still need routing work.

| Project access path | Current host access | Required next route |
| --- | --- | --- |
| Dynamic preview launch and proxy | Preview rows now persist the full host-selected `WorkspaceTargetReference`. Sandbox open, HTTP serve, and close require an injected preview capability with exact project/workspace/connection/provider/release/generation matching. Missing, expired, or forged targets fail before host loopback. Provider HTTP requests strip cookies, credentials, and internal headers while retaining method and body. Sandbox WebSocket reconnect is denied. Local launch and proxy behavior is unchanged. | Implement the live provider HTTP and WebSocket relay, inject its resolver into web dispatch, and add reconnect/recovery qualification. No public unauthenticated endpoint is accepted. |
| Static preview files | Local previews keep the existing realpath jail below `<project>/.ezcorp/sites`. A sandbox row is routed through the preview capability and cannot read `staticPath` from the AMD host. | Implement provider file serving or publish immutable artifacts to authenticated host-owned object storage. |
| Attachment upload, clone, rehydrate, handle resolution, download, and deletion | Every storage operation now receives an explicit `WorkspaceTarget`. Local targets preserve `.ezcorp/attachments`; sandbox targets require the narrow attachment capability. Direct history calls with no target resolve the persisted conversation's project through the binding guard. An explicit local history target also checks that guard, so a stale local target cannot bypass a later sandbox binding. A durable sandbox project binding makes web routes and direct history reads deny AMD-local resolution until a qualified backend target can be injected. | Connect the live provider adapter to the attachment capability and decide whether production attachments remain provider-owned or move to host-owned conversation storage. |
| File mentions and project feature scan | `web/src/routes/api/mentions/search/+server.ts` and `web/src/routes/api/projects/[id]/features/scan/+server.ts` scan the host project path. | Route scans through a read-only workspace backend or deny sandbox projects. |
| Extension filesystem reverse RPC and file-organizer effects | `src/extensions/virtual-filesystem.ts`, `src/extensions/tool-executor/fs-handler.ts`, and `src/extensions/file-organizer-applier.ts` use host paths and grants. | Carry `WorkspaceTarget` into these brokers and implement guest file primitives before enabling them for sandbox projects. |
| Extension data, files, uploads, and event routes | `web/src/routes/api/ext-files/[name]/[...path]/+server.ts`, `web/src/routes/api/extensions/[name]/data/[...path]/+server.ts`, `events/[event]/+server.ts`, and `uploads/+server.ts` resolve host roots. | Classify each root as host-owned extension state or workspace state. Route only workspace state through the selected target. |
| Import staging and installed project assets | `src/runtime/import/staging.ts` and `web/src/routes/api/import/*` use the host project root. | Keep staging in host control-plane storage or add an explicit commit-to-workspace operation. |
| Project and extension-author drafts, install paths, and bundled locks | `src/db/queries/ez-drafts.ts`, `src/extensions/author-install.ts`, `installer.ts`, `bundled-lock.ts`, and related install-root helpers use the host project root. | Classify host product state separately from guest workspace content before routing. |
| Arbitrary non-MCP extension subprocess project metadata | `src/extensions/tool-executor/executor.ts` can send `_meta.ezProjectRoot` to a host subprocess. Project Git and PR reverse RPC calls are protected by provenance, but an extension-owned direct path use is not remote-routed. | Stop exposing an AMD path to sandbox-bound subprocesses and provide a guest extension placement or a capability-specific broker. |
| Durable workflow and assignment resume | Live `WorkspaceTarget` backends are held in `AgentExecutor`; workflow run rows do not store a complete target reference. | Persist `WorkspaceTargetReference` with the run, validate all binding digests on resume, and rehydrate a backend from the controller/provider registry. |
| Controller-to-runtime target construction | `src/sandboxes/controller.ts` owns durable lifecycle bindings. No production resolver currently turns a qualified controller binding into `SandboxWorkspaceBackend`. | Add a provider dispatcher adapter and host resolver. It must validate project, connection, release, preset, and effective-settings digests before creating the target. |

## Canary coverage

- `src/runtime/workspaces/target.test.ts` covers all seven built-in operations,
  missing and failed backends, exact bindings, and an AMD file canary.
- `src/runtime/workspaces/propagation.test.ts` covers nested code agents and
  workflow agent steps, including a backend failure with zero local provider
  calls.
- `src/extensions/__tests__/project-git-broker.test.ts` proves missing and
  failed sandbox Git routing does not run local Git.
- `src/extensions/__tests__/project-pr-broker.test.ts` proves sandbox PR
  denial occurs before secrets and local PR execution.
- `src/extensions/__tests__/project-pull-request-broker.test.ts` proves a
  stored sandbox proposal cannot be observed through a local target.
- `src/extensions/__tests__/tool-executor.project-root-meta.test.ts` proves a
  sandbox MCP call cannot create a host client or process.
- `src/__tests__/orchestration-host.test.ts` and
  `src/__tests__/start-assignment-plumbing.test.ts` prove that the host target
  reaches assignment turns and that a forged parent run ID cannot replace it.
- `src/__tests__/workspace-preview-attachment-routing.test.ts` proves sandbox
  attachment and preview capabilities receive the full binding and cannot
  reach AMD files or loopback when absent, expired, or forged. It also proves
  provider HTTP requests have credentials removed while POST bytes survive.
- `src/__tests__/attachments-serve-route.test.ts`,
  `src/__tests__/attachments-gc.test.ts`, and
  `src/__tests__/messages-permission-mode-ceiling-route.test.ts` prove durable
  sandbox bindings deny production download, delete, and send before local
  file access or message/database mutation.
- `src/__tests__/preview-sessions-queries.test.ts` proves local static preview
  compatibility and sandbox open/close binding checks.
- `src/__tests__/session-history-producer-live-parity.test.ts` proves real
  local image rehydration and bound-project denial for direct history callers.
- `web/src/routes/api/extensions/[name]/uploads/__tests__/upload.test.ts`
  proves extension uploads preserve local behavior and deny a bound project
  before storage or an attachment row is written.
