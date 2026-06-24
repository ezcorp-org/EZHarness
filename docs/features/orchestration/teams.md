# Teams & Multi-Agent Orchestration

> _A team is an `agentConfig` (`category="team"`) that, when `![team:Name]`-mentioned, turns the current turn into an orchestrator: it resolves the team's member agents, optionally pre-invokes them, injects a coordinator system prompt, and exposes `invoke_agent` so the LLM can spawn each member as a hierarchical sub-conversation under a shared tool scope._

## Intent

EZCorp lets a user assemble a named group of specialized agents and drive them as one coordinated unit instead of one agent at a time. Mentioning `![team:Name]` in the composer (or assigning a team to a task) makes the active conversation an **orchestrator**: it knows about every member, can delegate to them via the `invoke_agent` tool, fan out in parallel, chain outputs, and synthesize a unified answer. A team also carries a custom **coordination prompt**, optional **per-member overrides** (model/permission/tools), an **auto-spin-up** mode that pre-invokes every member with the user's message, and a **team-level tool scope** that clamps what every member is allowed to touch.

**There are two parallel, unrelated "team" data models — do not conflate them** (see [Notes & gotchas](#notes--gotchas)):

- The **orchestration team** is an `agentConfig` row with `category="team"`; its `references` JSONB holds the member roster, coordination knobs, and tool scope. This is the model the runtime uses.
- The **RBAC team** is the `teams` / `team_members` tables exposed under `/api/teams`. These hold a name + `(owner|editor|viewer)` memberships and `agent_shares`. The runtime orchestration path never reads them.

## How it works

### Data model — the orchestration team

A team is just an `agentConfig` (`src/db/schema.ts` `agentConfigs`) with:

- `category = "team"` — the discriminator (`resolveMentionedTeams` and the UI both filter on it).
- `prompt` — the team's **coordination instructions** (free text describing the workflow).
- `references` JSONB (`{ agents, extensions, members?, autoSpinUp?, teamToolScope? }`):
  - `agents: string[]` — flattened member `agentConfigId`s (the authoritative roster the runtime spins up).
  - `members?: TeamMember[]` — the nested member tree (`{ agentConfigId, overrides?, subAgents? }`, ≤ 3 levels deep, ≤ 20 per level); drives the builder UI and per-member overrides.
  - `autoSpinUp?: boolean` — pre-invoke every member with the user's message before the orchestrator's first turn.
  - `teamToolScope?: { allowedTools?, deniedTools? }` — allow/deny lists applied to every invoked member, overriding their individual tool config.

Member overrides (`TeamMemberOverrides` in `src/types.ts`): `permissionMode`, `toolRestriction`, `modeId`, `allowedTools`, `deniedTools`, `provider`, `model`, `systemPromptAppend`. Model/provider may be the `CURRENT_MODEL_SENTINEL` (`"__current__"`) meaning "inherit the parent conversation's model".

Teams are created/edited through the **agent-configs** API and the `TeamBuilderForm` UI — there is **no** dedicated team-create route in the orchestration path.

### Mention resolution (`src/runtime/mention-wiring.ts`)

`resolveMentionedTeams(messageContent)`:

1. `parseMentions` extracts `team` mentions from the **literal** message text.
2. Round-trip 1: `getAgentConfigsByNames` resolves the names → configs; entries whose `category !== "team"` are dropped, dupes by `config.id` removed.
3. Round-trip 2: `getAgentConfigsByIds` batch-fetches every member id across all mentioned teams.
4. Returns `{ team: { id, name, description, prompt, autoSpinUp, teamToolScope }, members: [{ id, name, description }] }[]`.

### Per-turn wiring (`src/runtime/stream-chat/setup-tools.ts`, block 2d)

On every streamed turn at `depth = options.orchestrationDepth ?? 0` (the whole block is gated by `depth < MAX_ORCHESTRATION_DEPTH` (= 3) **and** a bound `projectId`):

1. **Team mentions are resolved only at `depth === 0`** — sub-agents (depth > 0) deliberately skip `resolveMentionedTeams` so a member echoing `![team:…]` in its task can't trigger exponential recursive re-spin-up.
2. Member agents from mentioned teams are merged into `allAvailableAgents` (deduped by id).
3. If the run was started **as** a team agent (`options.agentConfigId` points at a `category="team"` config), its `references.agents` are auto-wired as members, and `references.members` overrides, `autoSpinUp`, and `teamToolScope` are stashed on the run's scratch fields (`_teamConfig`, `_memberOverrides`, `_subAgentMembers`, `_teamToolScope`).
4. If any agents are available, the bundled **`orchestration` extension** is wired (`ensureOrchestrationWired` → `wireOrchestrationToolsForTurn`, `src/runtime/orchestration-host.ts`). This appends the `invoke_agent` AgentTool with a per-turn `agentConfigId` enum restricted to the available member ids, threading `parentMessageId` / `memberOverrides` / `teamToolScope` / `orchestrationDepth` through `extensionToAgentTool`.
5. The bundled **`scratchpad`** extension is auto-wired (fail-closed on row-exists + enabled + `storage` grant) so members can share intermediate state.
6. `_mentionedAgents` + `_teamConfig` are stashed; `autoSpinUp` sets `_pendingAutoSpinUp`.

### Auto-spin-up + prompt injection (`src/runtime/stream-chat/auto-spin-up.ts`)

After tools load:

- If `_pendingAutoSpinUp` is set, every member's `invoke_agent` is pre-invoked **in parallel** (`Promise.allSettled`) with the raw user message; results (or `[Error: …]`) are collected.
- The orchestrator system prompt is then prepended to `ctx.system`:
  - team run → `buildTeamOrchestratorPrompt(name, prompt, members, autoSpinUpResults?, teamToolScope?)` (`src/runtime/orchestrator-prompt.ts`), which emits `## Team: <name>`, the coordination instructions, a team-tool-scope block (when active), the member list (with per-member override tags suppressed when a team scope is active), any pre-computed member results, and the shared `ORCHESTRATION_PATTERNS`.
  - non-team multi-agent run → `buildOrchestratorPrompt(agents)`.
  - single-agent / no-agent run → `buildTaskTrackingInstructions()` only.

### Spawning a member (`invoke_agent` → `src/runtime/start-assignment.ts`)

When the orchestrator LLM calls `invoke_agent`, the member is launched as a **sub-conversation** (`createSubConversation`, `parentConversationId` = the orchestrator conversation, `userId = null` — unowned), and `executor.streamChat` runs it non-blocking with:

- model/provider resolved through the sentinel chain (override → agent config → parent fallback).
- system prompt = member prompt (+ `systemPromptAppend`) (+ a "Pinned Objective" block when agent-autonomy is enabled).
- **tool scoping:** if a `teamToolScope` is active (either list non-empty) it **wins** over per-member `toolRestriction`/`allowedTools`/`deniedTools` and is forwarded to `streamChat` as `allowedTools`/`deniedTools`; otherwise the member's own overrides apply.
- `orchestrationDepth` forwarded so depth-based recursion limits hold.

`run:complete` / `run:error` / `run:cancel` listeners drive the assignment lifecycle (completed / failed; cancelled runs that were left `running` are marked failed). Optional opt-in **autonomous self-continuation** re-prompts a finished member toward its pinned objective until it emits `<<TASK_DONE>>` / `<<TASK_BLOCKED: …>>` or hits the cycle cap (default 8), gated by the `global:agentAutonomyEnabled` setting.

### Tool-scope enforcement (`src/runtime/tools/filter.ts`)

`applyToolFilters` applies layers in order: `toolRestriction` → `allowedTools` → `deniedTools` → `forceDeniedTools`. **Orchestration tools (`ORCHESTRATION_TOOLS`: `invoke_agent`, `ask-user__ask_user_question`, `scratchpad__*`, the `task_*` family) are always preserved** through every team/mode layer — the only exception is `forceDeniedTools` (the conversation's explicit per-tool composer toggles), which can strip even those. A team's `allowedTools`/`deniedTools` therefore can never remove a member's ability to delegate, coordinate, ask the user, or track tasks.

### Recursion & spawn safety

Two **separate** depth limits guard against runaway recursion — don't conflate them:

- **In-process orchestration depth** — block 2d's entire body is gated by `depth < MAX_ORCHESTRATION_DEPTH` (`MAX_ORCHESTRATION_DEPTH = 3`, `setup-tools.ts`). Past depth 3, no `invoke_agent` tool is wired at all, so an orchestrator chain (orchestrator → member-as-orchestrator → …) can nest at most 3 levels deep within a single streamed run tree.
- **Reverse-RPC spawn depth** — the `ezcorp/spawn-assignment` path (`src/extensions/spawn-assignment-handler.ts`) enforces `MAX_SPAWN_DEPTH = 10` plus a per-conversation `SpawnQuota`, auditing `depth-exceeded` rejections. This caps extension-initiated spawn chains, tracked separately from the orchestration depth above.
- Team resolution is additionally gated to `depth === 0` (above), so a member echoing `![team:…]` can never re-expand the roster.
- The `invoke_agent` enum is restricted to the turn's available member ids, so the LLM can't invoke an arbitrary agent id.

## Usage

### Composer / runtime

- **`![team:Name]`** in the chat composer → the active turn becomes a team orchestrator. The `!` sigil also covers `agent`, `ext`, and `EZ` kinds (see [[mention-grammar]]); team resolution happens server-side in the send → `streamChat` path.
- **Task assignment** — assign a team to a task via `task_plan`'s `assignTo` (accepts an `agentConfigId` or agent/team name) or `task_assign`; the assigned team can be started from the task panel.
- **Auto-spin-up** — set on the team config so every member is pre-invoked with the user's message before the orchestrator's first turn (good for ensemble / vote-style teams).

### Orchestration teams (the runtime model) — agent-configs API

Teams are CRUD'd as agent configs (`category: "team"`, `references` populated):

| Method & path | Scope | Notes |
|---|---|---|
| `GET /api/agent-configs` | `read` | Lists configs; the UI filters `category === "team"` to show teams. |
| `POST /api/agent-configs` | `chat` | Create a team config. Body validated by `createAgentConfigSchema` (members tree ≤ 3 deep / ≤ 20 wide; `teamToolScope`; `autoSpinUp`). |
| `PUT /api/agent-configs/[id]` | `chat` | Edit a team config. |
| `DELETE /api/agent-configs/[id]` | `chat` | Delete. |

UI: `web/src/lib/components/TeamBuilderForm.svelte` (builds the `category:"team"` + `references` payload and emits it via its `onsubmit` callback — the host page `web/src/routes/(app)/agents/new/+page.svelte` / `[name]/+page.svelte` does the actual `createAgentConfig` POST/PUT); team list at `web/src/routes/(app)/agents/+page.svelte` (`teamConfigs = agentConfigs.filter(c => c.category === "team")`).

### RBAC teams (the membership model) — /api/teams

A **separate** surface for named groups + roles (used by sharing/RBAC, **not** the orchestration runtime):

| Method & path | Scope | Auth | Purpose |
|---|---|---|---|
| `GET /api/teams` | `read` | admin → all; else own | List teams (admin sees all via `listTeams`, others get `getUserTeams`). |
| `POST /api/teams` | `admin` | `requireRole("admin")` | Create a team (`{ name }`). 201. |
| `GET /api/teams/[id]` | `read` | `requireTeamRole(…, "viewer")` | Team + members. |
| `PUT /api/teams/[id]` | `admin` | `requireTeamRole(…, "owner")` | Rename. |
| `DELETE /api/teams/[id]` | `admin` | `requireRole("admin")` | Delete (cascades members). |
| `GET /api/teams/[id]/members` | `read` | `requireTeamRole(…, "viewer")` | List members (+ user name/email). |
| `POST /api/teams/[id]/members` | `admin` | `requireTeamRole(…, "owner")` | Add member (`{ userId, role? }`, role ∈ owner/editor/viewer). 201. |
| `DELETE /api/teams/[id]/members` | `admin` | `requireTeamRole(…, "owner")` | Remove member (rejects removing the **last owner**). |

`requireTeamRole` (`src/auth/middleware.ts`) is hierarchical (`viewer < editor < owner`) and instance admins bypass it.

### Settings keys

- `global:agentAutonomyEnabled` (default on) — master kill-switch for goal-pinning + autonomous self-continuation of spawned members (`src/runtime/start-assignment.ts`).

## Key files

- `src/runtime/mention-wiring.ts` — `resolveMentionedTeams` resolves `![team:Name]` → team config + member agents (two batched round trips).
- `src/runtime/stream-chat/setup-tools.ts` — per-turn orchestration wiring (block 2d, gated by `depth < MAX_ORCHESTRATION_DEPTH` = 3): team resolution (depth 0 only), member merge, `references` auto-wire, orchestration + scratchpad tool injection, scratch-field staging.
- `src/runtime/stream-chat/auto-spin-up.ts` — `applyAutoSpinUp`: parallel pre-invocation of members + orchestrator-prompt injection onto `ctx.system`.
- `src/runtime/orchestrator-prompt.ts` — `buildTeamOrchestratorPrompt`, `buildOrchestratorPrompt`, `buildTaskTrackingInstructions`, shared `ORCHESTRATION_PATTERNS`.
- `src/runtime/orchestration-host.ts` — `ensureOrchestrationWired` (wire-on-first-use) + `wireOrchestrationToolsForTurn` (builds the `invoke_agent` AgentTool with a per-turn `agentConfigId` enum + invocation metadata).
- `src/runtime/start-assignment.ts` — spawns/reuses a member's sub-conversation, applies `teamToolScope` over per-member overrides, runs `streamChat`, drives the assignment lifecycle + autonomous continuation.
- `src/runtime/tools/filter.ts` — `applyToolFilters` + `ORCHESTRATION_TOOLS`; the always-preserved-orchestration-tools invariant under any team/mode scope.
- `src/extensions/spawn-assignment-handler.ts` — reverse-RPC spawn path; `MAX_SPAWN_DEPTH = 10`, spawn quota, `teamToolScope` forwarding.
- `src/db/schema.ts` — `agentConfigs` (`category`, `references` JSONB) — the orchestration team; `teams` / `teamMembers` / `agentShares` — the RBAC model.
- `src/types.ts` — `TeamMember`, `TeamMemberOverrides`, `TeamToolScope`, `CURRENT_MODEL_SENTINEL`.
- `web/src/routes/api/teams/+server.ts` — RBAC teams list (GET) / create (POST, admin).
- `web/src/routes/api/teams/[id]/+server.ts` — RBAC team get / rename / delete.
- `web/src/routes/api/teams/[id]/members/+server.ts` — RBAC member list / add / remove (last-owner guard).
- `src/db/queries/teams.ts` — RBAC team/membership queries (`createTeam`, `getTeamMembership`, `getUserTeams`, `addTeamMember`, …).
- `web/src/routes/api/agent-configs/schema.ts` — `createAgentConfigSchema` (team member tree depth/width, `teamToolScope`, `autoSpinUp` validation).
- `web/src/lib/components/TeamBuilderForm.svelte` — team-builder UI; emits the `category:"team"` + `references` payload.
- `web/src/routes/(app)/agents/+page.svelte` — agents/teams list (filters `category === "team"`).

## Features it touches

- [[agents]] — team members are ordinary agent configs; a team is itself an agent config with `category="team"`.
- [[mention-grammar]] — `![team:Name]` is one kind under the `!` sigil; resolution runs on literal typed text only.
- [[conversations]] — each invoked member runs as an unowned (`userId=null`) sub-conversation under the orchestrator's `parentConversationId`.
- [[streaming-runtime]] — orchestration wiring + auto-spin-up happen inside `setupTools` / `applyAutoSpinUp` in the `streamChat` pipeline.
- [[runs-lifecycle]] — member spawns mint run ids; `run:complete`/`run:error`/`run:cancel` drive assignment state and autonomous continuation.
- [[permissions-and-grants]] — `teamToolScope` clamps member tool surfaces via `applyToolFilters`; orchestration tools are always preserved.
- [[rbac-and-permission-modes]] — the `/api/teams` model carries `owner|editor|viewer` roles (`requireTeamRole`); per-member `permissionMode` overrides feed each spawn.
- [[modes]] — members may carry a `modeId` override; mode tool scoping shares the `applyToolFilters` machinery.
- [[providers-and-models]] — per-member `model`/`provider` overrides resolve through `CURRENT_MODEL_SENTINEL` to the parent's model.
- [[ask-user]] — `ask-user__ask_user_question` is an always-preserved orchestration tool for human checkpoints.
- [[sandbox-and-isolation]] — recursive member spawns are capped by the in-process `MAX_ORCHESTRATION_DEPTH` (= 3) and the reverse-RPC `MAX_SPAWN_DEPTH` (= 10) + per-conversation spawn quota.
- [[api-security]] — every team route is gated by `requireScope` + auth/role middleware.

## Related docs

None yet — this is the primary reference. (See `docs/extensions/examples/orchestration/` for the bundled `invoke_agent` extension that now serves the orchestration tool surface, and `docs/extensions/examples/multi-agent-orchestrator/` for the legacy multi-agent example.)

## Notes & gotchas

- **Two unrelated "team" models.** The orchestration team is an `agentConfig` (`category="team"`, `references` JSONB) — this is what the runtime resolves and spawns. The `/api/teams` `teams`/`team_members` tables are a **separate RBAC/sharing model** (name + `owner|editor|viewer` + `agent_shares`) that the orchestration path **never reads**. A user can be an `owner` on a `/api/teams` team and that has zero effect on `![team:Name]` orchestration, and vice-versa. Don't wire one to the other expecting the other to react.
- **Team config is admin-adjacent, but the create route is `chat` scope.** Orchestration teams are created via `POST /api/agent-configs` (`chat` scope + auth), **not** an admin-only route. The RBAC `POST /api/teams` is admin-only — another way the two models diverge.
- **`teamToolScope` beats per-member tool config.** When either `allowedTools` or `deniedTools` is non-empty, the team scope is forwarded to each spawn and **overrides** the member's own `toolRestriction`/`allowedTools`/`deniedTools` (`start-assignment.ts`), and the orchestrator prompt suppresses per-member tool tags to stay honest (`orchestrator-prompt.ts`). It cannot strip orchestration tools, though (`filter.ts`).
- **Orchestration tools are unstrippable by team scope.** `invoke_agent`, `ask-user__ask_user_question`, `scratchpad__*`, and `task_*` survive every team/mode filter layer. Only the conversation's explicit per-tool composer toggles (`forceDeniedTools`) can remove them — a broad team scope cannot.
- **Team mentions are depth-0 only.** A spawned member that echoes `![team:…]` in its task will **not** re-trigger team spin-up (`depth === 0` guard in `setup-tools.ts`); this is a deliberate fix against exponential recursive spawning, on top of the `MAX_SPAWN_DEPTH`/quota caps.
- **Auto-spin-up is fire-everything-once.** With `autoSpinUp` set, every member is invoked in parallel with the raw user message before the orchestrator reasons; member failures degrade to `[Error: …]` strings folded into the prompt, never aborting the turn.
- **Members are unowned sub-conversations.** Server-spawned members get `userId = null`; access is gated by the parent conversation's root-walk ownership (see [[conversations]]), not by any team membership row.
- **Active-run IDOR (OPEN, inherited).** Member runs live in sub-conversations; the cross-tenant `GET`/`POST /api/conversations/[id]/active-run` route still has **no ownership check** (only `requireAuth` + `requireScope`). Any authenticated user can poll/cancel another tenant's live member run. This is a known, still-open finding — do not assume it is fixed.
- **`autoSpinUp`/`teamToolScope` are stored sparsely.** The builder only writes these keys when set; absent keys mean "off" / "no scope". Code paths default `autoSpinUp ?? false` and treat an all-empty `teamToolScope` as inactive.
