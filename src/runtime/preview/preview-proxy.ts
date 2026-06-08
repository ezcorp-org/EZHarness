import { resolve, sep } from "node:path";
import { realpath, stat } from "node:fs/promises";
import { isValidPreviewId } from "../../db/queries/preview-sessions";

// `BodyInit` is an ambient undici/DOM global that does not resolve under CI's
// frozen install (tsconfig lib is ESNext-only). Derive the body type from the
// available `Response` constructor instead.
type ResponseBody = NonNullable<ConstructorParameters<typeof Response>[0]>;

/**
 * Host-header allowlist + static reverse-proxy skeleton for the secure
 * preview origin (Secure User-Site Preview / Port Exposure, Phase 1 —
 * see tasks/preview-port-exposure.md §3.5).
 *
 * Everything here is PURE / dependency-injected so it is fully unit
 * testable without SvelteKit or a live socket. The SvelteKit `handle`
 * hook calls `parsePreviewHost` to decide whether a request is for the
 * preview origin, then `handlePreviewRequest` to serve it.
 *
 * D4 (LOCKED): routing is by wildcard subdomain `<id>.preview.<host>` —
 * a true separate origin. The app-origin's host-only `ezcorp_session`
 * cookie is therefore never sent here; access is via the `__ezpreview`
 * token (preview-token.ts) checked against the registry on EVERY request.
 *
 * DNS-rebind defense: we do NOT trust the subdomain blindly. The Host
 * header must end in `.preview.<appHost>` AND the label must be a
 * well-formed preview id. Anything else is rejected before any DB hit.
 */

/** The fixed infix that marks the preview origin: `<id>.preview.<host>`. */
export const PREVIEW_HOST_INFIX = ".preview.";

export interface ParsedPreviewHost {
  /** The preview id (well-formed; still must exist in the registry). */
  previewId: string;
}

/**
 * Parse a Host header against the configured app host. Returns the
 * preview id when the host is EXACTLY `<id>.preview.<appHost>` and `<id>`
 * is a well-formed preview id; null otherwise (not a preview request, or
 * a DNS-rebind / spoofed Host we must reject).
 *
 * `appHost` is the bare app host WITHOUT scheme/port (e.g. "localhost"
 * or "ezcorp.example.com"). The incoming `host` may carry a `:port`
 * suffix (dev), which we strip before matching. Matching is
 * case-insensitive (DNS labels are).
 */
export function parsePreviewHost(host: string | null, appHost: string): ParsedPreviewHost | null {
  if (!host || !appHost) return null;
  // Strip a port suffix; lower-case for case-insensitive DNS matching.
  const bareHost = host.split(":")[0]!.toLowerCase();
  const bareApp = appHost.split(":")[0]!.toLowerCase();
  const suffix = PREVIEW_HOST_INFIX + bareApp;
  if (!bareHost.endsWith(suffix)) return null;
  const label = bareHost.slice(0, bareHost.length - suffix.length);
  // The label must be a SINGLE preview-id label — no extra dots (which
  // would be a deeper subdomain / a rebind attempt).
  if (label.includes(".")) return null;
  if (!isValidPreviewId(label)) return null;
  return { previewId: label };
}

/**
 * Resolve the absolute on-disk path for a request path under a static
 * preview root, applying the SAME realpath/traversal/symlink-escape
 * guards as `/api/extensions/[name]/data/[...path]`. Returns the file's
 * realpath when it is a regular file safely contained within `root`;
 * null for every failure mode (traversal, symlink escape, missing file,
 * directory) so the caller can answer with one opaque 404.
 *
 * `requestPath` is the URL pathname (e.g. "/", "/assets/app.js"). A
 * trailing "/" or empty path resolves to "index.html".
 */
export async function resolveStaticFile(
  root: string,
  requestPath: string,
  /** Injected for tests: the final existence/type stat of the resolved target.
   *  Defaults to the real `fs.stat`. Lets a test exercise the post-realpath
   *  stat-failure catch (a TOCTOU race where the file vanishes between the
   *  symlink-escape realpath check and the stat) without an actual race. */
  statFn: (p: string) => Promise<{ isFile(): boolean }> = stat,
): Promise<string | null> {
  // Decode once; reject control bytes + explicit `..` segments early.
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  // Directory request -> index.html (SPA-friendly default).
  if (decoded === "" || decoded === "/" || decoded.endsWith("/")) {
    decoded = decoded + "index.html";
  }
  const segments = decoded.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (seg === "..") return null;
        // Reject control bytes (defense-in-depth — browsers encode these).
    // Char-code scan instead of a control-char regex (biome forbids the
    // literal class) — same semantics as the extension-data route.
    for (let i = 0; i < seg.length; i++) {
      const c = seg.charCodeAt(i);
      if (c <= 0x1f || c === 0x7f) return null;
    }
  }

  // Resolve the static root to its realpath first so the prefix check
  // compares canonical paths (defends against the root itself being a
  // symlink).
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return null;
  }

  const target = resolve(realRoot, ...segments);
  // Lexical containment check BEFORE touching disk.
  if (!target.startsWith(realRoot + sep) && target !== realRoot) return null;

  // realpath the target to catch symlinks that escape the jail
  // (a symlink inside the dir pointing at /etc/passwd resolves out).
  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch {
    return null;
  }
  if (!realTarget.startsWith(realRoot + sep) && realTarget !== realRoot) return null;

  let info;
  try {
    info = await statFn(realTarget);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  return realTarget;
}

const CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  map: "application/json; charset=utf-8",
  wasm: "application/wasm",
});

export function contentTypeFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filePath.slice(dot + 1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

export interface PreviewRegistryRow {
  id: string;
  userId: string | null;
  kind: "static" | "dynamic";
  staticPath: string | null;
  targetPort: number | null;
}

export interface PreviewTokenClaims {
  previewId: string;
  userId: string;
}

export interface HandlePreviewRequestDeps {
  /** Verify the `__ezpreview` cookie value into claims, or null. */
  verifyToken: (token: string) => Promise<PreviewTokenClaims | null>;
  /** The access-layer requester-only registry lookup: returns the row
   *  only when owned + active + unexpired + unrevoked. */
  getServable: (id: string, userId: string) => Promise<PreviewRegistryRow | undefined>;
  /** Read a resolved static file into a Response body. Injected so the
   *  pure handler can be tested without real I/O. `body` is anything
   *  `new Response(...)` accepts (a stream, a Uint8Array, a string). */
  readFile: (absPath: string) => Promise<{ body: ResponseBody; size: number }>;
  /** Bump last-seen on a served request (best-effort, fire-and-forget). */
  touch?: (id: string, userId: string) => Promise<unknown>;
  /** DYNAMIC branch (Phase 3a): proxy an HTTP request to the dev server
   *  pinned at `127.0.0.1:<port>`. Injected so the pure handler is testable
   *  without a live socket. The impl (dispatch.ts) fetches the upstream and
   *  returns its Response; it MUST NOT follow redirects (pin the port) and
   *  MUST connect to exactly `port` on loopback. Throws on a dead upstream;
   *  the handler maps that to a graceful 502. */
  proxyDynamic?: (port: number, request: Request, requestPath: string) => Promise<Response>;
  /** Per-preview request rate check (Phase 3b). Returns false when the
   *  preview has exceeded its per-second request cap → the handler answers
   *  429. Injected so the pure handler is testable; the dispatch wires the
   *  process-wide quota singleton. Omitted ⇒ no rate limiting (static-only
   *  callers / tests that don't exercise it). */
  checkRate?: (previewId: string) => boolean;
}

/**
 * Common security headers for every preview response. `no-referrer`
 * prevents the one-time `?c=` (and any in-site URL) from leaking via
 * Referer. `nosniff` + `private,no-store` mirror the extension-data
 * route. We deliberately do NOT send the app origin's CSP — the served
 * site is untrusted user content on a separate origin.
 */
function baseHeaders(): Headers {
  return new Headers({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
  });
}

function notFound(): Response {
  // Single opaque status for every failure mode (missing id, wrong user,
  // traversal, missing file) so the surface gives nothing away.
  const headers = baseHeaders();
  return new Response("Not found", { status: 404, headers });
}

function badGateway(): Response {
  // The dev server isn't answering (not started yet, crashed, wrong port).
  // 502 is the honest signal — distinct from 404 (no such preview) so the
  // user knows the preview EXISTS but the server is down.
  const headers = baseHeaders();
  return new Response("Preview server is not responding.", { status: 502, headers });
}

function tooManyRequests(): Response {
  // The preview exceeded its per-second request cap (Phase 3b quota). 429 is
  // the honest signal — distinct from 502 (server down) / 404 (no preview).
  const headers = baseHeaders();
  return new Response("Too many requests.", { status: 429, headers });
}

/**
 * Hop-by-hop headers that MUST NOT be forwarded across a proxy (RFC 7230
 * §6.1). The dynamic passthrough strips these from the upstream response
 * before relaying. (Deeper header sanitation — Set-Cookie domain widening,
 * framing-header neutralization, cookie-tossing defense — is Phase 3b; see
 * the TODO in proxyDynamicResponse.)
 */
export const HOP_BY_HOP_HEADERS: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * INBOUND header sanitation (Phase 3b). Before forwarding a request to the
 * UNTRUSTED dev server we strip everything that could (a) leak the user's app
 * credentials / session into the sandbox, or (b) let the dev server trust a
 * spoofable proxy header. We forward only a SAFE minimal set — the dev server
 * gets enough to render (method/body/content negotiation) but never the
 * EZCorp identity surface.
 *
 * Stripped:
 *   - `cookie` — the `__ezpreview` access token (already dropped in 3a;
 *     re-asserted here so the strip set is one source of truth).
 *   - `authorization`, `proxy-authorization` — app/proxy credentials.
 *   - `x-forwarded-*`, `forwarded`, `x-real-ip` — spoofable origin/IP claims
 *     the untrusted server must not be able to trust or echo.
 *   - any `x-ezcorp-*` / `x-ez-*` internal header — never crosses the trust
 *     boundary.
 *   - the hop-by-hop set (re-set by fetch anyway, but explicit).
 *
 * The `host` header is intentionally NOT preserved here — the caller rewrites
 * it to the loopback authority (`127.0.0.1:<port>`) so vhost'd dev servers
 * resolve. Everything else (Accept, Content-Type, User-Agent, etc.) passes.
 */
export function sanitizeInboundHeaders(incoming: Headers): Headers {
  const out = new Headers(incoming);
  const strip = [
    "cookie",
    "authorization",
    "proxy-authorization",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-forwarded-server",
    "x-real-ip",
    ...HOP_BY_HOP_HEADERS,
  ];
  for (const h of strip) out.delete(h);
  // Drop ANY internal EZCorp header (prefix match — can't enumerate them all).
  for (const key of [...out.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith("x-ezcorp-") || k.startsWith("x-ez-")) out.delete(key);
  }
  return out;
}

/**
 * Neutralize a single upstream `Set-Cookie` value so an untrusted dev server
 * cannot widen a cookie onto the parent app domain or a sibling preview
 * origin (cookie-tossing / cookie-fixation defense). We STRIP the `Domain=`
 * attribute entirely — a cookie with no Domain is host-only on the exact
 * preview subdomain, which is the only scope we permit. `Path`, `Max-Age`,
 * `Secure`, `HttpOnly`, `SameSite` are preserved (they don't cross origins).
 *
 * Pure + string-only so it is unit-testable against fixture cookie strings.
 */
export function neutralizeSetCookieDomain(value: string): string {
  // Split on ';' into attributes, drop any `Domain=...` (case-insensitive),
  // re-join. The name=value pair is always the first segment.
  return value
    .split(";")
    .filter((seg) => !/^\s*domain\s*=/i.test(seg))
    .join(";")
    .trim();
}

/**
 * Sanitize an upstream dev-server response for relay back to the browser
 * (Phase 3a basics + Phase 3b hardening):
 *   - strip hop-by-hop headers (RFC 7230);
 *   - re-assert the preview-origin security headers (nosniff / no-referrer)
 *     so the untrusted server can't weaken them;
 *   - NEUTRALIZE every `Set-Cookie` Domain attribute so an untrusted response
 *     can't set a cookie on the parent app domain or a sibling preview origin
 *     (cookie-tossing defense);
 *   - DROP framing headers (`X-Frame-Options`) from the untrusted response —
 *     we don't let it dictate framing of the preview origin; the preview is
 *     never embedded in the app chrome, and a conflicting/duplicate XFO from
 *     an untrusted source is only a footgun.
 *
 * `Headers` collapses multiple Set-Cookie into one on `.get`, so we use
 * `getSetCookie()` (WHATWG) to neutralize each individually, then re-append.
 */
export function sanitizeUpstreamResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  for (const h of HOP_BY_HOP_HEADERS) headers.delete(h);

  // ── Set-Cookie domain neutralization ──
  // Read every Set-Cookie BEFORE deleting, neutralize each, then re-add.
  const setCookies =
    typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  headers.delete("set-cookie");
  for (const raw of setCookies) {
    const neutralized = neutralizeSetCookieDomain(raw);
    if (neutralized.length > 0) headers.append("set-cookie", neutralized);
  }

  // ── Framing headers — drop the untrusted server's XFO (we control framing
  // of the preview origin; the served site is never embedded in app chrome). ──
  headers.delete("x-frame-options");

  // Re-assert the preview-origin security headers (don't let the upstream
  // override them).
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  // NOTE: we keep the upstream Content-Type/Length + body verbatim.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

/**
 * Serve a request for the preview origin. The caller has already parsed
 * the Host header into `previewId` via `parsePreviewHost`. This function
 * enforces the access layer (token + registry), then serves the STATIC
 * branch end-to-end. The DYNAMIC branch is a Phase-3 stub that returns
 * 501 — wiring netns passthrough is explicitly out of scope here.
 */
export async function handlePreviewRequest(
  opts: {
    previewId: string;
    requestPath: string;
    cookieToken: string | null;
    /** The original request — required for the DYNAMIC branch (method,
     *  body, headers are forwarded to the dev server). Optional so the
     *  static-only callers/tests don't need to construct one. */
    request?: Request;
  },
  deps: HandlePreviewRequestDeps,
): Promise<Response> {
  const { previewId, requestPath, cookieToken } = opts;

  if (!isValidPreviewId(previewId)) return notFound();
  if (!cookieToken) return notFound();

  const claims = await deps.verifyToken(cookieToken);
  if (!claims) return notFound();
  // The cookie must be FOR this preview id (a token minted for preview A
  // must not unlock preview B).
  if (claims.previewId !== previewId) return notFound();

  const row = await deps.getServable(previewId, claims.userId);
  if (!row || row.userId !== claims.userId) return notFound();

  // Best-effort liveness bump.
  if (deps.touch) void deps.touch(previewId, claims.userId);

  if (row.kind === "dynamic") {
    // ── DYNAMIC branch (Phase 3a) — passthrough to the pinned dev port. ──
    // The access layer (token + registry + userId match) has already run
    // above, so we only reach here for an owned, active, unexpired preview.
    if (!Number.isInteger(row.targetPort) || (row.targetPort ?? 0) <= 0) {
      return notFound();
    }
    // Per-preview rate limit (Phase 3b): reject + 429 over the per-second cap
    // BEFORE we touch the untrusted upstream.
    if (deps.checkRate && !deps.checkRate(previewId)) {
      return tooManyRequests();
    }
    if (!deps.proxyDynamic || !opts.request) {
      // No passthrough wired (static-only deployment / test without it).
      return badGateway();
    }
    // SSRF/port-pin: the impl connects to EXACTLY 127.0.0.1:<targetPort>
    // and does NOT follow redirects (Phase 3b adds CSWSH origin checks,
    // DNS-rebind Host recheck, rate limits — see TODO markers).
    try {
      const upstream = await deps.proxyDynamic(row.targetPort as number, opts.request, requestPath);
      return sanitizeUpstreamResponse(upstream);
    } catch {
      // Dev server down / connection refused → graceful 502.
      return badGateway();
    }
  }

  // ── STATIC branch (Phase 1, end-to-end) ──
  if (!row.staticPath) return notFound();
  const abs = await resolveStaticFile(row.staticPath, requestPath);
  if (!abs) return notFound();

  let file: { body: ResponseBody; size: number };
  try {
    file = await deps.readFile(abs);
  } catch {
    return notFound();
  }

  const headers = baseHeaders();
  headers.set("Content-Type", contentTypeFor(abs));
  headers.set("Content-Length", String(file.size));
  return new Response(file.body as unknown as ResponseBody, { status: 200, headers });
}
