# Providers & Models

> _The credential-and-catalog layer behind every chat: a layered credential resolver (OAuth / BYOK / env) with AES-256-GCM at rest and auto-refresh, a model registry that fuses pi-ai built-ins + live `/v1/models` discovery + user-custom endpoints, per-model attachment capabilities, and friendly connection-error translation — feeding the model picker, the runtime model resolver, and the admin provider settings._

## Intent

EZCorp talks to OpenAI, Anthropic, Google, OpenRouter, the Kilo AI Gateway, and arbitrary OpenAI-compatible / Ollama endpoints through one normalization layer so the rest of the app never touches raw provider SDKs. This feature owns: **how a credential is found and decrypted** (`src/providers/credentials.ts`), **what models exist and what they can do** (`src/providers/registry.ts`, `model-discovery.ts`, `model-capabilities.ts`), **which provider+model a run actually resolves to** (`src/providers/router.ts`), and **how provider failures are surfaced** (`src/providers/provider-error.ts`, `circuit-breaker.ts`). It exists to keep credentials encrypted-at-rest, to let OAuth-login users chat without an API key, and to give users a single picker over a heterogeneous model fleet.

## How it works

### Credential resolution (`src/providers/credentials.ts`)

`getCredential(provider, conversationId?)` walks a fixed precedence and returns `{ type: "oauth" | "apikey", token, refreshed? }`:

1. **Mock provider short-circuit** — `provider === MOCK_PROVIDER` only when `isTestSurfaceEnabled()` (remote-test harness); returns a sentinel `no-key-needed` token. Gated so it never resolves in prod.
2. **Per-conversation override** — `getSetting('conversation:<id>:accessMode:<provider>')` of `"apikey"` / `"oauth"` forces that path.
3. **User-level preference** — `getSetting('provider:accessMode:<provider>')`, same two values.
4. **Default chain** — try DB OAuth → BYOK → env var. (Anthropic skips the DB-OAuth step: it is BYOK-only — there is no pi-managed Anthropic OAuth flow here.)
5. **Keyless free tier** — if no credential resolves and the provider declares `keylessFreeTier` (Kilo alone today), return `no-key-needed`. Measured: Kilo's gateway answers a free model with no credential at all (HTTP 200, `cost: "0"`) and refuses a paid one with `401 PAID_MODEL_AUTH_REQUIRED`. The sentinel is **not** what restricts the deployment to free models — the catalog filter below is.
6. **Local fallback** — if no credential resolves but a `provider:customModels` entry has a `baseUrl` for this provider, return `no-key-needed` (local endpoints need no key).

OAuth tokens are stored encrypted under `provider:oauth:<provider>` in the pi-ai `OAuthCredentials` shape (`{ access, refresh, expires, … }`). `getOAuthCredential` decrypts, and:

- For **Google**, if `projectId` is missing it is discovered via the Cloud Code Assist API (`cloudcode-pa.googleapis.com`) and persisted back.
- **Auto-refresh** — if `expires < now + 60s`, refresh + key derivation run through `Models.getAuth(oauthProviderId, { minOAuthValidityMs: 60_000 })` over `SettingsCredentialStore` (`src/providers/credential-store.ts`), a pi-ai `CredentialStore` backed by the same encrypted `settings` rows. pi performs the token exchange **inside** `store.modify()`, so read → check-expiry → refresh → write is one serialized critical section per provider: a caller that queued behind another turn's refresh re-checks expiry under the lock and declines to exchange a second time. Provider→OAuth-id mapping: `openai → openai-codex`, `google → google-gemini-cli`, `anthropic → anthropic` (`OAUTH_PROVIDER_IDS`).
- **Every write on the refresh path goes through that store**, including the Google `projectId` backfill, so a refresh cannot interleave with another write to the same row. (Initial connect still writes the row directly from the OAuth callback route.) The lock is **in-process only** — the same constraint `withConvSessionLock` documents in `src/db/session-sync.ts`.
- **`google-gemini-cli` is not a provider pi-ai registers** (it never has been), so `getAuth` returns `undefined` for Google and `getOAuthCredential` throws, falling through to BYOK → env exactly as it always did.
- **"Connected but broken" is no longer flattened into "not configured."** A genuine refresh failure surfaces as pi's `ModelsError { code: "oauth" }`; `isBrokenOAuth` (shape-checked, never message-matched) separates it from "never connected", and if the whole ladder then fails, the thrown error names the cause and tells the user to sign in again rather than to add an API key.
- **BYOK-only providers** (`anthropic`, `openrouter`, `kilo`) skip the DB-OAuth step in the default chain. Both carry `auth.oauth` in pi-ai's catalog as of 0.83.0, but nothing in EZCorp ever *writes* `provider:oauth:anthropic` (the OAuth callback route accepts `openai` and `google` only), so the stored-credential precondition still stops it. Anthropic subscription auth is a feature, not a side effect of the catalog gaining the field.

`getApiKey(provider)` (the BYOK path, marked `@deprecated` in favor of `getCredential`) reads `provider:apiKey:<provider>` and decrypts, then falls back to pi-ai's `getEnvApiKey` (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY`), and finally to this repo's own provider table for env vars pi-ai does not know (`KILO_API_KEY` — kilo is not a pi-ai provider, so without this the var was silently ignored and a configured deployment still ran free-only).

### Encryption at rest (`src/providers/encryption.ts`)

All stored secrets (API keys, OAuth blobs) round-trip through `encrypt`/`decrypt`:

- **AES-256-GCM**, key = `scryptSync(secret, salt, 32)`.
- New ciphertexts use the tagged **`v1:<iv>:<tag>:<ciphertext>`** format with a **12-byte IV** (NIST-recommended). Legacy untagged `<iv>:<tag>:<ciphertext>` with a **16-byte IV** still decrypts for backward compatibility.
- The secret comes from `EZCORP_ENCRYPTION_SECRET`, else an auto-generated `.pi-secret` file; the salt from `EZCORP_ENCRYPTION_SALT`, else a `.pi-salt` file (or the legacy hardcoded `"pi-salt"` if a secret already exists without a salt). Both live in `getSecretsDir()` — the dir containing `EZCORP_DB_PATH` (so in Docker they sit under the `/app/data` VOLUME and survive upgrades), overridable with `EZCORP_SECRETS_DIR`, else CWD. Key/salt are cached in-process.

### Model registry (`src/providers/registry.ts`)

`getModelRegistry()` returns a flat `ModelEntry[]` (the `/api/models` payload shape) by concatenating three sources:

1. **pi-ai built-ins** — `getProviders()` × `getModels(provider)`.
2. **Live-discovered models** — `provider:discoveredModels:<provider>` settings (written by refresh-models), with any id already known to pi-ai filtered out to avoid duplicates.
3. **Kilo's catalog** — the built-in `kilo-auto/*` seed merged with anything `refresh-models` cached, then **filtered to what this deployment may call** (free-only until a Kilo key is saved). See _The Kilo AI Gateway_ below.
4. **User custom models** — `provider:customModels` settings, normalized by `parseCustomModelEntries` (`src/runtime/routing/custom-models.ts`; defaults `provider: "ollama"`, `tier: "balanced"`, `contextWindow: 128_000`, carries a `baseUrl`). That normalizer is shared with tier **routing** — the picker and the router read the same function, so a row cannot display in one tier and route in another.

`inferTier()` derives a display **tier** (`fast`/`balanced`/`powerful`) and **costTier** (`low`/`medium`/`high`) from real pricing (`model.cost.input + output`, blended USD/1M) with name-heuristic fallbacks (`mini|nano|flash|lite|haiku` → low/fast; `opus|pro|codex-max|o[1-9]` → high/powerful). It applies to **catalog** models only: a custom row's tier is the one the operator picked in the add-model form, never inferred from the model name (a local id like `qwen3:1.7b` or `my-finetune` carries no such signal). `resolveModelObject(provider, modelId, baseUrl?)` is the runtime resolver: pi-ai `getModel` → `resolveOAuthModel` (so `gpt-5.5` under the public `openai` id resolves to the `openai-codex` override with correct `input`/`reasoning`) → a synthesized `openai-completions` custom model (baseUrl coerced to end in `/v1`). `LOCAL_OAUTH_OVERRIDES` hardcodes OAuth-only models (e.g. `gpt-5.5`) that an OAuth token can't enumerate via `/v1/models`.

When an explicit `baseUrl` is supplied, the synthesized model also carries `compat: { maxTokensField: "max_tokens" }` — pi-ai's own documented per-model override. pi-ai's `detectCompat` otherwise sends the output cap as `max_completion_tokens` for any baseUrl outside its short known-gateway list, and Ollama / llama.cpp / vLLM / LM Studio **ignore** that field, so a declared `maxTokens` was silently unenforced against every custom model. The `https://api.openai.com/v1` fallback (no baseUrl given) deliberately keeps pi-ai's detection, because OpenAI's newer models reject `max_tokens`.

### Live model discovery (`src/providers/model-discovery.ts`)

`fetchProviderModels(provider, credential?)` is hybrid:

- **Direct** — for `openai`/`anthropic` (the `DIRECT_PROVIDERS` whose `/v1/models` is OpenAI-shaped), pull the authoritative, key-scoped id list via the shared `listModels()` helper with the provider auth header attached, then enrich each id with **models.dev** catalog metadata (pricing, context window, modalities, reasoning).
- **Catalog fallback** — the public `https://models.dev/api.json` catalog (unauth'd, 5-min in-memory cache) is used alone when there's no usable credential, when the direct call fails, or for **Google** (different API shape — catalog-only by design).
- A chat-capability filter (`isExcludedById`) drops ids matching `embedding|whisper|tts|moderation|dall-e|image-gen|audio-preview`; on the catalog path it additionally requires the model to emit a `text` output modality.

### The Kilo AI Gateway (`src/providers/kilo.ts`, `src/runtime/routing/kilo-catalog.ts`)

Kilo is an OpenAI-compatible gateway in front of ~350 models at
`https://api.kilo.ai/api/gateway` (pi-ai's client appends `/chat/completions`).
It is the only provider EZCorp ships that **answers with no credential
configured**, which is why it gets its own module rather than a row in
`model-discovery.ts`.

Everything below was measured against the live gateway, not read off a docs page:

| Probe | Result |
|---|---|
| `POST /chat/completions` for `kilo-auto/free`, **no auth header** | `200`, `cost: "0"` |
| Same for `anthropic/claude-sonnet-5`, no auth header | `401 PAID_MODEL_AUTH_REQUIRED` |
| Free model with an **unusable** bearer token | `200` — the gateway ignores a bad key on free models |
| `GET /api/gateway/models` | `200`, **unauthenticated**, 349 rows |
| `store`, `developer` role, strict tools, SSE + `include_usage` | all accepted |
| `max_tokens` **and** `max_completion_tokens` | both honoured |
| `reasoning_effort` **plus** `reasoning.effort` | **400 on 10 of 12 free models** |
| `reasoning: { effort }` alone (incl. `effort: "none"`) | 200 on all 12 |

**Kilo needs exactly one `compat` override, and it is not optional.** Kilo is an
*OpenRouter-compatible* gateway — its catalog advertises `reasoning` /
`include_reasoning` and never `reasoning_effort` — but pi-ai's `detectCompat`
recognises OpenRouter only by `provider === "openrouter"` or
`baseUrl.includes("openrouter.ai")`, neither of which matches Kilo. It therefore
took the OpenAI branch and sent `reasoning_effort`; Kilo normalises that into its
own `reasoning.effort` for the upstream and rejects the pair:

```
400 "reasoning_effort" and "reasoning.effort" are both provided with conflicting values
```

`KILO_COMPAT = { thinkingFormat: "openrouter" }` makes pi-ai emit only the nested
form. The branches in pi-ai's `buildParams` are mutually exclusive, so the
conflicting pair becomes *structurally impossible* from our side rather than
merely unlikely. It is applied to **both** model constructors
(`kiloModelToAnyModel` and `resolveKiloModel`'s stand-in) — a synthesized model
that dropped it would reproduce the bug for any unseeded id.

Nothing else is overridden: the `developer` role was probed across all 12 free
models and accepted, so it stays on pi-ai's detection rather than being
defensively disabled.

**Free vs paid is enforced by construction, not by a check.** `kiloModelsForAccess`
filters the catalog *before* it reaches the picker or the router, so a keyless
deployment has no paid Kilo model to show **or** to route to. Access is `"full"`
iff `provider:apiKey:kilo` or `KILO_API_KEY` is set. Free-ness comes from the
payload's explicit `isFree` flag, never from the id — `openrouter/free` is a free
model whose id has no `:free` suffix, and an id-shape rule would misclassify it.

**Why there is a built-in seed, and why it is not the whole story.** pi-ai has no
`kilo` provider, so `getModels("kilo")` is `[]` and a fresh install would show zero
Kilo models until an admin pressed "Refresh models" — a configuration step in front
of the one path that is supposed to need none. The seed is deliberately *only* the
five stable `kilo-auto/*` routers; Kilo rotates the free pool server-side, so
`kilo-auto/free` follows it without a release here, where a hardcoded
`vendor/model:free` list would go stale.

The seed alone means the picker lists **one** free model. `warmKiloCatalog()` fixes
that: at boot, once per `KILO_CATALOG_TTL_MS` (6 h), it fetches the unauthenticated
catalog and writes the same `provider:discoveredModels:kilo` row the admin button
writes. All 12 free models then list, tiered across fast/balanced/powerful. It is
fire-and-forget and deliberately **off the request path** — `getModelRegistry()`
runs on every `/api/models` call and must not make a network round trip — and it
never throws, so a gateway outage at boot costs the extra models rather than the
boot. The skip check requires a fresh timestamp *and* a non-empty row, so a failed
warm cannot pin a deployment to the seed for six hours.

**The persisted shape must round-trip.** `refresh-models` (and the warm) store
`kiloModelToAnyModel` output — `contextWindow` / `cost` / `input`, not the wire's
`context_length` / `pricing` / `architecture`. Reading that back with the wire
parser silently defaulted every field: measured on a real round-trip, a 1M-context
vision reasoning model returned as 128k, no vision, no reasoning, and
`openrouter/free` came back **paid**, hiding a genuinely free model from exactly
the deployments that need it. `normalizeKiloModel` now detects and handles both
shapes, and `kiloModelToAnyModel` carries the `free` flag (inert to pi-ai) so the
authoritative bit survives the write. Discovery still merges over the seed,
refreshing seeded ids in place and appending the rest.

**Two projections, and the difference matters.** `kiloPickerEntries()` yields one
row per model. `kiloRoutingEntries()` yields those *plus* `kilo-auto/free` repeated
into every tier nothing else covers. Routing asks a provider for a model **at a
specific tier** and moves on when there is none — so with only the seed, a keyless
install (one model, at `balanced`) had no answer for the `powerful` tier, which is
where the classifier sends every tool-using turn. `kilo-auto/free` is a server-side
router across the whole free pool, so it genuinely serves any tier asked of it;
repeating it is how a one-model-per-tier lookup expresses that. The picker never
sees the duplicates.

**Kilo routes last — behind local models too.** `getPreferenceOrder` demotes any
keyless-free provider to the very end, *after* the custom/local providers that are
themselves appended last. Without this, Kilo (which always authenticates) would
outrank the operator's own Ollama endpoint on every local-only install and quietly
start shipping prompts to a third party — and Kilo marks its free pool
`mayTrainOnYourPrompts`, so that is a privacy regression, not just a surprise. The
demotion applies **only** when Kilo was appended by the self-heal; an admin who
puts `kilo` in `provider:preferenceOrder` explicitly has made a choice and it
stands. The provider card discloses the logging caveat rather than burying it in
this file, because that is where the decision is made.

Kilo models reach tier routing through the **same overlay channel as custom
models** (`getRoutableOverlayModels`), because it is the same problem: `getModels(p)`
is `[]` for both `ollama` and `kilo`, and `findModelForProviderInTier` already
accepts an explicit model list for exactly that reason. Custom models come first in
the overlay — an operator's own registered model outranks a third-party gateway's.

### Attachment capabilities (`src/providers/model-capabilities.ts`)

`getCapabilities(provider, modelId)` builds an `AttachmentCapabilities` (`kinds`, `acceptedMimeTypes`, `maxBytesPerFile`, `maxFilesPerMessage`, `deliveryFor`):

- Every model accepts **text** (inlined) and **pdf** (delivered via text-extraction — pi-ai has no native PDF content type). **image** is added iff `model.input.includes("image")`. **audio** only when an `OVERRIDES` row sets `audioNative` (none currently do — audio is Phase 2 / not wired).
- A static `OVERRIDES` table tweaks per-provider limits (Anthropic 32 MB, Google 20 MB, OpenAI vision-PDF models).
- `getCapabilitiesWithExtensions(provider, modelId, extensionMimes)` unions in MIMEs contributed by wired extensions, routing them through the `extension-handle-only` delivery strategy. Base MIMEs always win over extension-supplied ones.

### Routing & resilience (`src/providers/router.ts`, `circuit-breaker.ts`, `provider-error.ts`)

`resolveModel(provider?, modelId?, requestedTier?, credentialScope?)` is the three-level resolver every chat path calls:

1. **Explicit provider + model** → passthrough (mock-provider gate; else discovered model → custom-model baseUrl → `resolveModelObject`). Pins are never re-routed; tier is ignored here.
2. **Provider only** → best model in the requested tier (else `provider:defaultTier`, default `balanced`), else first model.
3. **Neither** → iterate `provider:preferenceOrder` (default `[anthropic, openai, google, openrouter, kilo]`; stored orders self-heal via `mergePreferenceOrder`, **providers that have custom models are appended last** so a local-only install is reachable at all, and a **keyless-free provider is demoted behind even those** unless the operator ordered it explicitly — see below), **skipping providers whose circuit breaker `isOpen()`**, picking the first tier-matching model.

Levels 2 and 3 both consult custom models. `findModelForProviderInTier(provider, tier, ladder?, customModels?)` resolves in a fixed order — configured ladder over the catalog, built-in ladder over the catalog (openrouter only), configured ladder over custom models, catalog tier scan, then the custom tier scan **last**. Custom models therefore never displace or shadow a built-in, and a deployment with none routes exactly as it did before. Without this a local provider was unroutable outright: `getModels("ollama")` is `[]` (ollama is not a pi-ai provider), so every tier lookup returned `null` — and since a workflow `agent` step carries the `__current__` inherit sentinel that `resolveModel` collapses to "no pin", **every** workflow agent step is tier-routed.

The `requestedTier` comes from the heuristic quality-tier classifier (`src/runtime/tier-classifier.ts`) — it fires only when a thread has **no** established model, routing once at thread start (see [LLM routing & failover](../../llm-routing-and-failover.md)).

### What feeds `resolveModel` (`src/runtime/routing/`)

The resolver above is the bottom of the stack. Four pure modules sit on top of it; the deep spec is [LLM routing & failover](../../llm-routing-and-failover.md) — this is the map.

- **Model binding** (`mode-binding.ts`) — `resolveTurnModelBinding` collapses the precedence chain *above* the classifier: turn pin → caller provider → the mode's `preferredModel` → the mode's `preferredTier` → classifier. It reports which level decided as `source`. See [[modes]].
- **Tier ladder** (`tier-ladder.ts`) — settings key `provider:tierModels`, an **ordered** `{provider, model}` preference list per tier, so an operator says *which* model a tier actually gets instead of taking the registry's first match. `validateTierLadder` gates the write (a bad ladder is a 400); `parseTierLadder` is tolerant on read (a bad stored ladder is ignored, never thrown) — read and write live in one module so they cannot drift.
- **Custom models** (`custom-models.ts`) — settings key `provider:customModels`. `parseCustomModelEntries` is the tolerant read (a malformed row is skipped, never thrown on) and the single normalizer shared by the registry and the router. A custom model's tier is the operator's stored choice, never inferred; the router consults these entries only after the pi-ai catalog, so they cannot displace a built-in.
- **Default selection** (`default-selection.ts`) — settings key `provider:defaultSelection`, either `auto` (a fresh thread's first turn is routed) or `first` (pin the first available model, the pre-routing behaviour). This is the revert knob for routed-by-default traffic, which is why it is read back through the `read`-scoped `GET /api/models/default-selection` rather than the admin-only settings GET: an operator's revert must reach **every** user, not just admins.
- **Experiments** (`exploration.ts`, `shadow.ts`) — two independent, default-off knobs for measuring routing rather than guessing at it. `provider:explorationRate` (default `0`) is the probability a routed turn is deliberately served **one rung below** the classifier's tier, to gather unbiased counterfactual data — it trades a little answer quality for that data. `provider:routingShadow` names a candidate `{fastMaxTokens, powerfulMinTokens}` pair that is evaluated on every routed turn it *could* have moved and recorded into `usage.routingSignals.shadow`, but **never served**. Both validate on write and are treated as OFF on read.

Routing provenance is recorded per turn on the message `usage` blob (`routedTier`, `failover`, `routingSignals` in `src/db/schema.ts`) — the classifier's inputs *and* its verdict, so thresholds can be re-swept offline against real traffic. When `exploration` is true the classifier's `tier` is **not** the tier that served the turn (`routedTier` is); both are kept deliberately.

`suggestFallback(failedProvider, tier, credentialScope?)` returns the next healthy provider's tier-peer model. The `CircuitBreaker` is a standard closed/open/half-open machine (3 failures → open, 60 s reset), keyed per `(provider, scope)` — the scope is the conversation owner's user id in prod, so one user's rate-limit failures never open the breaker for other users; context-free callers share the `"shared"` scope. `friendlyProviderError(err, { provider, model, baseUrl })` detects connection-class failures (by message pattern, since `.code`/`.name` are lost across the executor's error rethrow) and rewrites Bun's cryptic `"typo in the url or port?"` text into an actionable "Couldn't reach the `<provider>` endpoint at `<baseUrl>`…" message; it's invoked in `src/runtime/stream-chat/finalize.ts`.

## Usage

### REST API

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/models` | scope `read` | Full registry (built-ins + discovered + custom), each tagged `available` (creds present, or local `baseUrl`). OAuth providers are filtered to their OAuth-variant ids + any refreshed-in models. |
| `GET /api/models/capabilities?provider=&model=&conversationId=&extensions=` | scope `read` | Per-model attachment caps (`kinds`, `acceptedMimeTypes`, `maxBytesPerFile`, `maxFilesPerMessage`); unions conversation-wired + pending `!ext:` MIMEs. Delivery-strategy enum is **not** leaked. |
| `GET /api/models/default-selection` | scope `read` | Read `provider:defaultSelection` (`auto` / `first`). Deliberately **not** admin-only — an operator's revert must reach every user. |
| `GET /api/providers` | scope `read` | Per-provider status: `hasKey`, `source` (`byok`/`env`/`none`), `oauthConnected`/`oauthExpired`/`oauthSupported`, `expiresAt`. |
| `GET /api/admin/analytics/routing?days=<1–365>` | `admin` **scope + role** | Routing + cost analytics for the admin dashboard's Routing panel (`getRoutingStats`). Split out of `/api/admin/analytics` so the routing tab neither pays for nor is blocked by that route's nine sequential aggregations. `days` defaults to 30 and is clamped twice (here for payload sanity, again in the query layer for safety). |
| `POST /api/providers` | **admin role** | Upsert an encrypted BYOK key (`{ provider, apiKey }`). Audited (`provider:key_upsert`). |
| `DELETE /api/providers` | **admin role** | Delete a BYOK key (`{ provider }`). Audited (`provider:key_delete`). |
| `POST /api/providers/[provider]/test` | **admin** | Live one-token `complete()` against the provider's fast-tier model. |
| `POST /api/providers/[provider]/refresh-models` | **admin** | Run discovery and persist to `provider:discoveredModels:<provider>`. |
| `POST /api/providers/local/test` | **admin** | SSRF-guarded reachability + availability + inference probe of a local/custom `baseUrl` + `modelId`. Literal loopback is allowed (see the carve-out invariant); every other private/link-local target is still refused 400. |
| `POST /api/providers/local/models` | **admin** | SSRF-guarded model list (`/v1/models` or Ollama `/api/tags`) for a `baseUrl`. Same loopback carve-out. |
| `GET /api/auth/oauth` | authed | Start an OAuth login (PKCE S256, state + verifier stored server-side under `oauth:pending:<state>`) for `openai`/`google`. |
| `POST / DELETE /api/auth/oauth/callback` | authed | Exchange the code (POST) / disconnect (DELETE) — these methods live on the **`callback`** route, not on `/api/auth/oauth`. |

### UI entry points

- **Settings → Models** (`web/src/routes/(app)/settings/models/+page.svelte`) — **admin-only**, eight stacked sections in order: `ProvidersSection.svelte` (BYOK keys, OAuth connect, test, refresh-models), `DefaultSelectionSection.svelte` (New Chat Model Default — `auto` / `first`), `DefaultTierSection.svelte` (`provider:defaultTier`), `PreferenceOrderSection.svelte` (`provider:preferenceOrder`), `TierLadderSection.svelte` (the per-tier ordered model ladder), `RoutingExperimentsSection.svelte` (exploration rate — the box is a percentage and raising it requires acknowledging the quality cost — plus the shadow-threshold pair; clearing both boxes turns shadow off), `ToolResultCapSection.svelte` (stale tool-result cap — see [[context-compaction]]), and `CustomModelsSection.svelte` (add a local/OpenAI-compatible model; writes `provider:customModels`; "Test connection" / "List models" hit the SSRF-guarded local routes).
- **Admin dashboard → Routing** (`web/src/routes/(app)/admin/dashboard/+page.svelte`) — the routing + spend panel over `GET /api/admin/analytics/routing`.
- **Model picker** in the composer — `ModelSelector.svelte` (imported by `web/src/lib/components/ChatInput.svelte`) fetches `/api/models` and filters by `available`. (`ModelSearchPicker.svelte` is a separate searchable picker used by agent/team/briefing forms, **not** the composer.)
- **Last-model persistence** — `web/src/lib/last-model.ts`: `restoreLastModel` / `persistLastModel` keep the pick in `localStorage` under `ezcorp-last-model`. The DB conversation row is only a per-conversation override.

### Settings keys & env vars

- Settings: `provider:apiKey:<p>`, `provider:oauth:<p>`, `provider:accessMode:<p>`, `conversation:<id>:accessMode:<p>`, `provider:discoveredModels:<p>`, `provider:discoveredModelsAt:kilo`, `provider:customModels`, `provider:defaultTier`, `provider:preferenceOrder`, `oauth:pending:<state>`.
- Routing settings (all validated on write — an unrecognised value is a **400**, not a silent no-op — and read tolerantly): `provider:defaultSelection` (default `auto`), `provider:tierModels` (the tier ladder, unset by default), `provider:explorationRate` (default `0` = off), `provider:routingShadow` (unset = off). Full semantics in [LLM routing & failover](../../llm-routing-and-failover.md).
- Env: `EZCORP_ENCRYPTION_SECRET`, `EZCORP_ENCRYPTION_SALT`, `EZCORP_SECRETS_DIR`, `EZCORP_DB_PATH`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `KILO_API_KEY` (optional — Kilo's free models need no key), `GOOGLE_CLOUD_PROJECT`.

## Key files

- `src/providers/kilo.ts` — Kilo seed catalog, live `/api/gateway/models` fetch, `warmKiloCatalog` (boot warm), `KILO_COMPAT`, `resolveKiloModel`, the picker/routing projections, `hasKiloApiKey`.
- `src/runtime/routing/kilo-catalog.ts` — pure (100% gate): payload parse, USD-per-token → per-1M conversion, free/paid classification, access filter, tier fill.
- `src/runtime/routing/llm-providers.ts` — pure (100% gate): the ONE provider table (id, env key, OAuth support, BYOK-only, keyless-free) that the router, registry, credentials, health and all four provider API routes derive from.
- `src/providers/credentials.ts` — `getCredential` precedence chain, OAuth auto-refresh, Google project discovery, BYOK/env fallback, `OAuthUnusableError` vs "not configured".
- `src/providers/credential-store.ts` — `SettingsCredentialStore` (pi-ai `CredentialStore` over the encrypted `settings` table), `resolveOAuthAuth` (the `Models.getAuth` wrapper that replaced pi-ai's removed `getOAuthApiKey`), `isBrokenOAuth`, `MIN_OAUTH_VALIDITY_MS`. Per-provider serialization lives in `modify()`.
- `src/runtime/routing/dropped-models.ts` — pure catalog-gap decision (`isCatalogGap`, `findCatalogGaps`, `reportCatalogGapOnce`): names a pinned model id the installed pi-ai catalog no longer lists, before it silently degrades into a synthesized 128k/unpriced stand-in. `scripts/scan-catalog-gaps.ts` runs the same decision over the stored pins.
- `src/providers/encryption.ts` — AES-256-GCM `encrypt`/`decrypt`; v1 (12-byte IV) + legacy (16-byte IV) formats; secret/salt sourcing.
- `src/providers/registry.ts` — `getModelRegistry`, `resolveModelObject`, `resolveOAuthModel`, `inferTier`, custom + discovered + OAuth-override merge.
- `src/providers/model-discovery.ts` — `fetchProviderModels` (direct `/v1/models` + models.dev catalog enrichment/fallback).
- `src/providers/model-capabilities.ts` — per-model attachment caps + extension-MIME union; `classifyMime`, `getCapabilitiesWithExtensions`.
- `src/providers/router.ts` — `resolveModel` (3-level, tier-aware), `suggestFallback`, `ProviderUnavailableError`, `mergePreferenceOrder`.
- `src/runtime/routing/mode-binding.ts` — `resolveTurnModelBinding`: turn-pin → mode-model → mode-tier → classifier precedence, with a named `source`.
- `src/runtime/routing/tier-ladder.ts` — `validateTierLadder` (write gate), `parseTierLadder` (tolerant read), `resolveLadderEntry`, `ladderCandidates`, `DEFAULT_TIER_LADDER`.
- `src/runtime/routing/custom-models.ts` — `parseCustomModelEntries` (tolerant read of `provider:customModels`), `customModelsForProvider`, `providersWithCustomModels`. The ONE normalizer, shared by the registry (picker) and the tier lookup (router).
- `src/runtime/routing/default-selection.ts` — the `auto`/`first` modes plus `parseDefaultSelection` + `validateDefaultSelection` in one module so read and write cannot drift.
- `src/runtime/routing/exploration.ts`, `src/runtime/routing/shadow.ts` — bounded exploration and never-served shadow evaluation.
- `src/runtime/routing/auto-capabilities.ts`, `src/runtime/routing/labels.ts` — the Auto sentinel's capability set and the human-facing routing labels.
- `web/src/routes/api/models/default-selection/+server.ts` — `read`-scoped read of `provider:defaultSelection` so a revert reaches every user, not just admins.
- `web/src/routes/api/admin/analytics/routing/+server.ts` — routing + cost analytics; gated on the admin **scope and role**.
- `web/src/lib/tier-ladder-view.ts`, `web/src/lib/routing-experiments-view.ts` — pure view models behind the two settings sections.
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
- [[modes]] — a mode's `preferredProvider`/`preferredModel`/`preferredTier` feed `resolveTurnModelBinding`, the level directly above the tier classifier.

## Related docs

- [LLM routing & failover](../../llm-routing-and-failover.md) — the operator view of tier routing, pre-stream failover, per-user breakers, and the OpenRouter alternative.
- (See [context-compaction](../../context-compaction.md) for how a model's `contextWindow` becomes the input budget.)

## Notes & gotchas

- **Failover is live — pre-stream only.** `runWithFailover` (`src/runtime/stream-chat/failover.ts`, wired into `executor.streamChat`) feeds the breaker in prod (`recordFailure` on provider-availability failures, `recordSuccess` on clean turns) and throws `ProviderUnavailableError` when no usable fallback exists (single-provider BYOK, all breakers open) — `finalize.ts` renders it as a structured `provider_unavailable` payload. Failures **before the first streamed token** get one same-provider retry (jittered backoff), then a cross-provider tier-peer fallback; once anything has streamed to the client the error is rendered as-is (mid-stream failover is a documented follow-up). Non-availability errors (400/401/403, content filter, tool bugs) still surface via `friendlyProviderError`, unretried. See [LLM routing & failover](../../llm-routing-and-failover.md).
- **Admin gating is role-based, not scope-based.** The provider mutation/test/local-probe routes use `requireRole(locals, "admin")` / `requireAdmin`. The earlier `requireScope(locals, "admin")` was a **no-op for cookie sessions** (allow-all for non-API-key principals) — pre-fix any authenticated member could overwrite the org's API key (billing redirect, sec-C5) or drive arbitrary server-side `fetch` (SSRF, sec-H1). Don't reintroduce scope-only checks here.
- **SSRF guard covers the *probe* routes only, not custom-model *save*.** `local/test` and `local/models` validate `baseUrl` through the single shared `checkLocalProviderTarget` (scheme allow-list + `isPrivateOrLoopback` + DNS-pinned `resolveAndValidateHostname`). But `CustomModelsSection` persists `provider:customModels` through the generic `upsertSetting`/`/api/settings` path with **no** SSRF re-check — a saved-then-used local `baseUrl` is only as safe as whatever validated it at probe time. The probe and the persisted endpoint are decoupled.
- **The loopback carve-out is LITERAL-only, and only on those two routes.** Self-hosted local inference is supported, and the UI auto-fills `http://localhost:11434` — which the sec-H1 guard then refused, making a local Ollama unregisterable through the UI. `checkLocalProviderTarget` therefore accepts a *literal* loopback host (`localhost` / `ip6-localhost` / `ip6-loopback`, `127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/8`) and nothing else. Everything sec-H1 blocked is still blocked: `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (cloud metadata), `0.0.0.0/8`, `::`, `fc00::/7`, `fe80::/10`, and any hostname whose DNS record resolves into those — **including one resolving to `127.0.0.1`**, because a literal is never resolved and rebinding is a resolution-time attack. `isPrivateOrLoopback` itself is unchanged, so any other/future consumer of the guard keeps the full strict posture. `EZCORP_BLOCK_LOOPBACK_PROVIDERS=1` restores the pre-carve-out refusal for deployments where the app's host is not the admin's own box.
- **OAuth providers see a filtered model list.** When a provider resolves an `oauth` credential, `/api/models` shows only the OAuth-variant's ids (`openai → openai-codex`, `google → google-gemini-cli`) plus any models explicitly pulled in via refresh-models — because the standard `/v1/models` endpoint can't be called with an OAuth token. `LOCAL_OAUTH_OVERRIDES` backfills OAuth-only models (e.g. `gpt-5.5`).
- **`getApiKey` is deprecated but live.** It is still the BYOK resolver inside `getApiKeyCredential`; prefer `getCredential` for new callers (it also handles OAuth + conversation overrides).
- **Encryption secret lives next to the DB by default.** With `EZCORP_DB_PATH` set, `.pi-secret`/`.pi-salt` land in the DB dir (under the Docker `/app/data` VOLUME). **Production best practice: set `EZCORP_ENCRYPTION_SECRET` explicitly** — the auto-generated file is a dev/first-run convenience. Rotating the secret/salt makes existing ciphertexts undecryptable.
- **models.dev is a third-party dependency.** Discovery enrichment and Google's model list depend on `https://models.dev/api.json` (and direct discovery on `api.openai.com`/`api.anthropic.com`). All have timeouts and a catalog-vs-direct fallback, but an offline server falls back to pi-ai built-ins only.
- **PDF is always text-extracted; audio is unwired.** Even "PDF-native" providers (Anthropic, Gemini) are delivered extracted text because pi-ai carries no PDF content part. No model currently sets `audioNative`, so audio uploads are rejected everywhere.
