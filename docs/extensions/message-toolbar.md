# Message Toolbar

Contribute an icon to the per-turn action toolbar — the same row that owns copy / regenerate / edit / branch / exclude / save-to-memory. A click on your icon delivers an event to your subprocess; from there you typically call the `ezcorp/append-message` reverse RPC to insert a follow-up turn the user can see, hear, or interact with.

This is the SDK surface for any per-message extension that doesn't fit a canvas card — read-aloud, send-to-Slack, summarize, translate-in-place, you name it.

## When to use a message-toolbar contribution

| Use a message toolbar when | Use a canvas card when | Use an agent skill when |
|---|---|---|
| The action is per-turn (each row gets its own icon) | The result is a freshly opened, interactive UI (knob sliders, embedded iframe) | The behaviour is part of the LLM's reasoning loop |
| The trigger is a user-driven click on the row | The trigger is the LLM choosing your tool | The LLM should decide when to invoke |
| The action emits a follow-up turn (excluded, by default) or a side-effect | Bidirectional events flow back from the open card into your subprocess | No persistent UI is needed |

The reference implementation in this repo is **`kokoro-tts`** ([code](examples/kokoro-tts/index.ts)) — a speaker icon that, when clicked, synthesises an audio turn below the source row using `kokoro-js` in the browser.

## The 5-line example

```typescript
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

That's the whole subprocess wiring. Everything else is the manifest, the bundled-extension grant, and the host-side card that runs in the new turn.

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

The card runs in the browser bundle — this is where in-browser TTS, image rendering, or any other heavy client-side work belongs. The subprocess stays light and only handles the event → reverse-RPC plumbing.

## Selection capture rules

When the user clicks your toolbar icon, the host computes `selection` from the current DOM selection and includes it in the event payload alongside `content` (the full row body). The rules:

| Rule | Why |
|---|---|
| Selection is **clamped to the row's DOM element** — text outside the message bubble is dropped | A single click shouldn't hand your extension content from a neighbouring turn |
| Selection is **truncated at 4 000 chars** | Mirrors the cap most TTS / summarize models impose; keeps payloads predictable |
| Empty / whitespace-only selection becomes `null` | Lets your handler fall back to `content` with a single `selection?.trim() || content` check |
| Selection is delivered as **plain text** (no HTML, no markdown) | Same as `window.getSelection().toString()` would return |

In your handler, the canonical pattern is one line:

```typescript
const text = (payload.selection?.trim() || payload.content).slice(0, 4_000);
```

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
| Click POST validates auth + conversation ownership before emitting | [`web/src/routes/api/extensions/[name]/events/[event]/+server.ts`](../../web/src/routes/api/extensions/[name]/events/[event]/+server.ts) |
| Selection capped at 4 000 chars (server-side, never trust the client) | Generic event route's payload guard |
| `appendMessages` RPC requires the matching grant (`-32001` otherwise) | Reverse-RPC handler at the host |
| Conversation scope forced — extension cannot target another conversation | `ezcorp/append-message` substitutes the wired conversation server-side |
| `excluded: true` forced on every authored turn | Same handler, regardless of what the extension passes |
| Attachment re-attribution validates the user owns each id | `message_attachments` lookup before the row insert commits |
| Cross-namespace event forgery in `eventSubscriptions` blocked | Dispatcher rejects unknown / cross-namespace declarations |

## Worked example

The full flow for `kokoro-tts` lives at [`docs/extensions/examples/kokoro-tts/`](examples/kokoro-tts/). The browser-side TTS happens in [`web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte`](../../web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte) — that's where `kokoro-js` runs, a `<audio controls>` element renders the synthesised WAV, the upload to `/api/extensions/kokoro-tts/uploads` happens, and the `kokoro-tts:save` event closes the loop by finalising the tool call's `attachmentId`.

## Common bugs

| Symptom | Root cause | Fix |
|---|---|---|
| Click POST returns 404 | Extension not in `BUNDLED_EXTENSIONS` or `grantedAt.eventSubscriptions` missing | Add the bundled entry with the `grantedAt` timestamp; see § Bundled-extension grant |
| `messageToolbar[0].event must be prefixed with "<name>:"` at install | Event name doesn't match the manifest's namespace | Prefix with your `manifest.name` followed by `:` |
| `messageToolbar[0].event "<event>" must also be listed in permissions.eventSubscriptions` | Toolbar event missing from the allowlist | Copy the event string into `permissions.eventSubscriptions` |
| Subprocess receives the speak event but the new turn never appears | `appendMessages` permission missing or `grantedAt.appendMessages` not set | Add the grant in `bundled.ts` (or have the user re-approve) |
| User says "the audio re-feeds itself into the next reply" | Excluded-turn pill not rendering, or you set `excluded: false` somewhere upstream | The host forces `excluded: true`; if the pill is missing, that's a host bug — don't try to work around it from the extension |

## Reference

- SDK: [`packages/@ezcorp/sdk/src/runtime/canvas.ts`](../../packages/@ezcorp/sdk/src/runtime/canvas.ts) (the same `createCanvas` helper drives both canvas cards and message-toolbar events)
- Manifest validator: [`src/extensions/manifest.ts:validateMessageToolbarArray`](../../src/extensions/manifest.ts)
- Reverse RPC: [`ezcorp/append-message`](api-reference.md#reverse-rpc-ezcorpappend-message), [`ezcorp/finalize-tool-call`](api-reference.md#reverse-rpc-ezcorpfinalize-tool-call)
- Worked example: [`docs/extensions/examples/kokoro-tts/`](examples/kokoro-tts/) — manifest, subprocess, tests
- Browser card: [`web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte`](../../web/src/lib/components/tool-cards/KokoroTtsPlayerCard.svelte)
