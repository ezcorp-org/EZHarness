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

The local MVP activates only newly created sandbox task projects. Creation
sets `projects.path` to the empty string in the same transaction as the binding.
The project update and delete routes reject persisted sandbox bindings. There
is no API that binds an existing host checkout or lets a provider set this path.

The code-agent executor rejects direct host shell/file adapters for any saved
binding. Native EZHarness is the supported runtime.

## Host access inventory

| Entry point | Local MVP behavior |
| --- | --- |
| Seven built-in tools | Resolve the saved workspace binding; call the reviewed provider; no host fallback. |
| Command discovery | Mention-search rejects sandbox bindings; the command registry only scans a nonempty local project path. |
| Extension Git/PR brokers | `authorizeProjectOperation` explicitly rejects any saved workspace binding. |
| Extension virtual filesystem | Both service and conversation roots require a nonempty `project.path`; sandbox projects have none. |
| Extension tool metadata | `ezProjectRoot` is only set for a nonempty local path. No sandbox mount path enters worker metadata. |
| Mention/path search | Explicit sandbox check returns no host paths or local commands. |
| Import, upload, attachments, extension file events | Existing roots require a nonempty project path and therefore reject sandbox projects. |
| Feature scan | Rejects a project with no filesystem path. |
| Preview | The guest helper receives no preview wiring. Its process supervisor stops the container after every command, including background children. |
| Project settings | Sandbox projects expose lifecycle controls; host checkout settings are unavailable. |

The empty-path invariant and the direct host-adapter refusal are covered by
workspace-routing, controller, project-route, and broker tests. This is a
local MVP boundary, not support for these deferred integrations. Any future
migration that binds an existing project must first make every listed path
resolve the workspace target explicitly.
