/**
 * Unit tests for the deterministic mock-LLM store + OpenAI chunk emitter.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  setMockScript,
  dequeueMockTurn,
  clearMockScripts,
  mockScriptKeyFromModel,
  mockTurnToChunks,
  mockTurnToSseFrames,
  buildChunkUsage,
  buildMockFaultResponse,
  buildMockStreamResponse,
  buildMockTurnResponse,
} from "$lib/server/mock-llm";

afterEach(() => clearMockScripts());

describe("mockScriptKeyFromModel", () => {
  test("extracts key from mock:<key>", () => {
    expect(mockScriptKeyFromModel("mock:conv-1")).toBe("conv-1");
    expect(mockScriptKeyFromModel("mock:")).toBe("");
  });
  test("non-mock model → default bucket", () => {
    expect(mockScriptKeyFromModel("gpt-4o")).toBe("default");
    expect(mockScriptKeyFromModel(undefined)).toBe("default");
    expect(mockScriptKeyFromModel(42)).toBe("default");
  });
});

describe("store FIFO + sentinel", () => {
  test("dequeues turns in order then returns a stop sentinel", () => {
    setMockScript("k", [{ text: "one" }, { text: "two" }]);
    expect(dequeueMockTurn("k").text).toBe("one");
    expect(dequeueMockTurn("k").text).toBe("two");
    const sentinel = dequeueMockTurn("k");
    expect(sentinel.finishReason).toBe("stop");
    expect(sentinel.text).toContain("no scripted turn");
  });

  test("unseeded key returns sentinel immediately", () => {
    expect(dequeueMockTurn("never").finishReason).toBe("stop");
  });

  test("setMockScript replaces (idempotent)", () => {
    setMockScript("k", [{ text: "a" }]);
    setMockScript("k", [{ text: "b" }]);
    expect(dequeueMockTurn("k").text).toBe("b");
  });
});

describe("mockTurnToChunks", () => {
  test("text-only → content chunk + stop finish", () => {
    const chunks = mockTurnToChunks({ text: "hi" }) as any[];
    expect(chunks).toHaveLength(2);
    expect(chunks[0].choices[0].delta.content).toBe("hi");
    expect(chunks[0].choices[0].finish_reason).toBeNull();
    expect(chunks[1].choices[0].finish_reason).toBe("stop");
    expect(chunks[1].usage).toBeDefined();
  });

  test("tool-only → tool_calls chunk + tool_calls finish", () => {
    const chunks = mockTurnToChunks({
      toolCalls: [{ name: "read_file", arguments: { path: "/x" } }],
    }) as any[];
    // no text chunk → [toolcall, finish]
    expect(chunks).toHaveLength(2);
    const tc = chunks[0].choices[0].delta.tool_calls[0];
    expect(tc.function.name).toBe("read_file");
    expect(JSON.parse(tc.function.arguments)).toEqual({ path: "/x" });
    expect(tc.id).toBe("call_0");
    expect(chunks[1].choices[0].finish_reason).toBe("tool_calls");
  });

  test("string arguments pass through verbatim; explicit id honored", () => {
    const chunks = mockTurnToChunks({
      toolCalls: [{ id: "call_custom", name: "f", arguments: '{"a":1}' }],
    }) as any[];
    const tc = chunks[0].choices[0].delta.tool_calls[0];
    expect(tc.function.arguments).toBe('{"a":1}');
    expect(tc.id).toBe("call_custom");
  });

  test("text + tools → both chunks then tool_calls finish", () => {
    const chunks = mockTurnToChunks({
      text: "let me check",
      toolCalls: [{ name: "f" }],
    }) as any[];
    expect(chunks).toHaveLength(3);
    expect(chunks[0].choices[0].delta.content).toBe("let me check");
    expect(chunks[2].choices[0].finish_reason).toBe("tool_calls");
  });

  test("explicit finishReason overrides default", () => {
    const chunks = mockTurnToChunks({ text: "x", finishReason: "length" }) as any[];
    expect(chunks[1].choices[0].finish_reason).toBe("length");
  });

  test("empty turn → just a stop finish chunk", () => {
    const chunks = mockTurnToChunks({}) as any[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].choices[0].finish_reason).toBe("stop");
  });
});

describe("mockTurnToSseFrames", () => {
  test("frames are valid SSE and terminate with [DONE]", () => {
    const frames = mockTurnToSseFrames({ text: "hi" });
    expect(frames.every((f) => f.startsWith("data: ") && f.endsWith("\n\n"))).toBe(true);
    expect(frames.at(-1)).toBe("data: [DONE]\n\n");
    // first frame parses back to a chunk
    const first = JSON.parse(frames[0]!.slice("data: ".length));
    expect(first.choices[0].delta.content).toBe("hi");
  });
});

describe("buildChunkUsage (synthetic cache usage)", () => {
  test("undefined usage → historic default shape (no cache details)", () => {
    expect(buildChunkUsage(undefined)).toEqual({
      prompt_tokens: 0,
      completion_tokens: 1,
      total_tokens: 1,
    });
  });

  test("cache values map onto prompt_tokens_details; prompt_tokens sums them", () => {
    const u = buildChunkUsage({ input: 200, cacheRead: 100, cacheWrite: 50, output: 7 }) as any;
    // pi-ai subtracts the cache parts back out of prompt_tokens → input=200.
    expect(u.prompt_tokens).toBe(350);
    expect(u.completion_tokens).toBe(7);
    expect(u.total_tokens).toBe(357);
    expect(u.prompt_tokens_details).toEqual({ cached_tokens: 100, cache_write_tokens: 50 });
  });

  test("cache-write only still emits prompt_tokens_details", () => {
    const u = buildChunkUsage({ input: 10, cacheWrite: 5 }) as any;
    expect(u.prompt_tokens_details).toEqual({ cached_tokens: 0, cache_write_tokens: 5 });
    expect(u.completion_tokens).toBe(1); // output defaulted
  });

  test("no cache tokens → prompt_tokens_details omitted", () => {
    const u = buildChunkUsage({ input: 42, output: 3 }) as any;
    expect(u.prompt_tokens).toBe(42);
    expect(u.prompt_tokens_details).toBeUndefined();
  });

  test("mockTurnToChunks threads the turn usage into the final chunk", () => {
    const chunks = mockTurnToChunks({ text: "hi", usage: { input: 1, cacheRead: 2 } }) as any[];
    expect(chunks.at(-1).usage.prompt_tokens_details).toEqual({ cached_tokens: 2, cache_write_tokens: 0 });
  });
});

describe("buildMockFaultResponse (simulated provider failures)", () => {
  test("status fault → OpenAI-shaped error body at that HTTP status", async () => {
    const res = buildMockFaultResponse({ status: 429, message: "slow down" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.message).toBe("slow down");
    expect(body.error.code).toBe("mock_429");
  });

  test("status fault defaults status→500 and synthesizes a message", async () => {
    const res = buildMockFaultResponse({});
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("500");
  });

  test("connection fault → body errors before any bytes (transport failure)", async () => {
    const res = buildMockFaultResponse({ kind: "connection" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Connection")).toBe("close");
    // Reading the aborted body throws rather than yielding data.
    let threw = false;
    try {
      await res.text();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("buildMockTurnResponse (dispatcher)", () => {
  test("plain turn → streamed reply", () => {
    const res = buildMockTurnResponse({ text: "hi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  test("fault turn → failing response", () => {
    const res = buildMockTurnResponse({ fault: { status: 503 } });
    expect(res.status).toBe(503);
  });

  test("matches buildMockStreamResponse for a non-fault turn", () => {
    expect(buildMockTurnResponse({ text: "x" }).headers.get("Content-Type"))
      .toBe(buildMockStreamResponse({ text: "x" }).headers.get("Content-Type"));
  });
});
