#!/usr/bin/env bun
// kokoro-tts — bundled subprocess for the in-browser Kokoro TTS feature.
//
// Architecture:
//   1. User clicks the speaker icon on a turn (the `messageToolbar`
//      contribution declared in `ezcorp.config.ts`). The host computes
//      `selection` from the current DOM selection (clamped to the row
//      element, ≤ 4_000 chars) and POSTs `kokoro-tts:speak` on the bus
//      with `{ messageId, conversationId, content, selection }`.
//   2. This subprocess receives the event via `createCanvas` →
//      synthesises a body string + a `kokoro-tts.synthesize` tool-call,
//      and calls the `ezcorp/append-message` reverse RPC to insert an
//      excluded turn whose card is `kokoro-tts-player`. The card
//      receives `messageId` of the new row from its rendering context
//      (see `ToolCardRouter.svelte`), so the subprocess does NOT need
//      to round-trip the new id back through `input`.
//   3. The card runs `kokoro-js` in the browser, plays a blob URL
//      immediately, uploads the WAV via `/api/extensions/kokoro-tts/
//      uploads`, then POSTs `kokoro-tts:save` with `{ messageId,
//      toolCallId, attachmentId }`. This subprocess receives that and
//      calls the `ezcorp/finalize-tool-call` reverse RPC to mark the
//      tool-call complete and persist `attachmentId` in the output —
//      next render swaps the blob URL for a stable `/api/attachments/
//      <id>` URL that survives reload.
//
// Permission contract: `eventSubscriptions: ["kokoro-tts:speak",
// "kokoro-tts:save"]` (delivers both events) + `appendMessages: {
// excludedDefault: true }` (grants the append-message RPC). The host
// always forces `excluded: true` regardless of what's passed — the
// excludedDefault field is reserved for a future opt-in tier. No
// network, no filesystem, no shell — kokoro-js runs in the browser
// card, not in this subprocess.

import {
  createCanvas,
  getChannel,
} from "@ezcorp/sdk/runtime";

// ── Constants ──────────────────────────────────────────────────────

/** Per-request character cap. Mirrors the host-side selection cap so
 *  oversized inputs are clamped rather than rejected — Kokoro-js
 *  itself will choke on inputs much above this. */
const TTS_MAX_CHARS = 4_000;

// ── Capability bindings (swappable for tests) ──────────────────────
//
// The seam pattern mirrors `ask-user/index.ts` and `claude-design/
// index.ts`: tests inject a no-op `createCanvas` so `start()` can be
// invoked without opening stdin, and the tests below drive
// `_internals.handleSpeak` / `handleSave` directly.

type CreateCanvasFn = typeof createCanvas;
let createCanvasImpl: CreateCanvasFn = createCanvas;

/** Test-only: inject a fake createCanvas. */
export function _setCreateCanvasForTests(fake: CreateCanvasFn): void {
  createCanvasImpl = fake;
}

/** Test-only: restore the real SDK binding. */
export function _resetBindingsForTests(): void {
  createCanvasImpl = createCanvas;
}

// The reverse-RPC dispatch is also seamed so unit tests can assert the
// exact frame this subprocess emits without spinning up a real
// HostChannel. In production the seam delegates to `getChannel().request`.

type RpcRequestFn = (method: string, params: unknown) => Promise<unknown>;

let rpcRequestImpl: RpcRequestFn = (method, params) =>
  getChannel().request(method, params);

/** Test-only: inject a fake reverse-RPC dispatcher. */
export function _setRpcRequestForTests(fake: RpcRequestFn): void {
  rpcRequestImpl = fake;
}

/** Test-only: restore the real SDK-channel-backed dispatcher. */
export function _resetRpcRequestForTests(): void {
  rpcRequestImpl = (method, params) => getChannel().request(method, params);
}

// ── Speak handler ──────────────────────────────────────────────────
//
// Wire payload: { messageId, conversationId, content, selection? }
//   - `messageId` / `conversationId` are extracted by createCanvas into
//     the typed `context`, but the toolbar route does NOT pass a
//     `toolCallId` (this event isn't tied to an in-flight tool call).
//     Tests should send the same flat shape the host emits.
//   - `selection` is the clamped DOM selection (≤4_000 chars) when the
//     user had highlighted text on the row; otherwise omitted/null.
//   - `content` is the row's full body, also clamped server-side.
//
// We compute `text = (selection?.trim() || content).slice(0, 4_000)` so
// the truncation is explicit and the length annotation in the new
// turn's content string matches what the card will actually synthesise.

interface SpeakPayload {
  messageId: string;
  conversationId: string;
  content: string;
  selection?: string | null;
}

async function handleSpeak(payload: SpeakPayload): Promise<void> {
  const { messageId, conversationId, content, selection } = payload;
  if (typeof messageId !== "string" || messageId.length === 0) return;
  if (typeof conversationId !== "string" || conversationId.length === 0) return;
  if (typeof content !== "string") return;

  const trimmedSelection = typeof selection === "string" ? selection.trim() : "";
  const usedSelection = trimmedSelection.length > 0;
  const source = usedSelection ? trimmedSelection : content;
  const text = source.slice(0, TTS_MAX_CHARS);

  // Body string the user sees in the new excluded turn. The 🔊 here is
  // emitted at runtime, not in docs prose — fine to keep.
  const headerContent = `🔊 TTS of ${usedSelection ? "selection" : "message"} (${text.length} chars)`;

  try {
    await rpcRequestImpl("ezcorp/append-message", {
      conversationId,
      parentMessageId: messageId,
      role: "extension",
      content: headerContent,
      // Host force-applies `excluded: true` regardless; we pass it
      // explicitly to make intent clear at this call site.
      excluded: true,
      toolCalls: [
        {
          name: "kokoro-tts.synthesize",
          input: { text },
          cardType: "kokoro-tts-player",
          status: "running",
        },
      ],
    });
  } catch (err) {
    // Robust error logging — the host captures stderr. Don't crash the
    // subprocess: a single failed synth shouldn't take down the
    // toolbar entry point for the rest of the conversation.
    process.stderr.write(
      `[kokoro-tts] append-message failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ── Save handler ───────────────────────────────────────────────────
//
// Wire payload: { messageId, toolCallId, attachmentId }.
//   - The browser card POSTs this after `/api/extensions/kokoro-tts/
//     uploads` returns a stable attachment id.
//   - We finalize the tool-call so the next render swaps the blob URL
//     for `/api/attachments/<id>` (persists across reloads).

interface SavePayload {
  messageId: string;
  toolCallId: string;
  attachmentId: string;
}

async function handleSave(payload: SavePayload): Promise<void> {
  const { toolCallId, attachmentId } = payload;
  if (typeof toolCallId !== "string" || toolCallId.length === 0) return;
  if (typeof attachmentId !== "string" || attachmentId.length === 0) return;

  try {
    await rpcRequestImpl("ezcorp/finalize-tool-call", {
      toolCallId,
      output: { attachmentId },
      status: "complete",
    });
  } catch (err) {
    process.stderr.write(
      `[kokoro-tts] finalize-tool-call failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// Expose internals for unit tests.
export const _internals = {
  handleSpeak,
  handleSave,
  TTS_MAX_CHARS,
};

/**
 * Wire the canvas event handlers and start the channel. Extracted so
 * tests can cover the production wiring branch (the `import.meta.main`
 * gate alone is dead under `bun test`). Mirrors the `start()` pattern
 * used by `ask-user/index.ts` and `openai-image-gen-2/index.ts`.
 */
export function start(): void {
  const ch = getChannel();
  // Two events, one canvas registration. `cardType` here is the card
  // the speak handler INSERTS via append-message — it's the card the
  // toolbar contribution drives, even though the speak event itself
  // doesn't originate from a card render. Generic carries the typed
  // event-payload shapes.
  createCanvasImpl<{ speak: SpeakPayload; save: SavePayload }>({
    cardType: "kokoro-tts-player",
    namespace: "kokoro-tts",
    events: {
      speak: async ({ payload }) => {
        await handleSpeak(payload);
      },
      save: async ({ payload }) => {
        await handleSave(payload);
      },
    },
  });
  ch.start();
}

// Production wiring — gated on `import.meta.main` so test imports
// don't open stdin. Single-line form matches the openai-image-gen-2
// pattern that the coverage gate expects.
if (import.meta.main) start();
