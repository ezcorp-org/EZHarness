/**
 * Cache accounting vs the REAL Anthropic provider shape.
 *
 * The existing mock-llm proof validates a synthetic OpenAI-completions field
 * (`prompt_tokens_details.cache_write_tokens`) — no real provider emits it.
 * This suite closes that gap: it drives pi-ai's REAL `streamAnthropic`
 * (node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js) with a fake
 * `options.client` whose `messages.create(...).asResponse()` streams genuine
 * Anthropic SSE frames — `message_start` carrying
 * `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens` and the
 * `usage.cache_creation.ephemeral_1h_input_tokens` retention split — then
 * asserts the parsed `Usage` matches the wire and pushes it through
 * `computeTurnCacheStats`, proving the app's accounting against the real
 * provider parse path (anthropic.js:349-356), not a synthetic field.
 */
import { test, expect, describe } from "bun:test";
import { getModel } from "@earendil-works/pi-ai";
import { streamAnthropic } from "@earendil-works/pi-ai/anthropic";
import { computeTurnCacheStats } from "../runtime/usage/cache-stats";

/** Encode Anthropic message-stream frames as a raw SSE body. */
function sseBody(frames: Array<{ event: string; data: unknown }>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("");
}

/**
 * Minimal Anthropic-SDK-shaped client: `messages.create(...).asResponse()`
 * resolves to a fetch Response streaming the given SSE frames — exactly the
 * seam streamAnthropic uses when `options.client` is provided.
 */
function fakeClient(body: string) {
  return {
    messages: {
      create: (_params: unknown, _opts: unknown) => ({
        asResponse: async () =>
          new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      }),
    },
  };
}

/** A complete single-text-block Anthropic stream with the given message_start usage. */
function anthropicFrames(messageStartUsage: Record<string, unknown>) {
  return [
    {
      event: "message_start",
      data: { type: "message_start", message: { id: "msg_test_1", usage: messageStartUsage } },
    },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      event: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
    },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 42 },
      },
    },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
}

const model = getModel("anthropic", "claude-sonnet-4-5");

async function runStream(messageStartUsage: Record<string, unknown>) {
  const stream = streamAnthropic(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
    { client: fakeClient(sseBody(anthropicFrames(messageStartUsage))) as never },
  );
  return stream.result();
}

describe("streamAnthropic — real wire-shape cache accounting", () => {
  test("parses cacheRead/cacheWrite/cacheWrite1h off real Anthropic SSE frames", async () => {
    const msg = await runStream({
      input_tokens: 100,
      output_tokens: 1,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_5m_input_tokens: 180, ephemeral_1h_input_tokens: 120 },
    });

    // Stream completed cleanly through message_stop (not the error path).
    expect(msg.stopReason).toBe("stop");
    expect(msg.content).toEqual([{ type: "text", text: "hello" }]);

    // Parsed usage matches the wire fields exactly.
    expect(msg.usage.input).toBe(100);
    expect(msg.usage.output).toBe(42); // message_delta supersedes message_start
    expect(msg.usage.cacheRead).toBe(800);
    expect(msg.usage.cacheWrite).toBe(300);
    expect(msg.usage.cacheWrite1h).toBe(120);
    // 1h split is a SUBSET of cacheWrite — totalTokens must not count it twice.
    expect(msg.usage.totalTokens).toBe(100 + 42 + 800 + 300);

    // pi-ai's own cost math prices the split as: 5m-rate × short + 2× input
    // rate × long — the 2× premium the meter exists to surface.
    const short = 300 - 120;
    expect(msg.usage.cost.cacheWrite).toBeCloseTo(
      (model.cost.cacheWrite * short) / 1e6 + (model.cost.input * 2 * 120) / 1e6,
      12,
    );

    // App-side accounting over the REAL parsed shape: subset carried, never
    // double-counted into promptTokens / cacheWriteTokens.
    const stats = computeTurnCacheStats(msg.usage);
    expect(stats.cacheWrite1hTokens).toBe(120);
    expect(stats.cacheWriteTokens).toBe(300);
    expect(stats.cachedTokens).toBe(800);
    expect(stats.promptTokens).toBe(100 + 800 + 300);
    expect(stats.hitRate).toBeCloseTo(800 / 1200, 10);
  });

  test("stream without a cache_creation retention split parses cacheWrite1h as 0", async () => {
    const msg = await runStream({
      input_tokens: 10,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 90,
    });

    expect(msg.stopReason).toBe("stop");
    expect(msg.usage.cacheWrite).toBe(90);
    expect(msg.usage.cacheWrite1h).toBe(0);

    const stats = computeTurnCacheStats(msg.usage);
    expect(stats.cacheWrite1hTokens).toBe(0);
    expect(stats.cacheWriteTokens).toBe(90);
    expect(stats.promptTokens).toBe(10 + 90);
  });
});
