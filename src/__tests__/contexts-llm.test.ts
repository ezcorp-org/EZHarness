/**
 * Unit tests for `src/contexts/llm.ts` — the dual-lane completion runner.
 *
 * All lanes exercised with injected `fetchFn` / `completeFn` (no network).
 */
import { test, expect, describe } from "bun:test";
import {
  runContextsCompletion,
  DEFAULT_CONTEXTS_TIMEOUT_MS,
  type ContextsCompletionRequest,
} from "../contexts/llm";
import type { ContextsTarget } from "../contexts/config";

const sidecarTarget: ContextsTarget = { kind: "sidecar", baseUrl: "http://local:11434/v1", model: "qwen3:1.7b" };
const piTarget: ContextsTarget = { kind: "pi", provider: "anthropic", modelId: "claude-x", piModel: { id: "claude-x" } };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function sidecarReq(overrides: Partial<ContextsCompletionRequest> = {}): ContextsCompletionRequest {
  return {
    target: sidecarTarget,
    systemPrompt: "sys",
    userPrompt: "user",
    schema: { type: "object" },
    schemaName: "topic_detection",
    ...overrides,
  };
}

describe("sidecar lane", () => {
  test("happy path sends json_schema, normalizes the /v1 baseUrl, returns content", async () => {
    let capturedUrl = "";
    let capturedBody: any;
    const fetchFn = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse({ choices: [{ message: { content: "hello" } }] });
    }) as unknown as typeof fetch;

    const out = await runContextsCompletion(sidecarReq(), { fetchFn });
    expect(out).toBe("hello");
    // trailing /v1 stripped then re-appended → exactly one /v1
    expect(capturedUrl).toBe("http://local:11434/v1/chat/completions");
    expect(capturedBody.model).toBe("qwen3:1.7b");
    expect(capturedBody.response_format.type).toBe("json_schema");
    expect(capturedBody.response_format.json_schema.name).toBe("topic_detection");
    expect(capturedBody.response_format.json_schema.strict).toBe(true);
  });

  test("non-OK with schema → retries WITHOUT response_format, then succeeds", async () => {
    const calls: any[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      calls.push(body);
      if (calls.length === 1) return jsonResponse({}, false, 400);
      return jsonResponse({ choices: [{ message: { content: "recovered" } }] });
    }) as unknown as typeof fetch;

    const out = await runContextsCompletion(sidecarReq(), { fetchFn });
    expect(out).toBe("recovered");
    expect(calls).toHaveLength(2);
    expect(calls[0].response_format).toBeDefined();
    expect(calls[1].response_format).toBeUndefined(); // retry dropped the schema
  });

  test("retry also fails → throws with the HTTP status", async () => {
    const fetchFn = (async () => jsonResponse({}, false, 503)) as unknown as typeof fetch;
    await expect(runContextsCompletion(sidecarReq(), { fetchFn })).rejects.toThrow(/HTTP 503/);
  });

  test("no-schema request (extraction) makes a single call, no retry", async () => {
    let count = 0;
    const fetchFn = (async () => {
      count++;
      return jsonResponse({ choices: [{ message: { content: "# md" } }] });
    }) as unknown as typeof fetch;
    const out = await runContextsCompletion(sidecarReq({ schema: undefined }), { fetchFn });
    expect(out).toBe("# md");
    expect(count).toBe(1);
  });

  test("empty / non-string content → throws", async () => {
    const empty = (async () => jsonResponse({ choices: [{ message: { content: "   " } }] })) as unknown as typeof fetch;
    await expect(runContextsCompletion(sidecarReq(), { fetchFn: empty })).rejects.toThrow(/empty content/);
    const missing = (async () => jsonResponse({ choices: [{}] })) as unknown as typeof fetch;
    await expect(runContextsCompletion(sidecarReq(), { fetchFn: missing })).rejects.toThrow(/empty content/);
  });

  test("fetch rejection (abort/timeout) propagates", async () => {
    const fetchFn = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    await expect(runContextsCompletion(sidecarReq(), { fetchFn })).rejects.toThrow(/timed out/);
  });

  test("passes the abort signal with the requested timeout", async () => {
    let sawSignal = false;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sawSignal = init.signal instanceof AbortSignal;
      return jsonResponse({ choices: [{ message: { content: "x" } }] });
    }) as unknown as typeof fetch;
    await runContextsCompletion(sidecarReq({ timeoutMs: DEFAULT_CONTEXTS_TIMEOUT_MS }), { fetchFn });
    expect(sawSignal).toBe(true);
  });
});

describe("pi lane", () => {
  test("happy path: string content", async () => {
    const completeFn = async (piModel: any, ctx: any, opts: any) => {
      expect(piModel).toEqual({ id: "claude-x" });
      expect(ctx.systemPrompt).toBe("sys");
      expect(ctx.messages[0].content).toBe("user");
      expect(opts.conversationId).toBe("conv-1");
      return { stopReason: "stop", content: "plain text" };
    };
    const out = await runContextsCompletion(
      { target: piTarget, systemPrompt: "sys", userPrompt: "user", conversationId: "conv-1" },
      { completeFn },
    );
    expect(out).toBe("plain text");
  });

  test("happy path: array content joins text parts", async () => {
    const completeFn = async () => ({
      stopReason: "stop",
      content: [
        { type: "text", text: "a" },
        { type: "tool_use", id: "x" },
        { type: "text", text: "b" },
      ],
    });
    const out = await runContextsCompletion(
      { target: piTarget, systemPrompt: "s", userPrompt: "u" },
      { completeFn },
    );
    expect(out).toBe("ab");
  });

  test("stopReason 'error' → throws with errorMessage", async () => {
    const completeFn = async () => ({ stopReason: "error", errorMessage: "provider 500", content: [] });
    await expect(
      runContextsCompletion({ target: piTarget, systemPrompt: "s", userPrompt: "u" }, { completeFn }),
    ).rejects.toThrow("provider 500");
  });

  test("stopReason 'error' with no message → generic throw", async () => {
    const completeFn = async () => ({ stopReason: "error", content: [] });
    await expect(
      runContextsCompletion({ target: piTarget, systemPrompt: "s", userPrompt: "u" }, { completeFn }),
    ).rejects.toThrow(/no error message/);
  });

  test("empty content (undefined) → throws no-text", async () => {
    const completeFn = async () => ({ stopReason: "stop", content: undefined });
    await expect(
      runContextsCompletion({ target: piTarget, systemPrompt: "s", userPrompt: "u" }, { completeFn }),
    ).rejects.toThrow(/no text/);
  });
});
