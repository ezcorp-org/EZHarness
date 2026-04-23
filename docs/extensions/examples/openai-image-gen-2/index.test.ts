import { describe, expect, test, beforeEach, mock } from "bun:test";

let nextResponse: () => Response = () => new Response("{}");
let capturedInit: RequestInit | null = null;

mock.module("@ezcorp/sdk/runtime", () => ({
  fetchPermitted: (_u: string | URL, init?: RequestInit) => {
    capturedInit = init ?? null;
    return Promise.resolve(nextResponse());
  },
  toolResult: (t: string) => ({ content: [{ type: "text", text: t }], isError: false }),
  toolError: (t: string) => ({ content: [{ type: "text", text: t }], isError: true }),
  getChannel: () => ({ start: () => {} }),
  createToolDispatcher: () => {},
}));

// Mock disk writes so tests don't touch the filesystem. The sequence of
// urls lets tests assert on which image the formatter used.
let savedImageCounter = 0;
const savedImages: Array<{ b64: string; mimeType: string; relPath: string; url: string }> = [];
mock.module("./image-storage", () => ({
  saveImageToDisk: async (b64: string, mimeType: string) => {
    savedImageCounter++;
    const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
    const relPath = `generated/test-${savedImageCounter}.${ext}`;
    const url = `/api/ext-files/openai-image-gen-2/${relPath}`;
    const rec = { b64, mimeType, relPath, url };
    savedImages.push(rec);
    return { relPath, url };
  },
  EXTENSION_NAME: "openai-image-gen-2",
}));

import {
  buildHandlers, formatResult, makeEditHandler, makeGenerateHandler, resolveAuthPath,
} from "./index";

interface ResultShape { content: Array<{ type: "text"; text: string }>; isError: boolean; }
const textOf = (r: unknown): string => (r as ResultShape).content[0]!.text;

const FAKE = "aGVsbG8=";

beforeEach(() => {
  process.env.OPENAI_API_KEY = "sk-test";
  delete process.env.OPENAI_ACCESS_TOKEN;
  nextResponse = () => new Response(JSON.stringify({ data: [{ b64_json: FAKE }] }));
  capturedInit = null;
  savedImageCounter = 0;
  savedImages.length = 0;
});

describe("resolveAuthPath", () => {
  test("OAuth wins when both are set", () => {
    expect(resolveAuthPath({ OPENAI_ACCESS_TOKEN: "oa", OPENAI_API_KEY: "sk" } as any))
      .toEqual({ kind: "codex", token: "oa" });
  });
  test("API key path when only sk is set", () => {
    expect(resolveAuthPath({ OPENAI_API_KEY: "sk" } as any)).toEqual({ kind: "images" });
  });
  test("null when nothing set", () => {
    expect(resolveAuthPath({} as any)).toBeNull();
  });
  test("treats whitespace-only tokens as missing", () => {
    expect(resolveAuthPath({ OPENAI_ACCESS_TOKEN: "   ", OPENAI_API_KEY: "   " } as any)).toBeNull();
  });
});

describe("formatResult", () => {
  test("emits markdown with a short URL (NO base64 in the text)", async () => {
    const md = await formatResult("a cat", [{ b64: "ABC", mimeType: "image/png" }]);
    // Regression: the tool result must NOT contain a data URI — base64
    // payloads in the tool text blow past the model's context window
    // on the next turn (context_length_exceeded).
    expect(md).not.toContain("data:image/");
    expect(md).not.toContain("ABC");
    expect(md).toContain("/api/ext-files/openai-image-gen-2/generated/");
    expect(md).toContain("![a cat](");
    expect(md).toContain("Generated 1 image with OpenAI.");
  });
  test("pluralizes count and emits one URL per image", async () => {
    const md = await formatResult("x", [
      { b64: "A", mimeType: "image/png" }, { b64: "B", mimeType: "image/webp" },
    ]);
    expect(md).toContain("Generated 2 images with OpenAI.");
    expect(savedImages.length).toBe(2);
    expect(md).toContain(savedImages[0]!.url);
    expect(md).toContain(savedImages[1]!.url);
  });
  test("passes correct mime type through to the saver (so extension matches)", async () => {
    await formatResult("x", [
      { b64: "A", mimeType: "image/png" },
      { b64: "B", mimeType: "image/webp" },
      { b64: "C", mimeType: "image/jpeg" },
    ]);
    expect(savedImages.map((s) => s.relPath.split(".").pop())).toEqual(["png", "webp", "jpg"]);
  });
  test("sanitizes brackets in alt", async () => {
    const md = await formatResult("a [nested] prompt ]", [{ b64: "A", mimeType: "image/png" }]);
    expect(md).toContain("![a nested prompt](");
    expect(md).not.toMatch(/!\[a \[/);
  });
  test("truncates very long prompts in alt", async () => {
    const long = "x".repeat(500);
    const md = await formatResult(long, [{ b64: "A", mimeType: "image/png" }]);
    const alt = md.match(/!\[([^\]]*)\]/)![1]!;
    expect(alt.length).toBeLessThanOrEqual(200);
  });
  test("generic alt when prompt is empty", async () => {
    const md = await formatResult("   ", [{ b64: "A", mimeType: "image/png" }]);
    expect(md).toContain("![generated image](");
  });
});

describe("generate handler — Images API path (sk-… key)", () => {
  test("happy path returns markdown with data URI", async () => {
    const r = await makeGenerateHandler()({ prompt: "a cat" });
    expect((r as ResultShape).isError).toBe(false);
    // Tool result carries only a short URL; base64 bytes stay out of the
    // model's context window.
    expect(textOf(r)).not.toContain("data:image/");
    expect(textOf(r)).toContain("/api/ext-files/openai-image-gen-2/");
    expect(savedImages.map((s) => s.b64)).toEqual([FAKE]);
  });
  test("rejects empty prompt without hitting network", async () => {
    nextResponse = () => { throw new Error("network should not be called"); };
    const r = await makeGenerateHandler()({ prompt: "   " });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/prompt/i);
  });
  test("augments prompts by default", async () => {
    const r = await makeGenerateHandler()({
      prompt: "a cat", use_case: "photorealistic-natural", style: "studio",
    });
    expect((r as ResultShape).isError).toBe(false);
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.prompt).toContain("Use case: photorealistic-natural");
    expect(body.prompt).toContain("Style/medium: studio");
  });
  test("augment=false sends bare prompt", async () => {
    await makeGenerateHandler()({ prompt: "a cat", augment: false, use_case: "ignored" });
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.prompt).toBe("a cat");
  });
  test("invalid model yields validation error", async () => {
    const r = await makeGenerateHandler()({ prompt: "c", model: "dall-e-3" });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/Invalid input/);
  });
  test("upstream 429 → OpenAI API error", async () => {
    nextResponse = () => new Response("quota", { status: 429 });
    const r = await makeGenerateHandler()({ prompt: "c" });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/OpenAI API error/);
    expect(textOf(r)).toMatch(/429/);
  });
  test("non-string options coerced to defaults", async () => {
    const r = await makeGenerateHandler()({ prompt: "c", size: 123, quality: null } as any);
    expect((r as ResultShape).isError).toBe(false);
  });
  test("network transient error produces 'Unexpected error'", async () => {
    nextResponse = () => { throw new Error("socket"); };
    const r = await makeGenerateHandler()({ prompt: "c" });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/Unexpected error/);
  });
});

describe("generate handler — Codex Responses path (subscription OAuth)", () => {
  test("routes OAuth-only env through Codex; image rendered inline", async () => {
    delete process.env.OPENAI_API_KEY;
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }),
    ).toString("base64url");
    const jwt = `${header}.${payload}.SIG`;
    process.env.OPENAI_ACCESS_TOKEN = jwt;

    const encoder = new TextEncoder();
    const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    nextResponse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(frame({
              type: "response.output_item.done",
              item: { type: "image_generation_call", result: "CDX", output_format: "png" },
            })));
            controller.close();
          },
        }),
        { status: 200 },
      );

    const r = await makeGenerateHandler()({ prompt: "cat" });
    expect((r as ResultShape).isError).toBe(false);
    expect(textOf(r)).not.toContain("data:image/");
    expect(textOf(r)).toContain("/api/ext-files/openai-image-gen-2/");
    expect(savedImages.map((s) => s.b64)).toEqual(["CDX"]);
    const h = capturedInit!.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${jwt}`);
    expect(h["chatgpt-account-id"]).toBe("acc-1");
  });
  test("invalid JWT yields auth error", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_ACCESS_TOKEN = "not-a-jwt";
    const r = await makeGenerateHandler()({ prompt: "cat" });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/Authentication error/);
  });
  test("401 from Codex → auth error", async () => {
    delete process.env.OPENAI_API_KEY;
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } }),
    ).toString("base64url");
    process.env.OPENAI_ACCESS_TOKEN = `${header}.${payload}.SIG`;
    nextResponse = () => new Response("nope", { status: 401 });
    const r = await makeGenerateHandler()({ prompt: "cat" });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/Authentication error/);
  });
});

describe("generate handler — no credentials", () => {
  test("clear auth-required error mentions both tokens", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_ACCESS_TOKEN;
    const r = await makeGenerateHandler()({ prompt: "cat" });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/Authentication error/);
    expect(textOf(r)).toMatch(/OPENAI_ACCESS_TOKEN|OPENAI_API_KEY/);
  });
});

describe("edit handler", () => {
  test("rejects missing images", async () => {
    const r = await makeEditHandler()({ prompt: "p" } as any);
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/images/);
  });
  test("rejects empty prompt", async () => {
    const r = await makeEditHandler()({ prompt: "   ", images: ["https://x/1.png"] });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/prompt/i);
  });
  test("happy path via BYOK Images API", async () => {
    const r = await makeEditHandler()({ prompt: "p", images: ["data:image/png;base64,QUFB"] });
    expect((r as ResultShape).isError).toBe(false);
    expect(textOf(r)).not.toContain("data:image/");
    expect(textOf(r)).toContain("/api/ext-files/openai-image-gen-2/");
  });
  test("filters non-string image entries but keeps valid ones", async () => {
    const r = await makeEditHandler()({
      prompt: "p", images: [123, null, "data:image/png;base64,AA"] as any,
    });
    expect((r as ResultShape).isError).toBe(false);
  });
  test("all-invalid image entries reported cleanly", async () => {
    const r = await makeEditHandler()({ prompt: "p", images: [123, null] as any });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/images/);
  });
  test("upstream 500 wrapped in toolError", async () => {
    nextResponse = () => new Response("boom", { status: 500 });
    const r = await makeEditHandler()({ prompt: "p", images: ["data:image/png;base64,AA"] });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/OpenAI API error/);
  });
  test("no credentials → auth error", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_ACCESS_TOKEN;
    const r = await makeEditHandler()({ prompt: "p", images: ["data:image/png;base64,AA"] });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/Authentication error/);
  });
});

describe("buildHandlers", () => {
  test("exposes generate and edit", () => {
    const h = buildHandlers();
    expect(typeof h.generate).toBe("function");
    expect(typeof h.edit).toBe("function");
  });
});
