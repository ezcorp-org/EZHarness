export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
};

/**
 * HOW a request authenticated — stamped POSITIVELY at each auth site, so a
 * gate can ask "is this an interactive human session?" without inferring it
 * from the ABSENCE of something else.
 *
 * There is exactly one producer per value and they are all in the request
 * pipeline:
 *   - `session`  — a verified session-cookie JWT (`web/src/hooks.server.ts`).
 *                  The only value that represents a human at a browser.
 *   - `api-key`  — a user-issued `ezk_*` bearer key
 *                  (`web/src/lib/server/security/bearer-auth.ts`).
 *   - `internal` — a loopback-only `ezkint_*` bundled-extension subprocess
 *                  key (same module).
 *
 * `undefined` means NO auth site claimed the request. A gate that allowlists
 * a value therefore refuses both "not authenticated" and "authenticated by
 * some future mechanism that has not been taught to stamp itself" — which is
 * the whole point of stamping rather than sniffing. Do NOT add a value here
 * without deciding, at every `requireSessionAuth` call site, whether that new
 * principal may spend a consent gate.
 */
export type AuthMethod = "session" | "api-key" | "internal";

export type JWTPayload = AuthUser & {
  iat: number;
  exp: number;
  // Random per-token claim. Two JWTs signed in the same second with the
  // same user payload produced identical tokens before this claim existed,
  // which collided on the `sessions.token_hash` UNIQUE constraint at insert
  // time. Optional for verify backward compat with tokens issued before
  // this change.
  jti?: string;
};
