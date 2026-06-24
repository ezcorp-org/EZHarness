# Modes

> _Preset conversation "flavors": a system-prompt instruction (prepend / append / replace) plus a tool-access scope (attached extensions or a legacy `all`/`read-only`/`none` restriction), selected per-conversation from the composer's Mode dropdown and applied server-side before every turn._

## Intent

A Mode is a reusable behavioral preset attached to a conversation. Picking a mode changes two things the runtime actually enforces: the **system prompt** (a stored instruction layered onto the base prompt) and the **tool surface** the LLM can see (narrowed to the union of attached extensions' tools, or a coarse `read-only`/`none` restriction). Three modes are built in and system-supplied (`Plan`, `Code Review`, and `Ez`, the in-app concierge); users author the rest. Modes exist so a user can flip a chat into "Debug", "Read-only research", "Writing", etc. without re-typing a system prompt or hand-toggling tools each time.

## How it works

A mode is a row in the `modes` table (`src/db/schema.ts`). Its fields split into three groups: identity (`name`, `slug`, `icon`, `description`, `builtin`, `userId`), **system-prompt** (`systemPromptInstruction`, `instructionPosition`), and **tool scope** (`toolRestriction`, `allowedTools`, `extensionIds`, `extensionTools`). A conversation references one via `conversations.modeId` (`on delete set null`).

Selecting a mode is purely a `modeId` write — nothing about the mode is copied onto the conversation:

1. **Pick** — the composer's `ModeSelector.svelte` (rendered inside `ChatInput.svelte`) emits `onselect`, which `ChatInput` forwards as its own `onmodechange` prop, wired to `handleModeChange` in the chat page (`web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte`). That sets the local `selectedMode` and fires a fire-and-forget `PUT /api/conversations/[id]` with `{ modeId }`.
2. **First-paint inheritance** — on conversation load the page has no `selectedMode` until a user pick. `decideInheritedMode` (`web/src/lib/chat/page-handlers/inherit-mode.ts`) resolves the conversation's persisted `modeId` against the fetched mode list exactly once per conversation id, so the composer's Tools popover reflects the saved mode without clobbering an explicit mid-session pick.
3. **Send** — `POST /api/conversations/[id]/messages` reads `conv.modeId` and threads it into `executor.streamChat(..., { modeId })` (`web/src/routes/api/conversations/[id]/messages/+server.ts`). The body-supplied `provider`/`model`/`thinkingLevel` come from the composer, **not** from the mode.

The runtime then applies the mode in two independent places:

- **System prompt** — `resolveSystemPrompt(conversationId, projectId, modeId)` in `src/db/queries/conversations.ts` (called from `src/runtime/stream-chat/load-history.ts`). It fetches the base prompt (conversation `systemPrompt` → project `systemPrompt` setting → global `systemPrompt` setting) and the mode in parallel, then layers `mode.systemPromptInstruction` by `instructionPosition`: `replace` returns the instruction alone, `append` joins it after the base (`\n\n`), and the default `prepend` joins it before. No instruction = the base prompt passes through unchanged.
- **Tool scope** — `executor.streamChat` (`src/runtime/executor.ts`) loads the mode via `getMode(modeId)` and calls `computeModeToolScope(mode, conv.extensionTools, ExtensionRegistry)` (`src/runtime/tools/mode-tool-scope.ts`), feeding the result into `applyToolFilters`. The scope decision is:
  - **`mode.extensionIds` non-empty** → the mode declares its surface via attached extensions. The scope is an **allowlist** of the union of those extensions' namespaced tool names, optionally narrowed per-extension by `mode.extensionTools[extId]` (absent key = all of that extension's tools, empty array = extension off, non-empty = subset). This supersedes any legacy `toolRestriction` on the mode.
  - **otherwise** → the legacy `mode.toolRestriction` (`all`/`read-only`/`none`/`allowlist` + `allowedTools`) governs. This path is what the built-in `Ez` mode uses.
  - **per-conversation toggles** narrow further on top of either path. The conversation's `extensionTools` map can only **remove** tools (narrow-only — a tool outside the mode's allowlist can never be re-added), and its exclusions ride the `forceDeniedTools` layer, the one layer in `applyToolFilters` allowed to switch off even orchestration tools (e.g. ask-user) for a single chat.
- The **same** `computeModeToolScope` + `applyToolFilters` pair powers `GET /api/tools` (`web/src/routes/api/tools/+server.ts`), so the chat header's tool-count badge can never advertise a surface different from what the runtime grants.

The built-in `Ez` mode is seeded once by the Phase-48 migration block in `src/db/migrate.ts` (`INSERT INTO modes (...) ... 'builtin-ez' ... ON CONFLICT (slug) DO NOTHING`) with `instruction_position = 'replace'`, `tool_restriction = 'allowlist'`, a fixed `allowed_tools` array, and `builtin = true`. It is one of **three** built-in modes (alongside `Plan` and `Code Review`, both seeded earlier in the same file as `read-only` modes); everything else is user-authored.

## Usage

### REST API (`web/src/routes/api/modes/`)

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/modes` | `read` | List built-in modes + the caller's own modes (`listModes(user.id)` → `builtin OR userId = me`). |
| `POST /api/modes` | `chat` | Create a custom mode. Validated by `createModeSchema`; `userId` stamped to the caller; `builtin` forced `false`. 201. |
| `GET /api/modes/[id]` | `read` | Fetch one by id. 404 if missing. |
| `PUT /api/modes/[id]` | `chat` | Update. **403** if `builtin`; **404** if owned by another user. |
| `DELETE /api/modes/[id]` | `chat` | Delete. **403** if `builtin`; **404** if owned by another user. |

`GET /api/tools?modeId=…&conversationId=…` returns the tool surface a mode + conversation would actually grant — a **present** `modeId` param is authoritative over the conversation's persisted `modeId` (so a just-picked mode reflects before the fire-and-forget PUT lands; `modeId=` empty means "cleared").

### UI entry points

- **Composer Mode dropdown** — `web/src/lib/components/ModeSelector.svelte`, rendered in `ChatInput.svelte`. "Default" (null) means no mode / full capabilities. The dropdown can be `disabled` (rendered inert) on surfaces that pin a mode server-side (the Ez panel). `read-only` / `no tools` chips surface a mode's legacy `toolRestriction`.
- **Create / edit / view** — `web/src/lib/components/ModeFormModal.svelte` (name, slug auto-derived from name, icon, description, system-prompt instruction, instruction position, and a "Tools & Extensions" attach picker that writes `extensionIds` + per-extension `extensionTools`). Built-in modes open read-only (the Edit button is disabled).
- **Settings management** — `web/src/lib/components/settings/ModesSection.svelte` at `/settings/personalization#modes` lists all modes, opens the modal, and deletes custom ones. The "Manage" / "New mode" links in the composer dropdown point here.

### SDK / client helpers (`web/src/lib/api.ts`)

`fetchModes()`, `createMode(data)`, `updateMode(id, data)`, `deleteMode(id)` wrap the routes above; `updateConversation(id, { modeId })` persists the per-conversation selection.

## Key files

- `src/db/schema.ts` — `modes` table (system-prompt + tool-scope columns) and `conversations.modeId` FK.
- `src/db/queries/modes.ts` — `listModes` (builtin OR own), `getMode`, `getModeBySlug`, `createMode`, `updateMode`, `deleteMode`. `updateMode`/`deleteMode` no-op on built-in rows.
- `src/db/migrate.ts` — earlier "Custom Modes" block seeds the `builtin-plan` + `builtin-code-review` built-in modes; the Phase-48 block adds schema deltas + the `builtin-ez` mode seed (all idempotent, `ON CONFLICT (slug) DO NOTHING`).
- `src/db/queries/conversations.ts` — `resolveSystemPrompt(conversationId, projectId, modeId)`: base-prompt resolution + `instructionPosition` layering.
- `src/runtime/tools/mode-tool-scope.ts` — `computeModeToolScope`: allowlist-from-extensions, per-extension subset, per-conversation narrow-only denials. Shared by the executor and `/api/tools`.
- `src/runtime/executor.ts` — `streamChat` loads the mode and applies `computeModeToolScope` → `applyToolFilters` before each turn.
- `src/runtime/stream-chat/load-history.ts` — calls `resolveSystemPrompt(..., modeId)` to build the system prompt.
- `web/src/routes/api/modes/+server.ts` — list (GET) + create (POST).
- `web/src/routes/api/modes/[id]/+server.ts` — GET/PUT/DELETE one; built-in 403 + cross-owner 404 guards.
- `web/src/routes/api/modes/schema.ts` — `createModeSchema` / `updateModeSchema` (Zod). Note: only exposes `toolRestriction ∈ {all, read-only, none}` and does **not** expose `allowedTools`.
- `web/src/routes/api/tools/+server.ts` — tool-listing endpoint that reuses `computeModeToolScope` for the header badge.
- `web/src/lib/components/ModeSelector.svelte` — composer Mode dropdown.
- `web/src/lib/components/ModeFormModal.svelte` — create / edit / view form + extension attach picker.
- `web/src/lib/components/settings/ModesSection.svelte` — settings management list.
- `web/src/lib/chat/page-handlers/inherit-mode.ts` — `decideInheritedMode`: once-per-conversation first-paint mode inheritance.
- `web/src/routes/(app)/project/[id]/chat/[convId]/+page.svelte` — `handleModeChange`: persists `modeId` only.
- `web/src/lib/api.ts` — `Mode` type + `fetchModes`/`createMode`/`updateMode`/`deleteMode`.
- `web/e2e/modes.spec.ts`, `web/e2e/modes-extensions.spec.ts` — Playwright coverage.

## Features it touches

- [[conversations]] — a mode is selected per-conversation via `conversations.modeId`; the send pipeline reads it. The `ez` mode is locked to `ez`-kind conversations.
- [[streaming-runtime]] — `executor.streamChat` is where mode tool-scoping and the resolved system prompt are applied before each turn.
- [[ez-concierge-and-actions]] — the built-in `Ez` mode (`builtin-ez`, `replace` + `allowlist`) is the concierge persona; its conversation pins the mode and disables the dropdown.
- [[builtin-file-tools]] — `read-only` / `allowlist` restrictions filter which file (and other built-in) tools the LLM can call.
- [[permissions-and-grants]] — extension tool subsets attached to a mode bound the callable surface; per-call permission prompts still apply on top.
- [[bundled-catalog]] — `mode.extensionIds` reference extensions the registry resolves into tool names for the allowlist.
- [[agents]] — `agentConfigs` carry their own attached-extension tool scoping; mode scope is the conversation-level analog.
- [[teams]] — team member overrides can carry a `modeId`; invocation-level `toolRestriction`/`allowedTools` (member/team scope) layer on **after** mode scope in `streamChat`.
- [[providers-and-models]] — a mode stores `preferredModel`/`preferredProvider` columns, but the main chat composer does not apply them (see gotchas).
- [[context-compaction]] — the resolved system prompt (with the mode instruction layered in) is part of the per-turn input window.
- [[settings]] — custom modes are managed under `/settings/personalization#modes`.

## Related docs

None yet — this is the primary reference. (See [providers-and-models](../chat/providers-and-models.md) for model/provider selection, which modes only weakly relate to, and [conversations](../chat/conversations.md) for how `modeId` rides on a conversation.)

## Notes & gotchas

- **Stored model/provider/temperature preferences are mostly inert.** The `modes` table and `Mode` type carry `preferredModel`, `preferredProvider`, `temperature`, and `preferredThinkingLevel`, and `createModeSchema` validates them — but the runtime never reads `preferredModel`/`preferredProvider`/`temperature`. `resolveSystemPrompt` and `computeModeToolScope` only consume the system-prompt and tool-scope fields; the provider/model/thinking level handed to `streamChat` come from the composer's own state. The **only** consumer of `preferredThinkingLevel` is `MetaAgentChat.svelte` (the Ez meta-agent chat), which seeds the thinking-level on mode-change if the model supports reasoning. In the main project chat, picking a mode does **not** switch the model, provider, temperature, or thinking level. Treat these columns as forward-looking/partially-wired, not as enforced behavior.
- **Schema vs. column drift on tool scope.** The DB column and the executor support `toolRestriction = 'allowlist'` + `allowedTools`, but `createModeSchema`/`updateModeSchema` (the public API) only accept `toolRestriction ∈ {all, read-only, none}` and don't expose `allowedTools`. So user-authored modes cannot set a bare `allowlist` over the API — that path is reserved for the seeded `builtin-ez` mode (set directly via SQL). User-authored allowlisting is expressed instead through `extensionIds` + `extensionTools`.
- **Built-in modes are immutable by construction.** `updateMode`/`deleteMode` short-circuit to `undefined`/`false` for `builtin = true` rows in the query layer, and the `[id]` route returns **403** before even reaching them. `listModes` always includes built-ins regardless of `userId`.
- **`listModes` is the only ownership filter.** `GET /api/modes/[id]` (single fetch) has **no** owner check — any authenticated user with `read` scope can fetch any mode by id, including another user's custom mode. Mutating routes (`PUT`/`DELETE`) do enforce `existing.userId !== user.id → 404`, but the read-by-id does not. This leaks a mode's system-prompt instruction + tool config across tenants if the id is known.
- **Mode selection is a fire-and-forget PUT.** `handleModeChange` does not await the `updateConversation` call; on failure the local `selectedMode` and the persisted `conversations.modeId` can diverge until the next load. The composer compensates by sending an authoritative `modeId` param to `/api/tools`.
- **`ez` mode is locked to `ez`-kind conversations.** A regular conversation cannot adopt `slug='ez'` (the create/update conversation routes return 403), and the Ez panel renders `ModeSelector` `disabled`. The concierge harness is the sole producer of `ez`-kind conversations. (See [[conversations]] / [[ez-concierge-and-actions]].)
- **A missing/deleted `modeId` silently degrades to Default.** `decideInheritedMode` resolves a `modeId` that matches no fetched mode to `null` (Default) on purpose, and the executor wraps mode lookup in a `try/catch` that keeps all tools on failure — a mode lookup error is non-fatal, never a hard stop.
