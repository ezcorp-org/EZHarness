import type { Handle, HandleServerError } from "@sveltejs/kit";
import { redirect } from "@sveltejs/kit";
import { ensureInitialized } from "$lib/server/context";
import { verifyJWT, getJwtSecret, signJWT } from "$server/auth/jwt";
import { getUserCount, getUserById } from "$server/db/queries/users";
import { logger } from "$server/logger";
import { RateLimiter } from "$lib/server/security/rate-limiter";
import { attachBearerAuth } from "$lib/server/security/bearer-auth";
import { getMaxPayload, payloadTooLarge } from "$lib/server/security/payload";
import { getSetting } from "$server/db/queries/settings";
import { hashToken, lookupSessionByTokenHash, touchSession, rotateSessionToken } from "$server/db/queries/sessions";
import {
  startBackgroundTimers,
  stopBackgroundTimers,
} from "$server/startup/background-timers";
import { registerTeardown } from "$lib/server/shutdown";
import {
  getSessionConfig,
  setSessionCookie,
  clearSessionCookie,
  getSessionCookieName,
} from "$lib/server/auth/session-cookie";
import { matchPreviewOrigin, servePreviewRequest } from "$lib/server/preview/dispatch";
import { createPreviewWebSocketHandler } from "$lib/server/preview/ws-bridge";
import { isLoopbackTestBypass } from "$lib/server/test-surface";

const log = logger.child("hooks.server");

if (!process.env.PI_SKIP_INIT) {
  await ensureInitialized();
  // Idempotent — safe across SvelteKit's dev-mode double module evaluation.
  await startBackgroundTimers();
  // Tear down daemons + intervals BEFORE pglite close. Registered after
  // start so it lands later in the teardown LIFO than the boot-time
  // registrations from ensureInitialized() — meaning at shutdown:
  // stopBackgroundTimers → executor.destroy → dispatchers.stop →
  // registry.killAll → stopBackups → closeDb. Daemons stop first so no
  // tick fires a query against a closing PGlite handle.
  registerTeardown("background-timers", async () => {
    await stopBackgroundTimers();
  });
}

// ── Rate Limiter ──────────────────────────────────────────────────
const rateLimiter = new RateLimiter(20, 60_000);

export interface RateLimitRoute {
  pattern: RegExp;
  method?: string;
  limit: number;
  keyType: "ip" | "user";
  category: string;
}

const RATE_LIMITED_ROUTES: RateLimitRoute[] = [
  { pattern: /^\/api\/auth\/login$/, limit: 5, keyType: "ip", category: "login" },
  // Caps conversation CREATION per user — without this, a bundled
  // extension (e.g. ai-kit) spawning root chats via POST /api/conversations
  // could chain unbounded fan-out: depth 0 spawns 20, each spawns 20, etc.
  // The messages POST has its own `chat` limit at 20/min, but that's a
  // per-conversation counter; root creations need their own bucket.
  // Intentionally looser than `chat` (30 vs 20) so a human power-user
  // tabbing through chats isn't throttled, but an LLM in an infinite
  // spawn loop hits the ceiling fast.
  { pattern: /^\/api\/conversations$/, method: "POST", limit: 30, keyType: "user", category: "conversationCreate" },
  { pattern: /^\/api\/conversations\/[^/]+\/messages$/, method: "POST", limit: 20, keyType: "user", category: "chat" },
  { pattern: /^\/api\/agents\/[^/]+\/run$/, method: "POST", limit: 10, keyType: "user", category: "agentRun" },
  { pattern: /^\/api\/agent-configs\/generate$/, method: "POST", limit: 5, keyType: "user", category: "agentGenerate" },
  { pattern: /^\/api\/pipelines\/[^/]+\/run$/, method: "POST", limit: 10, keyType: "user", category: "pipelineRun" },
  { pattern: /^\/api\/auth\/reset-password$/, method: "POST", limit: 3, keyType: "ip", category: "resetGenerate" },
  { pattern: /^\/api\/auth\/reset-password\/[^/]+$/, method: "POST", limit: 5, keyType: "ip", category: "resetPassword" },
];

// Cached rate limit overrides from settings KV
let rateLimitOverrides: Record<string, number> | null = null;
let rateLimitOverridesCachedAt = 0;
const RATE_LIMIT_CACHE_TTL = 60_000; // 60s

async function getRateLimitOverride(category: string): Promise<number | undefined> {
  const now = Date.now();
  if (!rateLimitOverrides || now - rateLimitOverridesCachedAt > RATE_LIMIT_CACHE_TTL) {
    try {
      const val = await getSetting(`limits:rateLimit`) as Record<string, number> | undefined;
      rateLimitOverrides = val ?? {};
    } catch {
      rateLimitOverrides = {};
    }
    rateLimitOverridesCachedAt = now;
  }
  return rateLimitOverrides[category];
}

function matchRateLimitRoute(pathname: string, method: string): RateLimitRoute | undefined {
  for (const route of RATE_LIMITED_ROUTES) {
    if (route.method && route.method !== method) continue;
    if (route.pattern.test(pathname)) return route;
  }
  return undefined;
}

function rateLimitResponse(retryAfter: number): Response {
  return new Response(JSON.stringify({
    error: "Rate limit exceeded",
    retryAfter,
  }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter),
    },
  });
}

function getClientIp(request: Request): string {
  const trustCount = parseInt(process.env.TRUSTED_PROXY_COUNT ?? "0", 10);
  if (trustCount > 0) {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map(s => s.trim());
      const idx = Math.max(0, parts.length - trustCount);
      return parts[idx] || "unknown";
    }
  }
  // Fallback: no trusted proxy, use x-real-ip (set by reverse proxies that
  // expose a single trusted client IP) or "unknown"
  return request.headers.get("x-real-ip") || "unknown";
}

// sec-M4: explicit allow-list only. If CORS_ALLOWED_ORIGINS is unset we default
// to [] (deny all cross-origin). Wildcard "*" is treated as "no origin allowed"
// rather than reflecting any origin — that pattern was exploitable because we
// echo the request origin back with Access-Control-Allow-Origin, which combined
// with credentialed fetches would leak authenticated responses to any site.
const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(s => s.length > 0 && s !== "*");

function getCorsHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  const origin = request.headers.get("origin");
  if (!origin) return headers;
  if (CORS_ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// sec-M4: hard expiry for the legacy pi_session → ezcorp_session migration path.
// After this date we stop honoring the old cookie entirely.
const PI_SESSION_MIGRATION_EXPIRES_AT = Date.parse("2026-06-01T00:00:00Z");
let piSessionMigrationWarned = false;

// Sliding-session refresh: re-issue the JWT (and bump the DB row's expiresAt)
// once the current token is older than refreshAfterSeconds. The new token
// gets another lifetimeSeconds of validity. Keeps active users from being
// forced to re-authenticate on a hard boundary while still capping the
// lifetime of an idle session. Lifetimes come from
// `getSessionConfig()` (env-driven; defaults: 90d total, refresh after 7d,
// 60s previous-hash grace) so all auth surfaces share one source of truth.
const _cfg = getSessionConfig();
export const __sessionRefreshConfig = {
  ..._cfg,
  // Back-compat aliases for tests written against the pre-config field names.
  REFRESH_AFTER_SECONDS: _cfg.refreshAfterSeconds,
  NEW_LIFETIME_SECONDS: _cfg.lifetimeSeconds,
};

// ── Content-Security-Policy ────────────────────────────────────────
// Extracted as module-level exports so tests can assert against the
// exact directive set without importing the full `handle` (which has
// startup side effects).
//
// `connect-src` allows the in-browser Kokoro-TTS pipeline (the
// `kokoro-tts` extension's player card) to fetch model + voice
// assets directly from Hugging Face. The fetch sites are:
//   - `KokoroTTS.from_pretrained(...)` in
//     node_modules/kokoro-js/dist/kokoro.js (the `M` class) which
//     delegates to `@huggingface/transformers` for config.json,
//     tokenizer.json, tokenizer_config.json, and the *.onnx model.
//   - The voice-bin loader inside the same file
//     (`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${e}.bin`)
//     which kokoro.js fetches directly via `fetch()`.
// Hugging Face redirects large blobs (the .onnx weights) to its
// LFS / Xet CDN — the exact host varies by region and migration
// state, so we allowlist all known fronts.
//
// `script-src` adds `'wasm-unsafe-eval'` because onnxruntime-web
// (pulled in by `@huggingface/transformers`) instantiates its WASM
// backend via `WebAssembly.instantiate()`. Strict CSPs treat that as
// dynamic code execution and block it — without this directive the
// model fails to initialize even when `connect-src` succeeds.
//
// `cdn.jsdelivr.net` appears in BOTH `script-src` and `connect-src`
// because `node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs`
// dynamically `import()`s its WASM glue (`ort-wasm-simd-threaded.jsep.mjs`)
// from a jsDelivr fallback unless a same-origin `wasmPaths` is set.
// transformers.js v3.8.1 hardcodes the fallback URL
// `https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/`.
// The dynamic-import is gated by `script-src`; the underlying network
// fetch is gated by `connect-src` — both must allow the host.
export const HUGGINGFACE_CSP_HOSTS = [
  "https://huggingface.co",
  // Old HF LFS fronts — kept for forward/back-compat with repos that
  // still resolve to them. Today's hot path is `cas-bridge.xethub.hf.co`.
  "https://cdn-lfs.huggingface.co",
  "https://cdn-lfs-us-1.huggingface.co",
  "https://cdn-lfs-eu-1.huggingface.co",
  // HF's new Xet-backed LFS. The `kokoro-82M-v1.0-ONNX` repo's
  // `.onnx` and `voices/*.bin` blobs all 302 here as of 2026-05-05.
  "https://cas-bridge.xethub.hf.co",
] as const;

// Hosts the onnxruntime-web WASM-glue dynamic import lands on. Read
// from the same constant in `script-src` (for the `import()`) and
// `connect-src` (for the underlying fetch).
export const ONNX_WASM_CDN_HOSTS = [
  "https://cdn.jsdelivr.net",
] as const;

export const CSP_CONNECT_SRC = [
  "'self'",
  ...HUGGINGFACE_CSP_HOSTS,
  ...ONNX_WASM_CDN_HOSTS,
].join(" ");
export const CSP_SCRIPT_SRC = [
  "'self'",
  "'unsafe-inline'",
  "'wasm-unsafe-eval'",
  ...ONNX_WASM_CDN_HOSTS,
].join(" ");
// `worker-src` gates the kokoro-tts Web Worker spawned by
// `web/src/lib/workers/kokoro-tts-bridge.ts`. `'self'` covers the
// production worker bundle (same-origin URL emitted by Vite); `blob:`
// covers Vite's dev-mode inline-worker fallback (some browsers refuse
// `import.meta.url` workers without it during HMR).
//
// We do NOT relax `script-src` further — the worker's outbound network
// traffic to HF / jsDelivr is already covered by `connect-src`.
export const CSP_WORKER_SRC = [
  "'self'",
  "blob:",
].join(" ");
// `media-src` gates `<audio>` / `<video>` sources. The kokoro-tts card
// plays back synthesized WAVs as `blob:` URLs (built from the
// ArrayBuffer the worker transfers back) before the upload + finalize
// chain swaps in the persisted `/api/attachments/{id}` URL. Without
// this directive, browsers fall back to `default-src 'self'` and
// refuse the blob URL.
export const CSP_MEDIA_SRC = [
  "'self'",
  "blob:",
].join(" ");

export const CSP_HEADER_VALUE = [
  `default-src 'self'`,
  `script-src ${CSP_SCRIPT_SRC}`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob: https:`,
  `font-src 'self'`,
  `connect-src ${CSP_CONNECT_SRC}`,
  `worker-src ${CSP_WORKER_SRC}`,
  `media-src ${CSP_MEDIA_SRC}`,
  `frame-ancestors 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
].join("; ");

export const handle: Handle = async ({ event, resolve }) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── Secure preview origin dispatch (D4 wildcard subdomain) ─────────
  // MUST run before payload/rate/auth: a `<id>.preview.<host>` request is
  // a SEPARATE origin and must never enter the app's auth flow (the app's
  // host-only ezcorp_session is not sent here by design). The preview
  // proxy enforces its own access via the __ezpreview token + registry.
  // Disabled (no-op) unless EZCORP_PREVIEW_APP_HOST is configured.
  const previewMatch = matchPreviewOrigin(request);
  if (previewMatch) {
    // Pass `event.platform` (svelte-adapter-bun: live Bun server + raw
    // request) so a preview WS/HMR upgrade can be bridged. Undefined under
    // vite dev — the bridge then answers 426 for upgrades, serves HTTP fine.
    return servePreviewRequest(request, previewMatch, event.platform as never);
  }

  // OPTIONS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }

  // ── Payload size check (POST/PUT/PATCH only) ───────────────────
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    const contentLength = request.headers.get("content-length");
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      const max = getMaxPayload(url.pathname);
      if (size > max) {
        return payloadTooLarge(max);
      }
    }
  }

  // ── Rate limiting (IP-based for login, before auth) ─────────────
  const rateLimitRoute = matchRateLimitRoute(url.pathname, request.method);
  if (rateLimitRoute && rateLimitRoute.keyType === "ip") {
    const ip = getClientIp(request);
    const override = await getRateLimitOverride(rateLimitRoute.category);
    const result = rateLimiter.check(`ip:${ip}:${rateLimitRoute.category}`, override ?? rateLimitRoute.limit);
    if (!result.allowed) {
      return rateLimitResponse(result.retryAfter!);
    }
  }

  // ── Auth enforcement ──────────────────────────────────────────────
  const PUBLIC_PATHS = ["/login", "/setup", "/signup", "/reset-password", "/api/auth/login", "/api/auth/setup", "/api/auth/invite", "/api/auth/reset-password", "/api/health", "/api/ready", "/api/version"];
  const isPublic = PUBLIC_PATHS.some(p => url.pathname === p || url.pathname.startsWith(p + "/"))
    || url.pathname.startsWith("/_app/")
    || url.pathname.startsWith("/favicon")
;

  if (!isPublic) {
    // ── Loopback test-surface bypass ───────────────────────────────────
    // The deterministic mock-LLM completions endpoint is called
    // server-internally by pi-ai's HTTP client over loopback with a dummy
    // bearer token, so it cannot satisfy session/key auth. Let ONLY that
    // path through, and ONLY when the test surface is enabled AND the peer
    // is genuine loopback with no proxy-forwarding headers. Everything else
    // (including the externally-reachable `/script` seed sub-path) still
    // goes through the normal auth flow below.
    {
      let loopbackAddr: string | undefined;
      try { loopbackAddr = event.getClientAddress(); } catch { loopbackAddr = undefined; }
      const proxied =
        request.headers.has("x-forwarded-for") ||
        request.headers.has("x-real-ip") ||
        request.headers.has("forwarded");
      if (isLoopbackTestBypass(url.pathname, loopbackAddr, proxied)) {
        return resolve(event);
      }
    }

    // Build /login URL preserving the page the user was trying to reach so we
    // can send them back after re-auth. GET only — POST/PUT/PATCH navigations
    // don't represent a "page the user was on". URLSearchParams handles
    // encoding; the consumer (login +page.server.ts) re-validates via
    // safeReturnTo before trusting the value.
    const buildLoginUrl = (reason?: string): string => {
      const params = new URLSearchParams();
      if (reason) params.set("reason", reason);
      if (request.method === "GET" && url.pathname !== "/login") {
        params.set("returnTo", url.pathname + url.search);
      }
      const qs = params.toString();
      return qs ? `/login?${qs}` : "/login";
    };

    let sessionToken = event.cookies.get(getSessionCookieName());

    // Migration bridge: accept old pi_session cookie and migrate.
    // sec-M4: disabled after PI_SESSION_MIGRATION_EXPIRES_AT to prevent an
    // unbounded window in which stolen legacy cookies can be auto-promoted.
    if (!sessionToken) {
      const legacyToken = event.cookies.get("pi_session");
      if (legacyToken) {
        if (Date.now() > PI_SESSION_MIGRATION_EXPIRES_AT) {
          if (!piSessionMigrationWarned) {
            log.warn("pi_session migration window closed - ignoring legacy cookie; clients must re-authenticate");
            piSessionMigrationWarned = true;
          }
          // Purge the stale cookie so the client stops presenting it.
          event.cookies.set("pi_session", "", { path: "/", httpOnly: true, sameSite: "lax", maxAge: 0 });
        } else {
          sessionToken = legacyToken;
          // Delete old cookie
          event.cookies.set("pi_session", "", { path: "/", httpOnly: true, sameSite: "lax", maxAge: 0 });
          // Set new cookie
          setSessionCookie(event.cookies, legacyToken);
        }
      }
    }

    if (!sessionToken) {
      // Try API key auth before rejecting. attachBearerAuth handles the
      // prefix-based routing between internal bundled-extension keys
      // (ezkint_, loopback-only) and user-issued keys (ezk_). See
      // lib/server/security/bearer-auth.ts for the full security contract.
      const authHeader = request.headers.get("authorization");
      let remoteAddress: string | undefined;
      try {
        remoteAddress = event.getClientAddress();
      } catch {
        // getClientAddress throws under Bun's prerender path; leaving
        // remoteAddress undefined correctly fails loopback gating closed.
        remoteAddress = undefined;
      }
      // Forwarding-header sniff: any of these means the request went
      // through a proxy, so the socket peer reported by getClientAddress
      // is NOT a trustworthy loopback signal for internal-auth.
      const proxyForwardedHeadersPresent =
        request.headers.has("x-forwarded-for") ||
        request.headers.has("x-real-ip") ||
        request.headers.has("forwarded");
      await attachBearerAuth(
        {
          locals: event.locals,
          remoteAddress,
          proxyForwardedHeadersPresent,
          onBehalfOfHeader: request.headers.get("x-ezcorp-on-behalf-of"),
        },
        authHeader,
      );

      if (!event.locals.user) {
        let count: number;
        try { count = await getUserCount(); } catch {
          // DB unreachable. Under PI_SKIP_INIT (E2E) the DB is intentionally
          // absent, so skip auth and let the request through. In every other
          // environment a transient DB failure must NOT fail open — doing so
          // would serve every protected route unauthenticated for the
          // duration of the outage. Fail closed with 503 instead.
          if (process.env.PI_SKIP_INIT) {
            return resolve(event);
          }
          return new Response(JSON.stringify({ error: "Service unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (count === 0) {
          if (url.pathname.startsWith("/api/")) {
            return new Response(JSON.stringify({ error: "Setup required" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }
          throw redirect(302, "/setup");
        }
        if (url.pathname.startsWith("/api/")) {
          return new Response(JSON.stringify({ error: "Authentication required" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw redirect(302, buildLoginUrl());
      }
    } else {
      let secret: string;
      try { secret = await getJwtSecret(); } catch {
        return resolve(event);
      }
      const payload = await verifyJWT(sessionToken, secret);

      if (!payload) {
        clearSessionCookie(event.cookies);
        if (url.pathname.startsWith("/api/")) {
          return new Response(JSON.stringify({ error: "Session expired" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw redirect(302, buildLoginUrl("session_expired"));
      }

      // Session-backed validation: check session record exists.
      // Missing session row = revoked; clear cookies and reject (do not auto-recreate).
      // The lookup also matches the row's previous_token_hash within its grace
      // window — that path is taken by concurrent in-flight requests still
      // carrying the pre-rotation cookie, and `viaPrevious` tells the
      // refresh block below to skip a redundant rotation.
      let sessionMissing = false;
      let dbAvailable = true;
      let sessionId: string | null = null;
      let viaPrevious = false;
      let inboundTokenHash: string | null = null;
      try {
        inboundTokenHash = await hashToken(sessionToken);
        const lookup = await lookupSessionByTokenHash(inboundTokenHash);
        if (!lookup) {
          sessionMissing = true;
        } else {
          sessionId = lookup.session.id;
          viaPrevious = lookup.viaPrevious;
          // Throttled touch to track last activity
          touchSession(lookup.session.id).catch(() => {});
        }
      } catch {
        // DB unavailable -- allow JWT-only auth as fallback
        dbAvailable = false;
      }

      if (sessionMissing && dbAvailable) {
        clearSessionCookie(event.cookies);
        event.cookies.delete("pi_session", { path: "/" });
        if (url.pathname.startsWith("/api/")) {
          return new Response(JSON.stringify({ error: "Session revoked" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw redirect(302, buildLoginUrl("session_revoked"));
      }

      // ── Sliding refresh ────────────────────────────────────────────────
      // Once the JWT crosses refreshAfterSeconds of age, re-issue it with
      // another lifetimeSeconds and bump the DB row's expiresAt. CAS on
      // (id, currentTokenHash) means concurrent requests can't double-rotate:
      // the loser's CAS misses and it serves the request with its inbound
      // cookie, which the row's `previous_token_hash` still matches for the
      // grace window.
      //
      // Skipped when the DB is unavailable (no row to rotate), the row was
      // missing (cookies already cleared), or the inbound token already
      // matched the previous-hash grace slot (peer just rotated).
      const cfg = __sessionRefreshConfig;
      if (sessionId && inboundTokenHash && dbAvailable && !viaPrevious) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (nowSeconds - payload.iat > cfg.refreshAfterSeconds) {
          try {
            const newToken = await signJWT(
              { id: payload.id, email: payload.email, name: payload.name, role: payload.role },
              secret,
              cfg.lifetimeSeconds,
            );
            const newTokenHash = await hashToken(newToken);
            const newExpiresAt = new Date((nowSeconds + cfg.lifetimeSeconds) * 1000);
            const rotated = await rotateSessionToken({
              id: sessionId,
              oldTokenHash: inboundTokenHash,
              newTokenHash,
              newExpiresAt,
              previousTokenGraceSeconds: cfg.previousTokenGraceSeconds,
            });
            if (rotated) {
              setSessionCookie(event.cookies, newToken);
            }
          } catch (err) {
            // Refresh is best-effort: if signing or the CAS update throws
            // we keep serving the request with the old (still-valid) cookie.
            log.warn("session refresh failed", { error: String(err) });
          }
        }
      }

      event.locals.user = {
        id: payload.id,
        email: payload.email,
        name: payload.name,
        role: payload.role,
      };
    }
  }

  // ── First-time onboarding gate ───────────────────────────────────
  // Pages-only: API routes (cookie OR Bearer) and asset paths bypass
  // entirely so programmatic clients aren't redirected. For real page
  // nav (including /onboarding itself), look up the user and stash
  // `onboardedAt` on locals so the wizard's load doesn't re-fetch.
  // The redirect itself is suppressed on /onboarding to avoid a loop.
  if (
    event.locals.user
    && !url.pathname.startsWith("/api/")
    && !url.pathname.startsWith("/_app/")
  ) {
    let userRow;
    try {
      userRow = await getUserById(event.locals.user.id);
    } catch {
      userRow = undefined; // DB unavailable — fail open.
    }
    if (userRow) {
      event.locals.onboardedAt = userRow.onboardedAt;
    }
    if (userRow && userRow.onboardedAt === null && url.pathname !== "/onboarding") {
      throw redirect(302, "/onboarding");
    }
  }

  // ── Rate limiting (user-based, after auth) ──────────────────────
  if (rateLimitRoute && rateLimitRoute.keyType === "user" && event.locals.user) {
    const userId = event.locals.user.id;
    const override = await getRateLimitOverride(rateLimitRoute.category);
    const result = rateLimiter.check(`user:${userId}:${rateLimitRoute.category}`, override ?? rateLimitRoute.limit);
    if (!result.allowed) {
      return rateLimitResponse(result.retryAfter!);
    }
  }

  const response = await resolve(event, {
    transformPageChunk: process.env.EZCORP_DEV_INDICATOR === "1"
      ? ({ html }) => html
          .replace("<html ", '<html data-dev-indicator="1" ')
          .replace(/<title>(?!DEV )([^<]*)<\/title>/g, "<title>DEV $1</title>")
          .replaceAll("/favicon-192.png", "/favicon-dev-192.png")
          .replaceAll("/favicon.ico", "/favicon-dev.ico")
      : undefined,
  });

  // ── Security headers on ALL responses ───────────────────────────
  // SSE replaces the old WebSocket transport — no ws: or wss: scheme needed
  // in connect-src anymore.
  // These are applied as DEFAULTS — a route that already set its own
  // value (e.g. /api/extensions/[name]/data/* serves sandboxed content
  // that needs same-origin iframing, so it sets a more permissive
  // Content-Security-Policy + omits X-Frame-Options) keeps that value.
  // The CSP itself is built from `CSP_HEADER_VALUE` above — see that
  // export for the rationale behind each directive (in particular,
  // the Hugging Face hosts in `connect-src` and `'wasm-unsafe-eval'`
  // in `script-src`, both required by the kokoro-tts extension's
  // in-browser TTS pipeline).
  const SECURITY_HEADERS: Record<string, string> = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": CSP_HEADER_VALUE,
  };
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(key)) {
      response.headers.set(key, value);
    }
  }
  if (url.protocol === "https:") {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // Add CORS headers to all API responses
  if (url.pathname.startsWith("/api")) {
    for (const [key, value] of Object.entries(getCorsHeaders(request))) {
      response.headers.set(key, value);
    }
  }

  return response;
};

// ── Error Handler ─────────────────────────────────────────────────────

export const handleError: HandleServerError = ({ error, status, message }) => {
  const err = error as Error;
  log.error("server error", { status, error: err?.message ?? "Unknown error" });
  return { message: message || "An unexpected error occurred" };
};

// ── Runtime Event Transport ───────────────────────────────────────────
//
// The runtime event bus is now streamed to the browser via SSE at
// /api/runtime-events/+server.ts. That endpoint subscribes to the bus
// and writes `data: {JSON}\n\n` frames on a long-lived HTTP response.
// Auth inherits from the session cookie check in the Handle hook above.
//
// The previous WebSocket fan-out (dev Bun.serve on 127.0.0.1:3002 + prod
// svelte-adapter-bun `websocket` export + /ws path handling in Handle)
// has been removed. SSE works identically in dev (vite) and prod
// (svelte-adapter-bun), across all access topologies (localhost,
// tailscale HTTPS, LAN), and avoids Bun's broken node:http upgrade
// handoff that made vite-level WS proxying impossible.
//
// ── Secure-preview WS/HMR bridge (Phase 3b) ───────────────────────────
// The app itself uses SSE (above), but dynamic PREVIEWS need a real WS relay
// so vite/bun HMR works through the `<id>.preview.<host>` origin. The Handle
// hook calls `tryBridgePreviewWebSocket`, which runs the access gate + CSWSH
// Origin check and then `event.platform.server.upgrade(...)` with the pinned
// loopback upstream as socket data. svelte-adapter-bun routes accepted
// sockets to THIS exported `websocket` handler, which opens the upstream and
// relays frames. Only sockets tagged `__preview` are bridged; this is a no-op
// in vite dev (no Bun server to upgrade). Live path is Docker-verified.

export const websocket = createPreviewWebSocketHandler();
