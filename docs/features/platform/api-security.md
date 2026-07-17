# API Security Helpers

> _The server-side perimeter for EZCorp's HTTP API: bearer-token auth (user `ezk_*` keys + loopback-only internal `ezkint_*` extension creds), scope gating, token-bucket rate limiting, payload caps, per-user quotas, SSRF/DNS-pinning URL validation, and the CORS / trusted-proxy / CSP headers — all wired through `hooks.server.ts`._

## Intent

EZCorp serves both a browser app (cookie/JWT sessions) and a programmatic API surface (extensions, the CLI, external harnesses). The modules under `web/src/lib/server/security/*` are the shared building blocks that gate that surface: they verify who is calling, what scopes they hold, whether they're over a rate or quota budget, and whether a user-supplied URL is safe to fetch. The design goal throughout is **fail-closed** — a missing scope, a forged token, a DB outage, or an unparseable address all default to denial, and admin authority is gated on the principal's *role* (never reachable by an API key, which is always minted `role: "member"`).

## How it works

The pipeline is orchestrated top-to-bottom in `web/src/hooks.server.ts`'s `handle`, with the security primitives invoked at each stage:

1. **Preview-origin short-circuit.** A `<id>.preview.<host>` request is a separate origin and is dispatched away from the app's auth flow entirely (`matchPreviewOrigin` / `servePreviewRequest`).
2. **CORS preflight.** `OPTIONS` returns 204 with `getCorsHeaders`. Allowed origins come from `CORS_ALLOWED_ORIGINS` (comma list); **unset → deny-all**, and a literal `*` is stripped (never reflected) — reflecting the request origin alongside credentialed fetches was the exploitable pattern this closes.
3. **Payload guard.** For `POST`/`PUT`/`PATCH`, `getMaxPayload(pathname)` (`payload.ts`) picks a prefix-matched cap (1 MB default; 100 MB `/api/conversations`, 50 MB `/api/knowledge-base`, 25 MB `/api/extensions`) and `payloadTooLarge` returns 413 when `content-length` exceeds it.
4. **IP rate limit (pre-auth).** `getClientIp(request, socketAddress)` resolves the client IP — peeling `TRUSTED_PROXY_COUNT` hops off the right of `x-forwarded-for` when a proxy is configured, else keying on the **trustworthy socket peer** (so attacker-rotated headers can't mint fresh buckets). `RATE_LIMITED_ROUTES` (login 5/min, password-reset 3–5/min, etc.) are checked against the singleton `RateLimiter` (`rate-limiter.ts`).
5. **Auth resolution.** For non-public paths with no session cookie, `attachBearerAuth` (`bearer-auth.ts`) routes the `Authorization: Bearer …` token:
   - **`ezkint_…`** (internal) → `verifyInternalKey` (`internal-auth.ts`). `attachBearerAuth` first rejects if *any* proxy-forwarding header is present (before any verify), and `verifyInternalKey` rejects if the peer isn't loopback. On success the principal is `sys-<ext>` with `role: "member"`; an `X-Ezcorp-On-Behalf-Of` header can re-target a *real, active, non-`sys-`* user (validated against the DB), falling back to the system principal on any failure (impersonation is a no-op, never an escalation).
   - **`ezk_…`** (user) → `verifyApiKey` (`api-keys.ts`). Constant-time SHA-256 hash compare via an O(1) `apikeyhash:<hash>` index row, with a one-time legacy table-scan fallback that lazily upgrades to the index.
   - A forged-`Bearer` spray is contained by a dedicated per-IP `failedBearerLimiter` (20/min): `peek()` short-circuits *before* the expensive verify scan once the budget is burned; only genuine failures `check()`-increment it.
6. **Fail-closed fallbacks.** A DB outage during auth returns **503** (not fail-open), except under `PI_SKIP_INIT` (E2E). Zero users → `/setup`; no principal → 401/redirect.
7. **User rate limit (post-auth).** Routes with `keyType: "user"` (`POST /api/conversations` 30/min, `POST /api/conversations/[id]/messages` 20/min, `POST /api/agents/[name]/run` + `POST /api/workflows/[name]/run` 10/min, `POST /api/agent-configs/generate` 5/min) check the limiter keyed on `user:<id>:<category>`. Per-category overrides come from the `limits:rateLimit` settings KV (60 s cache).
8. **Per-route scope + ownership.** Inside each `+server.ts`, `requireScope(locals, scope)` (`api-keys.ts`) gates the key's scopes (cookie sessions are allow-all there), `requireAuth` / `requireRole` / `requireTeamRole` (`src/auth/middleware.ts`) gate identity/role, and `requireAdmin` (`api-keys.ts`) gates on the *role* axis to defeat the "cookie session is allow-all for `requireScope('admin')`" footgun.
9. **Response headers.** Every response gets default security headers + the `CSP_HEADER_VALUE` CSP (built from exported `CSP_*` constants); HSTS on HTTPS; CORS echoed on `/api` responses.

### Credentials & quotas, separately

- **Key primitives** are pure and shared (`src/auth/api-key.ts`): `generateApiKey` (`ezk_` + 32 random bytes, base64url), `hashApiKey` (SHA-256 hex), `scopesOverCeiling` (only an `admin` role may mint the `admin` scope). `src/auth/mint-api-key.ts` persists the canonical `apikey:<userId>:<keyId>` settings row **plus** the `apikeyhash:<hash>` index in lock-step (and drops both on revoke).
- **Internal-key provisioning**: `bundled-creds.ts` holds the hard-coded allowlist (currently only `ai-kit`, scopes `read,chat,extensions`), mints a fresh `ezkint_*` per boot via `provisionInternalKey`, seeds a `sys-<ext>` user row via `ensureSystemUser` (`system-user.ts`), and injects `EZCORP_API_KEY` + loopback `EZCORP_BASE_URL` into the extension subprocess. An operator env flag (`EZCORP_DISABLE_<EXT>=1`) opts an extension out.
- **Provider-credential injection**: `openai-extension-creds.ts` registers a *per-spawn* async resolver that pulls the user's decrypted OpenAI `sk-…` key and/or refreshed Codex OAuth access token from settings and injects them only into the `openai-image-gen-2` subprocess.
- **Resource quotas** (`resource-quotas.ts`): `checkTokenBudget(userId)` gates daily token spend (default 100k, `limits:dailyTokens` override) and `checkStorageQuota(userId, resource, currentCount)` accepts `"Conversations" | "Memories" | "KnowledgeBase"` against `limits:max<Resource>` (defaults 500 / 10k / 100). Only the **KnowledgeBase** resource is wired today (`/api/knowledge-base`); the conversations/memories branches are defined but not yet called. Limits live in the settings KV.
- **SSRF/URL validation** (`url-validation.ts`): `isPrivateOrLoopback` is a synchronous literal-IP/loopback check; `resolveAndValidateHostname` adds an async DNS lookup that re-validates **every** resolved A/AAAA address, closing the DNS-rebinding window.

## Usage

### Gating helpers (inside a `+server.ts`)

```ts
import { requireScope, requireAdmin } from "$lib/server/security/api-keys";
import { requireAuth, requireRole, requireTeamRole } from "$server/auth/middleware";

const scopeErr = requireScope(locals, "read"); if (scopeErr) return scopeErr;
const user = requireAuth(locals);            // throws 401 Response if unauthenticated
const adminErr = requireAdmin(locals);       // 403 unless role === "admin"
```

`requireScope` is used in ~143 route files; the canonical pairing for admin routes is `requireScope(locals, "admin")` **+** `requireRole(locals, "admin")` (or `requireAdmin`), enforced by a route-contract meta-test.

### Developer API keys (HTTP)

| Method & path | Scope/role | Purpose |
|---|---|---|
| `GET /api/settings/developer/api-keys` | `read` | List own keys (`keyId`, `name`, `scopes`, `createdAt` — never the hash/raw). |
| `POST /api/settings/developer/api-keys` | `admin` scope **+** scope-ceiling | Mint a key (`name`, `scopes`). Returns the raw key **once**. A non-admin minting `admin` → 403 via `scopesOverCeiling`. |
| `DELETE /api/settings/developer/api-keys` | `admin` scope | Revoke by `keyId`; drops canonical row + hash index. 204 / 404. |

The CLI shares the exact same primitives: `bun run src/cli.ts key:mint …`.

### Internal extension auth (on-behalf-of)

Bundled extensions call back over loopback with their injected `ezkint_*` key. The executor sets `X-Ezcorp-On-Behalf-Of: <userId>` via a subprocess `_meta.ezOnBehalfOf` side channel (LLM tool args **cannot** reach this header). Honored only when the token is internal-auth, on loopback, no forwarding headers present, and the target is an active non-`sys-` user.

### SSRF-guarded routes

`POST /api/providers/local/test` and `POST /api/providers/local/models` (both `POST`, both `requireRole(locals, "admin")`-gated) run a user-supplied `baseUrl` through `isPrivateOrLoopback` then `resolveAndValidateHostname` before fetching.

### Env vars & settings keys

- `CORS_ALLOWED_ORIGINS` — comma allowlist (unset → deny-all; `*` stripped).
- `TRUSTED_PROXY_COUNT` — XFF hops to peel (default `0` → key on socket peer).
- `EZCORP_BASE_URL` — loopback callback URL **injected** into bundled extensions (alongside `EZCORP_API_KEY`). `EZCORP_PORT` is **not** injected — it's read server-side by `resolveInternalBaseUrl` only to *derive* `EZCORP_BASE_URL` (`http://127.0.0.1:<port>`) when `EZCORP_BASE_URL` is unset (default port `3000`).
- `EZCORP_DISABLE_<EXT>=1` — opt a bundled extension out of internal-cred minting.
- `CORS_ALLOWED_ORIGINS`, `PI_SKIP_INIT` (E2E DB-absent fail-open), `EZCORP_DEV_INDICATOR`.
- Settings KV: `limits:rateLimit` (per-category overrides), `limits:dailyTokens`, `limits:maxConversations` / `…Memories` / `…KnowledgeBase`, `usage:tokens:<userId>:<date>`.

## Key files

- `web/src/lib/server/security/api-keys.ts` — `verifyApiKey` (O(1) hash-index + legacy scan), `requireScope`, `requireAdmin`; re-exports the pure `src/auth/api-key` primitives.
- `web/src/lib/server/security/internal-auth.ts` — `ezkint_*` in-memory key store, `provisionInternalKey`/`revokeInternalKey`, `verifyInternalKey`, `isLoopbackAddress` (staged, fail-closed loopback parser).
- `web/src/lib/server/security/bearer-auth.ts` — `attachBearerAuth`: bearer-token routing, proxy-forwarding rejection, `X-Ezcorp-On-Behalf-Of` elevation.
- `web/src/lib/server/security/rate-limiter.ts` — `RateLimiter` token bucket: `check` (mutating, `firstBlock` single-audit flag), `peek` (read-only), `cleanup`, `reset`.
- `web/src/lib/server/security/payload.ts` — `getMaxPayload` prefix caps + `payloadTooLarge` (413).
- `web/src/lib/server/security/url-validation.ts` — `isPrivateOrLoopback` (sync) + `resolveAndValidateHostname` (async DNS-pinning); IPv4/IPv6 private-range parsing.
- `web/src/lib/server/security/resource-quotas.ts` — `checkTokenBudget`, `recordTokenUsage`, `checkStorageQuota`.
- `web/src/lib/server/security/system-user.ts` — `ensureSystemUser` / `systemUserIdFor` (`sys-<ext>`, role `member`, `.invalid` email, random discarded password).
- `web/src/lib/server/security/bundled-creds.ts` — hard-coded bundled-extension allowlist + `bootstrapBundledCredentials` / `teardownBundledCredentials`.
- `web/src/lib/server/security/openai-extension-creds.ts` — per-spawn OpenAI key/OAuth resolver for `openai-image-gen-2`.
- `web/src/lib/server/security/validation.ts` — shared `passwordSchema` + `validationError` (Zod → 400 with `fields`).
- `web/src/hooks.server.ts` — the orchestrator: payload → IP rate limit → bearer/session auth → user rate limit → scope; CORS / CSP / HSTS / security headers; `getClientIp` proxy peeling.
- `src/auth/api-key.ts` — pure key primitives shared by web + CLI: `generateApiKey`, `hashApiKey`, `scopesOverCeiling`, `apiKeySettingsKey`/`apiKeyHashIndexKey`.
- `src/auth/mint-api-key.ts` — `mintApiKeyForUser` / `deleteApiKeyForUser` (canonical row + hash index in lock-step).
- `src/auth/middleware.ts` — `requireAuth`, `requireRole`, `requireTeamRole` (throw `Response` on failure).
- `web/src/routes/api/settings/developer/api-keys/+server.ts` — developer key CRUD (GET/POST/DELETE).

## Features it touches

- [[authentication]] — sessions/JWT live alongside this; `hooks.server.ts` resolves cookie auth before falling back to bearer.
- [[developer-api-keys]] — the `ezk_*` mint/list/revoke surface and CLI parity are this module's user-facing product.
- [[rbac-and-permission-modes]] — `requireScope` / `requireRole` / `requireAdmin` are the scope + role enforcement layer.
- [[remote-testability]] — external harnesses authenticate with minted API keys and rely on the loopback test-surface bypass.
- [[sandbox-and-isolation]] — internal `ezkint_*` creds + `sys-<ext>` users let bundled extension subprocesses call back in.
- [[bundled-catalog]] — the hard-coded internal-cred allowlist (`ai-kit`) and provider-credential injection target bundled extensions.
- [[providers-and-models]] — the SSRF guard gates user-supplied provider `baseUrl`s; OpenAI creds inject into the image-gen extension.
- [[conversations]] — every conversation route is gated by `requireScope` + ownership; the chat route checks `checkTokenBudget`.
- [[knowledge-base]] — `checkStorageQuota` + the 50 MB payload cap gate uploads.
- [[runs-lifecycle]] — agent/pipeline run routes carry their own per-user rate-limit buckets.
- [[preview-port-exposure]] — preview origins are dispatched out of the auth flow with their own token gate.
- [[audit-and-observability]] — `firstBlock` single-audit and on-behalf-of elevation logs feed audit trails.

## Related docs

None yet — this is the primary reference for the `web/src/lib/server/security/*` perimeter. (See [authentication](authentication.md) and the [extension data-storage](../../extensions/data-storage.md) convention for adjacent surfaces.)

## Notes & gotchas

- **Admin authority is a *role* axis, not a scope.** `requireScope(locals, "admin")` returns ALLOW for any cookie session (`apiKeyScopes` is undefined there), so a non-admin member with a browser cookie would sail through. Gate admin routes on `requireAdmin` / `requireRole(locals, "admin")`; the route-contract meta-test enforces the pairing. API keys (incl. internal) are **always** minted `role: "member"`, so they can never be admin-by-role even holding the `admin` scope.
- **`recordTokenUsage` is defined but not called on the chat hot path.** The messages route calls `checkTokenBudget` (gate) but does **not** call `recordTokenUsage` there — the daily-token counter is only incremented by callers that explicitly invoke it. Don't assume the budget self-decrements on every chat turn.
- **Internal keys are loopback-only AND proxy-fail-closed.** `verifyInternalKey` rejects non-loopback peers, but a reverse proxy terminates the remote connection and re-opens to `127.0.0.1`, which would otherwise let a public attacker present an `ezkint_*` token from "loopback". `attachBearerAuth` rejects on the *presence of any* forwarding header (`x-forwarded-for` / `x-real-ip` / `forwarded`) — a genuine subprocess loops back directly with none.
- **`isLoopbackAddress` parses in staged passes, not one regex.** It strips IPv6 zone ids, bracketed ports, and trailing IPv4 ports separately and fails closed on any non-canonical `::ffff:` form — so strings like `127.0.0.1.evil.com`, `0127.0.0.1`, or `::ffff:2130706433` can't squeak through.
- **Rate-limit keying flips with `TRUSTED_PROXY_COUNT`.** Default (`0`) keys on the socket peer because in a direct-exposure topology (tailscale/LAN/port-forward) every header is attacker-controlled. Only set `TRUSTED_PROXY_COUNT > 0` behind a real proxy, or a spammer can rotate `x-forwarded-for` to mint a fresh bucket per request.
- **CORS unset = deny-all; `*` is NOT a wildcard.** Leaving `CORS_ALLOWED_ORIGINS` unset denies all cross-origin; a literal `*` is filtered out rather than reflected (reflecting origins with credentialed fetches was the original vuln).
- **DB outage during auth fails closed with 503** — except under `PI_SKIP_INIT` (E2E), where the DB is intentionally absent and the request is let through. Never rely on the E2E behavior in any other environment.
- **SSRF validation is two-layer and must be used as a pair.** The sync `isPrivateOrLoopback` does **not** reject arbitrary public hostnames; you must also `try/catch` `resolveAndValidateHostname` (which throws on NXDOMAIN and re-checks every resolved address) to close DNS rebinding. A non-IP hostname passing only the sync check is not safe.
- **`verifyApiKey` legacy fallback is a table scan.** Keys minted before the `apikeyhash:` index exist only as `apikey:*` rows; a forged token also misses the index and triggers the full `getAllSettings` scan. The per-IP `failedBearerLimiter` (`peek` before verify) is what caps that DoS-amplification vector — don't remove it.
- **`provisionInternalKey` refuses the `admin` scope** and throws; bundled extensions can never self-authorize to admin even by editing the allowlist scopes.
- **On-behalf-of failures are silent no-ops, not 401s.** An invalid/inactive/`sys-`-prefixed OBO target falls back to the system principal — the call still authenticates and runs *as the extension*, never as the unauthorized target. This is intentional (no privilege escalation), but means a typo in the header silently mis-attributes writes to `sys-<ext>`.
- **DEFAULT_PERMISSION_MODE = "yolo"** (in `src/runtime/tools/permissions.ts`, the per-tool-call layer — adjacent, not part of this module) is an intentional, permanent product decision, not a finding here.
