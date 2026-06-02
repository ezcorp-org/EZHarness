import type { Cookies } from "@sveltejs/kit";

const SESSION_COOKIE_NAME = "ezcorp_session";

function readPositiveNumber(envValue: string | undefined, fallback: number): number {
  if (!envValue) return fallback;
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Lifetimes are read once per process. Production deployments restart on
// config change anyway; tests that need to vary these reach in via the
// internal `__overrideSessionConfig` hook below rather than re-importing.
let _config: SessionConfig | null = null;

export interface SessionConfig {
  /** Cookie maxAge + DB row expiresAt + JWT exp window (seconds). */
  lifetimeSeconds: number;
  /** Re-issue the JWT once the inbound token is older than this (seconds). */
  refreshAfterSeconds: number;
  /**
   * After a rotation, the previous tokenHash keeps validating for this many
   * seconds. Bridges the in-flight gap between the rotating request's
   * Set-Cookie and concurrent requests still carrying the old cookie. Short
   * enough that revocation is still effectively immediate.
   */
  previousTokenGraceSeconds: number;
}

function loadConfig(): SessionConfig {
  const lifetimeDays = readPositiveNumber(process.env.EZCORP_SESSION_LIFETIME_DAYS, 90);
  const refreshAfterDays = readPositiveNumber(process.env.EZCORP_SESSION_REFRESH_AFTER_DAYS, 7);
  const previousTokenGraceSeconds = readPositiveNumber(
    process.env.EZCORP_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS,
    60,
  );
  return {
    lifetimeSeconds: Math.floor(lifetimeDays * 24 * 3600),
    refreshAfterSeconds: Math.floor(refreshAfterDays * 24 * 3600),
    previousTokenGraceSeconds: Math.floor(previousTokenGraceSeconds),
  };
}

export function getSessionConfig(): SessionConfig {
  if (!_config) _config = loadConfig();
  return _config;
}

/** Test-only: override the cached config. Pass `null` to revert to env-derived defaults. */
export function __overrideSessionConfig(override: Partial<SessionConfig> | null): void {
  if (override === null) {
    _config = null;
    return;
  }
  _config = { ...loadConfig(), ..._config, ...override };
}

export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

/**
 * Set the session cookie with the standard attributes. `secure` is opt-in via
 * FORCE_SECURE_COOKIES — see web/src/routes/api/auth/login/+server.ts:92-96
 * for the full explanation of why we can't auto-detect HTTPS.
 */
export function setSessionCookie(
  cookies: Cookies,
  token: string,
  opts: { maxAgeSeconds?: number } = {},
): void {
  const cfg = getSessionConfig();
  cookies.set(SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: opts.maxAgeSeconds ?? cfg.lifetimeSeconds,
    secure: process.env.FORCE_SECURE_COOKIES === "true",
  });
}

export function clearSessionCookie(cookies: Cookies): void {
  cookies.set(SESSION_COOKIE_NAME, "", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
  });
}
