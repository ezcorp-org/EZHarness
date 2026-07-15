/**
 * Unit tests for `src/contexts/sidecar-endpoint.ts` — endpoint detection +
 * the Ollama-native vs OpenAI-compat wire shapes. All via injected fetch — no
 * network.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  CONTEXTS_NUM_CTX,
  DEFAULT_CONTEXTS_NUM_CTX,
  SIDECAR_ENDPOINT_TTL_MS,
  buildSidecarRequest,
  detectSidecarEndpoint,
  normalizeSidecarUrl,
  readSidecarContent,
  resolveNumCtx,
  sendSidecarChat,
  _resetSidecarEndpointCacheForTests,
  type SidecarChatParams,
} from "../contexts/sidecar-endpoint";

const BASE = "http://localhost:11434";

function okResponse(): Response {
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
}
function notOk(status = 404): Response {
  return { ok: false, status } as unknown as Response;
}

beforeEach(() => _resetSidecarEndpointCacheForTests());

describe("resolveNumCtx", () => {
  test("unset → default", () => {
    expect(resolveNumCtx({})).toBe(DEFAULT_CONTEXTS_NUM_CTX);
    expect(CONTEXTS_NUM_CTX).toBe(DEFAULT_CONTEXTS_NUM_CTX);
  });
  test("valid override → that value (floored)", () => {
    expect(resolveNumCtx({ EZCORP_OLLAMA_CONTEXT_LENGTH: "8192" })).toBe(8192);
    expect(resolveNumCtx({ EZCORP_OLLAMA_CONTEXT_LENGTH: "24576.9" })).toBe(24576);
  });
  test("non-numeric / non-positive → default", () => {
    expect(resolveNumCtx({ EZCORP_OLLAMA_CONTEXT_LENGTH: "abc" })).toBe(DEFAULT_CONTEXTS_NUM_CTX);
    expect(resolveNumCtx({ EZCORP_OLLAMA_CONTEXT_LENGTH: "0" })).toBe(DEFAULT_CONTEXTS_NUM_CTX);
    expect(resolveNumCtx({ EZCORP_OLLAMA_CONTEXT_LENGTH: "-5" })).toBe(DEFAULT_CONTEXTS_NUM_CTX);
  });
});

describe("normalizeSidecarUrl", () => {
  test("strips /v1 + trailing slashes/colons", () => {
    expect(normalizeSidecarUrl("http://x:11434/v1")).toBe("http://x:11434");
    expect(normalizeSidecarUrl("http://x:11434/v1/")).toBe("http://x:11434");
    expect(normalizeSidecarUrl(" http://x:11434/ ")).toBe("http://x:11434");
  });
});

describe("detectSidecarEndpoint", () => {
  test("/api/tags OK → ollama, and probes the native path", async () => {
    let probedUrl = "";
    const fetchFn = (async (url: string) => {
      probedUrl = url;
      return okResponse();
    }) as unknown as typeof fetch;
    const kind = await detectSidecarEndpoint("http://x:11434/v1", { fetchFn, nowFn: () => 0 });
    expect(kind).toBe("ollama");
    expect(probedUrl).toBe("http://x:11434/api/tags");
  });

  test("/api/tags not-OK → openai-compatible", async () => {
    const fetchFn = (async () => notOk()) as unknown as typeof fetch;
    expect(await detectSidecarEndpoint(BASE, { fetchFn, nowFn: () => 0 })).toBe("openai-compatible");
  });

  test("fetch throws → openai-compatible (safe fallback)", async () => {
    const fetchFn = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await detectSidecarEndpoint(BASE, { fetchFn, nowFn: () => 0 })).toBe("openai-compatible");
  });

  test("caches per-baseUrl within the TTL; re-probes after expiry", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return okResponse();
    }) as unknown as typeof fetch;
    await detectSidecarEndpoint(BASE, { fetchFn, nowFn: () => 1_000 });
    await detectSidecarEndpoint(BASE, { fetchFn, nowFn: () => 1_000 + SIDECAR_ENDPOINT_TTL_MS - 1 });
    expect(calls).toBe(1); // cache hit
    await detectSidecarEndpoint(BASE, { fetchFn, nowFn: () => 1_000 + SIDECAR_ENDPOINT_TTL_MS + 1 });
    expect(calls).toBe(2); // expired → re-probe
  });

  test("default nowFn (Date.now) when not injected", async () => {
    const fetchFn = (async () => okResponse()) as unknown as typeof fetch;
    expect(await detectSidecarEndpoint(BASE, { fetchFn })).toBe("ollama");
  });
});

const baseParams: SidecarChatParams = {
  baseUrl: "http://x:11434/v1",
  model: "qwen3.5:4b",
  system: "sys",
  user: "usr",
  schema: { type: "object" },
  schemaName: "topic_detection",
  temperature: 0.2,
  maxTokens: 1500,
  timeoutMs: 120_000,
};

describe("buildSidecarRequest — ollama native", () => {
  test("with schema → /api/chat, options.num_ctx + num_predict, format=schema", () => {
    const { url, body } = buildSidecarRequest("ollama", baseParams, true);
    expect(url).toBe("http://x:11434/api/chat");
    expect(body.model).toBe("qwen3.5:4b");
    expect(body.stream).toBe(false);
    expect(body.options).toEqual({ num_ctx: CONTEXTS_NUM_CTX, temperature: 0.2, num_predict: 1500 });
    expect(body.format).toEqual({ type: "object" });
    // Native path must NOT carry the OpenAI-compat fields.
    expect(body.response_format).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
  });

  test("without schema → no format field", () => {
    const { body } = buildSidecarRequest("ollama", { ...baseParams, schema: undefined }, false);
    expect(body.format).toBeUndefined();
    expect(body.options).toMatchObject({ num_ctx: CONTEXTS_NUM_CTX });
  });

  test("withSchema true but no schema on the request → no format", () => {
    const { body } = buildSidecarRequest("ollama", { ...baseParams, schema: undefined }, true);
    expect(body.format).toBeUndefined();
  });
});

describe("buildSidecarRequest — openai-compatible", () => {
  test("with schema → /v1/chat/completions + response_format", () => {
    const { url, body } = buildSidecarRequest("openai-compatible", baseParams, true);
    expect(url).toBe("http://x:11434/v1/chat/completions");
    expect(body.max_tokens).toBe(1500);
    expect(body.temperature).toBe(0.2);
    expect((body.response_format as any).type).toBe("json_schema");
    expect((body.response_format as any).json_schema.name).toBe("topic_detection");
    expect((body.response_format as any).json_schema.strict).toBe(true);
    expect(body.options).toBeUndefined();
  });

  test("without schema → no response_format", () => {
    const { body } = buildSidecarRequest("openai-compatible", { ...baseParams, schema: undefined }, false);
    expect(body.response_format).toBeUndefined();
  });

  test("default schemaName when omitted", () => {
    const { body } = buildSidecarRequest("openai-compatible", { ...baseParams, schemaName: undefined }, true);
    expect((body.response_format as any).json_schema.name).toBe("contexts_output");
  });
});

describe("sendSidecarChat", () => {
  test("POSTs the built request with an abort signal", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return okResponse();
    }) as unknown as typeof fetch;
    await sendSidecarChat("ollama", baseParams, true, fetchFn);
    expect(seen!.url).toBe("http://x:11434/api/chat");
    expect(seen!.init.method).toBe("POST");
    expect(seen!.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(seen!.init.body as string).options.num_ctx).toBe(CONTEXTS_NUM_CTX);
  });
});

describe("readSidecarContent", () => {
  test("ollama → message.content", () => {
    expect(readSidecarContent("ollama", { message: { content: "hi" } })).toBe("hi");
    expect(readSidecarContent("ollama", { message: {} })).toBeUndefined();
    expect(readSidecarContent("ollama", {})).toBeUndefined();
  });
  test("openai-compatible → choices[0].message.content", () => {
    expect(readSidecarContent("openai-compatible", { choices: [{ message: { content: "yo" } }] })).toBe("yo");
    expect(readSidecarContent("openai-compatible", { choices: [{}] })).toBeUndefined();
    expect(readSidecarContent("openai-compatible", {})).toBeUndefined();
  });
});
