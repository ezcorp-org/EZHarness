# Developer API Keys

> _Long-lived `ezk_*` bearer tokens — SHA-256-hashed, scoped (`read`/`chat`/`extensions`/`admin`), shown raw exactly once — that let external harnesses, CI scripts, and tools drive a live EZCorp instance without a browser session._

## Intent

Developer API keys are EZCorp's programmatic credential. A browser carries a session cookie; everything else (a CI pipeline, a Playwright suite, a remote agent, a shell script) presents `Authorization: Bearer ezk_…` instead. Keys are **scoped** so a token can be narrowed to exactly the authority it needs, and they are the cold-start entry point for remote control: a `key:mint` CLI command issues a key with no UI session at all, which is how an operator bootstraps automation against a fresh instance. Only the SHA-256 **hash** of a key is ever persisted — the raw token is returned once at mint time and never recoverable.

## How it works

The key lifecycle is split across a pure backend module (shared by both the CLI and the SvelteKit server) and a web-side verification/gating layer.

### Shape & storage

- **Generation** (`src/auth/api-key.ts#generateApiKey`): `ezk_` + 32 random bytes (base64url) for the raw token, a random UUID `keyId`, and `hashApiKey(raw)` = SHA-256 hex. The raw key never touches the DB.
- **Persistence** lives entirely in the **settings store** (no dedicated table, no migration). `mintApiKeyForUser` (`src/auth/mint-api-key.ts`) writes **two** rows via `upsertSetting`:
  1. The **canonical per-user row** at `apikey:<userId>:<keyId>` (`ApiKeyEntry` = `{ hash, userId, scopes, name, createdAt }`) — the source of truth for listing and deletion.
  2. A **hash-index pointer** at `apikeyhash:<sha256>` (`ApiKeyHashIndexEntry` = `{ userId, keyId }`) — a derived index so verification is O(1) instead of a full settings scan. It can always be rebuilt by re-scanning, so it carries no migration cost.
- All key-string formats (`apikey:`, `apikeyhash:`, the prefix used to enumerate a user's keys) come from single helper functions in `src/auth/api-key.ts` so the CLI and the HTTP route can never drift on the layout.

### Scope ceiling (anti-privilege-escalation)

`scopesOverCeiling(role, scopes)` (`src/auth/api-key.ts`) is the shared, pure mint-time gate: a key must never carry authority its **owner** lacks. Admins may mint any scope; everyone else is capped — `admin` is filtered out and flagged. Both mint paths call it identically:

- HTTP `POST` → returns **403** with the offending scopes.
- CLI `key:mint` → prints an error and `exit(1)`.

This matters because the in-app `POST` route gates on `requireScope(locals, "admin")`, which is **allow-all for any cookie session** (`locals.apiKeyScopes` is undefined there). Without the ceiling, a non-admin browser user could self-mint an `admin`-scoped key. The Zod schema permits `"admin"`; the ceiling is what actually blocks it.

### Verification on each request

1. `hooks.server.ts` only reaches Bearer auth when there is no session cookie. It sniffs proxy-forwarding headers, derives the client address, then calls `attachBearerAuth` (`web/src/lib/server/security/bearer-auth.ts`).
2. `attachBearerAuth` routes by prefix: `ezkint_*` tokens go to the loopback-only **internal-auth** verifier (bundled extensions, never falls through); everything else goes to `verifyApiKey`.
3. `verifyApiKey` (`web/src/lib/server/security/api-keys.ts`) hashes the raw key, then:
   - **Fast path:** load the `apikeyhash:<hash>` pointer → load the pointed-at per-user row → **constant-time** compare (`crypto.timingSafeEqual`, length-guarded) the stored hash against the request hash. A dangling pointer (canonical row deleted) fails the compare and is rejected.
   - **Slow/legacy path:** keys minted before the index existed have no pointer; one full `apikey:` scan finds them, and the index is **lazily back-filled** (best-effort upsert) so the next use upgrades to the fast path. No migration needed.
4. On success, `attachBearerAuth` populates `locals.user` with `role: "member"` (a key principal is **never** admin-by-role, even holding the `admin` scope) and sets `locals.apiKeyScopes` to the key's scopes.
5. Per-route, `requireScope(locals, scope)` enforces authorization: for a **cookie session** (`apiKeyScopes` undefined) it is **allow-all**; for a **key principal** it returns **403 "Insufficient scope"** unless the scope is present. `requireAuth` separately throws **401** when there is no principal at all.

### Abuse defenses

- A failed-Bearer rate limiter in `hooks.server.ts` (`failedBearerLimiter`) is `peek`ed *before* the `verifyApiKey` scan and `check`ed only when a presented Bearer fails — a DoS-amplification guard so an attacker can't force unbounded settings scans, while a valid key is never throttled.
- DB-unavailable during verification fails **closed** (returns `false` → unauthenticated), except under `PI_SKIP_INIT` (E2E) where the DB is intentionally absent.

### Revocation

`deleteApiKeyForUser` (`src/auth/mint-api-key.ts`) reads the canonical row first to learn the hash, deletes the per-user row, then drops the `apikeyhash:<hash>` index in lock-step (tolerating a missing legacy index). Returns whether the canonical row existed so the route can answer **404** unchanged. After revocation the key can no longer authenticate via either path.

## Usage

### CLI (cold start — no UI session)

```sh
ezcorp key mint                                          # defaults: scopes read,chat; binds to first admin
ezcorp key mint --scopes read,chat --user me@x.com --name ci
ezcorp key mint --scopes admin --user me@x.com --name deploy-bot
```

- `--scopes` is comma-separated (`parseKeyScopes`); omitted → `["read","chat"]`; unknown scope → `exit(1)`.
- `--user` accepts an **email or user id**; omitted → the first admin (or first user). With no users → `exit(1)` ("complete first-run setup").
- `--name` defaults to `cli-minted`.
- The raw key is printed **once** with the reminder that only the hash is persisted, plus the `Authorization: Bearer <key>` usage hint.

### In-app REST CRUD (`/api/settings/developer/api-keys`)

| Method | Scope gate (key principals) | Behavior |
|---|---|---|
| `GET` | `read` | List the caller's keys — `keyId`, `name`, `scopes`, `createdAt`. **Never** the hash or raw key. |
| `POST` | `admin` | Mint. Body `{ name (1–100), scopes (≥1 of read/chat/extensions/admin) }` (Zod `createApiKeySchema`). Scope-ceiling enforced → 403 on over-ceiling. Returns `{ key, keyId, name, scopes }` (the raw key) with **201**. |
| `DELETE` | `admin` | Revoke. Body `{ keyId (uuid) }`. 204 on success, **404** if not found. |

Reminder: the `admin` **scope** gate is allow-all for cookie sessions, so any logged-in user can use this UI to mint/list/revoke their own keys; the scope ceiling still blocks a non-admin from minting an `admin`-scoped key.

### UI entry point

`Settings → Developer` (`web/src/routes/(app)/settings/developer/+page.svelte`) renders `ApiKeyManager.svelte`: name input + scope toggle chips (`read`/`chat`/`extensions`/`admin`), a list of existing keys with per-row revoke-with-confirm, and a one-time amber "This key will only be shown once" reveal banner with copy-to-clipboard. It drives the three REST methods above.

### Using a key against a live instance

```sh
curl -H "Authorization: Bearer ezk_…" https://host/api/conversations?projectId=…
```

Scope-to-capability, by how widely each scope gates routes today: `read` (~75 route files — list/fetch/poll), `chat` (~49 — send messages, create/update conversations, drive runs), `extensions` (~17 — extension-facing endpoints), `admin` (~28 — admin surfaces). See [docs/harness-contract.md](../../harness-contract.md) for the full remote-control contract.

## Key files

- `src/auth/api-key.ts` — pure primitives: `ApiKeyScope`, `API_KEY_SCOPES`, `generateApiKey`, `hashApiKey`, settings-key helpers (`apiKeySettingsKey`/`apiKeySettingsPrefix`/`apiKeyHashIndexKey`), and the `scopesOverCeiling` mint gate. No I/O; node:crypto only.
- `src/auth/mint-api-key.ts` — `mintApiKeyForUser` (writes canonical + index rows) and `deleteApiKeyForUser` (lock-step revocation). The single mint/store/revoke implementation shared by CLI + HTTP.
- `web/src/lib/server/security/api-keys.ts` — re-exports the pure primitives, plus `verifyApiKey` (O(1) index + legacy-scan fallback, constant-time compare) and `requireScope`/`requireAdmin` request gates.
- `web/src/lib/server/security/bearer-auth.ts` — `attachBearerAuth`: prefix-routes `ezkint_` (internal/loopback) vs `ezk_` (user) tokens, populates `locals.user` (`role: "member"`) + `locals.apiKeyScopes`.
- `web/src/routes/api/settings/developer/api-keys/+server.ts` — GET/POST/DELETE CRUD; scope gates + scope-ceiling enforcement.
- `web/src/routes/api/settings/developer/schema.ts` — `createApiKeySchema` / `deleteApiKeySchema` Zod validators.
- `web/src/lib/components/settings/ApiKeyManager.svelte` — the Developer settings UI (create/list/revoke + one-time reveal banner).
- `web/src/routes/(app)/settings/developer/+page.svelte` — the settings sub-route hosting `ApiKeyManager`.
- `src/cli.ts` — `key mint` subcommand: `parseKeyScopes`, `resolveKeyMintUser`, scope-ceiling check, raw-key print.
- `web/src/hooks.server.ts` — per-request enforcement: failed-Bearer rate limit, proxy-header sniff, `attachBearerAuth` invocation.

## Features it touches

- [[authentication]] — Bearer key auth is the second axis of the single `hooks.server.ts` enforcement point (session-cookie first, Bearer second); both resolve `locals.user`.
- [[api-security]] — `requireScope`/`requireAuth`/`requireAdmin` gate every route; keys are the credential those gates check.
- [[rbac-and-permission-modes]] — the scope ceiling (`scopesOverCeiling`) plus the always-`member` key principal are how a key can never out-rank its owner.
- [[remote-testability]] — keys are the cold-start credential for the harness control tier (`ezcorp key mint`); the determinism tier layers separate `isTestSurfaceEnabled()` gating on top.
- [[settings]] — keys persist as settings-store rows (`apikey:` / `apikeyhash:`), and the UI lives under Settings → Developer.
- [[mcp-servers]] — internal bundled-extension auth (`ezkint_*`, loopback-only) routes through the same `attachBearerAuth` prefix switch as user `ezk_*` keys.
- [[conversations]] — the headline thing a `chat`/`read`-scoped harness key drives: send messages, poll runs.
- [[runs-lifecycle]] — a key with `chat` mints runs; `read` polls them.

## Related docs

- [docs/harness-contract.md](../../harness-contract.md) — the remote-harness control/determinism tiers; the canonical "getting access" walkthrough that uses `ezcorp key mint`.
- [docs/features/platform/authentication.md](./authentication.md) — the surrounding session/JWT auth layer that Bearer keys sit alongside.

## Notes & gotchas

- **`admin` scope ≠ admin role.** A key principal is **always** minted with `role: "member"` in `attachBearerAuth`, even when the key holds the `admin` *scope*. Admin-*role* routes must gate on `requireAdmin` (or `requireRole`), **not** `requireScope("admin")` — the latter is allow-all for cookie sessions and only checks the scope for keys, so it can't enforce "a real admin human". The `admin` scope merely widens which `read`/`chat`/`extensions`/`admin`-scoped routes the key may call.
- **Raw key is unrecoverable.** Only `hashApiKey(raw)` is stored. Lose the printed/revealed key and you must mint a new one — there is no "show again".
- **Persistence is the settings store, not a table.** Keys are `apikey:<userId>:<keyId>` and `apikeyhash:<hash>` settings rows. `GET /api/settings/developer/api-keys` filters the whole settings map by the per-user prefix — there is no dedicated keys table and no migration was added.
- **The hash index is a rebuildable optimization.** If the `apikeyhash:*` pointer is ever lost or stale, `verifyApiKey` still authenticates via the legacy full-scan path and lazily re-writes the index. A dangling pointer (canonical row deleted) is caught by the post-load constant-time hash compare, not trusted blindly.
- **Failed-Bearer throttling.** Spraying invalid `ezk_*` tokens burns a per-IP budget (`failedBearerLimiter`) checked *before* the settings scan; a valid key never consumes a token. Don't mistake a sudden 429 on a good key for a bad key — it may be IP-shared exhaustion.
- **No length leak.** `hashesEqual` short-circuits to `false` on a hash-length mismatch before `timingSafeEqual` (which throws on unequal lengths); both inputs are fixed-width SHA-256 hex in normal operation.
- **CLI default user.** `ezcorp key mint` with no `--user` binds to the **first admin** (or first user). Be explicit with `--user` in scripts so a key isn't accidentally bound to the wrong principal.
</content>
</invoke>
