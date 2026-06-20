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
