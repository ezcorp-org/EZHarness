/**
 * End-to-end integration test for the openai-image-gen-2 extension's
 * "edit with prior image" loop.
 *
 * What this proves (the bug it would catch):
 *   The model generates an image → the tool persists it under
 *   `.ezcorp/extension-data/openai-image-gen-2/generated/<id>.png` and
 *   returns a `/api/ext-files/openai-image-gen-2/<relPath>` URL. Next
 *   turn, the model wants to *edit* that image and passes the same
 *   URL back as `images: [...]`. If the edit handler doesn't recognize
 *   the URL form, the loop is broken — symptoms are either a hard
 *   validation error or (worse) the URL string getting forwarded as if
 *   it were https/data and the upstream API receiving garbage.
 *
 * Coverage:
 *   1. BYOK Images-API path → multipart FormData carries the resolved
 *      disk bytes (correct mime, exactly one image[] field).
 *   2. Codex Responses path → the outgoing JSON body's input_image part
 *      is a `data:image/png;base64,<...>` URI containing the disk
 *      bytes — NOT the original /api/ext-files/... URL (the ChatGPT
 *      backend cannot reach the host's localhost routes).
 *   3. Mixed inputs (ext-files + data: + https://) — ext-files resolved
 *      locally, the other two pass through.
 *   4. Missing on-disk file → tool error mentioning the URL, no fetch.
 *   5. Path traversal (`../../../etc/passwd`) → validation error, no
 *      disk read attempted.
 *   6. Unknown extension namespace under /api/ext-files/ → validation
 *      error.
 *   7. Co-existence with `generate` (no regression on the simpler path).
 */

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  statSync,
} from "node:fs";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fetch interceptor wired through @ezcorp/sdk/runtime ────────────────
//
// Both openai-client.ts and codex-client.ts import `fetchPermitted` from
// "@ezcorp/sdk/runtime" and use it as the default fetcher. Mocking the
// module at the top of the file (Bun hoists `mock.module`) gives us a
// single seam for all outgoing HTTP. Tests assign `nextResponse` to
// shape the upstream reply and read `captured` to inspect what we sent.

interface CapturedCall { url: string; init?: RequestInit }
let captured: CapturedCall[] = [];
let nextResponse: (call: CapturedCall) => Response = () => new Response("{}");

mock.module("@ezcorp/sdk/runtime", () => ({
  fetchPermitted: (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init };
    captured.push(call);
    return Promise.resolve(nextResponse(call));
  },
  toolResult: (t: string) => ({ content: [{ type: "text", text: t }], isError: false }),
  toolError: (t: string) => ({ content: [{ type: "text", text: t }], isError: true }),
  getChannel: () => ({ start: () => {} }),
  createToolDispatcher: () => {},
  // Thin Node-fs wrappers for the extension's fsExists/fsRead/fsMkdir/fsWrite
  // calls. The host-RPC path requires a live channel; the test fixtures
  // (tmpdir + writeFileSync in beforeEach) sit on the real filesystem, so
  // direct node:fs delegation is byte-identical to what the host's
  // ezcorp/fs.* handlers would return.
  fsExists: async (path: string) => {
    try { statSync(path); return true; } catch { return false; }
  },
  fsRead: async (path: string, opts?: { encoding?: "utf-8" | "binary" }) => {
    const buf = readFileSync(path);
    if (opts?.encoding === "binary") return new Uint8Array(buf);
    return buf.toString("utf-8");
  },
  fsMkdir: async (path: string, opts?: { recursive?: boolean }) => {
    await fsp.mkdir(path, { recursive: opts?.recursive === true });
    return { resolvedPath: path };
  },
  fsWrite: async (path: string, content: string | Uint8Array) => {
    const isBinary = content instanceof Uint8Array;
    const bytes = isBinary
      ? content.byteLength
      : Buffer.byteLength(content as string);
    await fsp.writeFile(path, isBinary ? Buffer.from(content) : (content as string));
    return { bytes, resolvedPath: path };
  },
}));

// Loaded AFTER the mock so the extension picks up the stubbed runtime.
import {
  makeEditHandler,
  makeGenerateHandler,
} from "../../docs/extensions/examples/openai-image-gen-2/index";

// ── Test scaffolding ───────────────────────────────────────────────────

interface ResultShape { content: Array<{ type: "text"; text: string }>; isError: boolean }
const textOf = (r: unknown): string => (r as ResultShape).content[0]!.text;

// 16-byte minimal PNG-shaped fixture. The bytes don't need to render —
// they just need to survive the disk → multipart/data-URI pipeline
// byte-for-byte so the assertions are unambiguous.
const FIXTURE_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

// A valid JWT shape carrying the chatgpt_account_id claim Codex requires.
function makeCodexToken(accountId = "acc-123"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `${header}.${payload}.SIG`;
}

// SSE frame helper for the Codex path.
function sseFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function codexImageStreamResponse(b64: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sseFrame({
          type: "response.output_item.done",
          item: { type: "image_generation_call", result: b64, output_format: "png" },
        })));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

// One-shot byok response carrying a fake b64 generation result.
function imagesApiOkResponse(b64 = "QUFB"): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
}

// ── Filesystem fixture: tmpdir as $CWD ─────────────────────────────────

let projectRoot = "";
let prevCwd = "";

const REL_PATH = "generated/prior-pic.png";
const EXT_FILES_URL = `/api/ext-files/openai-image-gen-2/${REL_PATH}`;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "oig2-edit-int-"));
  const dir = join(projectRoot, ".ezcorp", "extension-data", "openai-image-gen-2", "generated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "prior-pic.png"), FIXTURE_PNG);

  prevCwd = process.cwd();
  // The extension calls `process.cwd()` to find the data root. Switch
  // to the tmpdir so the resolver maps the URL to *our* fixture.
  process.chdir(projectRoot);

  // Reset capture state between tests.
  captured = [];
  nextResponse = () => new Response("{}");

  // Default to BYOK. Codex tests override below.
  process.env.OPENAI_API_KEY = "sk-test-key";
  delete process.env.OPENAI_ACCESS_TOKEN;
});

afterEach(() => {
  // Restore CWD FIRST — even if rmSync fails, we don't want to leave
  // the test process pinned inside a deleted directory. process.chdir
  // is process-global; subsequent tests would silently misbehave.
  try {
    if (prevCwd) process.chdir(prevCwd);
  } finally {
    if (projectRoot) {
      try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
      projectRoot = "";
    }
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_ACCESS_TOKEN;
  }
});

// ── 1. BYOK Images-API path ────────────────────────────────────────────

describe("edit handler — BYOK Images API path", () => {
  test("ext-files URL is resolved to disk bytes and uploaded as multipart image[]", async () => {
    nextResponse = (call) => {
      // Only the upload to /v1/images/edits should hit the network.
      // ext-files URLs MUST be resolved locally — if a fetcher call
      // shows up for the ext-files URL we've broken the contract.
      expect(call.url).toBe("https://api.openai.com/v1/images/edits");
      return imagesApiOkResponse();
    };

    const r = await makeEditHandler()({
      prompt: "make it bluer",
      images: [EXT_FILES_URL],
      augment: false,
    });

    expect((r as ResultShape).isError).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.openai.com/v1/images/edits");

    const init = captured[0]!.init!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-key");
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;

    // Exactly one image[] entry — the ext-files URL produced one upload.
    const blobs = fd.getAll("image[]") as Blob[];
    expect(blobs).toHaveLength(1);
    const blob = blobs[0]!;
    // MIME inferred from the .png extension in the URL.
    expect(blob.type).toBe("image/png");
    // Byte-for-byte equality with the fixture: this is the load-bearing
    // assertion — it proves the disk bytes (NOT the URL string) were
    // sent up to OpenAI.
    const sentBytes = new Uint8Array(await blob.arrayBuffer());
    expect(sentBytes.length).toBe(FIXTURE_PNG.length);
    expect(Buffer.from(sentBytes).equals(Buffer.from(FIXTURE_PNG))).toBe(true);

    // Prompt forwarded as-is; URL never appears in the multipart text fields.
    expect(fd.get("prompt")).toBe("make it bluer");
  });
});

// ── 2. Codex Responses path ────────────────────────────────────────────

describe("edit handler — Codex Responses path (subscription OAuth)", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_ACCESS_TOKEN = makeCodexToken();
  });

  test("ext-files URL is INLINED as data: URI in the request body (NOT the original URL)", async () => {
    nextResponse = (call) => {
      expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      return codexImageStreamResponse("OUT");
    };

    const r = await makeEditHandler()({
      prompt: "make it bluer",
      images: [EXT_FILES_URL],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(false);

    expect(captured).toHaveLength(1);
    const init = captured[0]!.init!;
    const headers = init.headers as Record<string, string>;
    expect(headers["chatgpt-account-id"]).toBe("acc-123");

    const body = JSON.parse(init.body as string);
    const content = body.input[0].content as Array<Record<string, unknown>>;
    // [text, image]
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "input_text", text: "make it bluer" });
    expect(content[1]!.type).toBe("input_image");

    const url = content[1]!.image_url as string;
    // Critical regression: the outgoing body MUST NOT contain the
    // original /api/ext-files/... URL — the ChatGPT backend cannot
    // reach localhost. If we ever stop inlining, this assertion catches it.
    expect(url).not.toContain("/api/ext-files/");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);

    const b64 = url.slice("data:image/png;base64,".length);
    const decoded = Buffer.from(b64, "base64");
    expect(decoded.equals(Buffer.from(FIXTURE_PNG))).toBe(true);
  });
});

// ── 3. Mixed inputs ────────────────────────────────────────────────────

describe("edit handler — mixed input forms (ext-files + data: + https:)", () => {
  test("BYOK: all three forms upload as multipart image[] entries; only https hits the fetcher", async () => {
    nextResponse = (call) => {
      if (call.url === "https://img.example/remote.png") {
        return new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (call.url === "https://api.openai.com/v1/images/edits") {
        return imagesApiOkResponse();
      }
      throw new Error(`unexpected fetch: ${call.url}`);
    };

    const r = await makeEditHandler()({
      prompt: "remix",
      images: [
        EXT_FILES_URL,                       // resolved locally
        "data:image/png;base64,QUFB",        // decoded inline
        "https://img.example/remote.png",    // fetched
      ],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(false);

    // Two upstream URLs hit: the remote image and the edits endpoint.
    // The ext-files URL must NEVER appear in `captured`.
    const urls = captured.map((c) => c.url);
    expect(urls).toContain("https://img.example/remote.png");
    expect(urls).toContain("https://api.openai.com/v1/images/edits");
    expect(urls.some((u) => u.includes("/api/ext-files/"))).toBe(false);

    const editCall = captured.find((c) => c.url === "https://api.openai.com/v1/images/edits")!;
    const fd = editCall.init!.body as FormData;
    const blobs = fd.getAll("image[]") as Blob[];
    // All three references became upload entries — order matches input.
    expect(blobs).toHaveLength(3);

    const extFilesBlob = blobs[0]!;
    const extFilesBytes = new Uint8Array(await extFilesBlob.arrayBuffer());
    expect(Buffer.from(extFilesBytes).equals(Buffer.from(FIXTURE_PNG))).toBe(true);

    const dataUriBlob = blobs[1]!;
    const dataUriBytes = new Uint8Array(await dataUriBlob.arrayBuffer());
    // "QUFB" → "AAA" (3 bytes of 0x41).
    expect(Array.from(dataUriBytes)).toEqual([0x41, 0x41, 0x41]);

    const httpsBlob = blobs[2]!;
    const httpsBytes = new Uint8Array(await httpsBlob.arrayBuffer());
    expect(Array.from(httpsBytes)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  test("Codex: ext-files inlined to data:, data: passes through, https: passes through", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_ACCESS_TOKEN = makeCodexToken();

    nextResponse = () => codexImageStreamResponse("OUT");

    const r = await makeEditHandler()({
      prompt: "remix",
      images: [
        EXT_FILES_URL,
        "data:image/png;base64,QUFB",
        "https://img.example/remote.png",
      ],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(false);

    // Codex never makes a side fetch for input images — it inlines
    // ext-files locally and forwards the rest verbatim. Only the
    // single Responses POST should appear.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses");

    const body = JSON.parse(captured[0]!.init!.body as string);
    const content = body.input[0].content as Array<Record<string, unknown>>;
    // text + 3 input_image parts
    expect(content).toHaveLength(4);
    expect(content[0]!.type).toBe("input_text");

    // Slot 1 — ext-files inlined.
    expect(content[1]!.type).toBe("input_image");
    const extImg = content[1]!.image_url as string;
    expect(extImg).not.toContain("/api/ext-files/");
    expect(extImg.startsWith("data:image/png;base64,")).toBe(true);
    const decoded = Buffer.from(
      extImg.slice("data:image/png;base64,".length),
      "base64",
    );
    expect(decoded.equals(Buffer.from(FIXTURE_PNG))).toBe(true);

    // Slot 2 — data: passthrough.
    expect(content[2]).toEqual({
      type: "input_image",
      image_url: "data:image/png;base64,QUFB",
    });

    // Slot 3 — https: passthrough (Codex backend will fetch it itself).
    expect(content[3]).toEqual({
      type: "input_image",
      image_url: "https://img.example/remote.png",
    });
  });
});

// ── 4. Missing on-disk file ────────────────────────────────────────────

describe("edit handler — missing ext-files target", () => {
  test("BYOK: tool error mentioning the URL; no fetch issued", async () => {
    nextResponse = () => { throw new Error("network must not be called when the file is missing"); };

    const missingUrl = "/api/ext-files/openai-image-gen-2/generated/does-not-exist.png";
    const r = await makeEditHandler()({
      prompt: "p",
      images: [missingUrl],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(true);
    // Error text bubbled up from openai-client.fetchImageRef should
    // include the offending URL so the model can recover.
    expect(textOf(r)).toContain("does-not-exist.png");
    expect(textOf(r)).toMatch(/Invalid input/);
    expect(captured).toHaveLength(0);
  });

  test("Codex: tool error mentioning the URL; no fetch issued", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_ACCESS_TOKEN = makeCodexToken();
    nextResponse = () => { throw new Error("network must not be called when the file is missing"); };

    const missingUrl = "/api/ext-files/openai-image-gen-2/generated/does-not-exist.png";
    const r = await makeEditHandler()({
      prompt: "p",
      images: [missingUrl],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toContain("does-not-exist.png");
    expect(textOf(r)).toMatch(/Invalid input/);
    expect(captured).toHaveLength(0);
  });
});

// ── 5. Path traversal ──────────────────────────────────────────────────

describe("edit handler — path traversal rejected", () => {
  test("BYOK: validation error, no fetch and no disk read", async () => {
    nextResponse = () => { throw new Error("network must not be called for traversal"); };

    const r = await makeEditHandler()({
      prompt: "p",
      images: ["/api/ext-files/openai-image-gen-2/../../../etc/passwd"],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/Invalid input/);
    expect(textOf(r)).toMatch(/malformed|escapes/);
    expect(captured).toHaveLength(0);
  });

  test("Codex: validation error, no fetch", async () => {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_ACCESS_TOKEN = makeCodexToken();
    nextResponse = () => { throw new Error("network must not be called for traversal"); };

    const r = await makeEditHandler()({
      prompt: "p",
      images: ["/api/ext-files/openai-image-gen-2/../../../etc/passwd"],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/Invalid input/);
    expect(captured).toHaveLength(0);
  });
});

// ── 6. Unknown extension namespace ─────────────────────────────────────

describe("edit handler — unknown ext-files extension namespace", () => {
  test("BYOK: validation error, no fetch", async () => {
    nextResponse = () => { throw new Error("network must not be called for unknown namespace"); };

    const r = await makeEditHandler()({
      prompt: "p",
      images: ["/api/ext-files/some-other-ext/foo.png"],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/Invalid input/);
    // The validator's error message lists the three accepted forms.
    expect(textOf(r)).toMatch(/data.*https.*ext-files/);
    expect(captured).toHaveLength(0);
  });

  test("Codex: validation error, no fetch (symmetric with BYOK)", async () => {
    // Both paths must reject `/api/ext-files/<other-ext>/...` the same
    // way: validation error before any HTTP call. The shared
    // `isAcceptedImageRef` helper (in ext-files.ts) is consulted by the
    // BYOK path (validateEditParams) AND the Codex path
    // (materializeInputImages), so this case fails fast with a clear
    // message instead of leaking through to Codex as an opaque URL the
    // ChatGPT backend can't fetch.
    delete process.env.OPENAI_API_KEY;
    process.env.OPENAI_ACCESS_TOKEN = makeCodexToken();
    nextResponse = () => { throw new Error("network must not be called for unknown namespace"); };

    const r = await makeEditHandler()({
      prompt: "p",
      images: ["/api/ext-files/some-other-ext/foo.png"],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(true);
    expect(textOf(r)).toMatch(/Invalid input/);
    // Same help text as the BYOK rejection — lists the three accepted forms.
    expect(textOf(r)).toMatch(/data.*https.*ext-files/);
    expect(captured).toHaveLength(0);
  });
});

// ── 7. No regression on `generate` ────────────────────────────────────

describe("generate handler — still works after edit changes", () => {
  test("BYOK generate is unaffected by the edit-path additions", async () => {
    nextResponse = (call) => {
      expect(call.url).toBe("https://api.openai.com/v1/images/generations");
      return imagesApiOkResponse("R0VO");
    };

    const r = await makeGenerateHandler()({
      prompt: "a friendly otter",
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(false);
    expect(captured).toHaveLength(1);
    const body = JSON.parse(captured[0]!.init!.body as string);
    expect(body.prompt).toBe("a friendly otter");
  });

  test("can run generate immediately after edit in the same suite (state isolation)", async () => {
    // First: edit through BYOK using the prior-image URL.
    nextResponse = () => imagesApiOkResponse();
    let r = await makeEditHandler()({
      prompt: "edit",
      images: [EXT_FILES_URL],
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(false);

    // Reset capture buffer; the second handler should run cleanly.
    captured = [];
    nextResponse = () => imagesApiOkResponse("R0VO");

    r = await makeGenerateHandler()({
      prompt: "fresh",
      augment: false,
    });
    expect((r as ResultShape).isError).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.openai.com/v1/images/generations");
  });
});
