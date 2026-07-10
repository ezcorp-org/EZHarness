# Canvas Cards

Build extensions that render a custom UI card with **bidirectional events** — sandboxed iframe previews, knob sliders, comment overlays, anything that needs to push state back into the extension's subprocess as the user interacts.

This guide is for extensions that have outgrown the basic tool-result card. If your tool just returns text or a file path, the [DefaultCard renderer](../../web/src/lib/components/tool-cards/DefaultCard.svelte) already handles it — skip this guide.

## When to use a canvas card

| Use a canvas card when | Use the default card when |
|---|---|
| User input drives subsequent extension behavior (knob sliders, button clicks → new revisions) | The tool result is a static read |
| The visual is interactive (iframe-rendered HTML, charts, embedded media) | The result is a list, log, or single value |
| Multiple events flow back from the UI into the subprocess | Once the tool returns, that's it |

The three production examples in this repo:

- **`claude-design`** ([code](examples/claude-design/index.ts)) — generates HTML drafts and applies knob-based tweaks live. Iframe + canvas events.
- **`ask-user`** ([code](examples/ask-user/index.ts)) — pauses the LLM until the user clicks an option or submits text. Canvas events only (no iframe).
- **`price-chart`** ([code](examples/price-chart/) · [README](examples/price-chart/README.md)) — renders inline SVG charts in the chat bubble. **No iframe, no canvas events, no filesystem permission** — see below.

### Inline-render alternative (no iframe, no canvas events)

When the card's UI is small enough to render in Svelte and you don't need bidirectional events, you can skip the full canvas pattern entirely:

1. Tool returns a JSON payload (no `iframeSrc`).
2. A Svelte component registered against your `cardType` reads the payload and draws the UI inline in the chat bubble.
3. Range tabs, hover tooltips, filters — anything that operates on the already-fetched data — is pure local component state. No round-trip to the subprocess.

Wins:

- **No `filesystem` permission.** You don't write HTML to disk → no `fs.write` capability needed → no first-call permission prompt → no 90 s watchdog hang while the user finds and clicks "Allow".
- **No iframe CSP wrangling.** External resources (logos, scripts, fonts) load via the chat page's CSP, not a separate iframe CSP.
- **Smaller payload.** Just the data, not an HTML document.

Lose:

- **No subprocess events from user interaction.** If the user clicking a button needs to call a tool, you need the full canvas pattern. The inline pattern is fire-and-forget after the initial tool call.
- **No HTML sandboxing.** You're rendering inside the chat page's DOM. The component author is on the hook for not injecting arbitrary HTML/scripts.

See [`price-chart/README.md`](examples/price-chart/README.md) for a full walkthrough.

## The 10-line example

```typescript
import { createCanvas, createToolDispatcher, getChannel, toolResult } from "@ezcorp/sdk/runtime";

const ch = getChannel();   // arm the channel FIRST — createToolDispatcher throws "channel not ready" otherwise

createToolDispatcher({
  "open-thing": async () => toolResult(JSON.stringify({ cardType: "my-thing" })),
});

createCanvas<{ "user-action": { thingId: string; choice: string } }>({
  cardType: "my-thing",
  namespace: "my-extension",   // MUST equal manifest.name
  events: { "user-action": async ({ payload, context }) => { /* handle */ } },
});

ch.start();
```

That's the whole subprocess wiring. Everything else is your handler logic.

## What you also need

The 10-line example assumes you've already done the manifest, the host-side card component, and (if you want a real iframe) the data route. Each step below.

### 1. Manifest declarations

Three fields on `ezcorp.config.ts`:

```typescript
export default defineExtension({
  name: "my-extension",                      // ← namespace must match this
  // …
  tools: [{
    name: "open-thing",
    description: "Open the thing.",
    inputSchema: { type: "object", properties: {} },
    cardType: "my-thing",                    // ← (1) declares the card type
  }],
  permissions: {
    eventSubscriptions: ["my-extension:user-action"],   // ← (2) declares your event
  },
});
```

Two important rules the host enforces:

1. **Namespace must equal `manifest.name`.** The dispatcher rejects `eventSubscriptions: ["other-extension:foo"]` declarations — you can only subscribe to events in your own namespace. (Source: `event-subscription-dispatcher.ts:registerExtension`.)
2. **No platform-event collisions.** If your extension is named `tool` or `task` or `ask-user` (anything that prefixes a [direct-carrier event](../../src/runtime/sse-conversation-filter.ts)), you can't declare events that collide with the platform's. The dispatcher silently drops them.

### 2. Bundled-extension grant

If your extension ships in `BUNDLED_EXTENSIONS` ([src/extensions/bundled.ts](../../src/extensions/bundled.ts)), grant the same permissions you declared in the manifest:

```typescript
{
  name: "my-extension",
  path: "docs/extensions/examples/my-extension",
  permissions: {
    eventSubscriptions: ["my-extension:user-action"],
    grantedAt: { eventSubscriptions: Date.now() },
  },
},
```

**Without this**, the generic event route returns 404 for your event because the dispatcher reads from grants, not the manifest. (This is the most common Phase B / Phase C bug — both consumers initially missed it.)

### 3. Host-side Svelte card

Your `cardType` string maps to a Svelte component via [`tool-cards/utils.ts:getCardComponentName`](../../web/src/lib/components/tool-cards/utils.ts). Add one line:

```typescript
case 'my-thing': return 'MyThingCard';
```

Then create `web/src/lib/components/tool-cards/MyThingCard.svelte`. The cleanest path is to compose [`ExtensionIframeCard`](../../web/src/lib/components/tool-cards/ExtensionIframeCard.svelte) — it ships a sandboxed iframe + slottable sidebar:

```svelte
<script lang="ts">
  import type { ToolCallState } from "$lib/stores.svelte.js";
  import ExtensionIframeCard from "./ExtensionIframeCard.svelte";

  let { toolCall, conversationId = "" }: {
    toolCall: ToolCallState;
    conversationId?: string;
  } = $props();

  // Parse iframeSrc from the tool result.
  let iframeSrc = $derived(/* extract from toolCall.output */);
</script>

<ExtensionIframeCard {toolCall} {conversationId} {iframeSrc} extensionName="my-extension">
  {#snippet sidebar({ postEvent, busy })}
    <button onclick={() => postEvent("user-action", { thingId: "x", choice: "yes" })}>
      Confirm
    </button>
  {/snippet}
</ExtensionIframeCard>
```

`postEvent("user-action", { … })` POSTs to `/api/extensions/my-extension/events/user-action`, which validates auth, conversation ownership, and the manifest event allowlist before emitting on the bus. From there your `createCanvas`-registered handler picks it up.

### 4. (Optional) Data route for iframe content

If your card renders an iframe pointing at a generated artifact, the iframe needs a URL. Use the SDK's URL builder:

```typescript
import { extensionDataUrl } from "@ezcorp/sdk/runtime";
const url = extensionDataUrl("my-extension", "drafts/d-1.html");
// → "/api/extensions/my-extension/data/drafts/d-1.html"
```

The host's [`/api/extensions/[name]/data/[...path]`](../../web/src/routes/api/extensions/[name]/data/[...path]/+server.ts) route serves files from `<cwd>/.ezcorp/extension-data/my-extension/`. Auth, traversal protection, and a strict CSP header are applied automatically.

## End-to-end flow

```
┌─────────────────────────┐         ┌─────────────────────────┐
│  EXTENSION SUBPROCESS   │         │  HOST                   │
│                         │         │                         │
│  open-thing tool runs   │ ──────► │  Persists tool_calls,   │
│  returns toolResult     │         │  emits tool:start with  │
│  {cardType: "my-thing"} │         │  cardType.              │
└─────────────────────────┘         └─────────────────────────┘
                                              │
                                              ▼
                                    ┌─────────────────────────┐
                                    │  BROWSER                │
                                    │  ToolCardRouter mounts  │
                                    │  MyThingCard.svelte     │
                                    └─────────────────────────┘
                                              │
                                              ▼  user clicks
                                    ┌─────────────────────────┐
                                    │  POST /api/extensions/  │
                                    │  my-extension/events/   │
                                    │  user-action            │
                                    └─────────────────────────┘
                                              │
                                              ▼  validates + emits
┌─────────────────────────┐         ┌─────────────────────────┐
│  EXTENSION SUBPROCESS   │ ◄────── │  Bus emits              │
│                         │         │  my-extension:user-     │
│  createCanvas event     │         │  action.                │
│  handler unwraps frame, │         │  Dispatcher fans out    │
│  user code runs.        │         │  to subprocess.         │
└─────────────────────────┘         └─────────────────────────┘
```

## Wire format

The host emits events with a flat shape. `toolCallId` and `conversationId` are siblings of your user-defined data:

```json
{
  "toolCallId": "tc-xyz",
  "conversationId": "conv-abc",
  "thingId": "x",
  "choice": "yes"
}
```

The SDK's `createCanvas` handler receives the entire frame as `payload` AND extracts `toolCallId`/`conversationId` into a typed `context` for convenience:

```typescript
events: {
  "user-action": async ({ payload, context }) => {
    // payload.thingId, payload.choice (typed via the generic)
    // context.toolCallId, context.conversationId
  },
}
```

## Typed payloads

Pass an event-map type to `createCanvas` and your handlers get typed payloads — no casts at the boundary:

```typescript
type MyEvents = {
  "user-action": { thingId: string; choice: "yes" | "no" };
  "comment-added": { thingId: string; text: string };
};

createCanvas<MyEvents>({
  cardType: "my-thing",
  namespace: "my-extension",
  events: {
    "user-action": ({ payload }) => /* payload.choice is "yes" | "no" */,
    "comment-added": ({ payload }) => /* payload.text is string */,
  },
});
```

The generic is optional — without it, every payload is `unknown` (the pre-Phase-C-fix default).

## Security guarantees

The host enforces these without any per-extension code:

| Guarantee | Where it's enforced |
|---|---|
| iframe sandbox flags can't be downgraded | [`ExtensionIframeCard.svelte`](../../web/src/lib/components/tool-cards/ExtensionIframeCard.svelte) hardcodes `sandbox="allow-scripts allow-same-origin"` |
| Cross-origin iframe URLs refused | [`iframe-card-logic.ts:validateIframeSrc`](../../web/src/lib/components/tool-cards/iframe-card-logic.ts) |
| Path traversal blocked in `extensionDataUrl` and the data route | SDK's `extensionDataUrl` + host route's `path.resolve` prefix check |
| User-owns-conversation check | Both event and data routes call `getConversation(id)` and verify `userId` |
| `toolCallId` bound to `conversationId` | Generic events route looks up `tool_calls` and rejects mismatches (F2 from Phase A review) |
| Cross-namespace event forgery blocked | Dispatcher rejects `<other-ext>:<event>` declarations server-side (F1 + F3 from Phase B review) |
| Platform-event shadowing blocked | Extensions named `tool`/`task`/`ask-user` can't override platform events with custom ones |
| Per-extension rate limit (50 events/sec) | [`event-subscription-dispatcher.ts`](../../src/extensions/event-subscription-dispatcher.ts) token-bucket limiter |
| Per-user rate limit on extension content (240 reqs/min) | Data route `__rateLimiter` |
| CSRF | SvelteKit's same-origin POST + session cookie auth (default `csrf.checkOrigin: true`) |

**CSP caveat for served extension content.** The data route's `Content-Security-Policy` allows `'unsafe-inline'` and `'unsafe-eval'` in `script-src`, plus `cdn.jsdelivr.net` (for Tailwind in self-contained drafts). This is **deliberately relaxed** so generated HTML drafts can ship inline scripts without a build step. The trust model treats extension-authored content as **partially trusted** — `frame-ancestors 'self'` keeps it from being embedded by other origins, and the iframe sandbox flags (`allow-scripts allow-same-origin`) restrict cross-frame mischief. Don't ship secrets or unauthenticated APIs same-origin if you depend on this guarantee. The full CSP is in [`+server.ts`](../../web/src/routes/api/extensions/[name]/data/[...path]/+server.ts).

## Migrating from `registerEventHandler`

If your extension uses the legacy `registerEventHandler`, the migration is a single call site. Compare:

```typescript
// Before
import { registerEventHandler } from "@ezcorp/sdk/runtime";
registerEventHandler("my-extension:user-action", async (payload) => {
  // payload: unknown
});

// After
import { createCanvas } from "@ezcorp/sdk/runtime";
createCanvas<{ "user-action": MyPayload }>({
  cardType: "my-thing",
  namespace: "my-extension",
  events: {
    "user-action": async ({ payload, context }) => {
      // payload: MyPayload (typed via the generic)
      // context: { toolCallId, conversationId } (typed convenience)
    },
  },
});
```

The wire format is byte-equivalent — no behavior change. `ask-user` migrated in Phase C with no test breakage; `claude-design` was a fresh Phase B consumer.

## Common bugs (and the reviews that caught them)

| Symptom | Root cause | Fix |
|---|---|---|
| Event POST returns 404 | Extension not in `BUNDLED_EXTENSIONS` or grant missing | Add the bundled entry; see "Bundled-extension grant" above |
| `_setCreateCanvasForTests` swap doesn't take effect | Test imported the SDK before swap | Swap before calling `start()` |
| Tweak knob "applies" but iframe doesn't update | Body uses literal values, not CSS variables | Author body against `var(--*)` and `calc()` only |
| iframe shows "Cannot render preview" | `iframeSrc` is cross-origin or non-http(s) | Use `extensionDataUrl()`; URL is relative same-origin |
| Two consumers register same `<ns>:<event>` | Cross-namespace forgery — dispatcher rejects | Each extension declares only `<own-name>:<event>` |

## Dock layout

Set `cardLayout: "dock"` on a `ToolDefinition` to opt into the floating
right-side `DockHost` panel — a Slack/Linear-style sidecar (~50% viewport
on desktop, full-screen overlay on mobile) that lives at the app-layout
level. The same routed component (e.g. `DesignCanvasCard`) is mounted in
the dock; only its parent slot moves. Inline cards keep their existing
behavior.

```ts
{
  name: "open-canvas",
  description: "...",
  inputSchema: { ... },
  cardType: "design-canvas",
  cardLayout: "dock", // ← single line opts into the dock host
}
```

### What the host does for you

1. **Auto-replace.** The first dock-mode tool that completes opens the
   dock. Subsequent dock-mode completions in the same conversation
   REPLACE the dock content; the previous tool call's bubble shows a
   navigable "Canvas open ↗" pill that re-routes to that draft when
   clicked.
2. **Sidebar precedence.** The host snapshots the user's
   `sidebarCollapsed` preference, force-collapses the sidebar to give
   the dock breathing room, and restores the snapshot on close. If the
   user manually toggles the sidebar while the dock is open, that's
   "user wins" — close-on-dock skips the auto-restore.
3. **Streaming-precedence.** Running calls (`status === "running"`)
   always render inline so the user can watch progress. Only completed
   calls dock — the inline → dock handoff happens on `tool:complete`.
4. **Persistence.** Dock open-state survives a page reload (per-conv
   `localStorage["ezcorp-dock-state-<convId>"]`). The size is per-user
   (`localStorage["ezcorp-dock-size-px"]`).
5. **Mobile.** ≤640px viewport flips the dock to a full-screen overlay
   with swipe-to-dismiss (vertical-down or horizontal-right >80px). The
   close button stays available too.
6. **Debounce.** If multiple dock-mode tools complete within 500ms,
   only the last fires `openDock` — prevents flicker on multi-tool
   turns.
7. **Pop out to new tab.** If your tool's result includes an `iframeSrc`
   field (a relative path or same-origin absolute URL), the dock header
   shows a "Pop out" button that opens that URL in a new browser tab via
   `window.open(url, '_blank', 'noopener,noreferrer')`. Cross-origin or
   non-http(s) URLs are silently ignored — same policy as the embedded
   iframe. No extension code needed; the convention is the contract.
8. **Esc + close button.** The dock header's "Close" button and the Esc
   key both dismiss the dock. The closed `toolCallId` is marked
   "dismissed" in the store so the auto-open `$effect` doesn't fight the
   user; clicking the chat-history "Canvas open ↗" pill clears the flag
   and reopens.

### Security note

The component identity is the same in both inline and dock modes. The
iframe sandbox attribute (`allow-scripts allow-same-origin`) and the
`validateIframeSrc` cross-origin refusal are unchanged. Dock mode only
relaxes presentational CSS (border, min-height) — never the
`SANDBOX_FLAGS_STRICT` constant in `iframe-card-logic.ts`.

### Backwards compat

Pre-migration `tool_calls` rows have `card_layout = NULL`. The
`shouldRenderInDock` helper treats NULL as `"inline"`, so existing inline
cards (terminal, diff, ask-user, etc.) render exactly as today.

## Reference

- SDK: [`packages/@ezcorp/sdk/src/runtime/canvas.ts`](../../packages/@ezcorp/sdk/src/runtime/canvas.ts)
- SDK preview helpers: [`packages/@ezcorp/sdk/src/runtime/preview.ts`](../../packages/@ezcorp/sdk/src/runtime/preview.ts)
- Generic primitive: [`web/src/lib/components/tool-cards/ExtensionIframeCard.svelte`](../../web/src/lib/components/tool-cards/ExtensionIframeCard.svelte)
- Generic event route: [`web/src/routes/api/extensions/[name]/events/[event]/+server.ts`](../../web/src/routes/api/extensions/[name]/events/[event]/+server.ts)
- Generic data route: [`web/src/routes/api/extensions/[name]/data/[...path]/+server.ts`](../../web/src/routes/api/extensions/[name]/data/[...path]/+server.ts)
- Two consumers: [`claude-design`](examples/claude-design/index.ts), [`ask-user`](examples/ask-user/index.ts)
