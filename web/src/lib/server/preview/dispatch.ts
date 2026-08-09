import {
  parsePreviewHost,
  handlePreviewRequest,
  resolvePreviewAppHost,
  sanitizeInboundHeaders,
  type ParsedPreviewHost,
} from "$server/runtime/preview/preview-proxy";
import {
  verifyPreviewToken,
  redeemOneTimeCode,
  signPreviewToken,
  PREVIEW_COOKIE_NAME,
  PREVIEW_TOKEN_TTL_SECONDS,
} from "$server/runtime/preview/preview-token";
import { getServablePreview, touchPreview } from "$server/db/queries/preview-sessions";
import { tryBridgePreviewWebSocket } from "./ws-bridge";
import { getPreviewQuota } from "$server/runtime/preview/preview-rate-limit";

// ── Preview-origin dispatch glue (SvelteKit side) ──────────────────────
//
// Wires the pure proxy module (`preview-proxy.ts`) to real deps:
//   - token verify (preview-token.ts)
//   - registry access check (preview-sessions.ts)
//   - streamed file reads
// and handles the `/__open?c=<code>` cookie-swap handoff.
//
// Called FIRST in hooks.server.ts's `handle`, before payload/rate/auth:
// preview-origin requests must NOT be routed into the app's auth flow
// (the app origin's ezcorp_session is not sent here by design — D4).

/**
 * The app host that owns the `*.preview.<host>` wildcard. Delegates to the
 * shared `resolvePreviewAppHost` so this matcher and the open-URL builder
 * (`src/startup/background-timers.ts`) can never disagree about which
 * origin is live. When it returns null the preview origin is DISABLED
 * (parse returns null for every host) so a misconfigured deploy never
 * accidentally serves untrusted content on an unexpected origin.
 * Operators set `EZCORP_PREVIEW_APP_HOST` to e.g. `localhost` (dev,
 * `*.localhost` auto-resolves), `ezcorp.example.com` (prod, behind a
 * wildcard TLS cert), or `auto` to track `EZCORP_PUBLIC_URL`.
 *
 * Wildcard DNS + TLS setup: `deploy/preview-dns/Corefile.example` (the
 * env-driven CoreDNS sidecar and the split-DNS wiring for dnsmasq /
 * systemd-resolved / Tailscale) and docs/local-prod-test-stack.md for
 * the end-to-end flow. Feature reference:
 * docs/features/tools/preview-port-exposure.md.
 */
function appHost(): string | null {
  return resolvePreviewAppHost();
}

/**
 * If the request's Host header is a preview origin, returns the parsed
 * id; otherwise null (the caller falls through to normal app routing).
 */
export function matchPreviewOrigin(request: Request): ParsedPreviewHost | null {
  const host = appHost();
  if (!host) return null;
  return parsePreviewHost(request.headers.get("host"), host);
}

/**
 * Serve a request that has already been matched to the preview origin.
 * Handles `/__open` (code -> cookie swap), a WS-upgrade bridge (HMR), and
 * otherwise delegates to the static/dynamic handler.
 *
 * `platform` is the svelte-adapter-bun `event.platform` (the live Bun server +
 * raw request) — required only for the WS bridge; absent under vite dev (the
 * bridge then answers 426). Optional so static-only callers/tests don't need
 * to construct it.
 */
export async function servePreviewRequest(
  request: Request,
  parsed: ParsedPreviewHost,
  platform?: {
    server?: { upgrade(req: unknown, opts?: { data?: unknown }): boolean };
    request?: unknown;
  },
): Promise<Response> {
  const url = new URL(request.url);
  const previewId = parsed.previewId;

  // ── WebSocket / HMR upgrade bridge (Phase 3b) ──
  // Run BEFORE /__open + the HTTP path: an upgrade request is a distinct
  // protocol handoff. The bridge runs the access gate + CSWSH Origin check
  // and pins the upstream to loopback. Returns null when this is NOT an
  // upgrade (fall through to HTTP).
  const wsResponse = await tryBridgePreviewWebSocket(request, previewId, appHost(), platform);
  if (wsResponse) return wsResponse;

  // ── /__open?c=<code> — one-time code -> host-only cookie swap ──
  if (url.pathname === "/__open") {
    const code = url.searchParams.get("c") ?? "";
    const claims = redeemOneTimeCode(code);
    // The code must redeem AND be for THIS subdomain's preview id.
    if (!claims || claims.previewId !== previewId) {
      return new Response("Not found", {
        status: 404,
        headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store" },
      });
    }
    const token = await signPreviewToken({ previewId, userId: claims.userId });
    // Host-only cookie (NO Domain=) on the subdomain — never sent to the
    // app origin or sibling preview origins. httpOnly so served JS can't
    // read it; SameSite=Lax; secure when the deployment forces it.
    const secure = process.env.FORCE_SECURE_COOKIES === "true";
    const cookie =
      `${PREVIEW_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; ` +
      `Max-Age=${PREVIEW_TOKEN_TTL_SECONDS}` +
      (secure ? "; Secure" : "");
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": cookie,
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
      },
    });
  }

  // ── Everything else — token + registry gated serving ──
  const cookieToken = readCookie(request, PREVIEW_COOKIE_NAME);
  return handlePreviewRequest(
    { previewId, requestPath: url.pathname, cookieToken, request },
    {
      verifyToken: (t) => verifyPreviewToken(t),
      getServable: (id, userId) => getServablePreview(id, userId),
      touch: (id, userId) => touchPreview(id, userId).catch(() => undefined),
      readFile: async (abs) => {
        // Stream straight off disk via Bun.file (project convention — no
        // node:fs createReadStream / Readable.toWeb bridge). `.size`
        // backs Content-Length; `.stream()` is a WHATWG ReadableStream
        // that `new Response(...)` accepts directly.
        const file = Bun.file(abs);
        return { body: file.stream() as unknown as BodyInit, size: file.size };
      },
      proxyDynamic: (port, req, requestPath) =>
        proxyDynamicFetch(port, req, requestPath, previewId),
      // Per-preview request rate limit (Phase 3b) — the process-wide quota
      // singleton; over-cap → 429.
      checkRate: (id) => getPreviewQuota().allowRequest(id),
    },
  );
}

/**
 * DYNAMIC passthrough (Phase 3a): forward an HTTP request to the dev server
 * pinned at `127.0.0.1:<port>`. SSRF defense — the host is HARD-CODED to
 * loopback and the port is the exact registered `targetPort`; the original
 * request's URL host/scheme are discarded. `redirect: "manual"` so we never
 * follow an upstream redirect off the pinned port (no server-side SSRF via
 * a crafted 3xx Location).
 *
 * Phase 3b: inbound header sanitation (above), + per-preview BYTE budgeting —
 * the upstream response body is metered through the quota; an over-budget
 * preview's stream is cut (the body errors) so an untrusted server can't
 * exfil/stream unbounded bytes through us. The request RATE cap is enforced
 * earlier (handlePreviewRequest's `checkRate` → 429).
 */
export async function proxyDynamicFetch(
  port: number,
  request: Request,
  requestPath: string,
  previewId?: string,
): Promise<Response> {
  const incoming = new URL(request.url);
  // Pin to loopback + the exact port. Preserve path + query verbatim.
  const target = new URL(`http://127.0.0.1:${port}${requestPath}${incoming.search}`);

  // INBOUND sanitation (Phase 3b): strip the preview cookie, app/proxy
  // credentials (Authorization), and every spoofable X-Forwarded-* /
  // Forwarded / internal EZCorp header before forwarding to the untrusted
  // dev server. Then rewrite Host to the loopback authority so vhost'd dev
  // servers resolve.
  const fwdHeaders = sanitizeInboundHeaders(request.headers);
  fwdHeaders.set("host", `127.0.0.1:${port}`);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(target, {
    method: request.method,
    headers: fwdHeaders,
    body: hasBody ? request.body : undefined,
    redirect: "manual", // never follow upstream 3xx off the pinned port
    // @ts-expect-error — Bun/undici stream-body needs duplex:"half".
    duplex: hasBody ? "half" : undefined,
  });

  // Per-preview BYTE budget (Phase 3b): meter the response body. When the
  // preview exhausts its rolling budget the stream is cut (errored) so an
  // untrusted server can't stream unbounded bytes through the proxy. No
  // previewId / no body → passthrough unchanged.
  if (!previewId || !upstream.body) return upstream;
  const quota = getPreviewQuota();
  const metered = meterResponseBody(upstream.body, previewId, quota);
  return new Response(metered, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

/**
 * Wrap a response body stream so each chunk is charged against the preview's
 * byte budget; over-budget errors the stream (the browser sees a truncated
 * load — honest signal, no silent unbounded pass-through). Pure over the
 * injected quota.
 */
export function meterResponseBody(
  body: ReadableStream<Uint8Array>,
  previewId: string,
  quota: { allowBytes(id: string, bytes: number): boolean },
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      if (!quota.allowBytes(previewId, value.byteLength)) {
        controller.error(new Error("preview byte budget exhausted"));
        await reader.cancel().catch(() => {});
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}

/** Minimal Cookie header parser — returns the named cookie value or null. */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}
