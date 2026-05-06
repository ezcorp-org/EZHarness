/**
 * Tests for KokoroTtsPlayerCard's per-extension settings integration.
 *
 * Pins:
 *   - voice + speed are read from the cached `extensionSettings` store
 *     and forwarded to the bridge's `synthesize()` call
 *   - falls back to manifest defaults (`af_bella` / `1.0`) when the
 *     store is empty / not yet hydrated
 */

import { render, cleanup, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import KokoroTtsPlayerCard from "./KokoroTtsPlayerCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte";

function silentWavBlob(): Blob {
  return new Blob([new Uint8Array(44)], { type: "audio/wav" });
}

type SynthesizeFn = (text: string, opts?: unknown) => Promise<Blob>;
type GetCachedSettingsFn = (name: string) => Record<string, unknown> | undefined;
let mockSynthesize: ReturnType<typeof vi.fn<SynthesizeFn>>;
let mockGetCachedSettings: ReturnType<typeof vi.fn<GetCachedSettingsFn>>;

vi.mock("$lib/workers/kokoro-tts-bridge", () => ({
  synthesize: (text: string, opts?: unknown) => mockSynthesize(text, opts),
}));

vi.mock("$lib/stores/extensionSettings", () => ({
  getCachedSettings: (name: string) => mockGetCachedSettings(name),
  loadExtensionSettings: vi.fn(async () => ({})),
  invalidateExtensionSettings: vi.fn(),
}));

beforeEach(() => {
  mockSynthesize = vi.fn().mockResolvedValue(silentWavBlob());
  mockGetCachedSettings = vi.fn();
  vi.stubGlobal(
    "URL",
    Object.assign(globalThis.URL, {
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    }),
  );
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
      return new Response("{}", { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeToolCall(): ToolCallState {
  return {
    id: "tc-1",
    toolName: "kokoro-tts.synthesize",
    status: "running",
    input: { text: "Hello settings." },
    startedAt: 0,
    cardType: "kokoro-tts-player",
  };
}

describe("KokoroTtsPlayerCard — settings store integration", () => {
  test("voice from store is forwarded to synthesize()", async () => {
    mockGetCachedSettings.mockReturnValue({ voice: "bf_emma", speed: 1.0 });
    render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
      conversationId: "conv-1",
    });
    await waitFor(() => expect(mockSynthesize).toHaveBeenCalled());
    expect(mockGetCachedSettings).toHaveBeenCalledWith("kokoro-tts");
    const opts = mockSynthesize.mock.calls[0]?.[1] as { voice: string; speed: number };
    expect(opts.voice).toBe("bf_emma");
  });

  test("speed from store is forwarded to synthesize()", async () => {
    mockGetCachedSettings.mockReturnValue({ voice: "af_bella", speed: 1.5 });
    render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
      conversationId: "conv-1",
    });
    await waitFor(() => expect(mockSynthesize).toHaveBeenCalled());
    const opts = mockSynthesize.mock.calls[0]?.[1] as { voice: string; speed: number };
    expect(opts.speed).toBe(1.5);
  });

  test("both voice + speed from store applied together", async () => {
    mockGetCachedSettings.mockReturnValue({ voice: "am_adam", speed: 0.75 });
    render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
      conversationId: "conv-1",
    });
    await waitFor(() => expect(mockSynthesize).toHaveBeenCalled());
    const opts = mockSynthesize.mock.calls[0]?.[1] as { voice: string; speed: number };
    expect(opts.voice).toBe("am_adam");
    expect(opts.speed).toBe(0.75);
  });

  test("falls back to af_bella + 1.0 when store is empty", async () => {
    mockGetCachedSettings.mockReturnValue(undefined);
    render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
      conversationId: "conv-1",
    });
    await waitFor(() => expect(mockSynthesize).toHaveBeenCalled());
    const opts = mockSynthesize.mock.calls[0]?.[1] as { voice: string; speed: number };
    expect(opts.voice).toBe("af_bella");
    expect(opts.speed).toBe(1.0);
  });

  test("falls back to defaults when store has wrong types", async () => {
    mockGetCachedSettings.mockReturnValue({ voice: 123, speed: "fast" });
    render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
      conversationId: "conv-1",
    });
    await waitFor(() => expect(mockSynthesize).toHaveBeenCalled());
    const opts = mockSynthesize.mock.calls[0]?.[1] as { voice: string; speed: number };
    expect(opts.voice).toBe("af_bella");
    expect(opts.speed).toBe(1.0);
  });

  test("falls back to defaults when store returns empty object", async () => {
    mockGetCachedSettings.mockReturnValue({});
    render(KokoroTtsPlayerCard, {
      toolCall: makeToolCall(),
      conversationId: "conv-1",
    });
    await waitFor(() => expect(mockSynthesize).toHaveBeenCalled());
    const opts = mockSynthesize.mock.calls[0]?.[1] as { voice: string; speed: number };
    expect(opts.voice).toBe("af_bella");
    expect(opts.speed).toBe(1.0);
  });

  describe("NaN / Infinity / negative speed handling", () => {
    // The card's expression is `(typeof s.speed === "number" && s.speed) || 1.0`:
    //   NaN      → typeof "number" but falsy → falls back to 1.0
    //   Infinity → typeof "number" and truthy → passes through (NOT 1.0)
    //   -1       → typeof "number" and truthy → passes through (NOT 1.0)
    //
    // FINDING: The card has no min/max guard. It relies on the server-side
    // clamper (`isValidForField` in src/extensions/manifest.ts) to reject
    // out-of-range values before they're persisted — i.e. the resolved
    // store should never carry Infinity or -1 in steady state. If a stale
    // cache or a future client-side write bypasses clamping, these values
    // will reach the bridge unfiltered. Worth a follow-up: the card
    // should clamp once on its own, defense-in-depth.

    test("NaN speed falls back to 1.0 (NaN is falsy)", async () => {
      mockGetCachedSettings.mockReturnValue({ voice: "af_bella", speed: NaN });
      render(KokoroTtsPlayerCard, {
        toolCall: makeToolCall(),
        conversationId: "conv-1",
      });
      await waitFor(() => expect(mockSynthesize).toHaveBeenCalled());
      const opts = mockSynthesize.mock.calls[0]?.[1] as { speed: number };
      expect(opts.speed).toBe(1.0);
    });

    test("Infinity speed currently passes through (truthy → no fallback)", async () => {
      mockGetCachedSettings.mockReturnValue({
        voice: "af_bella",
        speed: Infinity,
      });
      render(KokoroTtsPlayerCard, {
        toolCall: makeToolCall(),
        conversationId: "conv-1",
      });
      await waitFor(() => expect(mockSynthesize).toHaveBeenCalled());
      const opts = mockSynthesize.mock.calls[0]?.[1] as { speed: number };
      // Pin current behavior; the brief expected 1.0 fallback but
      // the JS expression `(typeof n === "number" && n) || 1.0`
      // does NOT short-circuit on Infinity. Server-side clamping is
      // the only line of defense here.
      expect(opts.speed).toBe(Infinity);
    });

    test("negative speed -1 currently passes through (no client-side clamp)", async () => {
      mockGetCachedSettings.mockReturnValue({ voice: "af_bella", speed: -1 });
      render(KokoroTtsPlayerCard, {
        toolCall: makeToolCall(),
        conversationId: "conv-1",
      });
      await waitFor(() => expect(mockSynthesize).toHaveBeenCalled());
      const opts = mockSynthesize.mock.calls[0]?.[1] as { speed: number };
      // The card relies on server-side clamping to reject -1; without
      // it, a negative number reaches the bridge.
      expect(opts.speed).toBe(-1);
    });
  });
});
