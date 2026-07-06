# RBAC & Permission Modes

> _The three independent authorization layers in EZCorp: instance roles (`admin`/`member`) that gate admin/extension-lifecycle APIs, team roles (`owner`/`editor`/`viewer`) for collaborative resources, and per-project tool **permission modes** (`ask`/`auto-edit`/`yolo`) that decide which built-in tool calls auto-run vs. pause for the user._

## Intent

EZCorp has to answer two distinct questions on every privileged action: *"is this human/principal allowed to do this?"* (RBAC) and *"should this LLM-initiated tool call run without asking the user?"* (permission modes). These are deliberately separate axes. RBAC is human-identity authorization enforced at the HTTP boundary (`requireRole`, `requireTeamRole`, `requireAdmin`). Permission modes are a per-project trust dial for **built-in** tools (file read/write/exec) that the model invokes mid-turn. A third, orthogonal system — the [PermissionEngine PDP](#extension-capabilities-the-pdp-orthogonal-axis) — governs **extension** capabilities (grants → allow/deny/prompt) and is documented mainly under [[permissions-and-grants]]; this doc covers how the three relate and where each one bites.

## How it works

There are three authorization layers, each with its own enforcement point.

### 1. Instance roles (`admin` / `member`) — `users.role`

- The principal type is `AuthUser` (`src/auth/types.ts`): `{ id, email, name, role: "admin" | "member" }`. The role column lives on `users.role` (`src/db/schema.ts`, defaulting to `"member"`).
- `requireAuth(locals)` (`src/auth/middleware.ts`) returns the user or throws a raw `401` Response. `requireRole(locals, "admin")` calls `requireAuth` then throws a `403` Response unless `user.role === "admin"`. Both throw a `Response` object, which SvelteKit surfaces as a `500` unless the route catches it — several routes wrap it in a `requireAdminOr403`-style try/catch to return a clean `403` (e.g. `web/src/routes/api/extensions/[id]/+server.ts`).
- Admin-gated operations include: extension **install** / **modify** / **disable** (`POST`/`PATCH /api/extensions[/...]`), **reapprove-drift** (`POST /api/extensions/[id]/reapprove-drift`), permission editing (`PUT /api/extensions/[id]/permissions`), the **audit** log (`GET /api/audit`), marketplace flags/delete, provider CRUD, admin sessions/errors/analytics/system endpoints, and the `forever`-scope grant escalation in the permission modal (below).

### 2. API-key scopes — a second authorization axis

- Bearer / API-key principals carry `locals.apiKeyScopes` (`ApiKeyScope = "read" | "chat" | "extensions" | "admin"`, from `src/auth/api-key.ts`). `requireScope(locals, scope)` (`web/src/lib/server/security/api-keys.ts`) returns a `403` Response if the key lacks the scope — **but is a no-op (allow-all) for cookie sessions**, because `locals.apiKeyScopes` is `undefined` there.
- That no-op is the footgun: `requireScope(locals, "admin")` alone lets any cookie-authed *member* through. The role axis is the real authority. Two defenses exist:
  - **API-key principals are always minted with `role: "member"`** (`web/src/lib/server/security/bearer-auth.ts`), so a key can never be an admin *by role* even if it holds the `admin` *scope*.
  - `requireAdmin(locals)` checks `locals.user.role === "admin"` directly, and admin routes are expected to pair `requireScope("admin")` with `requireRole("admin")` — a route-contract meta-test enforces the pairing.

### 3. Team roles (`owner` / `editor` / `viewer`) — `team_members.role`

- `requireTeamRole(locals, teamId, minRole)` (`src/auth/middleware.ts`) resolves the caller's membership via `getTeamMembership(user.id, teamId)` and compares against a numeric ladder `ROLE_LEVELS = { viewer: 0, editor: 1, owner: 2 }`.
- **Instance admins bypass the team check entirely** (`if (user.role === "admin") return user;`). Non-members get `403` "Not a member of this team"; insufficient level gets `403` "Insufficient team permissions".
- Used by the teams API: `GET /api/teams/[id]` (viewer), `PUT /api/teams/[id]` + member add/remove (owner).

### 4. Permission modes (`ask` / `auto-edit` / `yolo`) — per-project built-in-tool gate

This is the LLM-action gate, defined in `src/runtime/tools/permissions.ts`. It governs only **built-in** tools, classified by `ToolCategory` (`read` / `write` / `execute` / `ez`; `src/runtime/tools/types.ts`).

- The auto-approve matrix:

  | Mode | Auto-approved categories | Prompts for |
  |---|---|---|
  | `ask` | `read`, `ez` | `write`, `execute` |
  | `auto-edit` | `read`, `write`, `ez` | `execute` |
  | `yolo` | `read`, `write`, `execute`, `ez` | (nothing) |

  `ez` (concierge propose/fill/navigate tools) is auto-approved in **every** mode — they're proposal/informational and the real mutation surface is a destination form's Submit button.
- `needsApproval(category, mode)` returns `!AUTO_APPROVE[mode].has(category)`. `getPermissionMode(projectId, sessionOverride?)` resolves the effective mode: an explicit `sessionOverride` wins; else the stored `project:${projectId}:tool_permission_mode` setting; else `DEFAULT_PERMISSION_MODE`.
- **`DEFAULT_PERMISSION_MODE = "yolo"`** — this is an intentional, permanent product decision (fresh installs auto-approve everything), not a security gap.

#### Gate lifecycle (built-in tool)

The gate is wired in `src/runtime/stream-chat/setup-tools.ts` (each built-in tool's `execute` is wrapped):

1. Resolve the effective mode: `options.permissionMode` (per-turn override from the send body) → `busOverrideMode` (live mid-run mode switch via the `tool:permission_mode_change` bus event) → `await getPermissionMode(projectId)`.
2. If `needsApproval(def.category, mode)`, emit a `tool:permission_request` bus event (renders the inline `PermissionGate.svelte` card) and `await createPermissionGate(toolCallId, conversationId)` — a promise stored in an in-memory `pendingApprovals` Map that blocks the tool until resolved.
3. The user answers via `POST /api/tool-calls/:id/permission` → `handleToolPermission` (`src/routes/tool-permission.ts`) → `resolvePermission(toolCallId, approved)`. Approve resolves the promise (tool runs); deny rejects it (tool returns an `isError` result).

The `pendingApprovals` Map stores the gate's `conversationId` so the resolver can run a **sec-H2 ownership check**: only the conversation owner (or an instance admin) may approve/deny a pending gate. Without it, a low-privileged user could approve an admin's pending `shell` execution.

### Extension capabilities: the PDP (orthogonal axis)

Extension tool calls do **not** go through permission modes. They route through the `PermissionEngine` PDP (`src/extensions/permission-engine.ts`), the single place mapping grants → `allow` / `deny` / `prompt`:

- `authorize(ctx, needed)` computes the effective grant set (cross-ext `capContext` → per-conversation override → registry grants), does a subset check (`firstMissingCapability`), and for **sensitive** caps (`SENSITIVE_KINDS` in `src/extensions/capability-types.ts` — `shell`, `fs.write`, plus `ezcorp:extension:install` / `ezcorp:extension:modify`) without an always-allow row returns `prompt`. The four-scope persisted gate (below) only carries `shell` / `fs.write` (`ExtensionGateMeta.capabilityKind` is typed exactly those two); install/modify take the one-shot, never-persisted path described in the last bullet.
- A `prompt` opens a *second* gate type via `createExtensionPermissionGate` (`src/runtime/tools/permissions.ts`, consumed in `src/extensions/tool-executor.ts`). Unlike built-in gates, this resolves to a structured `ApprovalResolution { allowed, scope, ttlOverrideMs }` so the chosen always-allow **scope** (session / conversation / project / forever) can be persisted via `resolvePrompt`. See the [four-scope modal](#related-docs).
- **Where RBAC re-enters the LLM path:** the `forever` scope is admin-gated *at the API layer* — `handleToolPermission` rejects `scope: "forever"` from a non-admin caller (`user.role !== "admin"` → `403`), defense-in-depth behind the client-side `isAdmin` prop on `PermissionGate.svelte`. Also, `ezcorp:extension:install` and `ezcorp:extension:modify` are never persisted as always-allow rows (every install/reopen-for-edit re-prompts), and **bundled** first-party extensions get a `bundled-ceiling-auto-allow` for non-install/non-modify sensitive caps so they don't hit an unanswerable gate.

### 5. Extension RBAC grants (`extension_rbac_grants`) — per-user, per-project, per-extension

A fourth axis answers *"may **this user** use / configure / approve-runs-for **this extension** in **this project**?"* — distinct from the PDP (which governs what the *extension* may do) and from instance roles (which are all-or-nothing across the instance). The resolver and delegation rules live in one place: `src/auth/extension-rbac.ts`.

- **Grant row** (`extension_rbac_grants`, `src/db/queries/extension-rbac.ts`): `(user_id, project_id?, extension_id?, scopes[])`. A `NULL` `project_id` covers **all** projects; a `NULL` `extension_id` covers **all** extensions. A COALESCE-unique index over `(user_id, COALESCE(project_id,''), COALESCE(extension_id,''))` makes each (user, project-or-all, extension-or-all) tuple singular (the same NULL-collapse pattern as `extension_secrets`; the query layer uses select-then-write with retry-once, never `ON CONFLICT`).
- **Scopes** = the fixed core verbs `use` / `configure` / `secrets` / `approve-runs` / `manage`, plus any **custom** scopes an extension declares in its manifest (`permissions.rbacScopes: [{name, description}]`, validated by `src/extensions/rbac-scopes.ts`: grammar `[a-z][a-z0-9-]*`, no core-verb collision, ≤16, description required). github-projects declares `write-tickets`.
- **Resolution** (`resolveEffectiveScopes` / `hasExtensionScope`): `role === "admin"` → the `RBAC_ALL_SCOPES` sentinel **without a DB hit** (a non-admin can never obtain it). Otherwise the union of `scopes` across grants whose `project_id` is NULL-or-equal AND `extension_id` is NULL-or-equal. **Deny-by-default** — no grant means empty set (a deliberate 2026-07-03 decision for a clean long-term posture; the instance has no non-admin users yet, so nothing regresses).
- **Delegation** (`canManageGrant`): admins always; otherwise the actor needs a `manage` scope whose grant coverage **contains** the target grant's exact (project, extension) coordinates — reusing the resolver, so a project-scoped manager can never mint a NULL-project (broader) grant. Managers may **never** grant or revoke a `manage`-bearing grant, and may never touch an admin user's grants. Upsert re-checks `canManageGrant` against both the new **and** existing scope sets (so overwriting to strip a broader grant is refused).
- **Enforcement points**: the github-projects web routes (`_shared.ts` `requireGithubScope` → 403 naming the missing scope, checked **after** the opaque 404 so existence never leaks), the extension-secrets route (`secrets` scope), the reverse-RPC handler (`github-projects-handler.ts`: approve/dismiss/rerun → `approve-runs`, poll-now/dashboard-data → `use`, ticket mutations → `write-tickets`; `dashboard-data` degrades to `{permissionDenied:true}` rather than erroring so the Hub renders), and the SDK broker `ctx.rbac.check(scope)` (tool-executor `ezcorp/rbac-check`, provenance-derived user + registry-resolved extension, never the wire). The daemon's own auto-spawn path is system-initiated (no user) and correctly bypasses.
- **Grants API + UI**: `GET/POST /api/rbac/extension-grants` + `DELETE /api/rbac/extension-grants/[id]` (delegation-gated, audit rows `RBAC_GRANTED` / `RBAC_REVOKED`), surfaced at the admin `/settings/permissions` page. Grant list visibility is scoped to the actor (admin: all; manager: their coverage; member: own).

## Usage

### RBAC enforcement (server-side, SvelteKit `+server.ts`)

```ts
import { requireAuth, requireRole, requireTeamRole } from "$server/auth/middleware";
import { requireScope, requireAdmin } from "$lib/server/security/api-keys";

requireAuth(locals);                       // 401 if unauthenticated
requireRole(locals, "admin");              // 403 unless instance admin (throws a Response)
const err = requireScope(locals, "chat");  // 403 Response | null (no-op for cookie auth)
const adminErr = requireAdmin(locals);     // 403 Response | null, role-based
await requireTeamRole(locals, teamId, "editor"); // team ladder; admins bypass
```

### Permission-mode API & UI

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/projects/[id]/tool-permission-mode` | `read` | Current stored mode (defaults to `yolo`). |
| `PUT /api/projects/[id]/tool-permission-mode` | `chat` | Set mode (`{ mode, conversationId? }`); emits `tool:permission_mode_change` so an in-flight run picks it up live. |
| `POST /api/tool-calls/[id]/permission` | `chat` | Approve/deny a pending gate (`{ approved, scope?, ttlOverrideMs? }`); ownership-checked; `scope:"forever"` admin-gated. |

- **Per-turn override:** the chat send body (`POST /api/conversations/[id]/messages`) accepts an optional `permissionMode` (`z.enum(["ask","auto-edit","yolo"])`, `messages/schema.ts`) that wins over the stored project mode for that one turn.
- **UI:** `ChatHeader.svelte` hosts the picker by rendering `PermissionModeIndicator.svelte`, which is itself both the colored dot (`ask`=red, `auto-edit`=yellow, `yolo`=green via `web/src/lib/permission-mode.ts`) and the dropdown that GET/PUTs `/api/projects/[id]/tool-permission-mode`; `PermissionGate.svelte` renders the inline approve/deny (and four-scope) card.

### Storage keys (settings KV)

- `project:${projectId}:tool_permission_mode` — the per-project mode.
- Always-allow grant rows + the `user:${id}:reapprove:lastTtl:${kind}` sticky TTL default (extension PDP side).
- `EZCORP_PERM_FOREVER_TTL_DAYS` — env override for the forever-grant TTL (default 90 days).

## Key files

- `src/auth/middleware.ts` — `requireAuth`, `requireRole(admin)`, `requireTeamRole(viewer|editor|owner)` (admins bypass team checks).
- `src/auth/types.ts` — `AuthUser` / `JWTPayload`; the `role: "admin" | "member"` principal shape.
- `src/auth/api-key.ts` — `ApiKeyScope` union + `API_KEY_SCOPES` (`read`/`chat`/`extensions`/`admin`).
- `web/src/lib/server/security/api-keys.ts` — `requireScope` (no-op for cookie auth), `requireAdmin` (role-based), `verifyApiKey`.
- `web/src/lib/server/security/bearer-auth.ts` — API-key principals minted with `role: "member"`.
- `src/runtime/tools/permissions.ts` — `PermissionMode`, `DEFAULT_PERMISSION_MODE = "yolo"`, `AUTO_APPROVE` matrix, `needsApproval`, `getPermissionMode`, built-in `createPermissionGate` + extension `createExtensionPermissionGate`, `resolvePermission`, the `pendingApprovals` Map + sec-H2 `getPendingApprovalConversation`.
- `src/runtime/tools/types.ts` — `ToolCategory = "read" | "write" | "execute" | "ez"`.
- `src/routes/tool-permission.ts` — `handleToolPermission` (ownership + `forever`-admin gate), `handleGetPermissionMode`, `handleSetPermissionMode`.
- `src/runtime/stream-chat/setup-tools.ts` — wires `needsApproval` + the gate around each built-in tool's `execute`; the `permissionMode` resolution order and `tool:permission_mode_change` subscription.
- `src/extensions/permission-engine.ts` — the PDP: `authorize` (allow/deny/prompt), `resolvePrompt`, sensitive-cap gate, bundled-ceiling auto-allow, audit rows.
- `src/extensions/tool-executor.ts` — consumes `createExtensionPermissionGate`; emits the extension `tool:permission_request` to the originating user only.
- `web/src/routes/api/projects/[id]/tool-permission-mode/+server.ts` — GET/PUT mode endpoints.
- `web/src/routes/api/tool-calls/[id]/permission/+server.ts` — POST gate resolution (requireAuth + requireScope("chat")).
- `web/src/lib/permission-mode.ts` — pure mode→label/color/description helpers + frontend `DEFAULT_PERMISSION_MODE`.
- `web/src/lib/components/tool-cards/PermissionGate.svelte` — inline approve/deny card; `isAdmin`-gated "Allow forever".
- `src/runtime/tools/validate.ts` — `validatePath`: **lexical** project-dir containment for built-in file tools (no realpath).
- `src/runtime/fs/scan-fs.ts` — `realpathInsideRoot`: realpath-based containment for the `@`-mention FS scanner (the asymmetry — see gotchas).
- `src/db/schema.ts` — `users.role` (`admin`/`member`), `team_members.role` (`owner`/`editor`/`viewer`).

## Features it touches

- [[permissions-and-grants]] — the extension-capability PDP, four-scope always-allow modal, and grant lifecycle live there; permission modes only gate built-in tools.
- [[authentication]] — supplies the `AuthUser` principal (`role`) that every RBAC check reads.
- [[api-security]] — `requireScope`/`requireAdmin` are the API-key authorization axis; RBAC is enforced per-route at the HTTP boundary.
- [[developer-api-keys]] — API keys carry `ApiKeyScope`s and are minted with `role: "member"`, so they can never satisfy a `requireRole("admin")` gate.
- [[teams]] — `requireTeamRole` (owner/editor/viewer) gates team resources; instance admins bypass it.
- [[builtin-file-tools]] — the read/write/execute categories that permission modes auto-approve or gate; `validatePath` containment.
- [[streaming-runtime]] — permission gating wraps each built-in tool's `execute` during the streamed turn; the gate blocks the tool, not the stream.
- [[runs-lifecycle]] — a pending gate is a legitimate user-wait the watchdog must not kill; mode can change mid-run via the bus.
- [[admin-surfaces]] — admin-only pages (audit, moderation, dashboard, settings/admin) all sit behind `requireRole("admin")`.
- [[audit-and-observability]] — every PDP decision writes an `auditLog` row; the audit API is admin-gated.
- [[marketplace]] — flags/delete/install are admin-gated via `requireRole("admin")`.
- [[sandbox-and-isolation]] — extension sensitive-cap prompts (`shell`/`fs.write`) complement OS-level jail isolation.
- [[projects]] — permission mode is a per-project setting (`project:${id}:tool_permission_mode`).

## Related docs

- [The four-scope permission modal](../../permissions/four-scope-modal.md) — the extension always-allow scope picker (session/conversation/project/forever) and why "Always allow" is admin-gated.
- [Capability expiry](../../permissions/capability-expiry.md) — TTL aging of project/forever grants + the expired-grants banner.
- [Audit drill-down](../../permissions/audit-drilldown.md) — the per-extension audit + grants view.
- [Authentication](authentication.md) — how the `AuthUser` principal (and its role) is established.

## Notes & gotchas

- **`yolo` default is intentional and permanent.** `DEFAULT_PERMISSION_MODE = "yolo"` means a fresh project auto-approves read **and** write **and** execute built-in tools. This is a locked product decision — do not file it as a security finding.
- **`requireScope` is a no-op for cookie auth.** `requireScope(locals, "admin")` *alone* allows any cookie-authed member through (because `locals.apiKeyScopes` is undefined). Admin routes must also call `requireRole("admin")` / `requireAdmin`. The route-contract meta-test enforces the pairing.
- **`requireRole` throws a raw `Response`.** SvelteKit doesn't auto-catch it, so an uncaught `requireRole` becomes a `500`. Routes wanting a clean `403` wrap it (`requireAdminOr403` pattern in `web/src/routes/api/extensions/[id]/+server.ts`).
- **Instance admins bypass `requireTeamRole`.** An `admin` is treated as having owner-level access to every team regardless of membership.
- **Two distinct gate mechanisms share one Map.** `createPermissionGate` (built-in, resolves `void`) and `createExtensionPermissionGate` (extension, resolves a structured `ApprovalResolution` with a scope) both live in `pendingApprovals` keyed by `toolCallId`/`promptId`. `resolvePermission` branches on the `extension` marker; built-in gates ignore `scope`/`ttlOverrideMs`.
- **Built-in gate ownership (sec-H2).** `POST /api/tool-calls/:id/permission` looks up the pending gate's owning conversation and refuses (`403`) unless the caller owns it or is an admin — fail-closed if the conversation can't load. The `forever` scope is *additionally* admin-gated server-side even though the button is client-side `isAdmin`-hidden.
- **Lexical vs. realpath path containment asymmetry.** Built-in file tools use `validatePath` (`src/runtime/tools/validate.ts`), which is purely **lexical** (`resolve` + `relative` string checks, no `realpath`). The `@`-mention FS scanner uses `realpathInsideRoot` (`src/runtime/fs/scan-fs.ts`), which resolves symlinks. A symlink inside the project that points outside it is filtered by the scanner but is **not** caught by `validatePath` — the built-in file tools' containment is symlink-naive.
- **Permission modes ≠ extension capabilities.** Permission modes only govern built-in `read`/`write`/`execute`/`ez` tools. Extension tools are gated solely by the PDP (`permission-engine.ts`); changing the project's permission mode has no effect on extension capability prompts.
- **Two role taxonomies, one column name.** `users.role` is `admin|member`; `team_members.role` is `owner|editor|viewer`; `messages.role` is the chat role — all three are `text("role")` columns. Don't conflate them.
