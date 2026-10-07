/**
 * ws-bridge.ts — the LIVE client↔upstream WebSocket bridge for dynamic
 * preview HMR (Secure User-Site Preview / Port Exposure, Phase 3b,
 * deliverable 2). Vite + Bun dev servers push HMR over a WebSocket; without
 * relaying it the page loads but live-reload is dead.
 *
 * The pure access gate + Origin/CSWSH check + port pin live in
 * `$server/runtime/preview/preview-ws.ts` (`decideWebSocketUpgrade`,
 * `isWebSocketUpgrade`). THIS module is the svelte-adapter-bun integration
 * seam: it runs that gate, then (on accept) hands `Bun.serve().upgrade()` the
 * pinned `ws://127.0.0.1:<port>` upstream URL as socket `data`, and the
 * exported `previewWebSocketHandler` opens an upstream `WebSocket` and relays
 * frames both ways.
 *
 * Live-path notes (documented seam):
 *   - This only runs in the svelte-adapter-bun PROD/Docker server, where
 *     `event.platform.server` exists. Under `vite dev` there is no Bun server
 *     to `.upgrade()`, so the bridge is inert in dev (the proxy still serves
 *     HTTP; HMR-through-preview is a Docker-verified path). The DECISION logic
 *     is fully unit-tested regardless.
 *   - The upstream is pinned to loopback + the exact registered port by the
 *     decision (SSRF defense); this module never derives a host from the
 *     request.
 */

import {
  isWebSocketUpgrade,
  decideWebSocketUpgrade,
} from "$server/runtime/preview/preview-ws";
import { verifyPreviewToken, PREVIEW_COOKIE_NAME } from "$server/runtime/preview/preview-token";
import { getServablePreview, isValidPreviewId } from "$server/db/queries/preview-sessions";
import { resolveCurrentPreviewSandboxTarget } from "$server/runtime/preview/preview-target";
import { getPreviewQuota } from "$server/runtime/preview/preview-rate-limit";
import { sameSandboxWorkspaceBinding, type SandboxPreviewSocket, type SandboxWorkspaceBinding } from "$server/runtime/workspaces/target";

/** Socket context attached at upgrade time, read by the open handler. */
interface LocalPreviewWsData {
  __preview: true;
  upstreamUrl: string;
  previewId: string;
}
interface SandboxPreviewWsData {
  __preview: true;
  kind: "sandbox";
  previewId: string;
  userId: string;
  cookieToken: string;
  binding: Readonly<SandboxWorkspaceBinding>;
  port: number;
  expiresAt: number;
  duplex: SandboxPreviewSocket;
  abort: AbortController;
}
export type PreviewWsData = LocalPreviewWsData | SandboxPreviewWsData;

const MAX_WS_FRAME_BYTES = 256 * 1024;
const MAX_WS_FRAMES = 1024;
const MAX_WS_BYTES = 4 * 1024 * 1024;
const MAX_WS_CONNECTIONS_PER_PREVIEW = 4;
const RECHECK_MS = 1000;

function frameBytes(frame: string | ArrayBufferLike | Uint8Array): number {
  return typeof frame === "string" ? Buffer.byteLength(frame) : frame.byteLength;
}

function requestedSubprotocol(header: string | null): "vite-hmr" | "vite-ping" | null | undefined {
  if (header === null) return null;
  const value = header.trim();
  return value === "vite-hmr" || value === "vite-ping" ? value : undefined;
}

async function currentSandboxPreview(data: SandboxPreviewWsData): Promise<boolean> {
  if (Date.now() >= data.expiresAt) return false;
  const claims = await verifyPreviewToken(data.cookieToken);
  if (claims?.previewId !== data.previewId || claims.userId !== data.userId) return false;
  const row = await getServablePreview(data.previewId, data.userId);
  if (!row || row.userId !== data.userId || row.kind !== "dynamic" || row.targetPort !== data.port
    || !(row.expiresAt instanceof Date) || row.expiresAt.getTime() <= Date.now()
    || row.workspaceTarget?.kind !== "sandbox"
    || !sameSandboxWorkspaceBinding(row.workspaceTarget.binding, data.binding)) return false;
  const target = await resolveCurrentPreviewSandboxTarget(row);
  return target?.kind === "sandbox" && sameSandboxWorkspaceBinding(target.binding, data.binding)
    && !!target.backend?.previews?.connectWebSocket;
}

/** Minimal Cookie header parser — returns the named cookie value or null. */
function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Attempt to bridge a WS upgrade for a preview origin. Returns:
 *   - a `Response` (101 on accept handing off to Bun, or a rejection status)
 *     when this request IS a preview WS upgrade we handled, OR
 *   - null when it is NOT a WS upgrade (the caller falls through to the HTTP
 *     passthrough).
 *
 * `server`/`rawRequest` come from `event.platform` (svelte-adapter-bun). When
 * they are absent (vite dev), an upgrade request can't be bridged — we return
 * a 426 so the client sees a clean "upgrade unavailable" rather than a hang.
 */
export async function tryBridgePreviewWebSocket(
  request: Request,
  previewId: string,
  appHost: string | null,
  platform: { server?: { upgrade(req: unknown, opts?: { data?: unknown; headers?: HeadersInit }): boolean }; request?: unknown } | undefined,
): Promise<Response | null> {
  if (!isWebSocketUpgrade(request)) return null;

  const url = new URL(request.url);
  const cookieToken = readCookie(request.headers.get("cookie"), PREVIEW_COOKIE_NAME);
  const decision = await decideWebSocketUpgrade(
    {
      previewId,
      requestPath: url.pathname,
      search: url.search,
      cookieToken,
      origin: request.headers.get("origin"),
      appHost,
    },
    {
      verifyToken: (t) => verifyPreviewToken(t),
      getServable: (id, userId) => getServablePreview(id, userId),
      isValidPreviewId,
    },
  );

  if (!decision.accept) {
    // Opaque 403 — same surface as the HTTP 404 (gives nothing away).
    return new Response("Forbidden", {
      status: 403,
      headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store" },
    });
  }

  // Hand off to the Bun server. Without a live Bun server (vite dev) we can't
  // upgrade — answer 426 Upgrade Required rather than hang the client.
  if (!platform?.server || platform.request === undefined) {
    return new Response("WebSocket bridge unavailable in this environment", { status: 426 });
  }

  if ("kind" in decision && decision.kind === "sandbox") {
    const protocol = requestedSubprotocol(request.headers.get("sec-websocket-protocol"));
    const target = await resolveCurrentPreviewSandboxTarget(decision.row);
    if (protocol === undefined || target?.kind !== "sandbox" || !target.backend?.previews?.connectWebSocket
      || decision.row.workspaceTarget?.kind !== "sandbox"
      || !sameSandboxWorkspaceBinding(target.binding, decision.row.workspaceTarget.binding)) {
      return new Response("Forbidden", { status: 403 });
    }
    const abort = new AbortController();
    let duplex: SandboxPreviewSocket | undefined;
    try {
      duplex = await target.backend.previews.connectWebSocket({
        binding: target.binding, previewId, userId: decision.userId, targetPort: decision.port,
        requestPath: url.pathname, search: url.search, expiresAt: decision.row.expiresAt!,
        signal: abort.signal, subprotocol: protocol,
      });
      if (duplex.protocol !== protocol) throw new Error("Sandbox preview protocol changed");
      const data: SandboxPreviewWsData = {
        __preview: true, kind: "sandbox", previewId, userId: decision.userId, cookieToken: cookieToken!, binding: target.binding,
        port: decision.port, expiresAt: decision.row.expiresAt!.getTime(), duplex, abort,
      };
      if (!await currentSandboxPreview(data)) throw new Error("Sandbox preview changed before upgrade");
      const headers = protocol ? { "Sec-WebSocket-Protocol": protocol } : undefined;
      if (!platform.server.upgrade(platform.request, { data, ...(headers ? { headers } : {}) })) {
        throw new Error("Sandbox preview upgrade failed");
      }
    } catch {
      abort.abort();
      await duplex?.close().catch(() => undefined);
      return new Response("Forbidden", { status: 403 });
    }
    return new Response(null, { status: 101 });
  }
  if (!("upstreamUrl" in decision)) return new Response("Forbidden", { status: 403 });

  const data: PreviewWsData = {
    __preview: true,
    upstreamUrl: decision.upstreamUrl,
    previewId,
  };
  const ok = platform.server.upgrade(platform.request, { data });
  if (!ok) {
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  // Bun has taken over the socket; SvelteKit just needs a 101 sentinel.
  return new Response(null, { status: 101 });
}

/**
 * Minimal subset of the WHATWG WebSocket the bridge actually uses upstream —
 * enough for the relay + the injectable test seam. `globalThis.WebSocket`
 * (Bun's) satisfies it structurally.
 */
export interface UpstreamWebSocket {
  binaryType: string;
  send(data: string | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", cb: () => void): void;
  addEventListener(type: "message", cb: (ev: MessageEvent) => void): void;
}

/** Factory for the upstream socket. Defaults to `globalThis.WebSocket`; tests
 *  inject a fake so the relay data-path can be driven without a live server. */
export type UpstreamWebSocketFactory = (url: string) => UpstreamWebSocket;

const defaultUpstreamFactory: UpstreamWebSocketFactory = (url) =>
  new WebSocket(url) as unknown as UpstreamWebSocket;

/**
 * Cap on frames buffered BEFORE the upstream finishes connecting. A client
 * that floods the socket pre-upstream-ready could otherwise grow the queue
 * unbounded (memory DoS). Past the cap we tear the client socket down (1011).
 */
export const MAX_PREUPSTREAM_QUEUE = 256;

/**
 * Bun WebSocketHandler that bridges an accepted preview client socket to its
 * pinned loopback upstream. Each client socket lazily opens an upstream
 * `WebSocket(upstreamUrl)`; frames relay both directions; either side closing
 * tears down the other. Only sockets carrying our `__preview` data are
 * handled — any other websocket (the app has none today, but defensively) is
 * left untouched (closed) so this handler can be the single adapter export.
 *
 * `upstreamFactory` is injectable so the relay data-path is unit-testable with
 * a fake upstream (the default constructs a real `globalThis.WebSocket`).
 */
export function createPreviewWebSocketHandler(
  upstreamFactory: UpstreamWebSocketFactory = defaultUpstreamFactory,
) {
  // Per-client upstream + a small outbound buffer for frames that arrive
  // before the upstream finishes connecting.
  const upstreams = new WeakMap<
    object,
    { ws: UpstreamWebSocket; ready: boolean; queue: (string | ArrayBufferLike)[] }
  >();
  type Client = { data?: unknown; close(code?: number, reason?: string): void; send(msg: string | ArrayBufferLike): void };
  type SandboxState = { data: SandboxPreviewWsData; closed: boolean; frames: number; bytes: number;
    timer: ReturnType<typeof setInterval>; pending: Promise<void>; checking?: Promise<boolean> };
  const sandboxStates = new WeakMap<object, SandboxState>();
  const sandboxByPreview = new Map<string, Set<object>>();

  function stopSandbox(ws: Client, state: SandboxState, code = 1000, closeClient = true): void {
    if (state.closed) return;
    state.closed = true;
    clearInterval(state.timer);
    state.data.abort.abort();
    sandboxStates.delete(ws);
    const clients = sandboxByPreview.get(state.data.previewId);
    clients?.delete(ws);
    if (clients?.size === 0) sandboxByPreview.delete(state.data.previewId);
    void state.data.duplex.close().catch(() => undefined);
    if (closeClient) ws.close(code, code === 1000 ? "preview closed" : "preview unavailable");
  }

  async function stillAllowed(ws: Client, state: SandboxState, fresh = false): Promise<boolean> {
    if (state.closed) return false;
    if (fresh && state.checking) await state.checking;
    if (state.closed) return false;
    state.checking ??= currentSandboxPreview(state.data).catch(() => false).then(allowed => {
      if (!allowed) stopSandbox(ws, state, 1008);
      return allowed && !state.closed;
    }).finally(() => { state.checking = undefined; });
    return state.checking;
  }

  function accountFrame(ws: Client, state: SandboxState, frame: string | ArrayBufferLike | Uint8Array): boolean {
    const bytes = frameBytes(frame);
    state.frames++;
    state.bytes += bytes;
    if (bytes <= MAX_WS_FRAME_BYTES && state.frames <= MAX_WS_FRAMES && state.bytes <= MAX_WS_BYTES
      && getPreviewQuota().allowBytes(state.data.previewId, bytes)) return true;
    stopSandbox(ws, state, 1009);
    return false;
  }

  return {
    open(ws: Client) {
      const data = ws.data as PreviewWsData | undefined;
      if (data?.__preview !== true) {
        ws.close(1008, "not a preview socket");
        return;
      }
      if ("kind" in data && data.kind === "sandbox") {
        const clients = sandboxByPreview.get(data.previewId) ?? new Set<object>();
        if (clients.size >= MAX_WS_CONNECTIONS_PER_PREVIEW) {
          data.abort.abort();
          void data.duplex.close().catch(() => undefined);
          ws.close(1008, "preview unavailable");
          return;
        }
        const state: SandboxState = { data, closed: false, frames: 0, bytes: 0,
          timer: setInterval(() => { void stillAllowed(ws, state); }, RECHECK_MS), pending: Promise.resolve() };
        sandboxStates.set(ws, state);
        clients.add(ws);
        sandboxByPreview.set(data.previewId, clients);
        void (async () => {
          if (!await stillAllowed(ws, state)) return;
          for await (const frame of data.duplex.messages) {
            if (!await stillAllowed(ws, state, true) || !accountFrame(ws, state, frame)) return;
            ws.send(typeof frame === "string" ? frame : Uint8Array.from(frame).buffer);
          }
          stopSandbox(ws, state);
        })().catch(() => stopSandbox(ws, state, 1011));
        return;
      }
      if (!("upstreamUrl" in data)) {
        ws.close(1008, "preview unavailable");
        return;
      }
      // The upstream ctor can throw SYNCHRONOUSLY (malformed URL, immediate
      // refusal). Catch it so we never leave a half-open client socket —
      // close 1011 and bail (nit D).
      let upstream: UpstreamWebSocket;
      try {
        upstream = upstreamFactory(data.upstreamUrl);
      } catch {
        ws.close(1011, "upstream connect failed");
        return;
      }
      const state = { ws: upstream, ready: false, queue: [] as (string | ArrayBufferLike)[] };
      // Bun's WebSocket supports binary; relay both text + binary.
      upstream.binaryType = "arraybuffer";
      upstreams.set(ws, state);

      upstream.addEventListener("open", () => {
        state.ready = true;
        for (const frame of state.queue) upstream.send(frame);
        state.queue.length = 0;
      });
      upstream.addEventListener("message", (ev: MessageEvent) => {
        ws.send(ev.data as string | ArrayBufferLike);
      });
      upstream.addEventListener("close", () => {
        ws.close(1000, "upstream closed");
      });
      upstream.addEventListener("error", () => {
        ws.close(1011, "upstream error");
      });
    },

    message(ws: { data?: unknown; close(code?: number, reason?: string): void }, message: string | ArrayBufferLike) {
      const sandbox = sandboxStates.get(ws as object);
      if (sandbox) {
        if (!accountFrame(ws as Client, sandbox, message)) return;
        sandbox.pending = sandbox.pending.then(async () => {
          if (!await stillAllowed(ws as Client, sandbox, true)) return;
          const frame = typeof message === "string" ? message : new Uint8Array(message);
          await sandbox.data.duplex.send(frame);
        }).catch(() => stopSandbox(ws as Client, sandbox, 1011));
        return;
      }
      const state = upstreams.get(ws as object);
      if (!state) return;
      if (state.ready) {
        state.ws.send(message);
        return;
      }
      // Pre-upstream-ready: buffer, but CAP the queue so a flood before the
      // upstream connects can't grow memory without bound (nit E). Over the
      // cap we tear down the client + upstream rather than keep buffering.
      if (state.queue.length >= MAX_PREUPSTREAM_QUEUE) {
        try {
          state.ws.close();
        } catch {
          // already closed
        }
        upstreams.delete(ws as object);
        ws.close(1011, "preview upstream buffer overflow");
        return;
      }
      state.queue.push(message);
    },

    close(ws: { data?: unknown }) {
      const sandbox = sandboxStates.get(ws as object);
      if (sandbox) {
        stopSandbox(ws as Client, sandbox, 1000, false);
        return;
      }
      const state = upstreams.get(ws as object);
      if (state) {
        try {
          state.ws.close();
        } catch {
          // already closed
        }
        upstreams.delete(ws as object);
      }
    },
  };
}
