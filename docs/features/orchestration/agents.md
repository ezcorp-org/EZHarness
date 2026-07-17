# Agents (Agent Configs)

> _Reusable, persisted LLM templates — a name, system prompt, model/provider, sampling knobs, capabilities, an optional input schema, and a set of attached extensions (with per-extension tool narrowing) — that can be `![agent:Name]`-mentioned to spin up a scoped helper inside any chat._

## Intent

An **agent config** is the EZCorp unit of "a configured LLM persona." It bundles a system prompt with a model choice, temperature/maxTokens, an output format, an optional structured input schema, and a curated tool surface (attached extensions, optionally narrowed to specific tools). Agents are stored in the `agent_configs` table, exposed over a REST CRUD surface, and registered into the runtime executor's in-memory agent map so they can be invoked by name. They are the building block that `![team:…]` (teams), `references.members` (sub-agents), task assignments, and the Daily Briefing all compose on top of — but on their own an agent is just a callable template a user can `![agent:Name]`-mention into a conversation.

## How it works

### Data model (`agent_configs`)

A row (`src/db/schema.ts` → `agentConfigs`) carries:

- **Identity / persona** — `name` (unique), `description`, `prompt` (the system prompt), `category` (free text; the literal `"team"` flags a team config).
- **Model binding** — `provider` + `model`. Both default to `CURRENT_MODEL_SENTINEL` (`"__current__"`, from `src/types.ts`), meaning "inherit whatever model the calling turn is using" — resolved against the parent conversation at invocation time (`src/runtime/start-assignment.ts`). `temperature` (real) + `maxTokens` (int) are nullable sampling overrides.
- **Capabilities / IO** — `capabilities` (jsonb `string[]`, default `["llm"]`), `outputFormat` (`"text"` | `"json"`), `inputSchema` (jsonb `Record<string, unknown>` — a field-builder schema rendered by the form).
- **Tool surface** — `extensions` (jsonb `string[]` of attached extension ids) and `extensionTools` (jsonb `Record<extId, string[]>` — the **per-extension tool narrowing**; absent key or empty array ⇒ all of that extension's tools, a non-empty array ⇒ only those).
- **Composition** — `references` (jsonb: `{ agents, extensions, members?, autoSpinUp?, teamToolScope? }`). `references.agents` drives the cycle check; `references.members` is the team roster.
- **Ownership** — `userId` (FK to `users`, `ON DELETE SET NULL`). **`userId IS NULL` ⇒ system-owned**: readable by everyone, mutable/deletable by admins only.

### CRUD → executor registration

The REST handlers (`web/src/routes/api/agent-configs/…`) keep the DB and the executor's live agent map in sync:

1. **Create** (`POST`) — validate with `createAgentConfigSchema`, call `createAgentConfig` (which defaults model/provider to the sentinel, normalizes `references`, and runs `validateReferences`), then build an `AgentDefinition` via `configToAgent(...)` and `executor.registerAgent(def)`.
2. **Update** (`PUT`) — re-validate, `updateAgentConfig`, then **re-register** the rebuilt `AgentDefinition` under the (possibly new) name.
3. **Delete** (`DELETE`) — `deleteAgentConfig`, then `executor.unregisterAgent(config.name)`.

`configToAgent` (`src/runtime/config-to-agent.ts`) wraps the config into an `AgentDefinition` whose `execute(ctx)` flattens `ctx.input` into `key: value` lines, calls `ctx.llm.complete(...)` with the config's `system`/`provider`/`model`/`temperature`/`maxTokens`, and — when `outputFormat === "json"` — `JSON.parse`s the response (returning a failure result if it doesn't parse). The same module also exports `composeAgent`, a depth-limited variant (`DEFAULT_MAX_DEPTH = 3`) used for nested composition.

### Boot load

On startup the executor is primed with **YAML/file agents plus DB agents**: `src/runtime/loader.ts` calls `loadDbAgents()` (`src/db/queries/agent-configs.ts`) when `includeDb` is set, which maps every `agent_configs` row through `configToAgent` into the executor's `Map<name, AgentDefinition>`. The CRUD register/unregister calls keep that map current without a restart.

### `![agent:Name]` resolution + auto-wiring

When a user types `![agent:Name]` in the composer, two things happen at run setup (`src/runtime/stream-chat/setup-tools.ts`, via `src/runtime/mention-wiring.ts`):

- **Extension auto-wire** (`wireMentionedExtensions`) — for each mentioned agent, its `extensions` ids are added to the conversation's extension set (so the agent's attached tools become available this turn). This is parsed from the **literal** typed text only — expanded command/feature bodies are never re-parsed.
- **Orchestration resolve** (`resolveMentionedAgents` / `resolveMentionedTeams`) — mentioned agents (and team members) are collected into `allAvailableAgents` and handed to the bundled `orchestration` extension's `invoke_agent` tool surface (`orchestration-host`), gated by `MAX_ORCHESTRATION_DEPTH = 3` and requiring `options.projectId`. Sub-conversations (depth > 0) do **not** re-expand `![team:…]` to avoid exponential auto-spin-up.

### Per-tool selection (effective tool surface)

The effective tool surface for an agent run is computed at the agent's execution chokepoint by `ExtensionRegistry.getToolsForAgent(agentConfigId)` (`src/extensions/registry.ts`), consumed in `setup-tools.ts` step 2b:

- Read the agent's `extensions` (attached ids) and `extensionTools` (per-extension narrowing map).
- For each attached extension, take its registered tools; if `extensionTools[extId]` is a **non-empty** array, keep only tools whose `name` **or** `originalName` is in that array (matched against both the namespaced and unnamespaced name); otherwise keep **all** of them.
- Absent key / empty array ⇒ all tools (including tools added to that extension later) — this is why `NULL` on legacy rows preserves the old all-tools behavior.

### Reference validation (cycle guard)

`createAgentConfig` / `updateAgentConfig` fold every `references.members[*].agentConfigId` (recursively, via `flattenMemberIds`) into `references.agents`, then — if any agent refs exist — call `validateReferences`, which builds the full ref graph and runs `detectCycle` (`src/runtime/dag-validator.ts`). A cycle throws `AgentValidationError` (HTTP 400) listing the offending names. Team member nesting is independently capped at 3 levels by the create schema.

### Sharing

`listAgentConfigs(userId)` returns the user's owned agents **plus** agents shared with them (`getSharedAgentsForUser`, deduped against owned ids, flagged `shared`/`sharedBy`). Sharing lives in a separate `agent_shares` surface (see [[teams]]) — `agent-configs.ts` only reads it.

## Usage

### REST API (`web/src/routes/api/agent-configs/`)

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/agent-configs` | `read` | List the caller's owned + shared agent configs (`listAgentConfigs(user.id)`). |
| `POST /api/agent-configs` | `chat` | Create. Body validated by `createAgentConfigSchema`; stamps `userId = user.id`; registers with the executor. **201.** |
| `GET /api/agent-configs/[id]` | `read` | Fetch one. 404 if a user-owned config belongs to someone else; system (`userId = null`) configs are readable by all. |
| `PUT /api/agent-configs/[id]` | `chat` | Update (`.passthrough()` schema forwards `references`/`capabilities`/`inputSchema`/`extensions`/`extensionTools` to the DB layer). **System configs → admin-only (403 for non-admins).** Re-registers with the executor. |
| `DELETE /api/agent-configs/[id]` | `chat` | Delete + `unregisterAgent`. **System configs → admin-only.** |

Every handler runs `requireScope(...)` then `requireAuth(...)`. Non-admin access to a system config's mutate/delete paths returns **403** (via `requireAdminOr403`); access to another user's *owned* config returns **404** (existence not leaked).

### UI entry points

- **`/agents`** (`web/src/routes/(app)/agents/+page.svelte`) — the agent list/management surface.
- **`/agents/new`** — create flow; `?type=team` switches to the team builder, `?prefill=<draftId>` hydrates from an Ez-generated draft.
- **`/agents/[name]`** — edit an existing agent.
- **`AgentConfigForm.svelte`** (`web/src/lib/components/`) — the shared form: name, description, system prompt, output format, model/provider picker (`ModelSearchPicker`, with a "reset to current chat model" → sentinel), temperature, maxTokens, category, the dynamic **input-fields** builder, and the **Tools & Extensions** section (`ExtensionSearchPicker` / `ExtensionAttachPicker` + `ExtensionToolSelector` for per-extension narrowing).

### In-chat invocation

Type `![agent:Name]` in the composer (the `!` sigil; see [[mention-grammar]]). It resolves the config, auto-wires its attached extensions into the conversation, and exposes it to the turn's `invoke_agent` orchestration surface.

## Key files

- `web/src/routes/api/agent-configs/+server.ts` — GET (list) + POST (create); validate → `createAgentConfig` → `configToAgent` → `registerAgent`.
- `web/src/routes/api/agent-configs/[id]/+server.ts` — GET/PUT/DELETE one; `requireAdminOr403` gate for system (`userId = null`) configs; re-register / unregister.
- `web/src/routes/api/agent-configs/schema.ts` — `createAgentConfigSchema` (incl. `extensions`, `extensionTools`, `references.members`, `teamToolScope`, 3-level nesting refine).
- `src/db/queries/agent-configs.ts` — `createAgentConfig`, `updateAgentConfig`, `deleteAgentConfig`, `getAgentConfig(sByIds/ByNames)`, `listAgentConfigs`, `loadDbAgents`, `validateReferences`, `flattenMemberIds`, `AgentValidationError`, `deleteAgentConfigsByNameExceptId`.
- `src/db/schema.ts` — `agentConfigs` table (`extensions`, `extensionTools`, `references`, `userId`).
- `src/runtime/config-to-agent.ts` — `configToAgent` (config → `AgentDefinition.execute`) + depth-limited `composeAgent`.
- `src/runtime/mention-wiring.ts` — `resolveMentionedAgents`, `resolveMentionedTeams`, `wireMentionedExtensions` (auto-wire attached extensions from an `![agent:…]` mention).
- `src/runtime/stream-chat/setup-tools.ts` — per-turn wiring: agent tools via `getToolsForAgent` (step 2b) + multi-agent orchestration resolution (step 2d).
- `src/extensions/registry.ts` — `getToolsForAgent(agentConfigId)`: applies the `extensionTools` per-extension narrowing.
- `src/runtime/dag-validator.ts` — `detectCycle` used by `validateReferences`.
- `src/runtime/loader.ts` — boot: merges `loadDbAgents()` into the executor's agent map.
- `src/db/queries/agent-shares.ts` — `getSharedAgentsForUser` (sharing read folded into `listAgentConfigs`).
- `web/src/lib/components/AgentConfigForm.svelte` — the create/edit form (model picker, input-schema builder, extension attach + per-tool selector).

## Features it touches

- [[teams]] — a team is an agent config with `category="team"` + `references.members` + `teamToolScope`; teams reuse the same table, schema, and CRUD route.
- [[workflows]] — multi-step agent chaining (agent / transform / gate steps + loops); sibling `workflow_definitions` table.
- [[mention-grammar]] — `![agent:Name]` / `![team:Name]` are the `!`-sigil tokens that resolve to these configs.
- [[conversations]] — `agentConfigId` binds a (sub-)conversation to an agent; `@agent` mentions spawn sub-conversations.
- [[runs-lifecycle]] — invoked agents execute as runs under the executor.
- [[bundled-catalog]] — the `orchestration` and `scratchpad` extensions are auto-wired around agent invocation.
- [[permissions-and-grants]] — an agent's effective tool surface is the attached extensions narrowed by `extensionTools`, then subject to per-tool permission gates.
- [[providers-and-models]] — `provider`/`model` (or the `__current__` sentinel) selects the LLM; the form's `ModelSearchPicker` drives it.
- [[daily-briefing]] — ships a system-owned (`userId = null`) agent config minted at boot.
- [[marketplace]] — agent configs can be imported/installed from the marketplace.
- [[rbac-and-permission-modes]] — system-owned configs are admin-only to mutate/delete.
- [[ez-concierge-and-actions]] — the Ez agent-author flow prefills `/agents/new` via a draft id.

## Related docs

None yet — this is the primary reference. (See [docs/extensions/data-storage.md](../../extensions/data-storage.md) for where attached extensions store state, and [docs/slash-commands.md](../../slash-commands.md) for the related `/`-sigil expansion.)

## Notes & gotchas

- **System configs are admin-only to mutate.** A `userId IS NULL` row (e.g. the boot-minted Daily Briefing agent) is readable by everyone but only an admin may `PUT`/`DELETE` it — otherwise any member could rewrite the system agent's prompt/capabilities through the `.passthrough()` schema, or delete-and-recreate it by name to adopt it (the `name` column is `UNIQUE`). Non-admin mutate/delete → **403**; cross-user access to *owned* configs → **404** (existence never leaked).
- **`extensionTools` semantics are "narrow, not grant."** It can only *subset* tools from an extension already listed in `extensions`. Absent key / empty array ⇒ all tools (including ones added later). A non-empty array matches against **both** the namespaced `name` and the `originalName`.
- **The model field is a deferred binding.** `provider`/`model` default to `CURRENT_MODEL_SENTINEL` (`"__current__"`), resolved to the *caller's* model at invocation — not stored as a concrete model. "Reset to current chat model" in the form writes the sentinel back.
- **References vs. members.** `references.members[*].agentConfigId` are folded into `references.agents` (recursively) before the cycle check, so a team's member graph is cycle-validated like any other ref. `validateReferences` only runs when there is at least one agent ref; it scans **all** `agent_configs` to build the graph.
- **CRUD type casts are intentional.** The route handlers cast `capabilities`/`inputSchema`/`provider` when calling `configToAgent` because JSONB columns decode wider than the `AgentConfig` shape; the schema + query layer are the real validators (see the inline comments in `+server.ts`).
- **Orchestration is depth-capped.** `![agent:…]` invocation only wires the `invoke_agent` surface at `orchestrationDepth < 3` and only when `projectId` is present; team mentions are not re-expanded in sub-conversations (prevents exponential auto-spin-up).
- **`DEFAULT_PERMISSION_MODE = "yolo"`** governs whether an invoked agent's tool calls prompt — this is an intentional, permanent product decision, not a misconfiguration.
- **Disk-vs-bundled is not the agent surface.** Agent *configs* live in the DB; the *extensions* they attach are a separate population — `BUNDLED_EXTENSIONS` (`src/extensions/bundled.ts`) wires ~24 at boot, while `docs/extensions/examples/` holds ~39 dirs (including example-only + `test-*` fixtures). Don't conflate the two.
