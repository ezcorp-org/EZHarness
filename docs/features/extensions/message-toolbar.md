# Message Toolbar Contributions

> _An extension point that lets an installed extension add a per-turn action icon to the chat message toolbar (next to copy / regenerate / exclude); clicking it POSTs a declared event to the host, which — for the bundled `kokoro-tts` pattern — appends a forced-excluded follow-up turn whose card runs client-side._

## Intent

The message toolbar is the row of action icons that fades in under each chat turn (copy, edit, regenerate, branch, exclude-from-context, save-to-memory). `messageToolbar` contributions let an extension inject its own icon into that row — a per-message, user-driven click target for actions that don't fit a canvas card or an LLM tool: read-aloud, send-to-Slack, summarize-in-place, translate. The contribution is a pure UI affordance (the LLM never sees it), so it is visible globally on every chat row the moment the extension is installed and enabled — there is no per-conversation wiring step the way canvas cards require. The reference implementation is **`kokoro-tts`**, a speaker icon that synthesizes an audio turn below the clicked row using `kokoro-js` in the browser.

## How it works

### Declaration → discovery → render

1. **Manifest** — an extension declares a `messageToolbar[]` array on its `ezcorp.config.ts` (each entry: `id`, `icon` lucide name, `tooltip`, optional `appliesTo`, optional `appliesToSelection`, and `event`). The validator (`src/extensions/manifest.ts` `validateMessageToolbarArray`) enforces two coupling rules: the `event` must be prefixed with `<manifest.name>:` (the dispatcher namespace rule), and it must also appear in `permissions.eventSubscriptions`.
2. **Discovery** — `GET /api/conversations/[id]/extension-toolbar` (`web/.../extension-toolbar/+server.ts`) returns the union of every **enabled** installed extension's `messageToolbar[]`, re-clamped so an item whose event isn't in that manifest's `eventSubscriptions` is dropped (defense-in-depth over the validator). The DB row's `manifest` JSONB is the source of truth (no round-trip through the live registry). The route is ownership-gated (`verifyConversationOwnership`) and returns `Cache-Control: private, max-age=10`.
3. **Per-conversation cache** — `extensionToolbarStore` (`web/src/lib/stores/extension-toolbar.svelte.ts`) fetches that list once per conversation and dedupes concurrent `ensure()` calls, so the N rows in a thread share one GET. On error it caches `[]` (degrade to "no extension actions").
4. **Render** — `ChatMessage.svelte` reads the store, filters to this row's role via `selectApplicableContributions` (drops `appliesToSelection: "bulk"`-only items), and maps each into an `ExtensionAction` whose `onclick` captures selection + POSTs. `MessageToolbar.svelte` renders the icons between the exclude affordance and save-to-memory, each via `LucideIcon` (name resolved from the manifest string).

### Click → event POST (single row)

- On click, `ChatMessage.svelte` calls `captureSelection` (`web/src/lib/chat/extension-toolbar-action.ts`) — `window.getSelection()` clamped to the row's DOM element (`messageEl.contains(anchorNode)`) so a highlight in a neighbouring turn can't be stolen, truncated at `SELECTION_CAP = 4_000`, empty/collapsed → `null`.
- `buildExtensionEventPayload` produces `{ messageId, conversationId, content, selection }`; `postExtensionEvent` POSTs it to the URL from `buildExtensionEventUrl` — which strips the `<extName>:` prefix off the event so the bare suffix lands in the `[event]` URL segment (the route's `PARAM_REGEX` forbids colons). The toolbar shows an in-flight spinner for the duration; failures surface as a toast.

### Host event route (`/api/extensions/[name]/events/[event]`)

The generic event route (`web/src/routes/api/extensions/[name]/events/[event]/+server.ts`) handles canvas-card events, hub-page actions, and messageToolbar events on one POST handler. The messageToolbar branch:

1. `requireScope(locals, "chat")` + `requireAuth` + URL `PARAM_REGEX` + `isRegisteredExtensionEvent(`<name>:<event>`)` (unknown event → 404).
2. Body parsed by a Zod `looseObject`: requires one of `toolCallId` / `messageId` / `messageIds[]` (canvas-card vs single vs bulk discriminator). Server-side caps: `selection` ≤ 4 000, `content` ≤ 100 000, `messageIds[]` ≤ 50.
3. **Ownership** — the acting user must own `conversationId` (404, never 403).
4. **Auto-wire** — messageToolbar icons render even on conversations the extension was never wired into, so the route inserts a `conversation_extensions` row for `(conv, ext)` if absent (otherwise the dispatcher's `wired.has(extId)` gate silently drops everything) and spawns/wires the subprocess (`persistent: false` extensions don't auto-spawn at boot).
5. **In-process append** — rather than emit on the bus and rely on the dispatcher → subprocess → reverse-RPC chain (which had multiple silent failure points in production), the route computes `text = (selection || content).slice(0, 4000)` itself and calls `handleAppendMessageRpc` directly with a `running` tool call of `cardType: "<name>-player"`. The grant (`appendMessages`) is still checked (`-32001` / 403 otherwise). **Phase 2 (not yet built): generalize via manifest-declared `messageToolbar[i].action` so every contribution doesn't get the hardcoded kokoro-tts shape.**
6. **Notify UI** — emits `run:turn_saved` (one of the `DIRECT_CARRIER_EVENT_TYPES`) over SSE with a synthetic `runId = ext:<extId>:<messageId>`.

### Append handler (`ezcorp/append-message`)

`src/extensions/append-message-handler.ts` is the same reverse RPC an in-subprocess extension would call. Its enforcement ladder: kill-switch → PDP `engine.authorize("ezcorp:chat:append")` (legacy boolean fallback when no engine) → conversation scope bound → extension wired to the conversation → caller `conversationId` (if present) must equal the host's → 50 ops/sec rate limit → param validation → attachment-ownership preflight. On accept it `createMessage(role: "extension")` then `setMessageExcluded(true)`, persists one tool-call row per `toolCalls[]` item, and re-keys any supplied `attachmentIds` to the new message. **`role: "extension"` rows are filtered out of LLM history** by `convertToLlm` in `src/runtime/stream-chat/build-pi-agent.ts`; the forced `excluded: true` is belt-and-suspenders that also makes the UI's "Excluded from chat context" pill render. (`appendMessages.excludedDefault` on the grant is reserved for a future opt-in tier — no runtime effect today.)

### Client refresh

The synthetic `ext:` runId reaches the chat page as an `ez:turn_saved` window event handled in `ChatThread.svelte`. `handleExtensionTurnSaved` (`web/src/lib/chat/page-handlers/handle-extension-turn.ts`) is a no-op if the message id is already known; otherwise it busts the `messages-all:` and `messages-tools:` fetch-policy cooldowns (mount-time `loadMessages()` already hit the throttle key) and re-runs `loadMessages()` + `hydrateToolCallsFromApi()` so the new row **and** its `running` tool-card hydrate into `inlineToolStore`. The card itself (e.g. `KokoroTtsPlayerCard.svelte`) runs in the browser bundle and does the heavy work (synthesis, `<audio>`, upload), then closes the loop via the extension's `:save` event → `handleFinalizeToolCallRpc`.

### Bulk (multi-select) path

The same icon set drives the multi-select bulk action bar. `SelectModeActionBar.svelte` reuses `MessageToolbar.svelte` in `variant: "inline"`. `ChatThread.svelte` builds `bulkExtensionActions` from `selectBulkApplicableContributions` (items with `appliesToSelection` of `"bulk"` or `"both"`; the per-row `appliesTo` axis is **not** applied — a bulk selection can mix roles). The onclick concatenates the selected turns' content (chronological order) and POSTs `buildExtensionBulkEventPayload({ messageIds, conversationId, content })` — no `selection`. Server-side the bulk branch ignores any caller selection, anchors the new turn to the **last** id in `messageIds[]` (most-recent reply is the natural anchor), and headers it `🔊 TTS of N turns (X chars)` (single-row clicks use `🔊 TTS of selection|message (X chars)`).

### Toolbar prop parity

Every `on*` callback prop on `MessageToolbar.svelte` is registered in `message-toolbar-registry.ts` with a `bulkSupported` flag; `message-toolbar-parity.unit.test.ts` fails the build if a prop has no registry entry, isn't referenced in `ChatMessage.svelte`, or a `bulkSupported: true` entry isn't wired into `SelectModeActionBar.svelte`. (This governs the built-in buttons; extension `extensionActions` flow through `extensionActions={...}`, separate from this registry.)

## Usage

### REST API

| Method & path | Scope | Purpose |
|---|---|---|
| `GET /api/conversations/[id]/extension-toolbar` | `chat` | List the union of enabled extensions' `messageToolbar[]` items (ownership-gated, `eventSubscriptions`-clamped, 10 s private cache). |
| `POST /api/extensions/[name]/events/[event]` | `chat` | Fire a toolbar event. Single: `{ conversationId, messageId, content, selection? }`. Bulk: `{ conversationId, messageIds[], content }`. The `[event]` segment is the **bare** suffix (no `<name>:` prefix). |

### Manifest (extension author)

```typescript
export default defineExtension({
  name: "kokoro-tts",                  // ← namespace; event must be prefixed with this
  messageToolbar: [{
    id: "speak",                       // /^[a-z0-9][a-z0-9-]{0,31}$/, unique within the ext
    icon: "Volume2",                   // lucide-svelte icon name
    tooltip: "Read aloud (selection or full message)",
    appliesTo: "both",                 // "user" | "assistant" | "both" (default "both")
    appliesToSelection: "both",        // "single" | "bulk" | "both" (default "single")
    event: "kokoro-tts:speak",         // MUST be prefixed `<name>:` AND in eventSubscriptions
  }],
  permissions: {
    eventSubscriptions: ["kokoro-tts:speak", "kokoro-tts:save"],
    appendMessages: { excludedDefault: true },   // grants ezcorp/append-message
  },
});
```

### Bundled-extension grant

A bundled extension also needs a matching entry in `BUNDLED_EXTENSIONS` (`src/extensions/bundled.ts`) granting the same `eventSubscriptions` + `appendMessages` — with a `grantedAt` timestamp per key. The runtime allowlist reads from `granted_permissions`, **not** the manifest; without `grantedAt` the dispatcher/route 404s the click (the canvas-card footgun).

### Host-side card (for follow-up turns that render UI)

The `cardType` passed in `toolCalls[]` (e.g. `kokoro-tts-player`) resolves to a Svelte component via `web/src/lib/components/tool-cards/utils.ts` `getCardComponentName`; create the component under `web/src/lib/components/tool-cards/`. The card runs in the browser bundle — heavy client-side work (TTS, image render, upload) belongs there, keeping the subprocess thin.

### SDK (in-subprocess, the canonical author pattern)

```typescript
import { createCanvas, getChannel } from "@ezcorp/sdk/runtime";
createCanvas<{ speak: { messageId: string; conversationId: string; content: string; selection?: string } }>({
  cardType: "kokoro-tts-player",
  namespace: "kokoro-tts",   // MUST equal manifest.name
  events: { speak: async ({ payload }) => {
    const text = (payload.selection?.trim() || payload.content).slice(0, 4_000);
    await getChannel().request("ezcorp/append-message", { /* … */ });
  }},
});
getChannel().start();
```

(For `kokoro-tts` specifically the host short-circuits the `:speak` event in-process — see "Host event route" — so the subprocess's speak handler is bypassed; the subprocess is still spawned/wired for the later `:save` callback.)

### Env vars

- `EZCORP_DISABLE_CAPABILITY_TOOLS=1` — kill-switch; makes `ezcorp/append-message` (and other capability tools) return `-32001` "permission not granted", disabling the toolbar's follow-up turn.

## Key files

- `web/src/lib/components/MessageToolbar.svelte` — the icon row (built-in buttons + `extensionActions[]`); hover (`group-hover`) and `inline` variants; per-action in-flight spinner.
- `web/src/lib/components/ChatMessage.svelte` — fetches the store, builds single-row `ExtensionAction`s, captures selection, POSTs on click.
- `web/src/lib/components/ChatThread.svelte` — wires `SelectModeActionBar` `extensionActions` (bulk) and the `ez:turn_saved` → `handleExtensionTurnSaved` refresh.
- `web/src/lib/components/chat/SelectModeActionBar.svelte` — multi-select bulk bar; reuses `MessageToolbar` `inline`.
- `web/src/lib/chat/extension-toolbar-action.ts` — pure helpers: `captureSelection`, `appliesToRole`, `selectApplicableContributions`, `selectBulkApplicableContributions`, `buildExtensionEventPayload` / `…BulkEventPayload`, `buildExtensionEventUrl`, `postExtensionEvent`; `SELECTION_CAP = 4_000`.
- `web/src/lib/stores/extension-toolbar.svelte.ts` — per-conversation cache + in-flight dedupe of the contributions GET.
- `web/src/lib/chat/page-handlers/handle-extension-turn.ts` — `handleExtensionTurnSaved`: cooldown-bust + reload after an `ext:` turn lands.
- `web/src/lib/components/message-toolbar-registry.ts` — built-in toolbar prop registry; bulk-support flags for the parity test.
- `web/src/routes/api/conversations/[id]/extension-toolbar/+server.ts` — GET contributions; ownership-gated, `eventSubscriptions`-clamped.
- `web/src/routes/api/extensions/[name]/events/[event]/+server.ts` — generic event route; messageToolbar branch (auto-wire, in-process append, `run:turn_saved` emit), plus canvas-card + hub-page branches.
- `src/extensions/append-message-handler.ts` — `handleAppendMessageRpc`; enforcement ladder, forced `role: "extension"` + `excluded: true`, tool-call + attachment persistence.
- `src/extensions/types.ts` — `MessageToolbarItem` interface (`appliesTo`, `appliesToSelection`, `event`).
- `src/extensions/manifest.ts` — `validateMessageToolbarArray`: id regex, icon/tooltip required, `appliesTo`/`appliesToSelection` enums, event-prefix + `eventSubscriptions` allowlist rules.
- `src/extensions/bundled.ts` — `kokoro-tts` bundled entry + its `granted_permissions` (`grantedAt` timestamps).
- `src/runtime/sse-conversation-filter.ts` — `DIRECT_CARRIER_EVENT_TYPES` (includes `run:turn_saved`), `isRegisteredExtensionEvent`, the per-conversation/scope filter.
- `docs/extensions/examples/kokoro-tts/ezcorp.config.ts` — worked manifest (speaker icon, `appliesToSelection: "both"`).

## Features it touches

- [[conversations]] — contributions render on every message row; the bulk path reuses the multi-select toolbar; an appended turn is a new `messages` row.
- [[canvas-cards]] — shares the `/api/extensions/[name]/events/[event]` route and the `cardType` → component resolver; same bundled-grant footgun.
- [[runtime-and-rpc]] — the click drives `ezcorp/append-message` (and `ezcorp/finalize-tool-call` for the card's `:save`); the subprocess is spawned/wired via `ToolExecutor`.
- [[permissions-and-grants]] — the `appendMessages` grant + `eventSubscriptions` allowlist gate the event and the append; PDP `engine.authorize` is the live gate.
- [[overview-and-authoring]] — `messageToolbar` is one of the manifest extension points an author declares.
- [[streaming-runtime]] — the appended turn reaches the client via the `run:turn_saved` SSE event, not the streaming placeholder path.
- [[context-compaction]] — appended `role: "extension"` / `excluded` turns are filtered from the LLM input window, so a TTS turn never re-feeds itself.
- [[persistent-memory]] — `save-to-memory` is the neighbouring built-in toolbar button (single + bulk).
- [[bundled-catalog]] — `kokoro-tts` is the bundled reference contribution.
- [[attachments]] — the append handler re-keys pre-uploaded `attachmentIds` onto the new turn (the card's synthesized audio).
- [[hub-pages]] — the same event route serves hub-page actions on a sibling branch.

## Related docs

- [Message Toolbar (SDK guide)](../../extensions/message-toolbar.md) — the author-facing SDK surface: 5-line example, manifest declarations, bundled grant, host card, selection rules, security-gate table, common bugs.
- [Extension data storage](../../extensions/data-storage.md) — the `.ezcorp/extension-data/<ext>/` convention.

## Notes & gotchas

- **Global, not per-conversation.** A `messageToolbar` icon appears on every chat row in every conversation as soon as the extension is installed + enabled — unlike canvas cards, which gate on `conversation_extensions` wiring. The route auto-inserts the wiring row on first click; the icon's visibility is governed only by install/enable state. Rationale: the icon is a user affordance, not LLM tooling.
- **In-process append is hardcoded to the kokoro-tts shape.** The route's messageToolbar branch always synthesizes a `🔊 TTS of …` header + a single `<name>-player` `running` tool call. There is **no** manifest-declared `action` field yet — the code comments call this out as "Phase 2 (future)." A non-TTS extension would currently get TTS-flavored host bookkeeping (the card itself is whatever `<name>-player` resolves to, but the header text and tool name are fixed).
- **`excluded: true` is forced and cannot be opted out of.** The handler flips it regardless of what the extension passes; `role: "extension"` is independently filtered from LLM history. `appendMessages.excludedDefault` is declared but has no runtime effect today. Author turns the user expects the model to see — reconsider the `messageToolbar` shape; that's an agent-tool concern.
- **Selection is capped twice (4 000 chars).** Client-side `captureSelection` (`SELECTION_CAP`) and server-side both the Zod `selection.max(4_000)` and `.slice(0, 4_000)` in the route. The server never trusts the client value. Bulk mode ignores selection entirely.
- **The event URL carries the bare suffix, not the full `<name>:event`.** `buildExtensionEventUrl` strips the prefix; forwarding the full name 404s because the route's `PARAM_REGEX` forbids colons (a real production bug fixed 2026-05-05). The route reconstructs `${name}:${event}` server-side for the registry check.
- **404 on click usually means a missing grant.** If the extension isn't in `BUNDLED_EXTENSIONS` with `grantedAt.eventSubscriptions`, `isRegisteredExtensionEvent` returns false (event never registered) → 404. Same for a missing `appendMessages` grant → 403 on the append.
- **`run:turn_saved` is the only client signal.** It's a direct-carrier SSE event filtered per-conversation by `sse-conversation-filter.ts`. The refresh is throttle-aware — `handleExtensionTurnSaved` must bust the `messages-all:`/`messages-tools:` cooldowns or the new row never loads (the mount-time `loadMessages()` already consumed the throttle key).
- **The contributions GET _is_ ownership-gated** (`verifyConversationOwnership`) — unlike the sibling `active-run` route, which is a known **open** cross-tenant IDOR (no ownership check on its child `+server.ts`). Don't conflate the two: the toolbar route checks ownership; `active-run` does not. See [[conversations]] notes.
- **`role: "extension"` is the only accepted role.** `validateParams` rejects any other role string up front so the `messages.role` column never gets a value the LLM history filter doesn't recognize.
- **Append is best-effort non-transactional.** A partial failure mid-way (e.g. attachment re-key) leaves the message row in place — same tradeoff as the `messages` POST handler.
