import { defineExtension } from "../../../../src/extensions/sdk/define";

// kokoro-tts — bundled extension that contributes a speaker icon to the
// per-message action toolbar via the `messageToolbar` extension point.
// Click → host POSTs `kokoro-tts:speak` on the bus → this subprocess
// receives the event and calls the `ezcorp/append-message` reverse RPC
// to insert an excluded turn whose `kokoro-tts-player` card runs
// kokoro-js in the browser. The card persists the synthesised audio via
// a `kokoro-tts:save` callback that finalises the tool call.
//
// Permission contract:
//   - `eventSubscriptions: ["kokoro-tts:speak", "kokoro-tts:save"]`
//     wires the dispatcher to deliver both events to this subprocess.
//     `:speak` originates from the toolbar click; `:save` originates
//     from the browser card after the upload completes.
//   - `appendMessages: { excludedDefault: true }` grants the
//     `ezcorp/append-message` reverse RPC. `excludedDefault` is
//     reserved for a future opt-in tier — the host always forces
//     `excluded: true` regardless of this field's value.
//
// The bundled-grant entry in `src/extensions/bundled.ts:285` MUST mirror
// these fields exactly. Without the matching grant the dispatcher
// returns 404 for the event POST — same footgun as canvas-cards.

export default defineExtension({
  schemaVersion: 2,
  name: "kokoro-tts",
  version: "1.0.0",
  description:
    "In-browser Kokoro-TTS. Adds a speaker icon to message toolbars.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  // Subprocess is short-lived: each `:speak`/`:save` event is independent
  // and there's no per-process state to retain. Setting `persistent:
  // false` lets the host reap the subprocess between bursts.
  persistent: false,
  messageToolbar: [
    {
      id: "speak",
      icon: "Volume2",
      tooltip: "Read aloud (selection or full message)",
      appliesTo: "both",
      // Show the speaker on both the per-message hover toolbar AND the
      // multi-select bulk action bar. In single mode the route receives
      // `messageId` + `selection` (or full content); in bulk mode it
      // receives `messageIds[]` + concatenated content of every
      // selected turn. The card flow is identical for both — one new
      // excluded turn with one audio player synthesizing the supplied
      // text.
      appliesToSelection: "both",
      // Event name MUST be prefixed with `kokoro-tts:` (the
      // event-subscription-dispatcher namespace rule) AND must also be
      // present in `permissions.eventSubscriptions` below.
      event: "kokoro-tts:speak",
    },
  ],
  permissions: {
    eventSubscriptions: ["kokoro-tts:speak", "kokoro-tts:save"],
    appendMessages: { excludedDefault: true },
  },
  settings: {
    voice: {
      type: "select",
      label: "Voice",
      description:
        "Speaker timbre used for synthesis. Curated subset of the Kokoro voice catalogue.",
      options: [
        { value: "af_bella", label: "Bella (US, female)" },
        { value: "af_sarah", label: "Sarah (US, female)" },
        { value: "am_adam", label: "Adam (US, male)" },
        { value: "bf_emma", label: "Emma (UK, female)" },
        { value: "bm_george", label: "George (UK, male)" },
      ],
      default: "af_bella",
    },
    speed: {
      type: "number",
      label: "Playback speed",
      description: "1.0 = natural; <1 slower, >1 faster.",
      min: 0.5,
      max: 2.0,
      step: 0.05,
      default: 1.0,
    },
  },
});
