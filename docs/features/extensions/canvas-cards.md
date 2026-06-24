# Canvas Cards & Dock

> _Custom interactive tool-result cards: a `cardType` routes a tool result to a Svelte component, `ExtensionIframeCard` renders a sandboxed iframe + slottable sidebar with bidirectional `createCanvas` events, and `cardLayout: "dock"` floats completed cards in a persistent right-side `DockHost` panel._

## Intent

A built-in or extension tool can return more than text — it can drive a rich, interactive UI card in the chat thread. Canvas cards exist so extensions like `claude-design` can render a live HTML preview in a sandboxed iframe, expose knob sliders in a sidebar, and round-trip user interactions back into the extension's subprocess (apply a tweak, pick a revision, answer a question) without each extension hand-rolling a transport. The **dock** layer adds a Slack/Linear-style sidecar: a tool can opt into a floating panel that auto-replaces as new canvases complete, persists across reloads, and pops out to a new tab — all from a single `cardLayout: "dock"` manifest line.

## How it works

The data path splits into three concerns: **routing** (`cardType` → component), **bidirectional events** (`createCanvas` ↔ generic events route), and **layout** (`cardLayout` → inline vs. dock).

### 1. Routing a result to a card

- A `ToolDefinition` declares `cardType` (e.g. `"design-canvas"`). When the tool completes, the runtime's `subscribe-bridge.ts` fans the `cardType` (and `cardLayout`) out on the `tool:start` / `tool:complete` stream events and persists them onto the tool-call row (`persistToolCall({ …, cardType, cardLayout })`). `src/runtime/executor-watchdog.ts` carries the same fields on its in-flight tool-call map (`InflightToolInfo`) so a watchdog-trip `tool:complete` re-emits them.
- In the browser, `tool-cards/utils.ts#getCardComponentName(cardType, permissionPending)` maps the string to a component name via a `switch`. `permissionPending` always wins → `PermissionGate`.
- `ToolCardRouter.svelte` is the dispatcher: it computes `cardName` and renders the matching component (`DesignCanvasCard`, `WeatherCard`, `AskUserQuestionCard`, `EzToolResultCard`, …). Unknown / streaming / malformed payloads degrade to `DefaultCard`. It receives a `mode: "inline" | "dock"` prop and, for noisy dev cards (terminal/diff/search), collapses them to a one-liner inline only (`isCollapsibleDevCard`).

### 2. The iframe primitive + bidirectional events

- `ExtensionIframeCard.svelte` is the generic primitive most canvas cards compose. It renders a `<iframe>` with a **hard-coded** `sandbox="allow-scripts allow-same-origin"` (the `SANDBOX_FLAGS_STRICT` constant in `iframe-card-logic.ts`) plus an optional `sidebar` snippet. The `iframeSrc` prop is validated by `validateIframeSrc` — same-origin http(s) only; cross-origin / `javascript:` / `data:` / `blob:` / `file:` are refused.
- The sidebar snippet receives `{ postEvent, busy }`. `postEvent(eventName, body)` POSTs to the **generic events route** `/api/extensions/[name]/events/[event]`, with `{ toolCallId, conversationId, ...body }`. The component re-keys the iframe (`iframeKey`) whenever `iframeSrc` changes so the browser reloads cleanly.
- The events route (`web/src/routes/api/extensions/[name]/events/[event]/+server.ts`) enforces the full security ladder: `requireScope("chat")` + `requireAuth`, name/event regex, `isRegisteredExtensionEvent` (the event must have been declared in the manifest's `permissions.eventSubscriptions` and granted), conversation-ownership (`conv.userId === user.id`, else **404**), and a `toolCallId↔conversationId` binding check. On success it emits `<name>:<event>` on the bus.
- The `EventSubscriptionDispatcher` (`src/extensions/event-subscription-dispatcher.ts`) fans the bus event to subscribed extension subprocesses — gated on `conversation_extensions` wiring and a per-extension token-bucket rate limit (`createRateLimiter(options.maxOpsPerSecond ?? DEFAULT_MAX_OPS)`, where `DEFAULT_MAX_OPS = 50` → 50 events/sec).
- In the subprocess, `createCanvas` (`packages/@ezcorp/sdk/src/runtime/canvas.ts`) registers a handler per event under the JSON-RPC method `ezcorp/event/<namespace>:<event>`. The handler receives the whole wire frame as `payload` plus a typed `context: { toolCallId, conversationId }`; a frame missing `conversationId` is dropped silently (defense-in-depth against cross-conversation bleed). The `namespace` **must** equal `manifest.name` — a mismatch fails closed (no delivery).

### 3. Dock layout

- A `ToolDefinition` sets `cardLayout: "dock"`. The host normalizes the value fail-open in `subscribe-bridge.ts#normalizeCardLayout` (`"inline"` / `"dock"` only; anything else → undefined + a warn-log).
- `tool-cards/utils.ts#shouldRenderInDock(cardLayout, status)` returns true only when `cardLayout === "dock"` **and** `status === "complete"`. Running calls always render inline so the user can watch progress (NULL `cardLayout` ⇒ inline, the backwards-compat default).
- `InlineToolCard.svelte` / `ToolCallCard.svelte` observe a complete dock-mode call and schedule `openDock(convId, id)` on a **500ms debounce** (a setTimeout cleared on teardown) — so a multi-tool turn doesn't flicker; only the last fires. Once docked, the inline bubble renders a `DockOpenPill` ("Canvas open ↗") that re-routes to that card.
- `DockHost.svelte` is a single instance mounted at the `(app)` layout level. It reads `store.dockState[activeConvId]`, adapts the `InlineToolCall` → `ToolCallState`, and renders the routed component via `ToolCardRouter` with `mode="dock"`. The same component identity is used inline and docked — only the parent slot and presentational CSS (border, min-height) move; sandbox flags are unchanged.
- Dock state lives in `stores.svelte.ts`: `dockState` (per-conv `{toolCallId, previousSidebar, userOverrode}`), `dockSizePx` (per-user width), and `dismissedDocks` (per-conv set of user-closed ids). `openDock` snapshots `sidebarCollapsed` on first open and force-collapses it; `closeDock` restores the snapshot unless the user manually re-toggled (`noteSidebarUserOverride` → "user wins"). Reload persistence is keyed `ezcorp-dock-state-<convId>` (slot) and `ezcorp-dock-size-px` (width) in localStorage.
- `DockHost` on mount rehydrates from the persisted slot, else falls back to the **most-recently-completed** dock-mode call in the conversation (so historical canvases don't cycle). Mobile (≤640px) flips to a full-screen overlay with swipe-to-dismiss (>80px down or right); Esc and the close button also dismiss. If the tool result carries an `iframeSrc`, the header shows a "Pop out" button (`window.open(url, "_blank", "noopener,noreferrer")`, same-origin only via `extractPopoutUrl`).

## Usage

### Extension author wiring (the four pieces)

1. **Manifest** (`ezcorp.config.ts`): set `cardType` on the tool, add `cardLayout: "dock"` to opt into the dock, and declare `permissions.eventSubscriptions: ["<name>:<event>"]`. The namespace **must** equal `manifest.name`.
2. **Bundled grant** (if in `BUNDLED_EXTENSIONS`, `src/extensions/bundled.ts`): grant the same `eventSubscriptions` — the events route reads from grants, not the manifest, so a missing grant ⇒ 404 on every event POST.
3. **Host card**: add a `case` to `getCardComponentName` in `tool-cards/utils.ts`, then author the Svelte component (compose `ExtensionIframeCard` for the iframe + sidebar).
4. **Subprocess**: register handlers with `createCanvas({ cardType, namespace, events })` and call `getChannel().start()`.

### SDK call

```ts
import { createCanvas, createToolDispatcher, getChannel, toolResult } from "@ezcorp/sdk/runtime";

createToolDispatcher({
  "open-thing": async () => toolResult(JSON.stringify({ cardType: "my-thing", iframeSrc })),
});
createCanvas<{ "user-action": { thingId: string; choice: "yes" | "no" } }>({
  cardType: "my-thing",
  namespace: "my-extension",          // MUST equal manifest.name
  events: { "user-action": async ({ payload, context }) => { /* … */ } },
});
getChannel().start();
```

The generic is optional; without it every `payload` is `unknown`. `extensionDataUrl(name, relpath)` builds the same-origin `/api/extensions/<name>/data/<relpath>` URL for iframe content.

### HTTP routes

| Method & path | Purpose |
|---|---|
| `POST /api/extensions/[name]/events/[event]` | Generic canvas/messageToolbar/hub event sink. Scope `chat`; auth + ownership + manifest-allowlist + `toolCallId↔conv` binding. Emits `<name>:<event>` on the bus. |
| `GET /api/extensions/[name]/data/[...path]` | Serves extension-data files (iframe content) from `<cwd>/.ezcorp/extension-data/<name>/` with a strict CSP + traversal guard + per-user rate limit. |

### UI entry points

- Inline: the tool card renders in the chat bubble (`ToolCardRouter` via `InlineToolCard` / `ToolCallCard`).
- Dock: `DockHost` floats the completed dock-mode card; the inline bubble shows a `DockOpenPill` to re-open. Resize via the left-edge handle, close via Esc / the close button.

## Key files

- `web/src/lib/components/tool-cards/ToolCardRouter.svelte` — `cardType` → component dispatcher; threads `mode` and degrades unknowns to `DefaultCard`.
- `web/src/lib/components/tool-cards/utils.ts` — `getCardComponentName`, `shouldRenderInDock`, `isCollapsibleDevCard` (pure, unit-tested).
- `web/src/lib/components/tool-cards/ExtensionIframeCard.svelte` — generic sandboxed-iframe + sidebar primitive; `postEvent` POSTs to the events route.
- `web/src/lib/components/tool-cards/iframe-card-logic.ts` — `SANDBOX_FLAGS_STRICT`, `validateIframeSrc`, `buildEventUrl`, `extractPopoutUrl` (security-critical pure helpers).
- `web/src/lib/components/tool-cards/DesignCanvasCard.svelte` — `claude-design`'s consumer; reference composition of `ExtensionIframeCard` with a knob sidebar + inline `tweak-design` round-trip.
- `web/src/lib/components/tool-cards/DesignBriefCard.svelte` — `claude-design`'s `clarify-brief` card. NOT an `ExtensionIframeCard` (no iframe); a form that POSTs answers to the generic events route via `buildEventUrl`.
- `web/src/lib/components/tool-cards/DockHost.svelte` — app-layout floating panel; resize, mobile overlay, pop-out, persistence, auto-replace.
- `web/src/lib/components/tool-cards/DockOpenPill.svelte` — inline placeholder that re-opens (and replaces) the dock for a `toolCallId`.
- `web/src/lib/components/InlineToolCard.svelte`, `web/src/lib/components/ToolCallCard.svelte` — schedule `openDock` on a 500ms debounce when a dock-mode call completes.
- `web/src/lib/stores.svelte.ts` — `dockState` / `dockSizePx` / `dismissedDocks` state + `openDock` / `closeDock` / `setDockSize` / `noteSidebarUserOverride` / `readPersistedDockSlot`.
- `packages/@ezcorp/sdk/src/runtime/canvas.ts` — `createCanvas`: registers `ezcorp/event/<ns>:<event>` handlers, typed `payload` + `context`, namespace = `manifest.name`.
- `web/src/routes/api/extensions/[name]/events/[event]/+server.ts` — generic events route (canvas + messageToolbar + hub branches); full auth/ownership/allowlist ladder.
- `web/src/routes/api/extensions/[name]/data/[...path]/+server.ts` — extension-data file server (iframe content) with CSP + traversal guard.
- `src/runtime/stream-chat/subscribe-bridge.ts` — fans `cardType` / `cardLayout` onto the `tool:start` / `tool:complete` SSE events; `normalizeCardLayout` (fail-open).
- `src/extensions/event-subscription-dispatcher.ts` — fans bus events to subscribed subprocesses; `registerExtensionEvent` + 50 events/sec token bucket.
- `src/runtime/sse-conversation-filter.ts` — `DIRECT_CARRIER_EVENT_TYPES`, `registerExtensionEvent` / `isRegisteredExtensionEvent` (event allowlist registry).
- `packages/@ezcorp/sdk/src/types.ts` — `ToolDefinition.cardType` (the `cardLayout` field is consumed by the host's subscribe-bridge).

## Features it touches

- [[streaming-runtime]] — `cardType` / `cardLayout` ride the `tool:start` / `tool:complete` SSE stream; the dock auto-opens on `tool:complete`.
- [[runtime-and-rpc]] — `createCanvas` registers JSON-RPC `ezcorp/event/<ns>:<event>` handlers over the subprocess channel.
- [[runs-lifecycle]] — cards render against a tool call within an active run; `status === "complete"` gates docking.
- [[ask-user]] — `ask-user` is a canvas consumer (events only, no iframe) that pauses the LLM until the user answers; migrated to `createCanvas`.
- [[hub-pages]] — the same generic events route serves Hub page actions (`source: "hub"` branch) and shares the manifest-event allowlist.
- [[message-toolbar]] — the same route handles messageToolbar contributions (`messageId` / `messageIds[]` branch), sharing the wire format with canvas events.
- [[permissions-and-grants]] — event delivery is gated on the granted `eventSubscriptions`; bundled extensions must grant what they declare.
- [[sandbox-and-isolation]] — the iframe runs framed extension content; `createCanvas` handlers run in the extension's sandboxed subprocess.
- [[bundled-catalog]] — `claude-design` / `ask-user` ship in `BUNDLED_EXTENSIONS` and must carry the matching grant.
- [[overview-and-authoring]] — authoring a canvas card is part of the extension authoring surface (manifest `cardType` / `cardLayout` / `eventSubscriptions`).
- [[preview-port-exposure]] — the "Pop out" / consent flow shares the same-origin iframe + `validateIframeSrc` policy; the `ez-preview-consent` cardType routes through this same router.

## Related docs

- [canvas-cards (extension-author guide)](../../extensions/canvas-cards.md) — the authoring-facing how-to with the 10-line example, manifest/grant steps, wire format, typed payloads, and the security-guarantee table.
- [data-storage](../../extensions/data-storage.md) — the `.ezcorp/extension-data/<name>/` convention the data route serves iframe content from.

## Notes & gotchas

- **The iframe sandbox is NOT a trust boundary.** `ExtensionIframeCard` hard-codes `sandbox="allow-scripts allow-same-origin"`, but the framed content is **same-origin** (`/api/extensions/[name]/data/*`). `allow-same-origin` + `allow-scripts` means the framed JS keeps the app's origin and can reach `window.parent` / `fetch /api/*` with the user's cookie. The sandbox attr only blocks the listed escape hatches (popups, top-nav, forms, modals) — it does **not** contain a malicious extension. Real containment requires a separate origin (tracked in `tasks/preview-port-exposure.md`). Do not "fix" this by tweaking the sandbox flags or the data route CSP — neither closes the `window.parent` path.
- **CSP is deliberately relaxed for served content.** The data route's `Content-Security-Policy` allows `'unsafe-inline'` / `'unsafe-eval'` in `script-src` (plus `cdn.jsdelivr.net`) so generated HTML drafts can ship inline scripts without a build step. Extension-authored content is treated as **partially trusted**; `frame-ancestors 'self'` blocks foreign embedding. Don't ship secrets / unauthenticated APIs same-origin if you rely on this.
- **Namespace mismatch fails silently.** `createCanvas`'s `namespace` must equal `manifest.name`; the host composes `<namespace>:<event>` server-side. A mismatch produces no delivery — the SDK can't detect it (no manifest introspection in the subprocess).
- **Missing bundled grant ⇒ 404 on every event.** The events route reads `eventSubscriptions` from **grants**, not the manifest. A bundled extension that declares an event but doesn't grant it gets 404 on every POST — the single most common wiring bug.
- **Outbound push-back (`refresh`/`close`) is NOT wired.** `createCanvas` returns an empty `Canvas` handle; the SDK→host "push a new revision into the open card" path is intentionally deferred. Today the inbound event flow is complete and the iframe re-renders by reloading its `iframeSrc` (e.g. `DesignCanvasCard` cache-busts with a `_v=` query param). Shipping no-op `refresh()`/`close()` was rejected by review as "dead code that looks functional."
- **`cardLayout` is consumed but not on the SDK `ToolDefinition` interface.** `packages/@ezcorp/sdk/src/types.ts` formally lists only `cardType`; `cardLayout` is read off the tool definition at runtime in `subscribe-bridge.ts` (`toolDef?.cardLayout`) and normalized fail-open. Unknown values warn-log and fall back to inline.
- **Dock streaming-precedence + debounce.** A running dock-mode call renders inline (never docks until `status === "complete"`); when multiple complete within ~500ms, only the last `openDock` fires. NULL `cardLayout` rows (pre-migration) always render inline.
- **Sidebar "user wins" precedence.** `openDock` force-collapses the app sidebar and snapshots the prior state; `closeDock` restores it **unless** the user manually re-toggled the sidebar while docked (`noteSidebarUserOverride`), in which case restore is skipped.
- **Pop-out is same-origin only.** `extractPopoutUrl` reuses `validateIframeSrc`, so cross-origin / non-http(s) `iframeSrc` values silently omit the "Pop out" button; the opened tab uses `noopener,noreferrer` to sever the back-channel.
- **No platform-event shadowing.** A `<namespace>:<event>` that exactly matches a `DIRECT_CARRIER_EVENT_TYPES` entry is refused — e.g. an extension named `ask-user` declaring `answer` (→ `ask-user:answer`), or one named `tool` declaring `start` (→ `tool:start`). The guard is an **exact** set-membership check on the composed `namespace:eventName` (not a prefix match): `registerExtensionEvent` returns false and the dispatcher drops the registration.
