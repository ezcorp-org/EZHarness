# Authentication & Sessions

> _EZCorp's request-level identity layer: HS256 JWTs carried in a host-only `ezcorp_session` cookie, backed by revocable `sessions` rows with sliding refresh, plus Bearer API-key auth — all enforced once in `hooks.server.ts` ahead of every route._

## Intent

Every protected route in EZCorp resolves a principal (`locals.user`) before the handler runs. Auth is **session-cookie first, Bearer second**: a browser carries a signed JWT in an httpOnly cookie whose validity is cross-checked against a server-side `sessions` row (so admins can revoke), while programmatic clients present `Authorization: Bearer …`. The whole flow — public-path allowlist, first-user `/setup` gate, onboarding redirect, rate limiting, CORS, security headers, and a loopback test-bypass — lives in a single SvelteKit `handle` hook so there is one fail-closed enforcement point, not per-route checks.

## How it works

### Tokens (`src/auth/jwt.ts`)

- `signJWT(payload, secret, expiresInSeconds)` hand-rolls an **HS256** JWT (header/payload base64url + HMAC-SHA-256 via WebCrypto). It stamps `iat`, `exp`, and a random 16-byte `jti` — the `jti` exists purely so two tokens minted in the same second with the same payload don't produce an identical string and collide on the `sessions.token_hash` UNIQUE constraint. Default lifetime is 30d, but callers pass `cfg.lifetimeSeconds` (90d).
- `verifyJWT(token, secret)` checks the signature and the `exp` claim, returning the payload or `null`. It does **not** enforce `jti` uniqueness.
- `getJwtSecret()` resolves the HMAC key with a 3-tier cache-then-persist strategy: `EZCORP_JWT_SECRET` env → encrypted `instance:jwtSecret` setting (decrypted via `providers/encryption`; legacy plaintext is lazily re-encrypted) → auto-generate 32 random bytes and persist encrypted. The result is memoized in a module-level `_cachedSecret`.

### Passwords (`src/auth/password.ts`)

- `hashPassword` / `verifyPassword` are thin wrappers over `Bun.password` (argon2id). The **login route** (`web/src/routes/api/auth/login/+server.ts`) adds the anti-enumeration guard: on a user miss or inactive account it still runs `verifyPassword` against a pre-computed dummy argon2id hash (`getDummyPasswordHash`) so the response timing matches the wrong-password branch for a real account.

### Sessions (`src/db/queries/sessions.ts`, `sessions` table)

- A login/setup/invite mints a JWT, then `createSession` inserts a `sessions` row keyed by `hashToken(token)` (SHA-256 hex of the raw token — the raw token is never stored). The row carries `userAgent`, `ipAddress`, `expiresAt`, `lastActiveAt`.
- `lookupSessionByTokenHash` matches the inbound hash against `token_hash` **or** `previous_token_hash` (while `previous_token_expires_at > NOW()`), returning `viaPrevious` so the hook knows the row was just rotated by a peer request.
- **Missing row = revoked.** Logout (`revokeSession`), admin session-kill, and `revokeAllUserSessions` delete the row; the next request then fails the lookup and is bounced.

### Per-request enforcement (`web/src/hooks.server.ts`, the `handle` hook)

Order matters — these run before any `+server.ts`:

1. **Preview-origin dispatch** — a `<id>.preview.<host>` request is a separate origin and never enters the app's auth flow (own token + registry gate). No-op unless `EZCORP_PREVIEW_APP_HOST` is set.
2. **OPTIONS preflight** → 204 with CORS headers.
3. **Payload-size cap** on POST/PUT/PATCH via `getMaxPayload(pathname)`.
4. **IP rate limit** for `keyType: "ip"` routes (login, reset), keyed on the trustworthy socket peer (`getClientIp`) unless `TRUSTED_PROXY_COUNT > 0`.
5. **Public-path allowlist** — `/login`, `/setup`, `/signup`, `/reset-password`, `/api/auth/{login,setup,invite,reset-password}`, `/api/health`, `/api/ready`, `/api/version`, `/_app/`, `/favicon` skip auth.
6. **Loopback test-bypass** — `isLoopbackTestBypass` lets the deterministic mock-LLM completions endpoint through, but **only** when the test surface is enabled, the peer is genuine loopback, and no proxy-forwarding headers are present.
7. **Cookie branch** — read `ezcorp_session` (with a hard-expired `pi_session` legacy-cookie migration bridge). `verifyJWT` → on failure clear the cookie and 401/redirect with `reason=session_expired`. On success, `lookupSessionByTokenHash`: a missing row (DB available) → clear cookie + `session_revoked`. A DB error falls back to **JWT-only** auth (degraded, but not fail-open to unauth).
8. **Sliding refresh** — if the JWT is older than `refreshAfterSeconds` (and not matched via the previous-hash grace slot), re-sign a fresh token and `rotateSessionToken` via a CAS on `(id, oldTokenHash)`. The loser of a concurrent rotation serves with its inbound cookie, which the row's `previous_token_hash` still matches for `previousTokenGraceSeconds`. Best-effort: a signing/CAS failure keeps the old (still-valid) cookie.
9. **Bearer branch** (no cookie) — `attachBearerAuth` routes the token: `ezkint_` internal keys (loopback-only, with `X-Ezcorp-On-Behalf-Of` impersonation gating) vs user `ezk_` keys. A failed-Bearer per-IP budget (`FAILED_BEARER_LIMIT = 20/min`) short-circuits forged-token sprays before the `verifyApiKey` table scan.
10. **First-user gate** — if `getUserCount() === 0`, page nav redirects to `/setup`; API returns 401 `Setup required`. A DB-unreachable count (outside `PI_SKIP_INIT`) fails closed with 503.
11. **Onboarding gate** — authenticated page nav with `onboardedAt === null` redirects to `/onboarding` (suppressed on `/onboarding` itself; API + asset paths bypass).
12. **User rate limit** for `keyType: "user"` routes (chat, runs, conversation create) after auth.
13. **Security headers** on every response (CSP, `X-Frame-Options: DENY`, nosniff, Referrer-Policy, Permissions-Policy; HSTS on HTTPS) + CORS on `/api`.

### Route handlers (`src/auth/middleware.ts`)

`requireAuth(locals)` / `requireRole(locals, "admin")` / `requireTeamRole(...)` throw a `Response` (401/403) when the principal is absent or under-privileged. Handlers call these at the top; the hook has already populated `locals.user`.

## Usage

### REST API

| Method & path | Public? | Purpose |
|---|---|---|
| `POST /api/auth/setup` | yes | First-user bootstrap (only when `getUserCount() === 0`); creates the admin, mints a session, 201. Rate-limited 3/hr/IP. |
| `POST /api/auth/login` | yes | Email + password → session cookie. Rate-limited 5/15min/IP; constant-time dummy-verify on miss. |
| `POST /api/auth/logout` | (cookie) | Revoke the current session row + clear the cookie. |
| `GET /api/auth/me` | no | Echo `locals.user` (or 401 via `requireAuth`). |
| `GET /api/auth/invite/[token]` / `POST …` | yes | Validate an invite token (GET) / create the invited account + session (POST). Rate-limited 10/15min/IP. |
| `POST /api/auth/reset-password` | (admin) | Admin mints a 1-hour reset token (returns only a masked preview; full URL goes to the audit log). 5/hr/admin. |
| `POST /api/auth/reset-password/[token]` | yes | Consume a reset token, set a new password hash. 10/15min/IP. |
| `GET /api/auth/oauth?provider=…` | no | **Provider** OAuth initiator (OpenAI/Google for LLM model auth — *not* user login); PKCE + server-side state, loopback callback worker. |

### Cookie & env / settings

- Cookie: `ezcorp_session`, `path=/`, `httpOnly`, `sameSite=lax`, `secure` **only** when `FORCE_SECURE_COOKIES=true` (HTTPS can't be auto-detected reliably under svelte-adapter-bun). `maxAge = lifetimeSeconds`.
- `EZCORP_JWT_SECRET` — explicit HMAC secret; otherwise auto-generated + persisted encrypted as `instance:jwtSecret`.
- `EZCORP_SESSION_LIFETIME_DAYS` (90), `EZCORP_SESSION_REFRESH_AFTER_DAYS` (7), `EZCORP_SESSION_PREVIOUS_TOKEN_GRACE_SECONDS` (60) — all read once via `getSessionConfig()`.
- `TRUSTED_PROXY_COUNT`, `CORS_ALLOWED_ORIGINS` (explicit allowlist; `*` means deny-all), `EZCORP_PREVIEW_APP_HOST`.

### Programmatic clients

Send `Authorization: Bearer ezk_…` (user key) — see [[developer-api-keys]]. Bundled-extension subprocesses use loopback-only `ezkint_…` keys with optional `X-Ezcorp-On-Behalf-Of`.

## Key files

- `src/auth/jwt.ts` — `signJWT` / `verifyJWT` (HS256 via WebCrypto), `getJwtSecret` 3-tier resolver + encryption-at-rest.
- `src/auth/password.ts` — `hashPassword` / `verifyPassword` over `Bun.password` (argon2id).
- `src/auth/types.ts` — `AuthUser` (`role: "admin" | "member"`) + `JWTPayload` (`iat`/`exp`/`jti`).
- `src/auth/middleware.ts` — `requireAuth` / `requireRole` / `requireTeamRole` route guards (throw `Response`).
- `src/db/queries/sessions.ts` — `hashToken`, `createSession`, `lookupSessionByTokenHash`, `touchSession`, `rotateSessionToken`, `revokeSession`, `revokeAllUserSessions`, `deleteExpiredSessions`.
- `src/db/schema.ts` — `sessions` table (`token_hash` unique, `previous_token_hash` + grace, `expires_at`, `last_active_at`).
- `web/src/hooks.server.ts` — the `handle` hook: allowlist, cookie+Bearer auth, sliding refresh, setup/onboarding gates, rate limit, CORS, CSP/security headers, loopback bypass.
- `web/src/lib/server/auth/session-cookie.ts` — `getSessionConfig`, `setSessionCookie` / `clearSessionCookie` (`ezcorp_session`, `FORCE_SECURE_COOKIES`).
- `web/src/lib/server/security/bearer-auth.ts` — `attachBearerAuth`: internal (`ezkint_`) vs user (`ezk_`) key routing + on-behalf-of gating.
- `web/src/routes/api/auth/login/+server.ts` — login + constant-time dummy-verify + per-IP throttle.
- `web/src/routes/api/auth/setup/+server.ts` — first-admin bootstrap.
- `web/src/routes/api/auth/logout/+server.ts` — session revoke + cookie clear.
- `web/src/routes/api/auth/me/+server.ts` — current-principal echo.
- `web/src/routes/api/auth/invite/[token]/+server.ts`, `web/src/routes/api/auth/reset-password/+server.ts`, `web/src/routes/api/auth/reset-password/[token]/+server.ts` — invite + admin-driven reset flows.
- `src/auth/oauth-callback-server.ts`, `src/auth/oauth-callback-worker.ts`, `web/src/routes/api/auth/oauth/+server.ts` — provider-OAuth (model login) PKCE flow with a loopback callback worker.

## Features it touches

- [[api-security]] — this hook is the enforcement point; per-route handlers add `requireScope`/ownership on top.
- [[developer-api-keys]] — Bearer `ezk_` keys are the non-cookie principal path (`attachBearerAuth` → `verifyApiKey`).
- [[rbac-and-permission-modes]] — `AuthUser.role` (`admin`/`member`) gates `requireRole`; team roles gate `requireTeamRole`.
- [[onboarding-quickstart]] — first-user `/setup` gate and the `onboardedAt`-null `/onboarding` redirect live in this hook.
- [[admin-surfaces]] — admin session listing/kill and reset-token minting depend on the revocable `sessions` row.
- [[audit-and-observability]] — login/failed-login/rate-limited/reset events are written to the audit log here.
- [[remote-testability]] — the loopback test-bypass and `ezkint_` internal keys are how the mock-LLM + harness authenticate.
- [[preview-port-exposure]] — preview origins are dispatched out of the auth flow before the cookie is ever read.
- [[providers-and-models]] — `/api/auth/oauth` is provider (LLM) OAuth, not user login, but shares the route namespace.
- [[settings-system]] — the JWT secret and rate-limit overrides are persisted settings (`instance:jwtSecret`, `limits:rateLimit`).

## Related docs

None yet — this is the primary reference. (See [production-guide](../../production-guide.md) for deployment-time `FORCE_SECURE_COOKIES` / `CORS_ALLOWED_ORIGINS` / `TRUSTED_PROXY_COUNT` guidance, and [harness-contract](../../harness-contract.md) for the loopback test surface.)

## Notes & gotchas

- **DB-unavailable falls back to JWT-only auth.** If `lookupSessionByTokenHash` throws (DB down), the hook keeps serving the request on the JWT alone — revocation is not enforced during a DB outage. This is deliberate (availability over instant-revoke) but means a stolen-then-revoked token still works while the DB is unreachable.
- **Password reset does NOT revoke existing sessions.** `reset-password/[token]` updates the hash and audits, but never calls `revokeAllUserSessions`. A session captured before the reset stays valid until it expires or is killed manually. Revoke explicitly if rotating a compromised password.
- **The admin reset-*generate* endpoint sits under a public-allowlist prefix (sharp edge).** `PUBLIC_PATHS` lists `/api/auth/reset-password` so the genuinely-public token-*consume* sub-path (`/api/auth/reset-password/[token]`) skips the hook's auth. But the exact-match arm of that allowlist entry (`url.pathname === p`) also exempts `POST /api/auth/reset-password` — the admin *generate* endpoint — so the hook never populates `locals.user` for it. Its own `requireRole(locals, "admin")` then runs against an empty `locals` and 401s on a real cookie request. The route's unit tests inject `locals.user` directly (bypassing the hook), so they pass and don't surface this; the table above marks it "(admin)" by the handler's intent, not by an end-to-end-verified path.
- **`secure` is opt-in only.** Cookies are marked `Secure` solely when `FORCE_SECURE_COOKIES=true` — svelte-adapter-bun's `get_origin()` defaults the protocol to `https` when `ORIGIN` is unset, so HTTPS can't be auto-detected without risking a `Secure` cookie on a plain-HTTP deploy. Set it explicitly behind TLS.
- **JWT secret is auto-generated if unset.** Without `EZCORP_JWT_SECRET`, the first boot mints and persists a random secret (encrypted at rest). Rotating it (or letting it regenerate) invalidates every outstanding JWT. Legacy plaintext `instance:jwtSecret` values are silently re-encrypted on first read.
- **JWT-only fallback bypasses revocation.** Distinct from the cookie path: in the no-cookie Bearer flow, an `ezk_` API key is its own revocation surface (key delete), not a session row.
- **Internal `ezkint_` keys are loopback-gated and fail closed on proxy headers.** Any of `x-forwarded-for` / `x-real-ip` / `forwarded` present → the internal-key path returns false (a reverse proxy re-originates to 127.0.0.1, which would otherwise spoof loopback). On-behalf-of impersonation rejects `sys-`-prefixed and inactive targets, falling back to the system principal (no privilege escalation).
- **`role` is `"admin" | "member"`** in `AuthUser` — the `viewer`/`editor`/`owner` levels in `src/auth/middleware.ts` are **team** roles (`requireTeamRole`), a separate axis from the instance role.
- **`pi_session` legacy migration is hard-expired** (after `2026-06-01`). Past that date the old cookie is purged, not promoted — clients must re-authenticate.
- **`/api/auth/oauth` is provider login, not user login.** It runs a PKCE flow (server-side `oauth:pending:<state>` record, code-verifier never leaves the server) to authenticate the instance to an LLM provider; `requireAuth` still gates it, so a logged-in EZCorp user is a prerequisite.
