# Message Toolbar

Contribute an icon to the per-turn action toolbar — the same row that owns copy / regenerate / edit / branch / exclude / save-to-memory. Registering a `messageToolbar` contribution in your manifest surfaces the icon on every chat row. On click, the browser POSTs the event to the generic extension-events route, which **currently handles the follow-up turn in-process** and inserts an excluded turn below the clicked row.

> **Status — one working shape today (Phase 2 pending).** The per-click append is
> currently **hard-coded to the kokoro-tts shape**: the host builds a
> `<name>.synthesize` tool call inside a `<name>-player` card with a
> `🔊 TTS of … (N chars)` body, and does **not** dispatch the click to your
> subprocess. The generic model — where your own subprocess handler runs and
> emits your own `cardType` — is intended but **not wired yet** (see
> **Status / not yet wired (Phase 2)** below). Until it lands, **`kokoro-tts` is
> the only contribution that renders a meaningful result**: a non-TTS extension
> that registers a `messageToolbar` icon (read-aloud, send-to-Slack, summarize,
> translate-in-place, …) will still get a fixed TTS-player-shaped turn, and its
> custom subprocess handler will never be invoked for this path.

## When to use a message-toolbar contribution

| Use a message toolbar when | Use a canvas card when | Use an agent skill when |
|---|---|---|
| The action is per-turn (each row gets its own icon) | The result is a freshly opened, interactive UI (knob sliders, embedded iframe) | The behaviour is part of the LLM's reasoning loop |
| The trigger is a user-driven click on the row | The trigger is the LLM choosing your tool | The LLM should decide when to invoke |
| The action emits a follow-up turn (excluded, by default) or a side-effect | Bidirectional events flow back from the open card into your subprocess | No persistent UI is needed |

The reference implementation in this repo is **`kokoro-tts`** ([code](examples/kokoro-tts/index.ts)) — a speaker icon that, when clicked, synthesises an audio turn below the source row using `kokoro-js` in the browser.

## What actually happens on click (today)

When the user clicks a `messageToolbar` icon, the browser POSTs to the generic
event route
([`/api/extensions/[name]/events/[event]`](../../web/src/routes/api/extensions/[name]/events/[event]/+server.ts)).
A messageToolbar event is discriminated by carrying `messageId` (single row) or
`messageIds[]` (bulk multi-select) and **never** a `toolCallId`. In that branch
the route does everything **in-process and never notifies your subprocess**
(route lines ~343-598):

1. Look up the extension; reject if unknown/disabled (`404`).
2. Auto-wire the extension into the conversation (inserts the
   `conversation_extensions` row if missing) so later bookkeeping lines up.
3. Require the `appendMessages` grant — **missing grant → HTTP `403`
   "Extension lacks appendMessages permission"** (an explicit failure returned
   from the click POST, not a silently-missing turn).
4. Compute `text = (selection?.trim() || content).slice(0, 4_000)` and call the
   `ezcorp/append-message` handler directly (the same handler a subprocess would
   reach over reverse-RPC — same permission ladder, same forced `excluded: true`).
5. Emit `run:turn_saved` on the bus so the chat UI re-fetches and renders the
   new row.

The inserted turn is **hard-coded to the kokoro-tts shape for every extension**
(route lines ~446-524):

```typescript
// host-side, inside the events route — NOT your subprocess:
content: `🔊 TTS of ${headerSubject} (${text.length} chars)`,
toolCalls: [{
  name: `${name}.synthesize`,      // e.g. "kokoro-tts.synthesize"
  input: { text },
  cardType: `${name}-player`,      // e.g. "kokoro-tts-player"
  status: "running",
}],
```

`kokoro-tts` still ships a subprocess ([`index.ts`](examples/kokoro-tts/index.ts))
that registers `speak`/`save` handlers via `createCanvas`, but for the
messageToolbar path those handlers are **not invoked in production** — the route
performs both the append and the later `:save` finalize in-process. (The route
does spawn and RPC-wire the subprocess as a residual step, but sends it no
event.) Because the emitted `cardType` is `${name}-player` with a `synthesize`
tool-call carrying `{ text }`, only an extension shaped exactly like
`kokoro-tts` produces a working result.

## Status / not yet wired (Phase 2)

Everything in this section describes the **intended** generic model. It is **not
wired in the current code** — do not build against it yet. The events route's
own comment (lines ~423-426) states the plan verbatim:

> Phase 2 (future): generalize this with manifest-declared
> `messageToolbar[i].action` fields (cardType, toolName, contentTemplate) so
> other extensions can opt in. For now every messageToolbar contribution gets
> the kokoro-tts shape.

The intended shape: a click delivers the event to **your** subprocess, which
calls `ezcorp/append-message` with **your** `cardType`. This is exactly the
handler `kokoro-tts`'s subprocess already declares (and what the host currently
performs in-process on its behalf):

```typescript
// INTENDED (Phase 2) — this handler is NOT reached for messageToolbar today.
import { createCanvas, getChannel } from "@ezcorp/sdk/runtime";

createCanvas<{ speak: { messageId: string; conversationId: string; content: string; selection?: string } }>({
  cardType: "kokoro-tts-player",
  namespace: "kokoro-tts",     // MUST equal manifest.name
  events: {
    speak: async ({ payload }) => {
      const text = (payload.selection?.trim() || payload.content).slice(0, 4_000);
      await getChannel().request("ezcorp/append-message", {
        conversationId: payload.conversationId,
        parentMessageId: payload.messageId,
        role: "extension",
        content: `🔊 TTS of message (${text.length} chars)`,
        toolCalls: [{
          name: "kokoro-tts.synthesize",
          input: { text },
          cardType: "kokoro-tts-player",
          status: "running",
        }],
      });
    },
  },
});
getChannel().start();
```

Until the generic dispatch lands, a non-kokoro extension that registers this
handler will find it **never invoked** for the messageToolbar path, and the host
will emit the fixed TTS-player-shaped turn instead. Note the contrast:
**canvas-card events** (which carry a `toolCallId`) *do* reach subprocess
handlers via `getBus().emit(fullEventName)` today (route lines ~646-657) — only
the messageToolbar path is short-circuited in-process.

## What you also need

### 1. Manifest declarations

Two coupled fields on `ezcorp.config.ts`:

```typescript
export default defineExtension({
  name: "kokoro-tts",                         // ← namespace must match this
  // …
  messageToolbar: [{
    id: "speak",                              // ← (1) declares the toolbar entry
    icon: "Volume2",                          //     lucide icon name
    tooltip: "Read aloud (selection or full message)",
    appliesTo: "both",                        //     "user" | "assistant" | "both"
    appliesToSelection: "both",               //     "single" | "bulk" | "both" (optional)
    event: "kokoro-tts:speak",                //     event POSTed on click
  }],
  permissions: {
    eventSubscriptions: ["kokoro-tts:speak", "kokoro-tts:save"],   // ← (2) declares your events
    appendMessages: { excludedDefault: true },                     // ← (3) grants the reverse RPC
  },
});
```

Two rules the manifest validator enforces — both with the exact error string the install flow surfaces:

1. **Event-namespace rule.** `messageToolbar[i].event` must be prefixed with the manifest's `name:` (`kokoro-tts:` in the example). Cross-namespace events are rejected with `messageToolbar[i].event must be prefixed with "<name>:" (event-subscription-dispatcher namespace rule)`. This mirrors the same constraint the dispatcher already enforces for `permissions.eventSubscriptions`.
2. **Allowlist rule.** `messageToolbar[i].event` must also be listed in `permissions.eventSubscriptions`. The error reads `messageToolbar[i].event "<event>" must also be listed in permissions.eventSubscriptions`. This is the manifest-time defense in depth that catches the common typo where the toolbar entry references an event the dispatcher doesn't deliver.

### 2. Bundled-extension grant

If your extension ships in `BUNDLED_EXTENSIONS` ([src/extensions/bundled.ts](../../src/extensions/bundled.ts)), grant the same permissions you declared in the manifest — including a `grantedAt` timestamp for each:

```typescript
{
  name: "kokoro-tts",
  path: "docs/extensions/examples/kokoro-tts",
  permissions: {
    eventSubscriptions: ["kokoro-tts:speak", "kokoro-tts:save"],
    appendMessages: { excludedDefault: true },
    grantedAt: {
      eventSubscriptions: Date.now(),
      appendMessages: Date.now(),
    },
  },
},
```

**Without `grantedAt`**, the dispatcher rejects the click event because the runtime allowlist reads from `granted_permissions`, not the manifest. This is the same footgun called out in **[Canvas Cards § Bundled-extension grant](canvas-cards.md#2-bundled-extension-grant)** — both Phase B and Phase C consumers have hit it on first try. The fix is one line per permission key.

### 3. Host-side card (for follow-up turns that render UI)

Whatever `cardType` you pass in `appendMessages`'s `toolCalls[]` resolves to a Svelte component via [`tool-cards/utils.ts:getCardComponentName`](../../web/src/lib/components/tool-cards/utils.ts). Add one line:

```typescript
case 'kokoro-tts-player': return 'KokoroTtsPlayerCard';
```

Then create `web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte` — see [`KokoroTtsPlayerCard.svelte`](../../web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte) for the worked example. The card receives `messageId` of the row it renders in via the standard `ToolCardRouter` props, so your card has everything it needs to upload artifacts back through the host without round-tripping the id through the tool input.

The card runs in the browser bundle — this is where in-browser TTS, image rendering, or any other heavy client-side work belongs. Today the host performs the `append-message` bookkeeping in-process (see [What actually happens on click](#what-actually-happens-on-click-today)), so no subprocess round-trip is involved on click; the `<name>-player` card your turn references still resolves and renders here in the browser exactly as above.

## Selection capture rules

When the user clicks your toolbar icon, the host computes `selection` from the current DOM selection and includes it in the event payload alongside `content` (the full row body). The rules:

| Rule | Why |
|---|---|
| Selection is **clamped to the row's DOM element** — text outside the message bubble is dropped | A single click shouldn't hand your extension content from a neighbouring turn |
| Selection is **truncated at 4 000 chars** | Mirrors the cap most TTS / summarize models impose; keeps payloads predictable |
| Empty / whitespace-only selection becomes `null` | Lets your handler fall back to `content` with a single `selection?.trim() || content` check |
| Selection is delivered as **plain text** (no HTML, no markdown) | Same as `window.getSelection().toString()` would return |

The host applies this rule itself today — the events route computes the
equivalent one-liner before appending the turn:

```typescript
const text = (selection?.trim() || content).slice(0, 4_000);
```

(Once the generic subprocess path lands, your own handler would apply the same
one-liner over its typed `payload` — as `kokoro-tts`'s `index.ts` already does.)

## Excluded-turn UI affordance

Every turn authored via `ezcorp/append-message` is forced to `excluded: true` (the host strips and overrides whatever the extension passes). The host renders an **"Excluded from chat context"** pill on the new row — not a hidden flag, a visible signal that the turn won't be replayed back to the LLM on the next user message. Existing strikethrough styling continues to apply via the `excluded` flag; the pill is the new, explicit signal users notice.

This matters for the kokoro-tts case specifically — the audio turn is meant for the user's ear, not the model's context window. A model that re-ingested its own TTS output as text would loop on `🔊 TTS of message (N chars)` headers forever. The pill makes this contract visible.

If you author turns that the user expects to be conversation-relevant (e.g. an extension that translates on-demand), reconsider the `messageToolbar` shape — that's an agent-tool concern, not a per-turn user action.

## Visibility model — global, not per-conversation

`messageToolbar` contributions appear on every chat row in every conversation as soon as the extension is **installed and enabled**. There is no per-conversation wiring step (unlike canvas-card flows, which gate on `conversation_extensions` so the LLM gets exposed to the extension's tools).

Why: the icon is a USER-facing UI affordance, not an LLM tooling integration. Wiring requirements exist so the LLM gets exposed to tools and so composer-attachment caps line up — neither applies to a per-row click target. Treating the icon like the built-in `copy`/`regenerate` buttons (always visible) gives the right UX.

The `GET /api/conversations/[id]/extension-toolbar` endpoint enumerates all enabled installed extensions and unions their `messageToolbar[]` items, clamped to each manifest's `eventSubscriptions` allowlist as a defense-in-depth check.

## Security gates summary

The host enforces these without any per-extension code:

| Guarantee | Where it's enforced |
|---|---|
| Event-namespace forgery (`<other-ext>:<event>`) blocked at manifest validation | [`src/extensions/manifest.ts:validateMessageToolbarArray`](../../src/extensions/manifest.ts) |
| Click POST validates auth + conversation ownership before appending / emitting | [`web/src/routes/api/extensions/[name]/events/[event]/+server.ts`](../../web/src/routes/api/extensions/[name]/events/[event]/+server.ts) |
| Selection capped at 4 000 chars (server-side, never trust the client) | Generic event route's payload guard |
| `appendMessages` grant required — messageToolbar path returns HTTP `403` as a pre-check at the click POST; the reverse-RPC path (canvas cards) surfaces `-32001` | Events route pre-check + reverse-RPC handler |
| Conversation scope forced — extension cannot target another conversation | `ezcorp/append-message` substitutes the wired conversation server-side |
| `excluded: true` forced on every authored turn | Same handler, regardless of what the extension passes |
| Attachment re-attribution validates the user owns each id | `message_attachments` lookup before the row insert commits |
| Cross-namespace event forgery in `eventSubscriptions` blocked | Dispatcher rejects unknown / cross-namespace declarations |

## Worked example

The full flow for `kokoro-tts` lives at [`docs/extensions/examples/kokoro-tts/`](examples/kokoro-tts/). The browser-side TTS happens in [`web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte`](../../web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte) — that's where `kokoro-js` runs, a `<audio controls>` element renders the synthesised WAV, the upload to `/api/extensions/kokoro-tts/uploads` happens, and the `kokoro-tts:save` POST closes the loop — the events route finalises the tool call's `attachmentId` **in-process** via `handleFinalizeToolCallRpc` (again bypassing the subprocess), so the next render swaps the blob URL for a stable `/api/attachments/<id>` URL.

## Common bugs

| Symptom | Root cause | Fix |
|---|---|---|
| Click POST returns 404 | Extension not in `BUNDLED_EXTENSIONS` or `grantedAt.eventSubscriptions` missing | Add the bundled entry with the `grantedAt` timestamp; see § Bundled-extension grant |
| `messageToolbar[0].event must be prefixed with "<name>:"` at install | Event name doesn't match the manifest's namespace | Prefix with your `manifest.name` followed by `:` |
| `messageToolbar[0].event "<event>" must also be listed in permissions.eventSubscriptions` | Toolbar event missing from the allowlist | Copy the event string into `permissions.eventSubscriptions` |
| Click POST returns `403 "Extension lacks appendMessages permission"` | `appendMessages` grant missing or `grantedAt.appendMessages` not set — the host requires the grant before the in-process append, so no turn is created (the subprocess is never reached) | Add the grant in `bundled.ts` (or have the user re-approve) |
| User says "the audio re-feeds itself into the next reply" | Excluded-turn pill not rendering, or you set `excluded: false` somewhere upstream | The host forces `excluded: true`; if the pill is missing, that's a host bug — don't try to work around it from the extension |

## Reference

- SDK: [`packages/@ezcorp/sdk/src/runtime/canvas.ts`](../../packages/@ezcorp/sdk/src/runtime/canvas.ts) (the `createCanvas` helper `kokoro-tts` uses to register its `speak`/`save` handlers — invoked for canvas-card events today; for the messageToolbar path the host does the append/finalize in-process, so those handlers are **not** reached — see *Status / not yet wired (Phase 2)*)
- Manifest validator: [`src/extensions/manifest.ts:validateMessageToolbarArray`](../../src/extensions/manifest.ts)
- Reverse RPC: [`ezcorp/append-message`](api-reference.md#reverse-rpc-ezcorpappend-message), [`ezcorp/finalize-tool-call`](api-reference.md#reverse-rpc-ezcorpfinalize-tool-call)
- Worked example: [`docs/extensions/examples/kokoro-tts/`](examples/kokoro-tts/) — manifest, subprocess, tests
- Browser card: [`web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte`](../../web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte)
