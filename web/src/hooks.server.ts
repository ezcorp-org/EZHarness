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
import { hashToken, getSessionByTokenHash, touchSession, rotateSessionToken } from "$server/db/queries/sessions";
import { startBackgroundTimers } from "$server/startup/background-timers";

const log = logger.child("hooks.server");

if (!process.env.PI_SKIP_INIT) {
  await ensureInitialized();
  // Idempotent — safe across SvelteKit's dev-mode double module evaluation.
  await startBackgroundTimers();
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

export function matchRateLimitRoute(pathname: string, method: string): RateLimitRoute | undefined {
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
// once the current token is older than REFRESH_AFTER_SECONDS. The new token
// gets another NEW_LIFETIME_SECONDS of validity. Keeps active users from
// being forced to re-authenticate on a hard 30-day boundary while still
// capping the lifetime of an idle session.
const REFRESH_AFTER_SECONDS = 7 * 24 * 3600;
const NEW_LIFETIME_SECONDS = 30 * 24 * 3600;
export const __sessionRefreshConfig = { REFRESH_AFTER_SECONDS, NEW_LIFETIME_SECONDS };

export const handle: Handle = async ({ event, resolve }) => {
  const { request } = event;
  const url = new URL(request.url);

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
    let sessionToken = event.cookies.get("ezcorp_session");

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
          event.cookies.set("ezcorp_session", legacyToken, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 });
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
          // DB not initialized (e.g. PI_SKIP_INIT for E2E tests) — skip auth
          return resolve(event);
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
        throw redirect(302, "/login");
      }
    } else {
      let secret: string;
      try { secret = await getJwtSecret(); } catch {
        return resolve(event);
      }
      const payload = await verifyJWT(sessionToken, secret);

      if (!payload) {
        event.cookies.delete("ezcorp_session", { path: "/" });
        if (url.pathname.startsWith("/api/")) {
          return new Response(JSON.stringify({ error: "Session expired" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw redirect(302, "/login?reason=session_expired");
      }

      // Session-backed validation: check session record exists.
      // Missing session row = revoked; clear cookies and reject (do not auto-recreate).
      let sessionMissing = false;
      let dbAvailable = true;
      let sessionId: string | null = null;
      let oldTokenHash: string | null = null;
      try {
        oldTokenHash = await hashToken(sessionToken);
        const session = await getSessionByTokenHash(oldTokenHash);
        if (!session) {
          sessionMissing = true;
        } else {
          sessionId = session.id;
          // Throttled touch to track last activity
          touchSession(session.id).catch(() => {});
        }
      } catch {
        // DB unavailable -- allow JWT-only auth as fallback
        dbAvailable = false;
      }

      if (sessionMissing && dbAvailable) {
        event.cookies.delete("ezcorp_session", { path: "/" });
        event.cookies.delete("pi_session", { path: "/" });
        if (url.pathname.startsWith("/api/")) {
          return new Response(JSON.stringify({ error: "Session revoked" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw redirect(302, "/login?reason=session_revoked");
      }

      // ── Sliding refresh ────────────────────────────────────────────────
      // Once the JWT crosses REFRESH_AFTER_SECONDS of age, re-issue it with
      // another NEW_LIFETIME_SECONDS and bump the DB row's expiresAt. CAS on
      // (id, oldTokenHash) means concurrent requests can't double-rotate:
      // the loser sees `rotated === null` and silently keeps using its
      // inbound cookie, whose hash is still in the row.
      //
      // Skipped when the DB is unavailable (we have no row to rotate) or
      // when the row was missing (we already cleared the cookies above).
      if (sessionId && oldTokenHash && dbAvailable) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (nowSeconds - payload.iat > REFRESH_AFTER_SECONDS) {
          try {
            const newToken = await signJWT(
              { id: payload.id, email: payload.email, name: payload.name, role: payload.role },
              secret,
              NEW_LIFETIME_SECONDS,
            );
            const newTokenHash = await hashToken(newToken);
            const newExpiresAt = new Date((nowSeconds + NEW_LIFETIME_SECONDS) * 1000);
            const rotated = await rotateSessionToken({
              id: sessionId,
              oldTokenHash,
              newTokenHash,
              newExpiresAt,
            });
            if (rotated) {
              const isSecure = process.env.FORCE_SECURE_COOKIES === "true";
              event.cookies.set("ezcorp_session", newToken, {
                path: "/",
                httpOnly: true,
                sameSite: "lax",
                maxAge: NEW_LIFETIME_SECONDS,
                secure: isSecure,
              });
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
      ? ({ html }) => html.replace("<html ", '<html data-dev-indicator="1" ')
      : undefined,
  });

  // ── Security headers on ALL responses ───────────────────────────
  // SSE replaces the old WebSocket transport — no ws: or wss: scheme needed
  // in connect-src anymore.
  // These are applied as DEFAULTS — a route that already set its own
  // value (e.g. /api/extensions/[name]/data/* serves sandboxed content
  // that needs same-origin iframing, so it sets a more permissive
  // Content-Security-Policy + omits X-Frame-Options) keeps that value.
  const connectSrc = "'self'";
  const SECURITY_HEADERS: Record<string, string> = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src ${connectSrc}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
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
