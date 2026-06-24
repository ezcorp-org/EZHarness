# Settings System

> _EZCorp's instance-wide configuration store: a single `settings` key→JSONB KV table fronted by an admin-only CRUD API with a hard deny-list for secret keys, plus a separate per-(user, extension) settings table and a sub-routed Settings UI with client-side nav search and legacy-anchor redirects._

## Intent

The settings system is the platform's universal configuration substrate. Almost every cross-cutting toggle, default, and credential in EZCorp lives as a key-namespaced row in one `settings` table — provider keys, the instance JWT secret, model tiers, search policy defaults, compaction strategy, token limits, theme, marketplace install records, per-project overrides, and more. A thin generic CRUD API (`/api/settings`) lets admins (and the remote-test harness) read/write arbitrary keys, while a code-level **deny-list** fences off the handful of keys whose plaintext exposure would be catastrophic (mint-a-JWT / exfiltrate-credentials). Per-extension user preferences live in a **separate** table (`extension_settings_user`) so they can be schema-validated per manifest and scoped to a user, never colliding with the global namespace.

## How it works

### The KV table & query layer

- `settings` (`src/db/schema.ts`) is dead simple: `key text PRIMARY KEY`, `value jsonb NOT NULL` (`$type<unknown>()` — wide-open scalars/objects), `updated_at`.
- `src/db/queries/settings.ts` is the only DB accessor and exposes the full surface: `getAllSettings()` (→ `Record<string,unknown>`), `getSetting(key)`, `upsertSetting(key, value)` (select-then-insert/update, no native upsert), `deleteSetting(key)` (→ bool), and one bespoke helper `isListingInstalled(listingId)` that LIKE-scans `marketplace:installed:%` rows.
- Keys are **namespaced by convention** with `:` separators — e.g. `provider:apiKey:<provider>`, `global:systemPrompt`, `compaction:strategy`, `limits:dailyTokens`, `project:<id>:tool_permission_mode`, `theme`. The table itself enforces no namespace; consumers across `src/` read their own keys directly via `getSetting`.

### Sensitive-key encryption (at the consumer, not the KV layer)

The generic query layer stores values verbatim — it does **no** encryption. Encryption is the responsibility of the *dedicated* code path that owns each secret key, using `src/providers/encryption.ts`:

- `encrypt(plaintext)` / `decrypt(ciphertext)` are **AES-256-GCM** (`node:crypto`), keyed by an scrypt-derived 32-byte key from an app secret + salt. New ciphertexts are the tagged `v1:<iv>:<tag>:<ct>` format with a **12-byte** IV (sec-L4); legacy untagged `iv:tag:ct` rows with a 16-byte IV still decrypt for backward compat.
- The app secret resolves from `EZCORP_ENCRYPTION_SECRET` → a persisted `.pi-secret` file (under the DB/secrets dir) → auto-generated. Salt resolves from `EZCORP_ENCRYPTION_SALT` → `.pi-salt` → legacy `"pi-salt"`. In Docker the secret/salt live under the data VOLUME so they survive image upgrades.
- Who encrypts what: `src/auth/jwt.ts` writes `instance:jwtSecret` encrypted (sec-C1b; lazily re-encrypts a legacy plaintext value on first decrypt). `src/providers/credentials.ts` writes `provider:oauth:<provider>` and `provider:apiKey:<provider>` as encrypted JSON strings, and reads them back with `decrypt`. So the encrypted blobs live *in* the `settings` table, but are opaque to the generic API.

### The generic CRUD API + deny-list

`web/src/routes/api/settings/[key]/+server.ts` is the admin CRUD endpoint:

1. **Auth** — every method calls `requireRole(locals, "admin")` first (throws a 401 `Response` if unauthenticated, 403 if not admin).
2. **Deny-list** — `denyIfSensitive(params.key)` runs next; if `isSensitiveSettingKey(key)` matches, it returns **403** before touching the DB.
3. `GET` → `getSetting`; 404 if `value === undefined`. `PUT` → Zod-validates a `{ value }` body (`.strict()`, `value: z.unknown()`), rejects missing/`undefined` value with **400 "value required"**, then `upsertSetting`. `DELETE` → `deleteSetting`; 404 if absent.

The deny-list (`web/src/routes/api/settings/deny-list.ts`) is three regexes — `^instance:jwtSecret$`, `^provider:apiKey:`, `^provider:oauth:` — so the JWT secret and all provider credentials are unreadable and unwritable through this API, **even by admins**. The list endpoint `web/src/routes/api/settings/+server.ts` (`GET /api/settings`, admin-only) returns `getAllSettings()` with the same `isSensitiveSettingKey` filter applied, scrubbing secret keys from the bulk view too.

### Per-extension settings (separate table)

`extension_settings_user` (`src/db/schema.ts`) is a distinct table keyed by `(userId, extensionId)` PK with a `values jsonb` blob. `src/db/queries/extension-settings.ts` owns it:

- `getUserSettings` / `setUserSettings` / `clearUserSettings` per (user, extension).
- `setUserSettings` runs `clampSettings(schema, values)` against the extension's manifest `settings` schema (`isValidForField`) — unknown keys and invalid values are silently dropped, so a malicious/buggy write can't smuggle arbitrary fields.
- `resolveExtensionSettings(extId, userId, schema?)` merges **declared manifest defaults < user override**; a `null` userId (tool-call paths with no user) returns just the declared defaults. The optional `schema` arg lets the tool-executor skip the manifest DB lookup.

### The Settings UI (sub-routed)

The old `/settings` mega-page was split into sub-routes (`web/src/routes/(app)/settings/`):

- `models`, `search`, `personalization`, `briefing`, `developer`, `admin`, `admin/audit` are the live pages. `models`, `personalization`, `briefing`, `developer` are member-visible; `search`, `admin`, `admin/audit` are admin-only. The nav also links *out* to the canonical `/admin/dashboard` (System) and `/admin/moderation` (Moderation) pages — additive links, not new routes.
- `web/src/lib/settings-nav.ts` is the pure registry (`SETTINGS_NAV`): each `SettingsNavItem` carries `id`, `label`, `href`, `adminOnly`, legacy `anchors`, optional `bareAnchors`, and a `child` (indent) flag. `visibleNavItems(isAdmin)` filters admin entries; `activeNavId(pathname)` does a longest-prefix match so `/settings/admin/audit` highlights "Audit Log" over "Admin".
- `web/src/routes/(app)/settings/+page.svelte` is a **redirect shim** for the old mega-page: `resolveLegacyHash(hash, isAdmin)` maps every historical `/settings#<anchor>` fragment onto its new sub-route (admin targets fall back to `SETTINGS_DEFAULT_ROUTE = /settings/models` for non-admins). No hash → default route.
- `web/src/lib/settings-search.ts` powers the **client-side nav search** box in `+layout.svelte`: `filterSettings(query, registry, isAdmin)` is a pure substring filter + rank (label-prefix > label-substring > anchor/id, stable ties keep registry order) that also folds in the admin gate. Enter navigates to the top match. No backend, no fuzzy lib — unit-testable under vitest.

## Usage

### REST API (generic KV)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/settings` | admin | Bulk-read all settings; sensitive keys scrubbed. |
| `GET /api/settings/[key]` | admin | Read one key; 404 if absent, **403** if deny-listed. |
| `PUT /api/settings/[key]` | admin | Upsert `{ value }`; **400** "value required" if missing, **403** if deny-listed. |
| `DELETE /api/settings/[key]` | admin | Delete; 404 if absent, **403** if deny-listed. |

`web/src/routes/api/settings/developer/` is a **separate** surface — publish-token generation/check/revoke (`publish:token:<userId>`, hash-at-rest) and developer API keys — not the generic KV CRUD. See [[developer-api-keys]].

### Client / SDK

- Frontend: `web/src/lib/api.ts` exposes `fetchSettings()` (`GET /api/settings`) and `upsertSetting(key, value)` (`PUT /api/settings/[key]`).
- Remote-test harness: `@ezcorp/harness-client` (`packages/@ezcorp/harness-client/src/index.ts`) hits `GET`/`PUT /api/settings/:key` to drive instance config deterministically in tests.

### Representative setting keys (consumed directly via `getSetting`)

- `instance:jwtSecret` (encrypted), `instance:initialized`
- `provider:apiKey:<provider>` / `provider:oauth:<provider>` (encrypted), `provider:accessMode:<provider>`, `provider:defaultTier`, `provider:preferenceOrder`, `provider:customModels`, `provider:discoveredModels:<provider>`
- `global:systemPrompt`, `global:provider`, `global:memoryEnabled`, `global:agentAutonomyEnabled`, `global:lessonDistillerEnabled`, `global:auditIntervalHours`, `global:compactionIntervalHours`, `global:search:allowedByDefault` / `:defaultQuota` / `:defaultMaxResults` / `:defaultProviders`, `global:sdk*RetentionDays`
- `compaction:strategy`, `compaction:lastRun`
- `limits:dailyTokens`, `limits:rateLimit`
- `project:<id>:systemPrompt`, `project:<id>:tool_permission_mode`, `project:<id>:memoryIsolation`
- `marketplace:installed:<id>`, `marketplace:imported:<id>`
- `theme`, `oauth:pending:<state>`, `publish:token:<userId>`

### Env vars (encryption/secrets)

- `EZCORP_ENCRYPTION_SECRET` — explicit encryption secret (production best practice; otherwise auto-generated to `.pi-secret`).
- `EZCORP_ENCRYPTION_SALT` — explicit salt (otherwise `.pi-salt` or legacy `"pi-salt"`).
- `EZCORP_SECRETS_DIR` — override the secrets directory (defaults to the dir holding `EZCORP_DB_PATH`).

## Key files

- `src/db/schema.ts` — `settings` (KV) and `extension_settings_user` (per-(user,ext)) table defs.
- `src/db/queries/settings.ts` — `getAllSettings` / `getSetting` / `upsertSetting` / `deleteSetting` / `isListingInstalled`.
- `src/db/queries/extension-settings.ts` — per-extension `getUserSettings` / `setUserSettings` / `clearUserSettings` / `resolveExtensionSettings`, manifest-schema clamping.
- `web/src/routes/api/settings/+server.ts` — `GET /api/settings` bulk read, sensitive-key scrubbed.
- `web/src/routes/api/settings/[key]/+server.ts` — admin GET/PUT/DELETE one key, deny-list gated.
- `web/src/routes/api/settings/deny-list.ts` — the three regex `DENY_PATTERNS` + `isSensitiveSettingKey`.
- `web/src/routes/api/settings/developer/+server.ts` — publish-token CRUD (separate surface).
- `src/providers/encryption.ts` — AES-256-GCM `encrypt`/`decrypt`, scrypt key derivation, IV-format compat.
- `src/providers/credentials.ts` — encrypts/decrypts `provider:apiKey:*` / `provider:oauth:*` and resolves the credential chain.
- `src/auth/jwt.ts` — `instance:jwtSecret` encrypted at rest (sec-C1b), legacy-plaintext lazy re-encrypt.
- `web/src/routes/(app)/settings/+layout.svelte` — sub-route shell, nav, client-side search box.
- `web/src/routes/(app)/settings/+page.svelte` — legacy-hash redirect shim.
- `web/src/lib/settings-nav.ts` — `SETTINGS_NAV` registry, `resolveLegacyHash`, `activeNavId`, `visibleNavItems`.
- `web/src/lib/settings-search.ts` — `filterSettings` pure rank/filter for the nav search.
- `web/src/lib/settings-search-config.ts` — `global:search:*` default keys + coercion helpers for the admin Search page.
- `web/src/lib/api.ts` — frontend `fetchSettings` / `upsertSetting`.
- `packages/@ezcorp/harness-client/src/index.ts` — harness `GET`/`PUT /api/settings/:key`.

## Features it touches

- [[providers-and-models]] — provider API keys / OAuth tokens / tiers / custom models are settings keys; credential resolution reads them via `getSetting` + `decrypt`.
- [[authentication]] — `instance:jwtSecret` is a deny-listed, encrypted settings key minted by `src/auth/jwt.ts`.
- [[api-security]] — the CRUD route is `requireRole("admin")`-gated; the deny-list is a defense-in-depth fence on secret keys.
- [[rbac-and-permission-modes]] — admin-only nav entries and the `requireRole` gate; `project:<id>:tool_permission_mode` rides in settings.
- [[developer-api-keys]] — `/api/settings/developer` (publish tokens, dev keys) is a sibling surface under the same route prefix.
- [[remote-testability]] — the harness client configures a live instance through `GET`/`PUT /api/settings/:key`.
- [[context-compaction]] — `compaction:strategy` / `compaction:lastRun` select and track the trim strategy.
- [[web-search]] — `global:search:*` policy defaults are admin-edited via the Settings → Search page.
- [[daily-briefing]] — the Briefing settings sub-page configures briefing behavior.
- [[admin-surfaces]] — the admin sub-pages and the additive System/Moderation nav links.
- [[audit-and-observability]] — the `admin/audit` sub-route and `global:auditIntervalHours`.
- [[marketplace]] — `marketplace:installed:*` / `marketplace:imported:*` install records live in settings (`isListingInstalled`).
- [[projects]] — `project:<id>:*` keys hold per-project system prompt, permission mode, memory isolation.
- [[modes]] / [[persistent-memory]] — `global:systemPrompt`, `global:memoryEnabled` and related global toggles.
- [[hub-pages]] — extension Hub UI reads per-(user, extension) settings via `resolveExtensionSettings`.

## Related docs

None yet — this is the primary reference. (See [api-security](./api-security.md) for the auth gates, [developer-api-keys](./developer-api-keys.md) for the `/api/settings/developer` surface, and [context-compaction](../../context-compaction.md) for the `compaction:strategy` key.)

## Notes & gotchas

- **Encryption lives at the consumer, not the KV layer.** `upsertSetting`/`getSetting` store and return raw JSONB. Sensitive keys are encrypted by their owning module (`src/auth/jwt.ts`, `src/providers/credentials.ts`) before write. Storing a secret via the generic API would persist it in *plaintext* — which is exactly why those keys are deny-listed from the generic API.
- **Deny-list ≠ encryption boundary.** The deny-list blocks `instance:jwtSecret`, `provider:apiKey:*`, `provider:oauth:*` from the generic CRUD/list endpoints. Other secret-ish keys (e.g. `publish:token:<userId>`) are not on this list — they live behind their own dedicated routes (`/api/settings/developer`) and are stored hashed/handled there, not protected by the deny-list.
- **Admin-only, instance-wide.** The generic settings API is `requireRole("admin")` for *all* methods — there is no per-user scoping in the generic table. Most keys are global to the instance; "per-user"/"per-project" scoping is encoded *in the key string* (`project:<id>:…`, `publish:token:<userId>`), not by a column. True per-user extension prefs use the separate `extension_settings_user` table.
- **`upsertSetting` is select-then-write, not a native upsert.** Two round-trips (and a TOCTOU window) — fine for low-contention config, not a hot path.
- **Legacy-hash redirects must keep working.** `resolveLegacyHash` maps old `/settings#<anchor>` deep links; do not remove anchors from `SETTINGS_NAV` items or you break historical bookmarks. Admin-only targets silently resolve to `/settings/models` for non-admins (single bounce, mirrors the server gate).
- **Nav search is client-side only.** `filterSettings` ranks the static registry in-browser; it never queries the backend and has no Svelte imports (kept pure for vitest). It is not a search over *setting values*, only over nav labels/ids/anchors.
- **`global:search:*` keys are dual-owned.** `web/src/lib/settings-search-config.ts` reads them for the admin Search page and writes them via `PUT /api/settings/[key]`, but the backend resolver (`src/search/policy.ts`) is the source of truth — the key names MUST stay in sync between the two.
- **Encryption IV-format compat.** New rows use the tagged `v1:` 12-byte-IV format; pre-sec-L4 rows are untagged 16-byte-IV and still decrypt. A `.pi-secret`/`.pi-salt` mismatch (e.g. wrong `EZCORP_SECRETS_DIR`) renders existing encrypted settings undecryptable — `instance:jwtSecret` falls back to treating the value as legacy plaintext and re-encrypting, but provider keys just fail to decrypt.
