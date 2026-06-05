/**
 * Server-side tests for the secure-preview SvelteKit glue:
 *   - POST /api/preview/:id/token (app-origin handoff mint)
 *   - matchPreviewOrigin / servePreviewRequest (hostname dispatch + /__open)
 *
 * The pure proxy + token + registry logic is unit-tested under src/.
 * Here we mock the registry + token modules so we exercise the wiring:
 * auth gate, ownership gate, the code -> cookie swap, and the cookie-read
 * serving path — without a DB or live socket.
 */
import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";

// Registry mock.
const getServablePreview = vi.fn();
const touchPreview = vi.fn(async () => undefined);
vi.mock("$server/db/queries/preview-sessions", async () => {
  const actual = await vi.importActual<typeof import("$server/db/queries/preview-sessions")>(
    "$server/db/queries/preview-sessions",
  );
  return {
    ...actual,
    getServablePreview: (...a: any[]) => (getServablePreview as any)(...a),
    touchPreview: (...a: any[]) => (touchPreview as any)(...a),
  };
});

// Token mock — keep code/JWT logic real but observe mintOneTimeCode.
const mintOneTimeCode = vi.fn(() => "the-code");
const redeemOneTimeCode = vi.fn();
const verifyPreviewToken = vi.fn();
const signPreviewToken = vi.fn(async () => "signed.jwt.token");
vi.mock("$server/runtime/preview/preview-token", async () => {
  const actual = await vi.importActual<typeof import("$server/runtime/preview/preview-token")>(
    "$server/runtime/preview/preview-token",
  );
  return {
    ...actual,
    mintOneTimeCode: (...a: any[]) => (mintOneTimeCode as any)(...a),
    redeemOneTimeCode: (...a: any[]) => (redeemOneTimeCode as any)(...a),
    verifyPreviewToken: (...a: any[]) => (verifyPreviewToken as any)(...a),
    signPreviewToken: (...a: any[]) => (signPreviewToken as any)(...a),
  };
});

const { POST } = await import("../routes/api/preview/[id]/token/+server");
const { matchPreviewOrigin, servePreviewRequest, meterResponseBody } = await import(
  "$lib/server/preview/dispatch"
);
const { PREVIEW_TOKEN_TTL_SECONDS } = await import("$server/runtime/preview/preview-token");

const VALID_ID = "abcdefghjkmnpqrstvwxyz0123";
const user = { id: "u1", email: "u@x", name: "u", role: "member" as const };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EZCORP_PREVIEW_APP_HOST = "ezcorp.example.com";
  // FORCE_SECURE_COOKIES is toggled per-test below; make sure it never
  // leaks ACROSS tests/describe blocks (e.g. into matchPreviewOrigin).
  delete process.env.FORCE_SECURE_COOKIES;
});

afterEach(() => {
  delete process.env.FORCE_SECURE_COOKIES;
});

describe("POST /api/preview/:id/token", () => {
  test("401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST({ params: { id: VALID_ID }, locals: {} } as any);
    } catch (thrown) {
      res = thrown as Response;
    }
    expect(res?.status).toBe(401);
  });

  test("404 on a malformed id", async () => {
    const res = await POST({ params: { id: "bad" }, locals: { user } } as any);
    expect(res.status).toBe(404);
    expect(mintOneTimeCode).not.toHaveBeenCalled();
  });

  test("404 when the preview isn't servable for this user", async () => {
    getServablePreview.mockResolvedValue(undefined);
    const res = await POST({ params: { id: VALID_ID }, locals: { user } } as any);
    expect(res.status).toBe(404);
    expect(mintOneTimeCode).not.toHaveBeenCalled();
  });

  test("mints a one-time code for the owner's live preview", async () => {
    getServablePreview.mockResolvedValue({ id: VALID_ID, userId: "u1", kind: "static" });
    const res = await POST({ params: { id: VALID_ID }, locals: { user } } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: "the-code" });
    expect(mintOneTimeCode).toHaveBeenCalledWith({ previewId: VALID_ID, userId: "u1" });
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });
});

describe("matchPreviewOrigin", () => {
  test("matches a configured preview host", () => {
    const req = new Request("http://x/", { headers: { host: `${VALID_ID}.preview.ezcorp.example.com` } });
    expect(matchPreviewOrigin(req)).toEqual({ previewId: VALID_ID });
  });

  test("does not match the app origin", () => {
    const req = new Request("http://x/", { headers: { host: "ezcorp.example.com" } });
    expect(matchPreviewOrigin(req)).toBeNull();
  });

  test("disabled when EZCORP_PREVIEW_APP_HOST is unset", () => {
    delete process.env.EZCORP_PREVIEW_APP_HOST;
    const req = new Request("http://x/", { headers: { host: `${VALID_ID}.preview.ezcorp.example.com` } });
    expect(matchPreviewOrigin(req)).toBeNull();
  });
});

describe("servePreviewRequest /__open handoff", () => {
  test("redeems a code and sets a host-only __ezpreview cookie, 302 to /", async () => {
    redeemOneTimeCode.mockReturnValue({ previewId: VALID_ID, userId: "u1" });
    const req = new Request(`http://${VALID_ID}.preview.ezcorp.example.com/__open?c=the-code`);
    const res = await servePreviewRequest(req, { previewId: VALID_ID });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("__ezpreview=signed.jwt.token");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("Domain="); // host-only
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test("404 when the code does not redeem", async () => {
    redeemOneTimeCode.mockReturnValue(null);
    const req = new Request(`http://${VALID_ID}.preview.ezcorp.example.com/__open?c=bad`);
    const res = await servePreviewRequest(req, { previewId: VALID_ID });
    expect(res.status).toBe(404);
  });

  test("404 when the code is for a different preview id (cross-preview)", async () => {
    redeemOneTimeCode.mockReturnValue({ previewId: "z0123456789abcdefghjkmnpqr", userId: "u1" });
    const req = new Request(`http://${VALID_ID}.preview.ezcorp.example.com/__open?c=x`);
    const res = await servePreviewRequest(req, { previewId: VALID_ID });
    expect(res.status).toBe(404);
  });

  test("sets `; Secure` + Max-Age=TTL when FORCE_SECURE_COOKIES is on", async () => {
    process.env.FORCE_SECURE_COOKIES = "true";
    redeemOneTimeCode.mockReturnValue({ previewId: VALID_ID, userId: "u1" });
    const req = new Request(`http://${VALID_ID}.preview.ezcorp.example.com/__open?c=the-code`);
    const res = await servePreviewRequest(req, { previewId: VALID_ID });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("; Secure");
    // Max-Age tracks the token TTL constant (don't hardcode the number).
    expect(setCookie).toContain(`Max-Age=${PREVIEW_TOKEN_TTL_SECONDS}`);
  });

  test("omits `; Secure` when FORCE_SECURE_COOKIES is unset", async () => {
    // (beforeEach already deletes it; assert the negative branch explicitly.)
    redeemOneTimeCode.mockReturnValue({ previewId: VALID_ID, userId: "u1" });
    const req = new Request(`http://${VALID_ID}.preview.ezcorp.example.com/__open?c=the-code`);
    const res = await servePreviewRequest(req, { previewId: VALID_ID });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).not.toContain("; Secure");
    expect(setCookie).toContain(`Max-Age=${PREVIEW_TOKEN_TTL_SECONDS}`);
  });
});

describe("servePreviewRequest serving path", () => {
  test("404 with no cookie token", async () => {
    const req = new Request(`http://${VALID_ID}.preview.ezcorp.example.com/index.html`);
    const res = await servePreviewRequest(req, { previewId: VALID_ID });
    expect(res.status).toBe(404);
    expect(verifyPreviewToken).not.toHaveBeenCalled();
  });

  test("reads the __ezpreview cookie and runs the access check", async () => {
    verifyPreviewToken.mockResolvedValue({ previewId: VALID_ID, userId: "u1" });
    getServablePreview.mockResolvedValue(undefined); // not servable -> 404
    const req = new Request(`http://${VALID_ID}.preview.ezcorp.example.com/index.html`, {
      headers: { cookie: "__ezpreview=sometoken" },
    });
    const res = await servePreviewRequest(req, { previewId: VALID_ID });
    expect(res.status).toBe(404);
    expect(verifyPreviewToken).toHaveBeenCalledWith("sometoken");
  });

  test("a cookie header WITHOUT __ezpreview falls through to no-token 404 (readCookie miss)", async () => {
    // The Cookie header is present but has no __ezpreview entry — readCookie
    // must walk every part and return null (its final fall-through), so the
    // serving path 404s without ever verifying a token.
    const req = new Request(`http://${VALID_ID}.preview.ezcorp.example.com/index.html`, {
      headers: { cookie: "other=keep; malformed; another=x" },
    });
    const res = await servePreviewRequest(req, { previewId: VALID_ID });
    expect(res.status).toBe(404);
    expect(verifyPreviewToken).not.toHaveBeenCalled();
  });

  // NOTE: the static-serve happy path's `readFile` dep uses `Bun.file(abs)
  // .stream()` — a Bun-runtime-only API. The web coverage leg runs under
  // vitest/jsdom (node), where `Bun` is undefined, so that 2-line closure
  // (dispatch.ts:127-128) cannot be exercised here. It is covered live in the
  // adapter-bun server (Docker) + the pure resolveStaticFile/handlePreviewRequest
  // static path is exhaustively unit-tested under src/__tests__/preview-proxy.test.ts.
});

describe("servePreviewRequest dynamic passthrough (Phase 3a)", () => {
  test("proxies an authorized dynamic preview to the pinned dev port (port-pin + cookie strip)", async () => {
    verifyPreviewToken.mockResolvedValue({ previewId: VALID_ID, userId: "u1" });
    getServablePreview.mockResolvedValue({
      id: VALID_ID, userId: "u1", kind: "dynamic", staticPath: null, targetPort: 5173,
    });
    // Intercept the loopback fetch the passthrough makes.
    let fetched: { url: string; host: string | null; cookie: string | null } | null = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const h = new Headers(init?.headers);
      fetched = { url: String(input), host: h.get("host"), cookie: h.get("cookie") };
      return new Response("<h1>dev</h1>", { status: 200, headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;
    try {
      const req = new Request(`http://${VALID_ID}.preview.ezcorp.example.com/app.js?v=1`, {
        headers: { cookie: "__ezpreview=tok; other=keep" },
      });
      const res = await servePreviewRequest(req, { previewId: VALID_ID });
      expect(res.status).toBe(200);
      expect(fetched).not.toBeNull();
      // Pinned to loopback:5173 with the path + query preserved.
      expect(fetched!.url).toBe("http://127.0.0.1:5173/app.js?v=1");
      expect(fetched!.host).toBe("127.0.0.1:5173");
      // The preview access cookie is NEVER forwarded to the untrusted dev server.
      expect(fetched!.cookie).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("dev server down → graceful 502", async () => {
    verifyPreviewToken.mockResolvedValue({ previewId: VALID_ID, userId: "u1" });
    getServablePreview.mockResolvedValue({
      id: VALID_ID, userId: "u1", kind: "dynamic", staticPath: null, targetPort: 5173,
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    try {
      const req = new Request(`http://${VALID_ID}.preview.ezcorp.example.com/`, {
        headers: { cookie: "__ezpreview=tok" },
      });
      const res = await servePreviewRequest(req, { previewId: VALID_ID });
      expect(res.status).toBe(502);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("proxyDynamicFetch (loopback port-pin)", () => {
  test("pins host+port to 127.0.0.1, manual redirect, strips cookie, preserves query", async () => {
    const { proxyDynamicFetch } = await import("$lib/server/preview/dispatch");
    const realFetch = globalThis.fetch;
    let captured: { url: string; init: any } | null = null;
    globalThis.fetch = (async (input: any, init?: any) => {
      captured = { url: typeof input === "string" ? input : input.toString(), init };
      return new Response("ok");
    }) as typeof fetch;
    try {
      const req = new Request("http://attacker.example.com/path?q=1", {
        method: "GET",
        headers: {
          cookie: "__ezpreview=secret",
          authorization: "Bearer app-secret",
          "x-forwarded-for": "1.2.3.4",
          "x-forwarded-host": "evil",
          forwarded: "for=1.2.3.4",
          "x-ezcorp-internal": "leak",
          "x-keep": "1",
        },
      });
      await proxyDynamicFetch(8080, req, "/path");
      expect(captured!.url).toBe("http://127.0.0.1:8080/path?q=1");
      expect(captured!.init.redirect).toBe("manual");
      const h = new Headers(captured!.init.headers);
      // Inbound sanitation (Phase 3b): credentials + forwarded + internal gone.
      expect(h.get("cookie")).toBeNull();
      expect(h.get("authorization")).toBeNull();
      expect(h.get("x-forwarded-for")).toBeNull();
      expect(h.get("x-forwarded-host")).toBeNull();
      expect(h.get("forwarded")).toBeNull();
      expect(h.get("x-ezcorp-internal")).toBeNull();
      // Host pinned to loopback; an unrelated safe header survives.
      expect(h.get("host")).toBe("127.0.0.1:8080");
      expect(h.get("x-keep")).toBe("1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("meterResponseBody (per-preview byte budget)", () => {
  function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
        else controller.close();
      },
    });
  }
  async function drain(stream: ReadableStream<Uint8Array>): Promise<{ bytes: number; errored: boolean }> {
    const reader = stream.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
      return { bytes, errored: false };
    } catch {
      return { bytes, errored: true };
    }
  }

  test("passes through chunks while under budget", async () => {
    const quota = { allowBytes: () => true };
    const out = meterResponseBody(streamOf("aaa", "bbb"), "p1", quota);
    const r = await drain(out);
    expect(r.errored).toBe(false);
    expect(r.bytes).toBe(6);
  });

  test("errors the stream when a chunk exceeds the budget", async () => {
    let calls = 0;
    const quota = { allowBytes: () => { calls++; return calls === 1; } };
    const out = meterResponseBody(streamOf("aaa", "bbb"), "p1", quota);
    const r = await drain(out);
    expect(r.errored).toBe(true);
    expect(r.bytes).toBe(3);
  });

  test("charges the preview id passed in", async () => {
    const seen: string[] = [];
    const quota = { allowBytes: (id: string) => { seen.push(id); return true; } };
    const out = meterResponseBody(streamOf("x"), "preview-xyz", quota);
    await drain(out);
    expect(seen).toEqual(["preview-xyz"]);
  });

  test("cancelling the metered stream cancels the underlying reader (cleanup)", async () => {
    let cancelled = false;
    let cancelReason: unknown;
    // A source whose cancel records that downstream cancellation propagated.
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("data"));
      },
      cancel(reason) {
        cancelled = true;
        cancelReason = reason;
      },
    });
    const quota = { allowBytes: () => true };
    const out = meterResponseBody(source, "p1", quota);
    const reader = out.getReader();
    await reader.read(); // pull one chunk so the wrapper is live
    await reader.cancel("consumer-bailed"); // hits the wrapper's cancel(reason)
    expect(cancelled).toBe(true);
    expect(cancelReason).toBe("consumer-bailed");
  });
});
