# Providers & Models

> _The credential-and-catalog layer behind every chat: a layered credential resolver (OAuth / BYOK / env) with AES-256-GCM at rest and auto-refresh, a model registry that fuses pi-ai built-ins + live `/v1/models` discovery + user-custom endpoints, per-model attachment capabilities, and friendly connection-error translation — feeding the model picker, the runtime model resolver, and the admin provider settings._

## Intent

EZCorp talks to OpenAI, Anthropic, Google, and arbitrary OpenAI-compatible / Ollama endpoints through one normalization layer so the rest of the app never touches raw provider SDKs. This feature owns: **how a credential is found and decrypted** (`src/providers/credentials.ts`), **what models exist and what they can do** (`src/providers/registry.ts`, `model-discovery.ts`, `model-capabilities.ts`), **which provider+model a run actually resolves to** (`src/providers/router.ts`), and **how provider failures are surfaced** (`src/providers/provider-error.ts`, `circuit-breaker.ts`). It exists to keep credentials encrypted-at-rest, to let OAuth-login users chat without an API key, and to give users a single picker over a heterogeneous model fleet.

## How it works

### Credential resolution (`src/providers/credentials.ts`)

`getCredential(provider, conversationId?)` walks a fixed precedence and returns `{ type: "oauth" | "apikey", token, refreshed? }`:

1. **Mock provider short-circuit** — `provider === MOCK_PROVIDER` only when `isTestSurfaceEnabled()` (remote-test harness); returns a sentinel `no-key-needed` token. Gated so it never resolves in prod.
2. **Per-conversation override** — `getSetting('conversation:<id>:accessMode:<provider>')` of `"apikey"` / `"oauth"` forces that path.
3. **User-level preference** — `getSetting('provider:accessMode:<provider>')`, same two values.
4. **Default chain** — try DB OAuth → BYOK → env var. (Anthropic skips the DB-OAuth step: it is BYOK-only — there is no pi-managed Anthropic OAuth flow here.)
5. **Local fallback** — if no credential resolves but a `provider:customModels` entry has a `baseUrl` for this provider, return `no-key-needed` (local endpoints need no key).

OAuth tokens are stored encrypted under `provider:oauth:<provider>` in the pi-ai `OAuthCredentials` shape (`{ access, refresh, expires, … }`). `getOAuthCredential` decrypts, and:

- For **Google**, if `projectId` is missing it is discovered via the Cloud Code Assist API (`cloudcode-pa.googleapis.com`) and persisted back.
- **Auto-refresh** — if `expires < now + 60s`, it refreshes via pi-ai's `getOAuthApiKey(oauthProviderId, …)`, guarded by an in-memory `refreshLocks` `Map` keyed by provider so concurrent runs don't double-refresh. Refreshed credentials are re-encrypted and upserted. Provider→OAuth-id mapping: `openai → openai-codex`, `google → google-gemini-cli`, `anthropic → anthropic` (`OAUTH_PROVIDER_IDS`).

`getApiKey(provider)` (the BYOK path, marked `@deprecated` in favor of `getCredential`) reads `provider:apiKey:<provider>` and decrypts, then falls back to pi-ai's `getEnvApiKey` (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY`).

### Encryption at rest (`src/providers/encryption.ts`)

All stored secrets (API keys, OAuth blobs) round-trip through `encrypt`/`decrypt`:

- **AES-256-GCM**, key = `scryptSync(secret, salt, 32)`.
- New ciphertexts use the tagged **`v1:<iv>:<tag>:<ciphertext>`** format with a **12-byte IV** (NIST-recommended). Legacy untagged `<iv>:<tag>:<ciphertext>` with a **16-byte IV** still decrypts for backward compatibility.
- The secret comes from `EZCORP_ENCRYPTION_SECRET`, else an auto-generated `.pi-secret` file; the salt from `EZCORP_ENCRYPTION_SALT`, else a `.pi-salt` file (or the legacy hardcoded `"pi-salt"` if a secret already exists without a salt). Both live in `getSecretsDir()` — the dir containing `EZCORP_DB_PATH` (so in Docker they sit under the `/app/data` VOLUME and survive upgrades), overridable with `EZCORP_SECRETS_DIR`, else CWD. Key/salt are cached in-process.

### Model registry (`src/providers/registry.ts`)

`getModelRegistry()` returns a flat `ModelEntry[]` (the `/api/models` payload shape) by concatenating three sources:

1. **pi-ai built-ins** — `getProviders()` × `getModels(provider)`.
2. **Live-discovered models** — `provider:discoveredModels:<provider>` settings (written by refresh-models), with any id already known to pi-ai filtered out to avoid duplicates.
3. **User custom models** — `provider:customModels` settings (normalized; default `provider: "ollama"`, `contextWindow: 128_000`, carries a `baseUrl`).

`inferTier()` derives a display **tier** (`fast`/`balanced`/`powerful`) and **costTier** (`low`/`medium`/`high`) from real pricing (`model.cost.input + output`, blended USD/1M) with name-heuristic fallbacks (`mini|nano|flash|lite|haiku` → low/fast; `opus|pro|codex-max|o[1-9]` → high/powerful). `resolveModelObject(provider, modelId, baseUrl?)` is the runtime resolver: pi-ai `getModel` → `resolveOAuthModel` (so `gpt-5.5` under the public `openai` id resolves to the `openai-codex` override with correct `input`/`reasoning`) → a synthesized `openai-completions` custom model (baseUrl coerced to end in `/v1`). `LOCAL_OAUTH_OVERRIDES` hardcodes OAuth-only models (e.g. `gpt-5.5`) that an OAuth token can't enumerate via `/v1/models`.

### Live model discovery (`src/providers/model-discovery.ts`)

`fetchProviderModels(provider, credential?)` is hybrid:

- **Direct** — for `openai`/`anthropic` (the `DIRECT_PROVIDERS` whose `/v1/models` is OpenAI-shaped), pull the authoritative, key-scoped id list via the shared `listModels()` helper with the provider auth header attached, then enrich each id with **models.dev** catalog metadata (pricing, context window, modalities, reasoning).
- **Catalog fallback** — the public `https://models.dev/api.json` catalog (unauth'd, 5-min in-memory cache) is used alone when there's no usable credential, when the direct call fails, or for **Google** (different API shape — catalog-only by design).
- A chat-capability filter (`isExcludedById`) drops ids matching `embedding|whisper|tts|moderation|dall-e|image-gen|audio-preview`; on the catalog path it additionally requires the model to emit a `text` output modality.

### Attachment capabilities (`src/providers/model-capabilities.ts`)

`getCapabilities(provider, modelId)` builds an `AttachmentCapabilities` (`kinds`, `acceptedMimeTypes`, `maxBytesPerFile`, `maxFilesPerMessage`, `deliveryFor`):

- Every model accepts **text** (inlined) and **pdf** (delivered via text-extraction — pi-ai has no native PDF content type). **image** is added iff `model.input.includes("image")`. **audio** only when an `OVERRIDES` row sets `audioNative` (none currently do — audio is Phase 2 / not wired).
- A static `OVERRIDES` table tweaks per-provider limits (Anthropic 32 MB, Google 20 MB, OpenAI vision-PDF models).
- `getCapabilitiesWithExtensions(provider, modelId, extensionMimes)` unions in MIMEs contributed by wired extensions, routing them through the `extension-handle-only` delivery strategy. Base MIMEs always win over extension-supplied ones.

### Routing & resilience (`src/providers/router.ts`, `circuit-breaker.ts`, `provider-error.ts`)

`resolveModel(provider?, modelId?, requestedTier?, credentialScope?)` is the three-level resolver every chat path calls:

1. **Explicit provider + model** → passthrough (mock-provider gate; else discovered model → custom-model baseUrl → `resolveModelObject`). Pins are never re-routed; tier is ignored here.
2. **Provider only** → best model in the requested tier (else `provider:defaultTier`, default `balanced`), else first model.
3. **Neither** → iterate `provider:preferenceOrder` (default `[anthropic, openai, google, openrouter]`; stored orders self-heal via `mergePreferenceOrder`), **skipping providers whose circuit breaker `isOpen()`**, picking the first tier-matching model.

The `requestedTier` comes from the heuristic quality-tier classifier (`src/runtime/tier-classifier.ts`) — it fires only when a thread has **no** established model, routing once at thread start (see [LLM routing & failover](../../llm-routing-and-failover.md)).

`suggestFallback(failedProvider, tier, credentialScope?)` returns the next healthy provider's tier-peer model. The `CircuitBreaker` is a standard closed/open/half-open machine (3 failures → open, 60 s reset), keyed per `(provider, scope)` — the scope is the conversation owner's user id in prod, so one user's rate-limit failures never open the breaker for other users; context-free callers share the `"shared"` scope. `friendlyProviderError(err, { provider, model, baseUrl })` detects connection-class failures (by message pattern, since `.code`/`.name` are lost across the executor's error rethrow) and rewrites Bun's cryptic `"typo in the url or port?"` text into an actionable "Couldn't reach the `<provider>` endpoint at `<baseUrl>`…" message; it's invoked in `src/runtime/stream-chat/finalize.ts`.

## Usage

### REST API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/models` | scope `read` | Full registry (built-ins + discovered + custom), each tagged `available` (creds present, or local `baseUrl`). OAuth providers are filtered to their OAuth-variant ids + any refreshed-in models. |
| `GET /api/models/capabilities?provider=&model=&conversationId=&extensions=` | scope `read` | Per-model attachment caps (`kinds`, `acceptedMimeTypes`, `maxBytesPerFile`, `maxFilesPerMessage`); unions conversation-wired + pending `!ext:` MIMEs. Delivery-strategy enum is **not** leaked. |
| `GET /api/providers` | scope `read` | Per-provider status: `hasKey`, `source` (`byok`/`env`/`none`), `oauthConnected`/`oauthExpired`/`oauthSupported`, `expiresAt`. |
| `POST /api/providers` | **admin role** | Upsert an encrypted BYOK key (`{ provider, apiKey }`). Audited (`provider:key_upsert`). |
| `DELETE /api/providers` | **admin role** | Delete a BYOK key (`{ provider }`). Audited (`provider:key_delete`). |
| `POST /api/providers/[provider]/test` | **admin** | Live one-token `complete()` against the provider's fast-tier model. |
| `POST /api/providers/[provider]/refresh-models` | **admin** | Run discovery and persist to `provider:discoveredModels:<provider>`. |
| `POST /api/providers/local/test` | **admin** | SSRF-guarded reachability + availability + inference probe of a local/custom `baseUrl` + `modelId`. |
| `POST /api/providers/local/models` | **admin** | SSRF-guarded model list (`/v1/models` or Ollama `/api/tags`) for a `baseUrl`. |
| `GET /api/auth/oauth` | authed | Start an OAuth login (PKCE S256, state + verifier stored server-side under `oauth:pending:<state>`) for `openai`/`google`. |
| `POST / DELETE /api/auth/oauth/callback` | authed | Exchange the code (POST) / disconnect (DELETE) — these methods live on the **`callback`** route, not on `/api/auth/oauth`. |

### UI entry points

- **Settings → Models** (`web/src/routes/(app)/settings/models/+page.svelte`): `ProvidersSection.svelte` (BYOK keys, OAuth connect, test, refresh-models) + `CustomModelsSection.svelte` (add a local/OpenAI-compatible model; writes `provider:customModels`; "Test connection" / "List models" hit the SSRF-guarded local routes).
- **Model picker** in the composer — `ModelSelector.svelte` (imported by `web/src/lib/components/ChatInput.svelte`) fetches `/api/models` and filters by `available`. (`ModelSearchPicker.svelte` is a separate searchable picker used by agent/team/briefing forms, **not** the composer.)
- **Last-model persistence** — `web/src/lib/last-model.ts`: `restoreLastModel` / `persistLastModel` keep the pick in `localStorage` under `ezcorp-last-model`. The DB conversation row is only a per-conversation override.

### Settings keys & env vars

- Settings: `provider:apiKey:<p>`, `provider:oauth:<p>`, `provider:accessMode:<p>`, `conversation:<id>:accessMode:<p>`, `provider:discoveredModels:<p>`, `provider:customModels`, `provider:defaultTier`, `provider:preferenceOrder`, `oauth:pending:<state>`.
- Env: `EZCORP_ENCRYPTION_SECRET`, `EZCORP_ENCRYPTION_SALT`, `EZCORP_SECRETS_DIR`, `EZCORP_DB_PATH`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`.

## Key files

- `src/providers/credentials.ts` — `getCredential` precedence chain, OAuth auto-refresh + refresh-lock, Google project discovery, BYOK/env fallback.
- `src/providers/encryption.ts` — AES-256-GCM `encrypt`/`decrypt`; v1 (12-byte IV) + legacy (16-byte IV) formats; secret/salt sourcing.
- `src/providers/registry.ts` — `getModelRegistry`, `resolveModelObject`, `resolveOAuthModel`, `inferTier`, custom + discovered + OAuth-override merge.
- `src/providers/model-discovery.ts` — `fetchProviderModels` (direct `/v1/models` + models.dev catalog enrichment/fallback).
- `src/providers/model-capabilities.ts` — per-model attachment caps + extension-MIME union; `classifyMime`, `getCapabilitiesWithExtensions`.
- `src/providers/router.ts` — `resolveModel` (3-level, tier-aware), `suggestFallback`, `ProviderUnavailableError`, `mergePreferenceOrder`.
- `src/providers/circuit-breaker.ts` — closed/open/half-open breaker keyed per `(provider, scope)` (per-user in prod); bounded map.
- `src/providers/provider-error.ts` — `isProviderConnectionError` / `friendlyProviderError` translation.
- `src/providers/local-model-check.ts` — pure fetch-based local endpoint reachability / availability / inference + `listModels` (shared by discovery).
- `web/src/routes/api/models/+server.ts` — `GET /api/models`; availability + OAuth-variant model filtering.
- `web/src/routes/api/models/capabilities/+server.ts` — `GET /api/models/capabilities`.
- `web/src/routes/api/providers/+server.ts` — status (GET) + admin BYOK upsert/delete (POST/DELETE), audited.
- `web/src/routes/api/providers/[provider]/test/+server.ts` — admin live credential test.
- `web/src/routes/api/providers/[provider]/refresh-models/+server.ts` — admin model discovery → settings.
- `web/src/routes/api/providers/local/test/+server.ts`, `…/local/models/+server.ts` — admin SSRF-guarded local probes.
- `web/src/routes/api/auth/oauth/+server.ts`, `…/oauth/callback/+server.ts` — PKCE OAuth start + code exchange (state stored server-side).
- `web/src/lib/last-model.ts` — `localStorage` last-model store.
- `web/src/lib/components/settings/ProvidersSection.svelte`, `CustomModelsSection.svelte` — admin provider/model settings UI.

## Features it touches

- [[attachments]] — per-model `AttachmentCapabilities` (size, MIME, delivery strategy) gate every uploaded file; `/api/models/capabilities` drives the picker.
- [[streaming-runtime]] — `resolveModel` + `getCredential` are called per run to construct the pi-ai client; `finalize` applies `friendlyProviderError`.
- [[runs-lifecycle]] — a run records `provider`/`model`; `ProviderUnavailableError` becomes a structured `provider_unavailable` error payload.
- [[conversations]] — each conversation carries `provider`/`model`; `/model` switching and per-conversation `accessMode` overrides live here.
- [[context-compaction]] — `model.contextWindow` (from registry/discovery) sizes the per-model trim budget.
- [[settings-system]] — every provider/model fact is a `getSetting`/`upsertSetting` key.
- [[admin-surfaces]] — BYOK key writes, live tests, refresh-models, and local probes are all admin-gated.
- [[audit-and-observability]] — BYOK key upsert/delete write audit-log entries.
- [[api-security]] — admin routes gate on `requireRole`/`requireAdmin` (not the cookie-no-op `requireScope("admin")`); local probes are SSRF-guarded.
- [[mcp-servers]] — MCP tool models also resolve through `resolveModel`/`getCredential` (see `src/extensions/llm-handler.ts`).

## Related docs

- [LLM routing & failover](../../llm-routing-and-failover.md) — the operator view of tier routing, pre-stream failover, per-user breakers, and the OpenRouter alternative.
- (See [context-compaction](../../context-compaction.md) for how a model's `contextWindow` becomes the input budget.)

## Notes & gotchas

- **Failover is live — pre-stream only.** `runWithFailover` (`src/runtime/stream-chat/failover.ts`, wired into `executor.streamChat`) feeds the breaker in prod (`recordFailure` on provider-availability failures, `recordSuccess` on clean turns) and throws `ProviderUnavailableError` when no usable fallback exists (single-provider BYOK, all breakers open) — `finalize.ts` renders it as a structured `provider_unavailable` payload. Failures **before the first streamed token** get one same-provider retry (jittered backoff), then a cross-provider tier-peer fallback; once anything has streamed to the client the error is rendered as-is (mid-stream failover is a documented follow-up). Non-availability errors (400/401/403, content filter, tool bugs) still surface via `friendlyProviderError`, unretried. See [LLM routing & failover](../../llm-routing-and-failover.md).
- **Admin gating is role-based, not scope-based.** The provider mutation/test/local-probe routes use `requireRole(locals, "admin")` / `requireAdmin`. The earlier `requireScope(locals, "admin")` was a **no-op for cookie sessions** (allow-all for non-API-key principals) — pre-fix any authenticated member could overwrite the org's API key (billing redirect, sec-C5) or drive arbitrary server-side `fetch` (SSRF, sec-H1). Don't reintroduce scope-only checks here.
- **SSRF guard covers the *probe* routes only, not custom-model *save*.** `local/test` and `local/models` validate `baseUrl` (scheme allow-list + `isPrivateOrLoopback` + DNS-pinned `resolveAndValidateHostname`). But `CustomModelsSection` persists `provider:customModels` through the generic `upsertSetting`/`/api/settings` path with **no** SSRF re-check — a saved-then-used local `baseUrl` is only as safe as whatever validated it at probe time. The probe and the persisted endpoint are decoupled.
- **OAuth providers see a filtered model list.** When a provider resolves an `oauth` credential, `/api/models` shows only the OAuth-variant's ids (`openai → openai-codex`, `google → google-gemini-cli`) plus any models explicitly pulled in via refresh-models — because the standard `/v1/models` endpoint can't be called with an OAuth token. `LOCAL_OAUTH_OVERRIDES` backfills OAuth-only models (e.g. `gpt-5.5`).
- **`getApiKey` is deprecated but live.** It is still the BYOK resolver inside `getApiKeyCredential`; prefer `getCredential` for new callers (it also handles OAuth + conversation overrides).
- **Encryption secret lives next to the DB by default.** With `EZCORP_DB_PATH` set, `.pi-secret`/`.pi-salt` land in the DB dir (under the Docker `/app/data` VOLUME). **Production best practice: set `EZCORP_ENCRYPTION_SECRET` explicitly** — the auto-generated file is a dev/first-run convenience. Rotating the secret/salt makes existing ciphertexts undecryptable.
- **models.dev is a third-party dependency.** Discovery enrichment and Google's model list depend on `https://models.dev/api.json` (and direct discovery on `api.openai.com`/`api.anthropic.com`). All have timeouts and a catalog-vs-direct fallback, but an offline server falls back to pi-ai built-ins only.
- **PDF is always text-extracted; audio is unwired.** Even "PDF-native" providers (Anthropic, Gemini) are delivered extracted text because pi-ai carries no PDF content part. No model currently sets `audioNative`, so audio uploads are rejected everywhere.
