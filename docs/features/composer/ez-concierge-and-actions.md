# Ez Concierge & Runtime Actions

> _Two adjacent "Ez" surfaces: `![EZ:name]` runtime-action tokens that fire silently host-side and render a result card (never reaching the LLM), and the Ez concierge — a locked, per-user `ez`-kind conversation whose eight non-mentionable tools propose projects/agents/extensions, summarize, find agents, and see/drive the client via on-demand page context (`read_page` / `fill_form` / `navigate_to`)._

## Intent

EZCorp ships two distinct "Ez" mechanisms that share a sigil and a visual language but are otherwise independent:

1. **Runtime actions** (`![EZ:name]`) are composer tokens that invoke a server-side side-channel — they are stripped from the prompt before the LLM sees them, and an action-only message skips the LLM turn entirely. The result is persisted inline as a card. v1 carries exactly one action (`distill`, the lessons-distiller forwarder), plus a generic `![EZ:<bundled-ext>:<tool>]` dispatch.
2. **The Ez concierge** is an in-app assistant (persona "EZ") that lives in a single, locked `ez`-kind conversation per user. It is *not* an extension — its eight tools (`getEzToolDefs`) need per-user/per-turn runtime context (acting `userId`, conversation id, event bus, picked provider/model) that would leak across project switches if cached, so they are wired by a dedicated host instead of the project-tool path. They are non-mentionable: they only exist inside an Ez-mode turn. One bundled-extension tool rides alongside them: `extension-author__create_extension` is wired per-ez-turn (`wireExtensionAuthorToolsIfEz` in `setup-tools.ts`, fail-soft when the extension is missing/disabled) and allowlisted so EZ can scaffold new extensions on request.

## How it works

### Runtime actions (`![EZ:name]`)

The `EZ` kind is one of four under the `!` sigil (`agent | ext | team | EZ`) in `web/src/lib/mention-logic.ts`. Lifecycle:

1. **Authoring** — the composer popover for `!` surfaces registered actions via `GET /api/mentions/search?type=EZ`, which calls `listEzActions()` (the registry returns only `{name, description}` — never the handler). Bare `!`/`!e`/`!ez` also merges EZ actions into the `!` fallback for discoverability.
2. **Persist raw** — the user message is stored with its `![EZ:…]` tokens intact (history fidelity).
3. **Prompt strip** — `stripEzActionTokens` (in `src/runtime/mention-wiring.ts`) removes every `![EZ:*]` match from the LLM-facing text (consuming one trailing whitespace to avoid double-spaces), returning the cleaned `stripped` text plus the source-order `actions` list. This strip runs in two places: the send pipeline (`messages/+server.ts`) and again in `src/runtime/stream-chat/build-prompt.ts` (FIRST, before slash-command / file / feature / lesson expansion). The strip is **literal** — no recursion, no re-parse of other sigils.
4. **Dispatch** — in `POST /api/conversations/[id]/messages`, after the `/goal` interceptor, each token's name is resolved with `getEzAction(name)`; a hit fires the nullary `handler({conversationId, userId, projectId})` in-process and persists one synthetic `messages` row with `role: "ez-action-result"` (free-text role, no migration) carrying the JSON `EzActionResult` in `content`. Unknown names are silent no-ops.
5. **No-LLM short-circuit** — if `ezStrip.actions.length > 0 && ezStrip.stripped.trim() === ""` the handler returns `{runId: null, ezActionResults}` without calling `executor.streamChat`; a mixed message (action + prose) still streams an assistant turn.
6. **Render** — `ez-action-result` rows render via `web/src/lib/components/EzActionCard.svelte` (variant-keyed styling; a `success` result's `ref: {kind:"lesson", slug}` becomes a deep link).

A **direct dispatch endpoint** also exists: `POST /api/ez-actions/[name]` (`requireAuth + requireScope("read")` + conversation-ownership 404 gate). It anchors the result row under the conversation's current leaf. Name resolution there is two-stage:
- `resolveBundledEzAction(name)` (`src/runtime/ez-actions/resolve-bundled.ts`) — pure, synchronous. Resolves the legacy `"distill"` alias to `lessons-distiller:distill_now`, and any `"<ext>:<tool>"` shape **iff `<ext>` is bundled** (`isBundledExtensionName`, built from `BUNDLED_EXTENSIONS`). User-installed extensions get no `!EZ:` dispatch in v1.4.
- otherwise `getEzAction(name)` against the static registry (which today holds only the `distill` metadata stub).

The registry (`src/runtime/ez-actions/registry.ts`) is code-defined, not user-extensible. The `distill` entry is a **metadata-only forwarder stub**: its handler throws (defense-in-depth) because the route forwarder (`forwardToBundled`) special-cases the distiller envelope (`__ezDistillerOutcome`) and maps it to the rich 11-variant `EzActionResult`. Every other bundled `<ext>:<tool>` lands on a minimal `success | error` card keyed off `result.isError`.

### The Ez concierge (`ez`-kind conversation)

- **Conversation** — `getOrCreateEzConversation(userId)` (`src/db/queries/conversations.ts`) find-or-creates the user's single `ez`-kind row (`projectId: "global"`, `modeId: "builtin-ez"`), with a DB partial unique index `conversations_user_ez_unique` enforcing one per user. The lookup-then-insert race retries the SELECT on collision. "New chat" wipes the message list (`deleteAllMessagesForConversation`) rather than deleting the row, so the panel's SSE subscription and locked mode survive.
- **Mode** — the seeded `builtin-ez` mode (`src/db/migrations/add-ez-mode-and-kind.ts`) has `tool_restriction: 'allowlist'` and `allowed_tools` = the eight Ez tool names + `extension-author__create_extension`, plus the `EZ_PERSONA` system prompt (instruction_position `replace`). The persona presents EZ as the assistant for the entire harness: it CAN see the user's current page on demand (`read_page`), fills forms/navigates on request, works in proposals for mutations, and redirects rather than dead-ends when a request is outside its tools. A migrate.ts step surgically refreshes a stale seeded persona (LIKE-matched on the retired "You CANNOT see their open page" phrase) without clobbering admin-tuned personas.
- **Tool wiring** — `src/runtime/stream-chat/setup-tools.ts` calls `wireEzToolsForTurn` (`src/runtime/ez-tools-host.ts`) **only** for `convRecord.kind === "ez"`. It must push the tool defs into `agentTools` BEFORE the executor's `allowedTools` filter runs, or the allowlist intersection is empty and everything is stripped. The factory is `getEzToolDefs(ctx)` (`src/runtime/tools/ez/index.ts`).
- **The eight tools** (`EZ_TOOL_NAMES`):
  - `propose_create_project` / `propose_create_agent` / `propose_install_extension` — write an `ez_drafts` row (24h TTL) and return `{draftId, openUrl}`. `cardType: "ez-propose"` routes the result to `EzToolResultCard.svelte` — a one-click `<a href>` bridge to the prefilled form (`/new-project?prefill=…`, `/agents/new?prefill=…`, `/marketplace?…`). The tools never mutate state; the destination form's Submit is the real accept.
  - `summarize_conversation` — server-side LLM call (5-min timeout); requires an explicit `conversationId`; threads the user's per-turn provider/model AND the Ez conversation id (credential access-mode scoping) so it matches the surrounding chat. pi-ai reports provider failures as result FIELDS (`stopReason:"error"` + `errorMessage`, empty content) — the tool surfaces those as tool errors and treats empty text as an error, never a blank "success".
  - `find_agents` — in-memory ranked search over the user's accessible agents → deep links.
  - `read_page` / `fill_form` / `navigate_to` — **client-side** (`clientSide: true`): the execute body (shared scaffolding in `tools/ez/client-tool.ts`) emits an `ez:client-tool` event, registers a pending entry in the `ez-client-tool-registry`, and suspends until the Ez panel POSTs the resolution to `/api/conversations/[id]/tool-results`. This is the **on-demand page-context design** that replaced the retired push-per-message `<EzContext>` registry: no per-page instrumentation — `read_page` serializes whatever the user is currently looking at straight off the live DOM (`web/src/lib/ez/page-context.ts`: route, title, headings, a `content` visible-text excerpt of the main region (`<main>`/`[role=main]` preferred; ~3KB cap; chrome/nav/form-control text never contributes — this is what lets Ez describe a chat page, which has no headings or fillable forms), plus discovered forms + fields; the Ez panel's own subtree and `[data-ez-private]` are excluded; `detail:"full"` opts into field values, passwords never emitted; ~8KB cap). `fill_form` fills a form discovered by `read_page` (label/name matching, bubbling `input`/`change` for Svelte `bind:value`, refuses password/file, never submits — the user reviews). `navigate_to` validates the path server-side (relative, no `://`, no `//`, no control chars), `goto`s, then best-effort serializes the destination (identity + a 500-char content glance) into `detail.destination`. An ok-result's `detail` is rendered into the LLM-visible content text as fenced JSON by `panelResultToToolResult`.
- **Draft redemption** — `GET /api/ez/drafts/[id]` and `POST /api/ez/drafts/[id]/consume` (and the client `web/src/lib/ez/api.ts`). `getDraft(id, userId)` / `consumeDraft(id, userId)` are userId-scoped (cross-user reads return undefined) and refuse expired rows. `consumeDraft` is idempotent.

### What is and isn't shared

The two surfaces share the `EzActionResult`/card vocabulary and the `ez-action-result` message role (the `/goal` interceptor reuses the same row convention), but the dispatch paths are entirely separate: actions are nullary side-channels resolved by name; concierge tools are LLM-invoked tools inside an Ez-mode turn.

## Usage

### Runtime actions

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/mentions/search?type=EZ&q=…` | `read` | Popover listing (`{name, description, kind:"EZ"}`). |
| `POST /api/conversations/[id]/messages` | `chat` | Send pipeline — scans `![EZ:*]`, fires handlers, returns `ezActionResults` (+ `runId:null` for action-only). |
| `POST /api/ez-actions/[name]` | `read` | Direct dispatch. Body `{conversationId, projectId?}`; projectId is reconciled to the conversation's actual projectId. Returns `{result, messageId}`. |

- Token: `![EZ:distill]` (legacy alias) or `![EZ:<bundled-ext>:<tool>]`.
- Actions are **nullary** in v1 — the token is a verb, not verb+args. Multi-arg actions are v2.

### Ez concierge

| Method & path | Scope | Purpose |
|---|---|---|
| `GET / POST /api/ez/conversation` | `read` | Find-or-create the user's single Ez conversation (idempotent). |
| `DELETE /api/ez/conversation/messages` | `chat` | "Clear conversation" — wipes messages, keeps the row. |
| `GET /api/ez/drafts/[id]` | (auth) | Fetch a draft (userId-scoped, not expired). |
| `POST /api/ez/drafts/[id]/consume` | (auth) | Mark a draft consumed (idempotent). |
| `POST /api/conversations/[id]/tool-results` | — | Client-side `fill_form` / `navigate_to` resolution POSTed by the panel. |

- **UI entry point** — the floating Ez panel (`web/src/lib/components/ez/EzPanel.svelte`), which calls `getOrCreateEzConversation()` on open and stores the id for the session.
- **Mode lock** — `POST /api/conversations` with `modeId` pointing at `ez` → 403; `PUT /api/conversations/[id]` changing an `ez` conversation's mode → 403. The concierge harness is the sole producer of `ez`-kind rows.
- **Settings** — the persona lives in the `builtin-ez` mode's `system_prompt_instruction`; tuning it is a normal mode update (or direct SQL — `PUT /api/modes/[id]` 403s with "Cannot edit built-in modes" on the seeded `ez` row, and the underlying `updateMode` query at `src/db/queries/modes.ts` also refuses any `builtin = true` row), not a code change.

## Key files

### Runtime actions
- `src/runtime/ez-actions/registry.ts` — code-defined registry; `listEzActions`, `getEzAction`; `distill` metadata-only forwarder stub.
- `src/runtime/ez-actions/types.ts` — `EzAction`, `EzActionContext`, `EzActionResult` (`success`/`decline`/`error`), `EzActionRef`, `EzActionCard`.
- `src/runtime/ez-actions/resolve-bundled.ts` — pure `resolveBundledEzAction` (legacy `distill` alias + bundled-trust `<ext>:<tool>` gate).
- `src/runtime/mention-wiring.ts` — `stripEzActionTokens`, `EZ_ACTION_TOKEN_RE` (the literal LLM-prompt strip).
- `src/runtime/stream-chat/build-prompt.ts` — runs the EZ strip first, before all other mention expansions.
- `web/src/routes/api/ez-actions/[name]/+server.ts` — direct dispatch endpoint + `forwardToBundled` (distiller-envelope + minimal-card mapping).
- `web/src/routes/api/conversations/[id]/messages/+server.ts` — in-pipeline EZ scan/fire/persist + no-LLM short-circuit.
- `web/src/routes/api/mentions/search/+server.ts` — `type=EZ` popover branch + `!` fallback merge.
- `web/src/lib/components/EzActionCard.svelte` — renders `ez-action-result` rows (variant styling, lesson deep link).

### Ez concierge
- `src/runtime/tools/ez/index.ts` — `getEzToolDefs`, `getEzToolMetadata`, `EZ_TOOL_NAMES`, `isEzClientTool`.
- `src/runtime/tools/ez/propose-create-project.ts` / `propose-create-agent.ts` / `propose-install-extension.ts` — draft-and-link tools (`ez-propose` cardType).
- `src/runtime/tools/ez/summarize-conversation.ts` — server-side summarizer (style presets, per-turn model).
- `src/runtime/tools/ez/find-agents.ts` — in-memory ranked agent search.
- `src/runtime/tools/ez/client-tool.ts` — shared client-side scaffolding (`runEzClientTool` suspend/abort/emit, `panelResultToToolResult` detail→text rendering).
- `src/runtime/tools/ez/read-page.ts` / `fill-form.ts` / `navigate-to.ts` — client-side tools (`ez:client-tool` event + suspend/resume).
- `web/src/lib/ez/page-context.ts` — pure DOM serializer + `fillFormFields` (form discovery, masking, exclusions, size cap).
- `src/runtime/ez-tools-host.ts` — `wireEzToolsForTurn`; gated on `kind === "ez"` in `setup-tools.ts`.
- `src/runtime/ez-client-tool-registry.ts` — pending-promise registry for client-side tool round-trips.
- `src/db/queries/conversations.ts` — `getOrCreateEzConversation`, `deleteAllMessagesForConversation`.
- `src/db/queries/ez-drafts.ts` — `createDraft`/`getDraft`/`consumeDraft`/`sweepExpired` (24h TTL, userId-scoped).
- `src/db/migrations/add-ez-mode-and-kind.ts` — seeds `builtin-ez` mode, `conversations.kind`, `ez_drafts`, the unique partial index.
- `web/src/routes/api/ez/conversation/+server.ts` — find-or-create; `/messages/+server.ts` — clear.
- `web/src/routes/api/ez/drafts/[id]/+server.ts` + `[id]/consume/+server.ts` — draft read/consume.
- `web/src/lib/components/ez/EzPanel.svelte` — the floating concierge panel.
- `web/src/lib/components/ez/EzToolResultCard.svelte` — `ez-propose` result card (one-click `<a href>` bridge).
- `web/src/lib/components/tool-cards/ToolCardRouter.svelte` — routes `ez-propose` / `ez-install` cardType → `EzToolResultCard`.
- `web/src/lib/ez/api.ts` — typed client wrappers for the Ez REST surface.

## Features it touches

- [[conversations]] — `![EZ:]` tokens fire in the send pipeline; the `ez`-kind conversation is locked; `ez-action-result` rows live in the message tree.
- [[mention-grammar]] — `EZ` is the fourth kind under the `!` sigil; the strip and popover wiring share the mention machinery.
- [[goal-autopilot]] — `/goal` sits at the adjacent route position and reuses the `ez-action-result` row convention (but is a distinct, non-EZ mechanism).
- [[slash-commands]] — the literal-strip / silent-no-op-on-unknown discipline mirrors slash-command expansion; both run in `build-prompt`.
- [[feature-index]] — `$[feature:…]` expansion shares the same `mention-wiring.ts` prepend-note pattern and literal-no-double-expansion rule.
- [[lessons]] — the only live runtime action (`distill`) forwards to the lessons-distiller and deep-links the captured lesson slug.
- [[bundled-catalog]] — the generic `![EZ:<ext>:<tool>]` forwarder dispatches only to bundled extensions (`isBundledExtensionName`).
- [[agents]] — `propose_create_agent` drafts agents; `find_agents` searches the user's agent library.
- [[projects]] — `propose_create_project` drafts projects; the Ez conversation is pinned to `projectId: "global"`.
- [[marketplace]] — `propose_install_extension` links into the marketplace install surface.
- [[modes]] — the `builtin-ez` mode's `allowlist` `tool_restriction` gates the eight concierge tools (+ `extension-author__create_extension`).
- [[streaming-runtime]] — concierge tools are wired per-turn in `setup-tools`; client-side tools suspend on the SSE event bus.
- [[permissions-and-grants]] — the per-tool PermissionEngine gate runs inside `executeToolCall` for the bundled-tool forwarder.
- [[builtin-file-tools]] — concierge tools are deliberately kept out of the project-tool path (`getBuiltinToolDefs`) to avoid per-user context leaking across projects.

## Related docs

- [mention-grammar](../composer/mention-grammar.md) — the composer's five-sigil grammar (the `EZ` kind under `!`).
- [slash-commands](../../slash-commands.md) — the literal-expansion discipline that EZ-strip mirrors.

Otherwise, this is the primary reference for the Ez concierge and runtime actions.

## Notes & gotchas

- **`distill` is a metadata-only stub.** `getEzAction("distill")` returns an entry whose handler **throws**. Real dispatch goes through the route forwarder (`forwardToBundled`) which special-cases `lessons-distiller:distill_now`. The in-pipeline `messages` interceptor (`getEzAction(...).handler(...)`) would therefore throw for `![EZ:distill]` and surface an error card — the canonical path for `distill` is the direct `/api/ez-actions/[name]` route, which routes through the bundled resolver first. Persisted `![EZ:distill]` tokens must keep working forever (legacy alias).
- **Unknown action names diverge by path.** In the message pipeline an unknown name is a **silent strip** (the LLM-facing text drops it; no row persisted). The direct `/api/ez-actions/[name]` route **404s** (`bundled` null + `getEzAction` null). The popover never offers unknown names.
- **Generic `<ext>:<tool>` is bundled-only in v1.4.** User-installed extensions get no `!EZ:` chat dispatch. The result-card mapping for non-distiller tools is intentionally shallow (`success | error` from `result.isError`, body = tool text verbatim) — a wider envelope contract is deferred.
- **Concierge tools are not extensions and not mentionable.** `getEzToolMetadata()` flags them `mentionable: false`; they are excluded from `getBuiltinToolDefs()` and only loaded when `convRecord.kind === "ez"`. Wiring them as project tools would leak per-user context across project switches.
- **`summarize_conversation` has no in-tool ownership check.** It loads any conversation by id. It is safe only because it runs exclusively inside the user-owned Ez conversation under the allowlist gate — a future hardening pass should add an explicit ownership check if the tool ever becomes callable from a broader context.
- **OAuth credentials need the model swap on EVERY LLM path.** `providers/llm.ts` (`streamLLM`/`completeLLM`) applies `resolveModelForCredential` — the same OAuth-to-subscription-backend model swap `build-pi-agent` does for chat runs. Without it, a ChatGPT-plan OAuth token sent to the standard `openai-responses` endpoint 401s ("Missing scopes: api.responses.write"), which `summarize_conversation` used to surface as a silently blank summary.
- **Page context is on-demand, panel-scoped.** `read_page` / `fill_form` / `navigate_to` resolve only while the Ez panel is open (its window listener performs the DOM work); driving the Ez conversation from the "Full thread" page leaves a client-tool call to the registry's timeout. Discovered form ids for `<form>`s without an id attribute are positional (`form-<n>`), so the model must `read_page` first — `fill_form`'s `no-handler` error says exactly that. Password values are never serialized and password/file inputs are never filled.
- **The tool-list UI reads `allowedTools`.** The Modes settings row badges a builtin `allowlist` mode with its tool count and the view modal renders the allowlist chip list (`mode-allowlist-tools`); the Ez panel's 🔧 chip lists the live `/api/tools?conversationId=…` scope. A migrate.ts step fixed the historical `extension-author/create_extension` allowlist entry to the runtime's `__` separator (the slash form never matched, so the tool was silently unusable).
- **Drafts are inert and expire.** `propose_*` tools never mutate the target table — they write a 24h-TTL `ez_drafts` row and link to a prefilled form. `getDraft`/`consumeDraft` are userId-scoped and refuse expired rows; `consumeDraft` is idempotent.
- **`ez`-mode is locked end-to-end.** Create-with-`ez`-mode → 403; PUT changing an `ez` conversation's mode → 403; one `ez` conversation per user (DB partial unique index). "New chat" wipes messages, not the row.
- **Active-run IDOR is unrelated but adjacent (OPEN).** The sibling `GET/POST /api/conversations/[id]/active-run` route has no ownership check (SvelteKit doesn't wrap child `+server.ts` in a parent guard). It is not part of this feature, but any tooling that polls Ez runs touches the same conversation-route surface — treat the IDOR as a known open finding, not fixed.
- **`ez-action-result` is a free-text role.** No schema migration or check constraint — `role` is plain text. The `/goal` interceptor and the EZ dispatcher both write rows with this role; the renderer special-cases it.
