# kokoro-tts Extension

Bundled extension that contributes a speaker icon to the per-message
action toolbar via the `messageToolbar` extension point. Click → an
excluded turn is inserted with a `kokoro-tts-player` card that runs
[`kokoro-js`](https://www.npmjs.com/package/kokoro-js) in the browser
to synthesize WAV audio from the highlighted selection (or the full
message body if nothing is highlighted).

This is the worked example for **[Message Toolbar](../../message-toolbar.md)**.

## Install

This extension is bundled — it auto-installs on first startup. No
manual install is needed.

## What it adds

- A speaker icon (`Volume2`) in every message's toolbar (both user and
  assistant turns).
- Each click inserts a new **excluded** turn below the source row. The
  audio is rendered in the `KokoroTtsPlayerCard.svelte` host card, not
  in this subprocess.

## Settings

Configurable per-user from `/extensions/<id>` (admins set the global
default; each user can override).

- **Voice** — speaker timbre used for synthesis. Curated subset of the
  Kokoro voice catalogue:
  - `af_bella` — Bella (US, female) **(default)**
  - `af_sarah` — Sarah (US, female)
  - `am_adam` — Adam (US, male)
  - `bf_emma` — Emma (UK, female)
  - `bm_george` — George (UK, male)
- **Playback speed** — number, range `[0.5, 2.0]`, step `0.05`,
  default `1.0`. Forwarded to `kokoro-js`'s `generate()` call as the
  `speed` option.

The host card resolves these via the per-extension settings store the
chat layout hydrates on load — picking a different voice + speed and
clicking the speaker icon synthesises with the user's chosen values.

## Known limits

- Up to **4 000 characters** per request. Anything longer is truncated
  before synthesis (the new turn's content header reports the clamped
  length).
- Audio is uploaded as **`audio/wav`** with a 25 MB cap (enforced by
  the upload route).
- `kokoro-js` lazily downloads its **~80 MB ONNX model** on the first
  use of the speaker icon. Subsequent clicks use the browser cache.
- The new turn is forced to `excluded: true` — its content is not
  replayed back to the LLM. The host renders an "Excluded from chat
  context" pill so users see the audio is local-only.

## Testing

```bash
bun test docs/extensions/examples/kokoro-tts/index.test.ts
```

Tests cover the speak handler (selection vs. full message, length
clamp, RPC failure logging), the save handler (toolCallId + attachment
id), and the `start()` wiring contract (createCanvas shape).
