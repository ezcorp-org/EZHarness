import { describe, expect, test, beforeEach, mock } from "bun:test";

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
  ALLOWED_BACKGROUNDS, ALLOWED_OUTPUT_FORMATS, ALLOWED_QUALITIES, ALLOWED_SIZES,
  DEFAULT_IMAGE_MODEL, IMAGES_EDIT_URL, IMAGES_GENERATE_URL, OpenAIImageError,
  edit, generate, resolveAuth, validateEditParams, validateGenerateParams,
} from "./openai-client";

beforeEach(() => {
  captured = null;
  nextResponse = () => new Response("{}");
});

describe("resolveAuth", () => {
  test("returns the OPENAI_API_KEY when set", () => {
    expect(resolveAuth({ OPENAI_API_KEY: "sk-x" })).toEqual({ token: "sk-x", source: "api_key" });
  });
  test("trims whitespace", () => {
    expect(resolveAuth({ OPENAI_API_KEY: "  sk-x  " })).toEqual({ token: "sk-x", source: "api_key" });
  });
  test("treats whitespace-only as missing", () => {
    expect(() => resolveAuth({ OPENAI_API_KEY: "   " })).toThrow(OpenAIImageError);
  });
  test("throws auth error when unset", () => {
    try { resolveAuth({}); expect.unreachable(); }
    catch (e) { expect((e as OpenAIImageError).code).toBe("auth"); }
  });
  test("does NOT accept OPENAI_ACCESS_TOKEN — that's the Codex path", () => {
    expect(() => resolveAuth({ OPENAI_ACCESS_TOKEN: "oa" } as any)).toThrow(OpenAIImageError);
  });
});

describe("validateGenerateParams", () => {
  test("rejects empty prompt", () => {
    expect(() => validateGenerateParams({ prompt: "   " } as any)).toThrow(/prompt/);
  });
  test("rejects non-gpt-image model", () => {
    expect(() => validateGenerateParams({ prompt: "x", model: "dall-e-3" })).toThrow(/gpt-image/);
  });
  test("defaults model to gpt-image-1.5 (matches Codex skill's CLI fallback) and trims prompt", () => {
    const v = validateGenerateParams({ prompt: "  x  " });
    expect(v.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(DEFAULT_IMAGE_MODEL).toBe("gpt-image-1.5");
    expect(v.prompt).toBe("x");
  });
  test("rejects unknown enums", () => {
    expect(() => validateGenerateParams({ prompt: "x", size: "9x9" })).toThrow(/size/);
    expect(() => validateGenerateParams({ prompt: "x", quality: "ultra" })).toThrow(/quality/);
    expect(() => validateGenerateParams({ prompt: "x", background: "rainbow" })).toThrow(/background/);
    expect(() => validateGenerateParams({ prompt: "x", output_format: "bmp" })).toThrow(/output_format/);
  });
  test("rejects transparent + jpeg", () => {
    expect(() =>
      validateGenerateParams({ prompt: "x", background: "transparent", output_format: "jpeg" }),
    ).toThrow(/transparent/);
  });
  test("accepts transparent + png/webp", () => {
    expect(() => validateGenerateParams({ prompt: "x", background: "transparent", output_format: "png" })).not.toThrow();
    expect(() => validateGenerateParams({ prompt: "x", background: "transparent", output_format: "webp" })).not.toThrow();
  });
  test("rejects output_compression out of range / non-integer", () => {
    expect(() => validateGenerateParams({ prompt: "x", output_compression: -1 })).toThrow();
    expect(() => validateGenerateParams({ prompt: "x", output_compression: 101 })).toThrow();
    expect(() => validateGenerateParams({ prompt: "x", output_compression: 5.5 })).toThrow();
  });
  test("allowed-sets are stable", () => {
    expect(ALLOWED_SIZES.has("1024x1024")).toBe(true);
    expect(ALLOWED_QUALITIES.has("auto")).toBe(true);
    expect(ALLOWED_BACKGROUNDS.has("transparent")).toBe(true);
    expect(ALLOWED_OUTPUT_FORMATS.has("png")).toBe(true);
  });
});

describe("validateEditParams", () => {
  test("rejects empty prompt", () => {
    expect(() => validateEditParams({ prompt: "", images: ["https://x/1.png"] } as any)).toThrow(/prompt/);
  });
  test("rejects empty/non-array images", () => {
    expect(() => validateEditParams({ prompt: "x", images: [] })).toThrow(/images/);
    expect(() => validateEditParams({ prompt: "x", images: "nope" as any })).toThrow(/images/);
  });
  test("rejects >4 images", () => {
    expect(() =>
      validateEditParams({ prompt: "x", images: ["a","b","c","d","e"].map((n) => `https://x/${n}`) }),
    ).toThrow(/4/);
  });
  test("rejects bad image scheme", () => {
    expect(() => validateEditParams({ prompt: "x", images: ["ftp://x"] })).toThrow(/data.*https/);
  });
  test("accepts data: and https: image refs", () => {
    expect(() => validateEditParams({ prompt: "x", images: ["https://x/1.png", "data:image/png;base64,AA"] })).not.toThrow();
  });
  test("rejects invalid mask", () => {
    expect(() =>
      validateEditParams({ prompt: "x", images: ["https://x/1.png"], mask: "ftp://m" }),
    ).toThrow(/mask/);
  });
  test("rejects empty-string image entry", () => {
    expect(() => validateEditParams({ prompt: "x", images: ["", "https://x/1.png"] })).toThrow(/non-empty/);
  });
  test("rejects unknown input_fidelity", () => {
    expect(() =>
      validateEditParams({ prompt: "x", images: ["https://x/1.png"], input_fidelity: "insane" }),
    ).toThrow(/input_fidelity/);
  });
});

describe("generate", () => {
  const FAKE = "aGVsbG8=";
  test("hits /images/generations with bearer + JSON body", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [{ b64_json: FAKE }] }));
    const out = await generate(
      { prompt: "cat", size: "1024x1024", quality: "high" },
      { env: { OPENAI_API_KEY: "sk-t" } },
    );
    expect(out).toEqual([{ b64: FAKE, mimeType: "image/png" }]);
    expect(captured?.url).toBe(IMAGES_GENERATE_URL);
    expect((captured?.init?.headers as any).Authorization).toBe("Bearer sk-t");
    const body = JSON.parse(captured!.init!.body as string);
    expect(body.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(body.prompt).toBe("cat");
  });
  test("includes optional params", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [{ b64_json: FAKE }] }));
    await generate(
      { prompt: "c", background: "transparent", output_format: "png", output_compression: 75 },
      { env: { OPENAI_API_KEY: "sk-t" } },
    );
    const body = JSON.parse(captured!.init!.body as string);
    expect(body.background).toBe("transparent");
    expect(body.output_format).toBe("png");
    expect(body.output_compression).toBe(75);
  });
  test("throws auth error when no key", async () => {
    try { await generate({ prompt: "x" }, { env: {} }); expect.unreachable(); }
    catch (e) { expect((e as OpenAIImageError).code).toBe("auth"); }
  });
  test("propagates validation errors without hitting network", async () => {
    try { await generate({ prompt: "" } as any, { env: { OPENAI_API_KEY: "sk-t" } }); expect.unreachable(); }
    catch (e) { expect((e as OpenAIImageError).code).toBe("validation"); }
    expect(captured).toBeNull();
  });
  test("wraps non-2xx as api error", async () => {
    nextResponse = () => new Response("x".repeat(100), { status: 500 });
    try { await generate({ prompt: "c" }, { env: { OPENAI_API_KEY: "sk-t" } }); expect.unreachable(); }
    catch (e) {
      expect((e as OpenAIImageError).code).toBe("api");
      expect((e as Error).message).toContain("HTTP 500");
    }
  });
  test("reports api error on empty data array", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [] }));
    try { await generate({ prompt: "c" }, { env: { OPENAI_API_KEY: "sk-t" } }); expect.unreachable(); }
    catch (e) { expect((e as OpenAIImageError).code).toBe("api"); }
  });
  test("reports api error on non-JSON body", async () => {
    nextResponse = () => new Response("not json", { status: 200 });
    try { await generate({ prompt: "c" }, { env: { OPENAI_API_KEY: "sk-t" } }); expect.unreachable(); }
    catch (e) { expect((e as OpenAIImageError).code).toBe("api"); }
  });
  test("mime type follows output_format", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [{ b64_json: FAKE }] }));
    const out = await generate({ prompt: "c", output_format: "webp" }, { env: { OPENAI_API_KEY: "sk-t" } });
    expect(out[0]!.mimeType).toBe("image/webp");
  });
});

describe("edit", () => {
  const FAKE = "aGVsbG8=";
  test("hits /images/edits with multipart + bearer", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [{ b64_json: FAKE }] }));
    await edit(
      { prompt: "p", images: ["data:image/png;base64,AAAA"] },
      { env: { OPENAI_API_KEY: "sk-t" } },
    );
    expect(captured?.url).toBe(IMAGES_EDIT_URL);
    expect((captured?.init?.headers as any).Authorization).toBe("Bearer sk-t");
    expect(captured?.init?.body).toBeInstanceOf(FormData);
    const fd = captured!.init!.body as FormData;
    expect(fd.get("model")).toBe(DEFAULT_IMAGE_MODEL);
    expect(fd.get("prompt")).toBe("p");
    expect(fd.getAll("image[]").length).toBe(1);
  });
  test("fetches https images through the fetcher", async () => {
    const calls: string[] = [];
    const fetcher = async (u: string | URL) => {
      calls.push(String(u));
      if (String(u).includes("/v1/images/edits")) {
        return new Response(JSON.stringify({ data: [{ b64_json: FAKE }] }));
      }
      return new Response(new Uint8Array([1,2,3]), { headers: { "content-type": "image/png" } });
    };
    await edit(
      { prompt: "p", images: ["https://img.test/1.png"] },
      { env: { OPENAI_API_KEY: "sk-t" }, fetcher },
    );
    expect(calls).toEqual(["https://img.test/1.png", IMAGES_EDIT_URL]);
  });
  test("rejects malformed data URI", async () => {
    try {
      await edit(
        { prompt: "p", images: ["data:image/png;base64NOCOMMA"] },
        { env: { OPENAI_API_KEY: "sk-t" } },
      );
      expect.unreachable();
    } catch (e) { expect((e as OpenAIImageError).code).toBe("validation"); }
  });
  test("rejects non-base64 data URI", async () => {
    try {
      await edit(
        { prompt: "p", images: ["data:image/png,raw"] },
        { env: { OPENAI_API_KEY: "sk-t" } },
      );
      expect.unreachable();
    } catch (e) { expect((e as OpenAIImageError).code).toBe("validation"); }
  });
  test("network error on non-2xx image fetch", async () => {
    const fetcher = async (u: string | URL) => {
      if (String(u).includes("/v1/images/edits")) return new Response(JSON.stringify({ data: [] }));
      return new Response("x", { status: 404 });
    };
    try {
      await edit(
        { prompt: "p", images: ["https://img.test/missing.png"] },
        { env: { OPENAI_API_KEY: "sk-t" }, fetcher },
      );
      expect.unreachable();
    } catch (e) { expect((e as OpenAIImageError).code).toBe("network"); }
  });
  test("includes mask when provided", async () => {
    let editInit: RequestInit | null = null;
    const fetcher = async (u: string | URL, init?: RequestInit) => {
      if (String(u).includes("/v1/images/edits")) {
        editInit = init ?? null;
        return new Response(JSON.stringify({ data: [{ b64_json: FAKE }] }));
      }
      return new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } });
    };
    await edit(
      {
        prompt: "p",
        images: ["https://img.test/1.png"],
        mask: "data:image/png;base64,QUJD",
      },
      { env: { OPENAI_API_KEY: "sk-t" }, fetcher },
    );
    const fd = editInit!.body as FormData;
    expect(fd.get("mask")).toBeInstanceOf(Blob);
  });
  test("forwards all optional params", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [{ b64_json: FAKE }] }));
    await edit(
      {
        prompt: "p",
        images: ["data:image/png;base64,AAA"],
        output_format: "webp", quality: "medium",
        background: "transparent", input_fidelity: "high",
        output_compression: 60,
      },
      { env: { OPENAI_API_KEY: "sk-t" } },
    );
    const fd = captured!.init!.body as FormData;
    expect(fd.get("output_format")).toBe("webp");
    expect(fd.get("quality")).toBe("medium");
    expect(fd.get("background")).toBe("transparent");
    expect(fd.get("input_fidelity")).toBe("high");
    expect(fd.get("output_compression")).toBe("60");
  });
});
