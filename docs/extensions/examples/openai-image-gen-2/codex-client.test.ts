import { describe, expect, test, beforeEach, mock } from "bun:test";

// Mock fetchPermitted so tests don't hit the real network. Each test can
// override nextResponse.
let nextResponse: () => Response = () => new Response("{}");
let captured: { url: string; init?: RequestInit } | null = null;

mock.module("@ezcorp/sdk/runtime", () => ({
  fetchPermitted: (url: string | URL, init?: RequestInit) => {
    captured = { url: String(url), init };
    return Promise.resolve(nextResponse());
  },
  toolResult: (t: string) => ({ content: [{ type: "text", text: t }], isError: false }),
  toolError: (t: string) => ({ content: [{ type: "text", text: t }], isError: true }),
  getChannel: () => ({ start: () => {} }),
  createToolDispatcher: () => {},
}));

import {
  CODEX_IMAGE_TOOL_TYPE, CODEX_INSTRUCTIONS, CODEX_RESPONSES_URL,
  CodexImageError, DEFAULT_CODEX_MODEL, buildRequestBody,
  extractChatGPTAccountId, extractImagesFromStream, generateViaCodex,
  parseSSE, resolveCodexModel,
} from "./codex-client";

function makeToken(claimPayload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claimPayload)).toString("base64url");
  return `${header}.${payload}.SIG`;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

const MIME = (fmt: string | undefined) => {
  switch (fmt) { case "jpeg": return "image/jpeg"; case "webp": return "image/webp"; default: return "image/png"; }
};

const sseFrame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

beforeEach(() => {
  captured = null;
  nextResponse = () => new Response("{}");
});

describe("extractChatGPTAccountId", () => {
  test("reads chatgpt_account_id from standard claim path", () => {
    const token = makeToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-123" } });
    expect(extractChatGPTAccountId(token)).toBe("acc-123");
  });
  test("throws on non-3-segment JWT", () => {
    expect(() => extractChatGPTAccountId("abc.def")).toThrow(CodexImageError);
    expect(() => extractChatGPTAccountId("")).toThrow(CodexImageError);
  });
  test("throws when payload fails to decode", () => {
    expect(() => extractChatGPTAccountId("a.!not-base64!.c")).toThrow(CodexImageError);
  });
  test("throws when claim is absent", () => {
    const token = makeToken({ "https://api.openai.com/auth": { other: "x" } });
    expect(() => extractChatGPTAccountId(token)).toThrow(/chatgpt_account_id/);
  });
  test("throws when auth claim itself is missing", () => {
    const token = makeToken({ sub: "u" });
    expect(() => extractChatGPTAccountId(token)).toThrow(CodexImageError);
  });
  test("handles url-safe base64", () => {
    const payload = JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a?b+c/d" } });
    const b64 = Buffer.from(payload).toString("base64");
    const urlSafe = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(extractChatGPTAccountId(`h.${urlSafe}.s`)).toBe("a?b+c/d");
  });
});

describe("resolveCodexModel", () => {
  test("defaults to gpt-5.4 (current Codex CLI default)", () => {
    expect(resolveCodexModel(undefined)).toBe(DEFAULT_CODEX_MODEL);
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.4");
  });
  test("returns null/empty/whitespace → default", () => {
    expect(resolveCodexModel(null)).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel("")).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel("   ")).toBe(DEFAULT_CODEX_MODEL);
  });
  test("accepts gpt-5.1/gpt-5.2/gpt-5.3/gpt-5.4 variants", () => {
    expect(resolveCodexModel("gpt-5.1")).toBe("gpt-5.1");
    expect(resolveCodexModel("gpt-5.1-codex-mini")).toBe("gpt-5.1-codex-mini");
    expect(resolveCodexModel("gpt-5.2")).toBe("gpt-5.2");
    expect(resolveCodexModel("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(resolveCodexModel("gpt-5.3-codex")).toBe("gpt-5.3-codex");
    expect(resolveCodexModel("gpt-5.4")).toBe("gpt-5.4");
    expect(resolveCodexModel("gpt-5.4-pro")).toBe("gpt-5.4-pro");
  });
  test("ignores gpt-image-* models (they belong to the Images API path)", () => {
    // Regression: forwarding "gpt-image-1" to Codex returns HTTP 400
    // "model is not supported when using Codex with a ChatGPT account".
    expect(resolveCodexModel("gpt-image-1")).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveCodexModel("gpt-image-1.5")).toBe(DEFAULT_CODEX_MODEL);
  });
  test("ignores legacy gpt-5-codex (also rejected by ChatGPT-account endpoint)", () => {
    expect(resolveCodexModel("gpt-5-codex")).toBe(DEFAULT_CODEX_MODEL);
  });
  test("ignores gpt-5 (no '.' — not allowlisted)", () => {
    expect(resolveCodexModel("gpt-5")).toBe(DEFAULT_CODEX_MODEL);
  });
});

describe("buildRequestBody", () => {
  test("emits image_gen tool with defaults (no controls — matches built-in spec)", () => {
    const body = buildRequestBody({ prompt: "a cat" });
    expect(body.model).toBe(DEFAULT_CODEX_MODEL);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.parallel_tool_calls).toBe(false);
    // Tool name is `image_gen` (Codex built-in) NOT `image_generation`
    // (public Responses API). ChatGPT-account Codex rejects the latter.
    expect(body.tools).toEqual([{ type: CODEX_IMAGE_TOOL_TYPE }]);
    // Verified against codex binary string table + endpoint error surface:
    // "image_gen" was rejected with "Unsupported tool type"; the correct
    // wire type is "image_generation".
    expect(CODEX_IMAGE_TOOL_TYPE).toBe("image_generation");
    const input = body.input as any[];
    expect(input[0].role).toBe("user");
    expect(input[0].content[0]).toEqual({ type: "input_text", text: "a cat" });
  });
  test("always includes non-empty `instructions` (endpoint rejects requests without it)", () => {
    const body = buildRequestBody({ prompt: "a cat" });
    expect(typeof body.instructions).toBe("string");
    expect((body.instructions as string).length).toBeGreaterThan(0);
    expect(body.instructions).toBe(CODEX_INSTRUCTIONS);
  });
  test("adds input_image parts for inputImages", () => {
    const body = buildRequestBody({
      prompt: "e", inputImages: ["https://x/a.png", "data:image/png;base64,A"],
    });
    const content = (body.input as any[])[0].content as any[];
    expect(content.length).toBe(3);
    expect(content[1]).toEqual({ type: "input_image", image_url: "https://x/a.png" });
    expect(content[2]).toEqual({ type: "input_image", image_url: "data:image/png;base64,A" });
  });
  test("forwards allowlisted custom model", () => {
    expect(buildRequestBody({ prompt: "x", model: "gpt-5.2-codex" }).model).toBe("gpt-5.2-codex");
  });
  test("silently falls back to default for non-allowlisted model", () => {
    expect(buildRequestBody({ prompt: "x", model: "gpt-image-1" }).model).toBe(DEFAULT_CODEX_MODEL);
  });
});

describe("parseSSE", () => {
  test("yields event+data pairs", async () => {
    const events: any[] = [];
    for await (const ev of parseSSE(streamFromChunks(["event: foo\ndata: {\"a\":1}\n\n"]))) events.push(ev);
    expect(events).toEqual([{ event: "foo", data: '{"a":1}' }]);
  });
  test("handles data-only events", async () => {
    const events: any[] = [];
    for await (const ev of parseSSE(streamFromChunks(["data: {\"a\":1}\n\n"]))) events.push(ev);
    expect(events).toEqual([{ data: '{"a":1}' }]);
  });
  test("survives chunk boundaries", async () => {
    const events: any[] = [];
    for await (const ev of parseSSE(streamFromChunks(["data: {\"a\"", ":1}\n", "\n"]))) events.push(ev);
    expect(events).toEqual([{ data: '{"a":1}' }]);
  });
  test("yields multiple events", async () => {
    const events: any[] = [];
    for await (const ev of parseSSE(streamFromChunks(["data: 1\n\ndata: 2\n\ndata: 3\n\n"]))) events.push(ev);
    expect(events).toEqual([{ data: "1" }, { data: "2" }, { data: "3" }]);
  });
  test("concatenates multi-line data:", async () => {
    const events: any[] = [];
    for await (const ev of parseSSE(streamFromChunks(["data: a\ndata: b\n\n"]))) events.push(ev);
    expect(events).toEqual([{ data: "ab" }]);
  });
  test("skips heartbeat lines", async () => {
    const events: any[] = [];
    for await (const ev of parseSSE(streamFromChunks([": heartbeat\n\n"]))) events.push(ev);
    expect(events).toEqual([]);
  });
});

describe("extractImagesFromStream", () => {
  test("extracts image from output_item.done", async () => {
    const s = streamFromChunks([
      sseFrame({ type: "response.created" }),
      sseFrame({ type: "response.output_item.done", item: { type: "image_generation_call", result: "AAA", output_format: "png" } }),
      sseFrame({ type: "response.completed" }),
    ]);
    expect(await extractImagesFromStream(s, MIME)).toEqual([{ b64: "AAA", mimeType: "image/png" }]);
  });
  test("extracts multiple images", async () => {
    const s = streamFromChunks([
      sseFrame({ type: "response.output_item.done", item: { type: "image_generation_call", result: "A", output_format: "png" } }),
      sseFrame({ type: "response.output_item.done", item: { type: "image_generation_call", result: "B", output_format: "jpeg" } }),
    ]);
    expect(await extractImagesFromStream(s, MIME)).toEqual([
      { b64: "A", mimeType: "image/png" },
      { b64: "B", mimeType: "image/jpeg" },
    ]);
  });
  test("throws CodexImageError on error events", async () => {
    const s = streamFromChunks([sseFrame({ type: "response.error", message: "quota exceeded" })]);
    await expect(extractImagesFromStream(s, MIME)).rejects.toThrow(CodexImageError);
  });
  test("throws when stream ends with no images", async () => {
    const s = streamFromChunks([sseFrame({ type: "response.created" }), sseFrame({ type: "response.completed" })]);
    await expect(extractImagesFromStream(s, MIME)).rejects.toThrow(/without an image_generation_call/);
  });
  test("also accepts the alternate image_gen_call item type (if Codex switches variants)", async () => {
    const s = streamFromChunks([
      sseFrame({
        type: "response.output_item.done",
        item: { type: "image_gen_call", result: "Z", output_format: "png" },
      }),
    ]);
    expect(await extractImagesFromStream(s, MIME)).toEqual([{ b64: "Z", mimeType: "image/png" }]);
  });
  test("skips non-image output_item.done events", async () => {
    const s = streamFromChunks([
      sseFrame({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "hi" }] } }),
      sseFrame({ type: "response.output_item.done", item: { type: "image_generation_call", result: "OK", output_format: "png" } }),
    ]);
    expect(await extractImagesFromStream(s, MIME)).toEqual([{ b64: "OK", mimeType: "image/png" }]);
  });
  test("tolerates malformed JSON frames", async () => {
    const s = streamFromChunks([
      "data: not-json\n\n",
      sseFrame({ type: "response.output_item.done", item: { type: "image_generation_call", result: "X", output_format: "png" } }),
    ]);
    expect(await extractImagesFromStream(s, MIME)).toEqual([{ b64: "X", mimeType: "image/png" }]);
  });
  test("defaults mime to image/png when output_format missing", async () => {
    const s = streamFromChunks([
      sseFrame({ type: "response.output_item.done", item: { type: "image_generation_call", result: "Y" } }),
    ]);
    const out = await extractImagesFromStream(s, MIME);
    expect(out[0]!.mimeType).toBe("image/png");
  });
});

describe("generateViaCodex", () => {
  const VALID = makeToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } });

  test("rejects empty token", async () => {
    await expect(generateViaCodex("", { prompt: "x" })).rejects.toMatchObject({ code: "auth" });
  });
  test("rejects empty prompt", async () => {
    await expect(generateViaCodex(VALID, { prompt: "   " })).rejects.toMatchObject({ code: "validation" });
  });
  test("POST with bearer + chatgpt-account-id + OpenAI-Beta", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = async (u: string | URL, init?: RequestInit) => {
      calls.push({ url: String(u), init });
      return new Response(
        streamFromChunks([
          sseFrame({ type: "response.output_item.done", item: { type: "image_generation_call", result: "ZZ", output_format: "png" } }),
        ]),
        { status: 200 },
      );
    };
    const out = await generateViaCodex(VALID, { prompt: "a cat" }, { fetcher });
    expect(out).toEqual([{ b64: "ZZ", mimeType: "image/png" }]);
    expect(calls[0]!.url).toBe(CODEX_RESPONSES_URL);
    const h = calls[0]!.init!.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${VALID}`);
    expect(h["chatgpt-account-id"]).toBe("acc-1");
    expect(h["OpenAI-Beta"]).toBe("responses=experimental");
    expect(h["content-type"]).toBe("application/json");
    expect(h.accept).toBe("text/event-stream");
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.tools[0].type).toBe(CODEX_IMAGE_TOOL_TYPE);
    expect(body.model).toBe(DEFAULT_CODEX_MODEL);
    expect(body.input[0].content[0].text).toBe("a cat");
  });
  test("401/403 → auth error", async () => {
    const fetcher = async () => new Response("nope", { status: 401 });
    await expect(generateViaCodex(VALID, { prompt: "x" }, { fetcher })).rejects.toMatchObject({ code: "auth" });
  });
  test("500 → api error", async () => {
    const fetcher = async () => new Response("boom", { status: 500 });
    await expect(generateViaCodex(VALID, { prompt: "x" }, { fetcher })).rejects.toMatchObject({ code: "api" });
  });
  test("sessionId passed as session_id header", async () => {
    let captured: RequestInit | null = null;
    const fetcher = async (_u: string | URL, init?: RequestInit) => {
      captured = init ?? null;
      return new Response(
        streamFromChunks([
          sseFrame({ type: "response.output_item.done", item: { type: "image_generation_call", result: "A", output_format: "png" } }),
        ]),
      );
    };
    await generateViaCodex(VALID, { prompt: "x" }, { fetcher, sessionId: "sess-1" });
    expect((captured!.headers as Record<string, string>).session_id).toBe("sess-1");
  });
  test("no body → api error", async () => {
    const fetcher = async () => new Response(null, { status: 200 });
    await expect(generateViaCodex(VALID, { prompt: "x" }, { fetcher })).rejects.toMatchObject({ code: "api" });
  });
});
