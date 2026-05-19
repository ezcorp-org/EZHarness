import { afterAll, describe, expect, test, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../../../../src/__tests__/helpers/mock-cleanup";
import { stubChannel } from "./test-channel-stub";

afterAll(() => {
  // Restore real `@ezcorp/sdk/runtime` + `./image-storage` exports so
  // sibling files (image-storage.test.ts, ext-files.test.ts) see the
  // real `getChannel` they spy on. The global preload's afterEach drops
  // the JsonRpcChannel singleton but does NOT undo module mocks.
  restoreModuleMocks();
});

let nextResponse: () => Response = () => new Response("{}");
let capturedInit: RequestInit | null = null;

mock.module("@ezcorp/sdk/runtime", () => ({
  fetchPermitted: (_u: string | URL, init?: RequestInit) => {
    capturedInit = init ?? null;
    return Promise.resolve(nextResponse());
  },
  toolResult: (t: string) => ({ content: [{ type: "text", text: t }], isError: false }),
  toolError: (t: string) => ({ content: [{ type: "text", text: t }], isError: true }),
  // Phase 3: `formatResult` → `saveImageToDisk` → `fsMkdir`/`fsWrite`.
  // The image-storage mock below short-circuits that chain so the
  // channel here is only used by the sibling test files when this
  // mock.module call leaks into them between bun-test files. The
  // shared `stubChannel` provides safe fs.exists/fs.read defaults
  // (other methods throw a clear error).
  getChannel: () => stubChannel,
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
  buildHandlers, clampN, formatResult, makeEditHandler, makeGenerateHandler, resolveAuthPath,
  start,
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
  test("appends a hint that prompts the model to reuse URLs in edit calls", async () => {
    const md = await formatResult("a cat", [{ b64: "A", mimeType: "image/png" }]);
    // The hint MUST mention the `edit` tool and the canonical URL form
    // so models that ignore the long tool description still see the
    // shortest possible "use these URLs verbatim" reminder.
    expect(md).toContain("`edit` tool");
    expect(md).toContain("/api/ext-files/openai-image-gen-2/");
    expect(md.toLowerCase()).toContain("do not ask the user");
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

describe("clampN", () => {
  test("returns 1 for non-numeric / missing / non-finite", () => {
    expect(clampN(undefined)).toBe(1);
    expect(clampN(null)).toBe(1);
    expect(clampN("3")).toBe(1);
    expect(clampN(NaN)).toBe(1);
    expect(clampN(Infinity)).toBe(1);
  });
  test("clamps to [1,4] with floor semantics", () => {
    expect(clampN(0)).toBe(1);
    expect(clampN(-5)).toBe(1);
    expect(clampN(1)).toBe(1);
    expect(clampN(2)).toBe(2);
    expect(clampN(3.9)).toBe(3);
    expect(clampN(4)).toBe(4);
    expect(clampN(5)).toBe(4);
    expect(clampN(99)).toBe(4);
  });
});

describe("generate handler — multi-image (n)", () => {
  test("BYOK path: n=3 produces 3 saved images and pluralized count", async () => {
    // sk-… key path. The mocked fetchPermitted returns whatever
    // nextResponse() yields, so we stub a 3-entry data[] response.
    nextResponse = () =>
      new Response(
        JSON.stringify({
          data: [
            { b64_json: "B1" },
            { b64_json: "B2" },
            { b64_json: "B3" },
          ],
        }),
      );
    const r = await makeGenerateHandler()({ prompt: "cat", n: 3 });
    expect((r as ResultShape).isError).toBe(false);
    const txt = textOf(r);
    expect(txt).toContain("Generated 3 images with OpenAI.");
    // Each saved image gets one ![…](url) line in the result.
    const lines = txt.match(/!\[[^\]]*\]\([^\)]+\)/g);
    expect(lines?.length).toBe(3);
    expect(savedImages.length).toBe(3);
    expect(savedImages.map((s) => s.b64)).toEqual(["B1", "B2", "B3"]);
    // And `n: 3` made it into the wire body.
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.n).toBe(3);
  });

  test("Codex path: n=4 fires 4 parallel calls and concatenates results", async () => {
    delete process.env.OPENAI_API_KEY;
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }),
    ).toString("base64url");
    const jwt = `${header}.${payload}.SIG`;
    process.env.OPENAI_ACCESS_TOKEN = jwt;

    const encoder = new TextEncoder();
    const sseFrame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    let started = 0;
    let finished = 0;
    let maxConcurrent = 0;
    const callTimestamps: number[] = [];

    // Each call returns a single image, with a small delay so we can
    // observe overlap. We re-assign `nextResponse` to a closure that
    // captures call ordering for the parallel-execution assertion.
    nextResponse = () => {
      const callIdx = started++;
      callTimestamps.push(Date.now());
      const concurrent = started - finished;
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            // Yield to the event loop so subsequent calls can start
            // before this stream finishes — proves Promise.all
            // dispatched all N before any resolved.
            await new Promise((r) => setTimeout(r, 5));
            controller.enqueue(
              encoder.encode(
                sseFrame({
                  type: "response.output_item.done",
                  item: {
                    type: "image_generation_call",
                    result: `CDX${callIdx}`,
                    output_format: "png",
                  },
                }),
              ),
            );
            finished++;
            controller.close();
          },
        }),
        { status: 200 },
      );
    };

    const r = await makeGenerateHandler()({ prompt: "cat", n: 4 });
    expect((r as ResultShape).isError).toBe(false);
    expect(textOf(r)).toContain("Generated 4 images with OpenAI.");
    // 4 fetches happened.
    expect(started).toBe(4);
    // All 4 were in flight together — fan-out is fully parallel, not
    // partially serialized. The stub increments `started` synchronously
    // BEFORE the `await new Promise(setTimeout)`, so a correct
    // `Promise.all` over 4 fetches must reach `maxConcurrent === 4`
    // before any of them resolve. Anything less (e.g. 3) would mean
    // the build accidentally awaited a previous call before dispatching
    // the next one, which would slip past `> 1` but isn't truly parallel.
    expect(maxConcurrent).toBe(4);
    // 4 saves, with the 4 distinct b64 payloads from the stub.
    expect(savedImages.length).toBe(4);
    expect(savedImages.map((s) => s.b64).sort()).toEqual(["CDX0", "CDX1", "CDX2", "CDX3"]);
  });

  test("Codex path: n=4 with one rejection fails the whole call (no partial save)", async () => {
    delete process.env.OPENAI_API_KEY;
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }),
    ).toString("base64url");
    process.env.OPENAI_ACCESS_TOKEN = `${header}.${payload}.SIG`;

    const encoder = new TextEncoder();
    const sseFrame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    let callIdx = 0;
    nextResponse = () => {
      const i = callIdx++;
      // The 2nd call returns an HTTP 500 — generateViaCodex wraps
      // non-2xx as a CodexImageError, which Promise.all surfaces.
      if (i === 1) return new Response("nope", { status: 500 });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                sseFrame({
                  type: "response.output_item.done",
                  item: { type: "image_generation_call", result: `CDX${i}`, output_format: "png" },
                }),
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      );
    };

    const r = await makeGenerateHandler()({ prompt: "cat", n: 4 });
    expect((r as ResultShape).isError).toBe(true);
    // Partial-success UX is explicitly out of scope for v1: if any leg
    // fails the whole tool call errors and we save nothing.
    expect(savedImages.length).toBe(0);
  });

  test("BYOK path: n=99 clamps to 4 (defensive, even though the schema enforces 1..4)", async () => {
    // The mock returns whatever data we set — we don't care about the
    // image count here, only the `n` we sent. Verify the body uses
    // clamped n=4.
    nextResponse = () =>
      new Response(
        JSON.stringify({
          data: [
            { b64_json: "X1" },
            { b64_json: "X2" },
            { b64_json: "X3" },
            { b64_json: "X4" },
          ],
        }),
      );
    const r = await makeGenerateHandler()({ prompt: "cat", n: 99 });
    expect((r as ResultShape).isError).toBe(false);
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.n).toBe(4);
  });

  test("BYOK path: n=0 clamps to 1 and is omitted from the wire body", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [{ b64_json: FAKE }] }));
    const r = await makeGenerateHandler()({ prompt: "cat", n: 0 });
    expect((r as ResultShape).isError).toBe(false);
    const body = JSON.parse(capturedInit!.body as string);
    expect("n" in body).toBe(false);
  });

  test("Codex path: n=1 routes through the single-call branch (no fan-out)", async () => {
    delete process.env.OPENAI_API_KEY;
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }),
    ).toString("base64url");
    process.env.OPENAI_ACCESS_TOKEN = `${header}.${payload}.SIG`;

    const encoder = new TextEncoder();
    const sseFrame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
    let calls = 0;
    nextResponse = () => {
      calls++;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                sseFrame({
                  type: "response.output_item.done",
                  item: { type: "image_generation_call", result: "ONE", output_format: "png" },
                }),
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      );
    };

    const r = await makeGenerateHandler()({ prompt: "cat" }); // no n
    expect((r as ResultShape).isError).toBe(false);
    expect(calls).toBe(1);
    expect(textOf(r)).toContain("Generated 1 image with OpenAI.");
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
  test("routes edit through Codex when OAuth token is set, forwarding inputImages", async () => {
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

    const r = await makeEditHandler()({
      prompt: "blueify",
      images: ["data:image/png;base64,AAA", "https://img.example/1.png"],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(false);
    const body = JSON.parse(capturedInit!.body as string);
    expect(body.tools[0].type).toBe("image_generation");
    expect(body.input[0].content).toHaveLength(3);
    expect(body.input[0].content[0]).toEqual({ type: "input_text", text: "blueify" });
    expect(body.input[0].content[1]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,AAA",
    });
    expect(body.input[0].content[2]).toEqual({
      type: "input_image",
      image_url: "https://img.example/1.png",
    });
  });
  test("edit on Codex surfaces upstream 401 as auth error", async () => {
    delete process.env.OPENAI_API_KEY;
    const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } }),
    ).toString("base64url");
    process.env.OPENAI_ACCESS_TOKEN = `${header}.${payload}.SIG`;
    nextResponse = () => new Response("nope", { status: 401 });
    const r = await makeEditHandler()({
      prompt: "blueify",
      images: ["data:image/png;base64,AAA"],
    });
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

describe("start", () => {
  test("wires the dispatcher without throwing", () => {
    // getChannel and createToolDispatcher are mocked at module top, so
    // start() runs its full body as a no-op. This covers the
    // `if (import.meta.main) start()` guarded entrypoint lines.
    expect(() => start()).not.toThrow();
  });
});
