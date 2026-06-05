/**
 * Secure-preview WS/HMR bridge (Phase 3b) — server glue tests.
 *
 * Covers:
 *   - tryBridgePreviewWebSocket: non-upgrade → null (fall through); rejected
 *     decision → 403; accepted but no live Bun server (vite dev) → 426;
 *     accepted with a server → calls server.upgrade() with the pinned
 *     upstream as socket data + returns 101.
 *   - createPreviewWebSocketHandler: open rejects a non-preview socket; the
 *     message/close relay decisions (buffer-before-ready, relay-after-ready).
 *
 * The pure gate + CSWSH + port-pin live in src/.../preview-ws.ts (unit-tested
 * there). Here we mock token/registry so we exercise the wiring.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const verifyPreviewToken = vi.fn();
const getServablePreview = vi.fn();
vi.mock("$server/runtime/preview/preview-token", async () => {
  const actual = await vi.importActual<typeof import("$server/runtime/preview/preview-token")>(
    "$server/runtime/preview/preview-token",
  );
  return { ...actual, verifyPreviewToken: (...a: any[]) => (verifyPreviewToken as any)(...a) };
});
vi.mock("$server/db/queries/preview-sessions", async () => {
  const actual = await vi.importActual<typeof import("$server/db/queries/preview-sessions")>(
    "$server/db/queries/preview-sessions",
  );
  return { ...actual, getServablePreview: (...a: any[]) => (getServablePreview as any)(...a) };
});

const { tryBridgePreviewWebSocket, createPreviewWebSocketHandler, MAX_PREUPSTREAM_QUEUE } =
  await import("$lib/server/preview/ws-bridge");

const VALID_ID = "abcdefghjkmnpqrstvwxyz0123";
const APP_HOST = "ezcorp.example.com";
const ORIGIN = `https://${VALID_ID}.preview.${APP_HOST}`;

function wsRequest(headers: Record<string, string> = {}): Request {
  return new Request(`https://${VALID_ID}.preview.${APP_HOST}/__vite_hmr`, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      origin: ORIGIN,
      cookie: "__ezpreview=good",
      ...headers,
    },
  });
}

beforeEach(() => {
  verifyPreviewToken.mockReset();
  getServablePreview.mockReset();
  verifyPreviewToken.mockResolvedValue({ previewId: VALID_ID, userId: "u1" });
  getServablePreview.mockResolvedValue({
    id: VALID_ID, userId: "u1", kind: "dynamic", staticPath: null, targetPort: 5173,
  });
});

describe("tryBridgePreviewWebSocket", () => {
  test("a non-upgrade request returns null (fall through to HTTP)", async () => {
    const req = new Request(`https://${VALID_ID}.preview.${APP_HOST}/`);
    expect(await tryBridgePreviewWebSocket(req, VALID_ID, APP_HOST, undefined)).toBeNull();
  });

  test("a rejected gate (bad token) → 403", async () => {
    verifyPreviewToken.mockResolvedValue(null);
    const res = await tryBridgePreviewWebSocket(wsRequest(), VALID_ID, APP_HOST, { server: { upgrade: () => true }, request: {} });
    expect(res!.status).toBe(403);
  });

  test("a cross-site Origin → 403 (CSWSH)", async () => {
    const res = await tryBridgePreviewWebSocket(
      wsRequest({ origin: `https://evil.com` }),
      VALID_ID,
      APP_HOST,
      { server: { upgrade: () => true }, request: {} },
    );
    expect(res!.status).toBe(403);
  });

  test("accepted but no live Bun server (vite dev) → 426", async () => {
    const res = await tryBridgePreviewWebSocket(wsRequest(), VALID_ID, APP_HOST, undefined);
    expect(res!.status).toBe(426);
  });

  test("accepted with a live server → upgrade() with pinned upstream data", async () => {
    let upgradeArg: any = null;
    const server = { upgrade: (_req: unknown, opts?: { data?: unknown }) => { upgradeArg = opts?.data; return true; } };
    // NOTE: the function returns `new Response(null, {status:101})` — valid in
    // the live Bun runtime (the README pattern) but rejected by node/undici's
    // stricter Response ctor under vitest. We assert the load-bearing behavior
    // (upgrade() called with the pinned upstream data); the 101 sentinel is
    // exercised live in Docker.
    let res: Response | null = null;
    try {
      res = await tryBridgePreviewWebSocket(wsRequest(), VALID_ID, APP_HOST, { server, request: { raw: true } });
    } catch (e) {
      // undici 101 ctor rejection — tolerated; upgrade data is still captured.
      expect(String(e)).toContain("status");
    }
    if (res) expect(res.status).toBe(101);
    expect(upgradeArg).toMatchObject({
      __preview: true,
      previewId: VALID_ID,
      upstreamUrl: "ws://127.0.0.1:5173/__vite_hmr",
    });
  });

  test("upgrade() returning false → 400", async () => {
    const res = await tryBridgePreviewWebSocket(
      wsRequest(),
      VALID_ID,
      APP_HOST,
      { server: { upgrade: () => false }, request: {} },
    );
    expect(res!.status).toBe(400);
  });

  test("a Cookie header without __ezpreview yields a null token → gate rejects (readCookie miss)", async () => {
    // The upgrade carries a Cookie header, but it has no __ezpreview entry, so
    // readCookie walks every part and falls through to null. The decision gate
    // then sees no token and rejects → 403. (verifyToken must never run for a
    // null token.)
    const res = await tryBridgePreviewWebSocket(
      wsRequest({ cookie: "session=abc; junk; foo=bar" }),
      VALID_ID,
      APP_HOST,
      { server: { upgrade: () => true }, request: {} },
    );
    expect(res!.status).toBe(403);
    expect(verifyPreviewToken).not.toHaveBeenCalled();
  });
});

describe("createPreviewWebSocketHandler — frame relay decisions", () => {
  test("open closes a socket without __preview data (1008)", () => {
    const handler = createPreviewWebSocketHandler();
    let closed: { code?: number } | null = null;
    const ws = { data: undefined, close: (code?: number) => { closed = { code }; }, send: () => {} };
    handler.open(ws);
    expect(closed).toEqual({ code: 1008 });
  });

  test("message before upstream-ready buffers; close on an unknown socket is a no-op", () => {
    const handler = createPreviewWebSocketHandler();
    // No open() called → unknown socket. message + close must not throw.
    const ws = { data: { __preview: true } as any, close: () => {} };
    expect(() => handler.message(ws, "frame")).not.toThrow();
    expect(() => handler.close(ws)).not.toThrow();
  });

  test("default upstream factory: a malformed upstream URL throws in new WebSocket → 1011", () => {
    // No factory injected → the DEFAULT factory runs `new WebSocket(url)` for
    // real. A malformed URL makes the ctor throw synchronously; the open
    // handler's catch must close the client 1011 (never leave a half-open
    // socket). This exercises the production default factory closure.
    const handler = createPreviewWebSocketHandler();
    let closed: { code?: number } | null = null;
    const ws = {
      data: { __preview: true, upstreamUrl: "::::not-a-valid-ws-url::::", previewId: "p" } as any,
      close: (code?: number) => { closed = { code }; },
      send: () => {},
    };
    handler.open(ws);
    expect(closed).toEqual({ code: 1011 });
  });
});

// The LIVE relay data-path — previously untested (audit gap 2). A fake
// upstream (injected via the factory seam) lets us drive the full lifecycle:
// open → buffer-before-ready → upstream open (flush) → upstream message
// (→ client send) → upstream close (→ client close 1000), plus the nits
// (sync ctor throw → 1011; pre-ready queue cap → 1011).
type Listeners = { open?: () => void; message?: (ev: MessageEvent) => void; close?: () => void; error?: () => void };
function makeFakeUpstream() {
  const sent: (string | ArrayBufferLike)[] = [];
  const l: Listeners = {};
  let closedWith: { code?: number } | null = null;
  const ws = {
    binaryType: "",
    url: "",
    send: (d: string | ArrayBufferLike) => { sent.push(d); },
    close: (code?: number) => { closedWith = { code }; },
    addEventListener: (type: keyof Listeners, cb: any) => { l[type] = cb; },
  };
  return {
    ws,
    sent,
    get closedWith() { return closedWith; },
    fireOpen: () => l.open?.(),
    fireMessage: (data: unknown) => l.message?.({ data } as MessageEvent),
    fireClose: () => l.close?.(),
    fireError: () => l.error?.(),
  };
}
function makeClient() {
  const sent: (string | ArrayBufferLike)[] = [];
  let closedWith: { code?: number; reason?: string } | null = null;
  return {
    data: { __preview: true, upstreamUrl: "ws://127.0.0.1:5173/x", previewId: "p" } as any,
    send: (d: string | ArrayBufferLike) => sent.push(d),
    close: (code?: number, reason?: string) => { closedWith = { code, reason }; },
    sent,
    get closedWith() { return closedWith; },
  };
}

describe("createPreviewWebSocketHandler — LIVE relay data-path (fake upstream)", () => {
  test("full lifecycle: buffer → flush on upstream open → relay both ways → upstream close", () => {
    const up = makeFakeUpstream();
    const handler = createPreviewWebSocketHandler(() => up.ws as any);
    const client = makeClient();

    handler.open(client);
    // binaryType set on the upstream for binary relay.
    expect(up.ws.binaryType).toBe("arraybuffer");

    // Client sends BEFORE upstream is ready → queued, not yet forwarded.
    handler.message(client, "early-frame");
    expect(up.sent).toHaveLength(0);

    // Upstream connects → queued frames flush in order.
    up.fireOpen();
    expect(up.sent).toEqual(["early-frame"]);

    // Subsequent client frames forward immediately.
    handler.message(client, "live-frame");
    expect(up.sent).toEqual(["early-frame", "live-frame"]);

    // Upstream → client relay.
    up.fireMessage("hmr-update");
    expect(client.sent).toEqual(["hmr-update"]);

    // Upstream close → client gets a clean 1000.
    up.fireClose();
    expect(client.closedWith).toMatchObject({ code: 1000 });
  });

  test("upstream error closes the client 1011", () => {
    const up = makeFakeUpstream();
    const handler = createPreviewWebSocketHandler(() => up.ws as any);
    const client = makeClient();
    handler.open(client);
    up.fireError();
    expect(client.closedWith).toMatchObject({ code: 1011 });
  });

  test("client close tears down the upstream", () => {
    const up = makeFakeUpstream();
    const handler = createPreviewWebSocketHandler(() => up.ws as any);
    const client = makeClient();
    handler.open(client);
    handler.close(client);
    expect(up.closedWith).not.toBeNull();
  });

  test("a synchronous upstream-ctor throw closes the client 1011 (no half-open)", () => {
    const handler = createPreviewWebSocketHandler(() => {
      throw new Error("bad url");
    });
    const client = makeClient();
    handler.open(client);
    expect(client.closedWith).toMatchObject({ code: 1011 });
  });

  test("pre-ready queue cap: a flood before upstream-open tears the socket down 1011", () => {
    const up = makeFakeUpstream();
    const handler = createPreviewWebSocketHandler(() => up.ws as any);
    const client = makeClient();
    handler.open(client);
    // Fill the queue to the cap (upstream never fires open).
    for (let i = 0; i < MAX_PREUPSTREAM_QUEUE; i++) handler.message(client, `f${i}`);
    expect(client.closedWith).toBeNull(); // still under/at cap
    // One more overflows → both sockets torn down.
    handler.message(client, "overflow");
    expect(client.closedWith).toMatchObject({ code: 1011 });
    expect(up.closedWith).not.toBeNull();
  });
});
