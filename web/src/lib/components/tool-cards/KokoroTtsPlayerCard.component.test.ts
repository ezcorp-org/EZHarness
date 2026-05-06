/**
 * DOM tests for KokoroTtsPlayerCard.svelte.
 *
 * Three states under test:
 *   1. running — the card calls the kokoro-tts bridge, which (in
 *      production) postMessages a Worker. The bridge is mocked here
 *      so the test runs offline and never touches kokoro-js.
 *   2. persisted — output.attachmentId set → renders <audio> against
 *      /api/attachments/{id} immediately, no synthesis call.
 *   3. error — bridge rejects, retry button surfaces and re-runs the
 *      same flow (no new turn created).
 *
 * The bridge module (`$lib/workers/kokoro-tts-bridge`) is mocked via
 * `vi.mock()`. Mocking the bridge instead of kokoro-js directly is
 * cleaner: the card no longer talks to kokoro-js at all, and we can
 * stub the bridge's API surface (`synthesize(text, opts) → Blob`)
 * without duplicating the worker-protocol details in every test.
 *
 * URL.createObjectURL + revokeObjectURL are stubbed because jsdom's
 * implementations are thin (or absent) and the card calls them on
 * every blob round-trip.
 */

import { render, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import KokoroTtsPlayerCard from "./KokoroTtsPlayerCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte";

// ── Mocks ──────────────────────────────────────────────────────────

// "1 second of silence" stand-in — jsdom doesn't decode the bytes, so
// any non-empty Blob suffices for the playback contract.
function silentWavBlob(): Blob {
  const buf = new Uint8Array(44 + 16_000); // 44-byte header + zeros
  return new Blob([buf], { type: "audio/wav" });
}

// The bridge mock — `mockSynthesize` is the spy each test reads. It's
// indirected through a closure so beforeEach can re-bind the
// implementation per-test without redefining the mock module.
let mockSynthesizeImpl: (text: string, opts?: unknown) => Promise<Blob>;
// Typed as a callable mock so TS doesn't widen to the Constructable
// overload (`vi.fn`'s return type union of `Procedure | Constructable`
// is not invocable without a `new`-vs-call hint).
type SynthesizeFn = (text: string, opts?: unknown) => Promise<Blob>;
let mockSynthesize: ReturnType<typeof vi.fn<SynthesizeFn>>;

vi.mock("$lib/workers/kokoro-tts-bridge", () => {
  return {
    synthesize: (text: string, opts?: unknown) => mockSynthesize(text, opts),
  };
});

beforeEach(() => {
  // Default behaviour: resolve with a silent WAV after a microtask.
  mockSynthesizeImpl = async (_text: string, _opts?: unknown) =>
    silentWavBlob();
  mockSynthesize = vi
    .fn()
    .mockImplementation((text: string, opts?: unknown) =>
      mockSynthesizeImpl(text, opts),
    );

  // jsdom's URL.createObjectURL is undefined; stub both create + revoke
  // so the component's blob-URL lifecycle works.
  vi.stubGlobal(
    "URL",
    Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    }),
  );

  // fetch — handles both /uploads (multipart) and /events POSTs. Returns
  // 200 + a deterministic attachmentId so the upload + save chain
  // completes deterministically.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/uploads")) {
        return new Response(JSON.stringify({ attachmentId: "att-mock-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("/events/")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Helpers ────────────────────────────────────────────────────────

function makeToolCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
  return {
    id: "tc-1",
    toolName: "kokoro-tts.synthesize",
    status: "running",
    // messageId is plumbed through ToolCardRouter as a prop, NOT via input —
    // the kokoro-tts subprocess emits `input: { text }` only.
    input: { text: "Hello world." },
    startedAt: 0,
    cardType: "kokoro-tts-player",
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("KokoroTtsPlayerCard — persisted state", () => {
  test("output is a direct object → renders persisted audio without synthesis", async () => {
    const toolCall = makeToolCall({
      status: "complete",
      output: { attachmentId: "att-real-1" },
    });
    const { getByTestId } = render(KokoroTtsPlayerCard, { toolCall });
    const audio = getByTestId("kokoro-tts-audio-persisted");
    expect(audio).toBeInTheDocument();
    expect(audio).toHaveAttribute("src", "/api/attachments/att-real-1");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  test("output is a JSON string (DB-hydration path) → still recognised as persisted", async () => {
    // This is the shape `inlineToolStore.hydrateToolCalls` ships on
    // reload: `toolCallRowToSummary` extracts the inner text from the
    // `{ content: [{ type: "text", text }] }` envelope that
    // `handleFinalizeToolCallRpc` stores. The card receives a string,
    // not an object — and the previous code's `typeof out !== "object"`
    // bail-out caused it to re-synthesize on every page reload.
    const toolCall = makeToolCall({
      status: "complete",
      output: '{"attachmentId":"att-reload-2"}' as unknown as Record<string, unknown>,
    });
    const { getByTestId } = render(KokoroTtsPlayerCard, { toolCall });
    const audio = getByTestId("kokoro-tts-audio-persisted");
    expect(audio).toHaveAttribute("src", "/api/attachments/att-reload-2");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  test("output is the raw envelope → still recognised as persisted", async () => {
    // Defensive: the envelope normally gets unwrapped server-side, but
    // if it ever leaks through the card must NOT fall back to "running".
    const toolCall = makeToolCall({
      status: "complete",
      output: {
        content: [
          { type: "text", text: '{"attachmentId":"att-envelope-3"}' },
        ],
      },
    });
    const { getByTestId } = render(KokoroTtsPlayerCard, { toolCall });
    const audio = getByTestId("kokoro-tts-audio-persisted");
    expect(audio).toHaveAttribute("src", "/api/attachments/att-envelope-3");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });
});

describe("KokoroTtsPlayerCard — running state", () => {
  test("auto-runs synthesis on mount and renders blob-backed <audio>", async () => {
    const { findByTestId } = render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
      conversationId: "conv-1",
    });
    // The blob audio element appears once the bridge resolves and the
    // blob URL is created.
    const audio = await findByTestId("kokoro-tts-audio-blob");
    expect(audio).toHaveAttribute("src", "blob:mock");
    expect(mockSynthesize).toHaveBeenCalled();
    // The card forwards the parsed text + the af_bella voice (the
    // plan's locked-in default).
    expect(mockSynthesize.mock.calls[0]?.[0]).toBe("Hello world.");
    const opts = mockSynthesize.mock.calls[0]?.[1] as { voice: string };
    expect(opts.voice).toBe("af_bella");
  });

  test("uploads the WAV and posts the save event after synthesis", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
      conversationId: "conv-1",
      messageId: "msg-1",
    });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("/api/extensions/kokoro-tts/uploads"))).toBe(true);
      // URL is the bare suffix `/save`, not `/kokoro-tts:save` — the
      // route reconstructs the namespace from `${name}:${event}`
      // server-side. Forwarding the full namespaced name 404'd in
      // production (PARAM_REGEX rejects colons).
      expect(calls.some((u) => u.includes("/api/extensions/kokoro-tts/events/save"))).toBe(true);
    });
    // Pin the EXACT save-event URL — the bare suffix `/save`, not the
    // namespaced `/kokoro-tts:save`. The route's URL-param regex
    // (PARAM_REGEX in the [event] route) rejects colons, so the raw
    // namespaced form 404s. Mirror the comment in the production
    // KokoroTtsPlayerCard.svelte.
    const saveCallUrl = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/events/"));
    expect(saveCallUrl).toBe("/api/extensions/kokoro-tts/events/save");
    expect(saveCallUrl).not.toContain(":save");
    expect(saveCallUrl).not.toContain("kokoro-tts:");
    // The save event body carries conversationId + toolCallId +
    // attachmentId + messageId. `conversationId` is mandatory: the
    // route's body schema (`eventBodySchema` in
    // `routes/api/extensions/[name]/events/[event]/+server.ts`)
    // anchors the ownership check on it before the finalize-tool-call
    // handler runs — omitting it produces 400 "Invalid body".
    const saveCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/events/save"),
    );
    expect(saveCall).toBeTruthy();
    const body = JSON.parse((saveCall?.[1] as { body: string }).body) as {
      conversationId: string;
      toolCallId: string;
      attachmentId: string;
      messageId: string;
    };
    expect(body.conversationId).toBe("conv-1");
    expect(body.toolCallId).toBe("tc-1");
    expect(body.attachmentId).toBe("att-mock-1");
    expect(body.messageId).toBe("msg-1");
  });

  test("synthesizing label shows before audio is ready", () => {
    // Make the bridge hang so we can observe the running state.
    mockSynthesize = vi.fn().mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
    });
    expect(getByTestId("kokoro-tts-synthesizing")).toBeInTheDocument();
  });

  test("loading-phase callback flips the label to 'Loading model…'", async () => {
    // Synthesize hangs after firing onLoading("model") — gives the
    // test a chance to observe the intermediate "Loading model…"
    // label that the worker exposes during the WASM-compile phase.
    mockSynthesize = vi.fn().mockImplementation((_text, opts: { onLoading?: (p: string) => void }) => {
      opts?.onLoading?.("model");
      return new Promise(() => {});
    });
    const { findByTestId } = render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
    });
    const label = await findByTestId("kokoro-tts-synthesizing");
    expect(label.textContent ?? "").toMatch(/Loading model/);
  });
});

describe("KokoroTtsPlayerCard — error state + retry", () => {
  test("synthesis failure surfaces an error block with a Retry button", async () => {
    mockSynthesize = vi.fn().mockRejectedValue(new Error("model unavailable"));
    const { findByTestId, getByTestId } = render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
    });
    const errorBlock = await findByTestId("kokoro-tts-error");
    expect(errorBlock).toHaveTextContent(/model unavailable/);
    expect(getByTestId("kokoro-tts-retry")).toBeInTheDocument();
  });

  test("Retry re-runs synthesis without creating a new turn", async () => {
    let attempt = 0;
    mockSynthesize = vi.fn().mockImplementation(async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient");
      return silentWavBlob();
    });
    const { findByTestId } = render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
      conversationId: "conv-1",
    });
    const retryBtn = await findByTestId("kokoro-tts-retry");
    await fireEvent.click(retryBtn);
    // Second attempt produces audio.
    const audio = await findByTestId("kokoro-tts-audio-blob");
    expect(audio).toHaveAttribute("src", "blob:mock");
    expect(mockSynthesize).toHaveBeenCalledTimes(2);
  });
});
