# Web Search

> _A shared, host-side web-search + URL-to-markdown reader capability, exposed to extensions and host code via `ctx.search`, with an SSRF egress guard, a provider chain (keyless by default, BYOK opt-in), a shared cache, and per-extension daily quota + policy._

## Intent

EZCorp ships web search that "just works" with zero setup: the bundled `web-search` extension gives the LLM two tools (`search-web`, `read-url`) and they resolve, fetch, and render results entirely **host-side**. Centralizing the provider chain (SearXNG / DuckDuckGo / BYOK) in `src/search/` means provider logic, credentials, and internal-host access exist **once** and never leak into extension subprocesses — extensions reach search through the `ezcorp/search` reverse-RPC, never by fetching a backend themselves. Because the host fetches user/agent-controllable URLs, every outbound request routes through an SSRF guard (private-IP / DNS-rebind / redirect pinning). The capability is governed by a 3-layer policy (provider allowlist, max-results clamp, daily quota) so an admin can throttle or disable it per-extension.

## How it works

The data path for a single `ctx.search.web` / `ctx.search.read` call:

1. **Extension SDK call.** The extension calls `ctx.search.web(query)` / `ctx.search.read(url)` (`packages/@ezcorp/sdk/src/runtime/search.ts`). The SDK issues an `ezcorp/search` JSON-RPC request over its channel; it never fetches a backend itself.
2. **Reverse-RPC dispatch.** `src/extensions/tool-executor.ts` routes `method === "ezcorp/search"` to `handlePiSearch(extensionId, req)`, which looks up the extension's granted permissions, derives the caller's identity host-side from the `ezCallId` provenance token (`resolveReverseRpcMeta` → `deriveHandlerContext`, never RPC meta — spoofing defense), and delegates to `src/extensions/search-handler.ts#handlePiSearch`.
3. **Grant + policy resolution.** The handler soft-fails `-32101` ("search disabled") if the `search` grant is **absent**. Otherwise it resolves the 3-layer effective policy via `src/search/policy.ts#resolveSearchPolicy`: **hard default (code) < instance default (`global:search:*` admin settings) < per-extension grant override** (field-level merge; `false` → denied, `"inherit"` → live instance defaults, `{…}` → only defined fields win).
4. **Quota.** `src/search/search-quota.ts#consumeSearchQuota` enforces a per-extension/calendar-day (UTC) call ceiling counted for **both** web and read. The in-process counter is authoritative live; an async upsert to `extension_search_calls_daily` makes it crash-resilient (`hydrateSearchQuota` seeds it on restart). Over quota → `-32103` + a `SDK_SEARCH_QUOTA_EXCEEDED` audit row.
5. **Provider selection.** `src/search/index.ts#performSearch` / `performRead` resolve providers via `src/search/providers.ts#resolveProviders`, driven by env. On the real handler path the env is first overlaid with persisted backend config by `src/search/backend-config.ts#resolveSearchBackendEnv` (UI-saved SearXNG URL + decrypted BYOK keys override same-named base env vars). Precedence: **Tavily > Brave > Exa > SerpAPI > keyed Jina > SearXNG (`SEARXNG_BASE_URL`, with a one-shot DuckDuckGo fallback) > keyless DuckDuckGo**. URL reading **always** uses Jina Reader (`r.jina.ai`, keyless).
6. **Policy provider gate.** Before any fetch or cache probe, the resolved provider's name is checked against `policy.providers`; a disallowed provider throws `ProviderNotAllowedError` (pre-network; soft-fails `-32101` + audits `provider-not-allowed`). The reader is always Jina and is not gated here (its egress is bounded by the SSRF guard).
7. **Cache.** `src/search/cache.ts` is a process-wide in-memory TTL+LRU (500 entries; 15-min search TTL, 60-min read TTL). The key embeds the **provider name** so a fallback provider's results never poison the primary's namespace; on a primary-namespace miss it also probes the fallback's namespace.
8. **SSRF-guarded fetch.** Every provider fetch routes through `src/search/egress.ts#guardedFetch` (injected as the transport via `makeGuardedTransport`). Two modes: `mode:"backend"` (configured hosts → allowlist by exact host, still IP-pinned) and `mode:"read"` (fully attacker-controlled → resolve all IPs, reject any private/loopback/link-local/metadata/CGNAT address, pin the connection to the validated IP, re-validate every redirect, cap redirects ≤3 / body 5 MiB / timeout 15 s, http(s)-only). Each block fires `onBlocked` → a `SDK_SEARCH_EGRESS_BLOCKED` audit row.
9. **Render + return.** `src/search/markdown.ts#formatResults` renders a markdown bullet list (`read-url` returns the reader's markdown, truncated to `maxChars`). The handler returns `{ markdown, provider, cached }`, writes a `SDK_SEARCH_QUERY` audit row + an `sdk_capability_calls` governance row, and (when in a conversation) inserts a chat pill. The SDK maps `-32101 → SearchDisabledError`, `-32105 → SearchError`.

The bundled `web-search` extension (`docs/extensions/examples/web-search/index.ts`) is a **thin shim**: its `search-web` / `read-url` handlers just forward to `ctx.search.web` / `ctx.search.read`. It owns no network hosts, no provider-key env vars, and no filesystem grant — only `permissions.search: "inherit"`.

## Usage

**As an extension (SDK):**

```ts
import { Search } from "@ezcorp/sdk/runtime";
const search = new Search();
const { markdown, provider, cached } = await search.web("query", { maxResults: 5 }); // 1..20
const page = await search.read("https://example.com", { maxChars: 20000 }); // 500..200000
```

**As host code:** import `performSearch` / `performRead` directly from `src/search/index.ts`.

**As the LLM:** the bundled extension exposes the tools `search-web` (arg `query`, optional `maxResults`) and `read-url` (arg `url`, optional `maxChars`).

**Admin backend config — `web/src/routes/api/search/backend/+server.ts` (all admin-only):**
- `GET /api/search/backend` — presence-only status (`hasKey` per BYOK provider + `searxngUrl`). Keys are **never** returned.
- `POST /api/search/backend` — upsert a BYOK key `{ provider, apiKey }` (encrypted via `provider:apiKey:*`) **or** the SearXNG URL `{ searxngUrl }` (`global:search:searxngUrl`, non-secret).
- `DELETE /api/search/backend` — remove a BYOK key `{ provider }`.

**Admin policy defaults** are plain settings written through the generic admin settings API (`PUT /api/settings/[key]` / `upsertSetting`), read by `src/search/policy.ts`:
- `global:search:allowedByDefault` (default `true`) — whether new extensions get `"inherit"` vs `false` at install.
- `global:search:defaultQuota` (hard default `100`) — daily calls per extension.
- `global:search:defaultMaxResults` (hard default `5`).
- `global:search:defaultProviders` (hard default `"all"`) — provider allowlist or `"all"`.

UI: **Settings → Search** (`web/src/routes/(app)/settings/search/+page.svelte`) with `SearchBackendSection.svelte` (BYOK keys + SearXNG URL) and `SearchDefaultsSection.svelte` (policy defaults).

**Host env vars** (configure the host process, read by `resolveProviders`; persisted backend config overrides same-named env):
- `SEARXNG_BASE_URL` — SearXNG instance (compose sets `http://localhost:8889`).
- `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`, `SERPAPI_API_KEY`, `JINA_API_KEY` — BYOK (selection precedence as listed above).
- `*_BASE_URL` overrides (`TAVILY_BASE_URL`, `JINA_READER_BASE_URL`, `DDG_LITE_BASE_URL`, …) exist for tests only; production never sets them.
- `SEARXNG_SECRET` — SearXNG container secret (compose).

**SearXNG sidecar:** `docker-compose.yml` ships an always-on `searxng` service (image `searxng/searxng:latest`, 256 MB / 0.5 CPU, published on loopback `127.0.0.1:8889` only, no `depends_on` — DuckDuckGo covers it if down). Its JSON API is enabled via the committed `deploy/searxng/settings.yml`.

## Key files

- `src/search/index.ts` — provider-agnostic entry points `performSearch` / `performRead`; cache wiring; `ProviderNotAllowedError`; max-results (1..20) and max-chars (500..200000) clamps.
- `src/search/providers.ts` — provider classes (Jina, Tavily, Brave, Exa, SerpApi, SearXNG, DuckDuckGo), DDG HTMLRewriter scraper + redirect unwrap, `withFallback` connection-error wrapper, `resolveProviders` selection precedence, the injectable `Transport` seam.
- `src/search/egress.ts` — the SSRF guard `guardedFetch`; IPv4/IPv6 blocked-range classification (incl. v4-in-v6 transition forms + cloud metadata); DNS resolve-and-pin; redirect/body/timeout caps; `EgressBlockedError`.
- `src/search/policy.ts` — the 3-layer policy resolver (`resolveSearchPolicy`, `mergeSearchPolicy`, `getSearchInstanceDefaults`), `HARD_SEARCH_DEFAULTS`, `SEARCH_SETTING_KEYS`, capability settings schema for the UI.
- `src/search/search-quota.ts` — per-extension/day quota counter (`consumeSearchQuota`, `hydrateSearchQuota`) backed by `extension_search_calls_daily`.
- `src/search/cache.ts` — process-wide TTL+LRU `SearchCache`; provider-namespaced keys; `getSharedSearchCache` singleton.
- `src/search/markdown.ts` — `formatResults` (markdown bullet list) + `truncate`.
- `src/search/backend-config.ts` — `resolveSearchBackendEnv`: bridges persisted Settings → Search backend config (SearXNG URL + decrypted BYOK keys) into the resolver env (host-only; keys never leave the server).
- `src/extensions/search-handler.ts` — `handlePiSearch`: grant gate, policy + quota enforcement, audit rows, soft-fail codes (-32101/-32103/-32105).
- `src/extensions/tool-executor.ts` — `ezcorp/search` method dispatch + provenance-stamped reverse-RPC meta.
- `packages/@ezcorp/sdk/src/runtime/search.ts` — `Search` client class + `SearchDisabledError` / `SearchError` mapping.
- `docs/extensions/examples/web-search/index.ts` — the bundled extension's thin `search-web` / `read-url` forwarders.
- `web/src/routes/api/search/backend/+server.ts` — admin GET/POST/DELETE backend config (presence-only GET).
- `web/src/lib/components/settings/SearchBackendSection.svelte`, `SearchDefaultsSection.svelte`, `web/src/lib/settings-search-config.ts` — Settings → Search UI + shared keys.
- `docker-compose.yml` (`searxng` service), `deploy/searxng/settings.yml` — the keyless SearXNG sidecar.

## Features it touches

- [[bundled-catalog]] — the `web-search` extension is wired in `BUNDLED_EXTENSIONS` with `search: "inherit"`.
- [[permissions-and-grants]] — the `search` capability grant (`false` / `"inherit"` / override) gates and shapes every call; ceiling in `bundled-ceiling.ts`.
- [[sandbox-and-isolation]] — provider fetches run host-side precisely so credentials + internal-host access stay outside the extension sandbox.
- [[runtime-and-rpc]] — `ctx.search` is an `ezcorp/search` reverse-RPC dispatched by the tool executor with provenance-stamped identity.
- [[audit-and-observability]] — emits `SDK_SEARCH_QUERY`, `SDK_SEARCH_EGRESS_BLOCKED`, `SDK_SEARCH_QUOTA_EXCEEDED` audit rows + `sdk_capability_calls` governance rows.
- [[settings-system]] — admin backend keys + policy defaults live in encrypted/plain settings; Settings → Search UI.
- [[api-security]] — the SSRF egress guard is the core network-safety boundary for host-side fetches.
- [[daily-briefing]] — a host-side consumer can call `performSearch` directly (same shared module + cache).
- [[mention-grammar]] — the bundled `web-search` extension is reachable as an `![ext:web-search]` mention.

## Related docs

- [docs/extensions/examples/web-search/README.md](../../extensions/examples/web-search/README.md) — user-facing story, BYOK table, "bring your own SearXNG", data locations.
- The repo has no standalone `docs/web-search.md`; **this file is the primary host-side reference.**

## Notes & gotchas

- **The README's "Data locations" section is partly stale.** It describes a per-subprocess disk cache (`cache.json`, sha256 keys) and a Jina 60/hour cap — that was the **retired** extension-owned implementation. Today the cache is an **in-process** `SearchCache` (`src/search/cache.ts`); there is no disk cache and no Jina hourly cap in the host module. The provider/precedence/SSRF prose is accurate.
- **Keyless Jina *search* was removed (2026-06):** `s.jina.ai` returns 401 without a key. `JinaSearch` is now BYOK-only (needs `JINA_API_KEY`); the Jina **reader** (`r.jina.ai`) stays keyless and is the only `read-url` backend.
- **SearXNG must enable the JSON API.** Upstream defaults to HTML-only; `format=json` returns 403. `deploy/searxng/settings.yml` enables it. A reachable-but-erroring SearXNG (e.g. 403) does **not** fall back to DuckDuckGo — only connection-level failures (refused/timeout/DNS/network-denied, matched by `isConnectionError`) trigger the one-shot fallback, so misconfiguration isn't silently masked.
- **`mode:"backend"` does not reject private IPs.** The configured SearXNG host is the one sanctioned internal target; in backend mode the host allowlist is the trust boundary and the connection is IP-pinned (so a hostile DNS answer can't rebind it elsewhere), but an internal/loopback IP is **not** rejected. Only `mode:"read"` rejects private IPs — and `read-url` runs in backend mode against Jina (Jina sandboxes the inner fetch), so `mode:"read"`'s private-IP rejection is currently reserved for a future host-side BYOK reader.
- **`/api/search/backend` vs `/api/search/messages` are unrelated.** `messages` is conversation message search (a different feature); only `backend` configures web-search providers.
- **Quota is best-effort durable, not transactional.** The in-process counter increments synchronously but the DB upsert is fire-and-forget; a multi-process deployment would not share the counter (the table is the durable record, hydrated per-process on first lookup).
- **Custom SearXNG hostnames** beyond `searxng` / `localhost` / `127.0.0.1` are blocked by the egress allowlist until added to the configured backend host set — searches then fall back to DuckDuckGo and the deny lands in the audit log, not stderr.
- **`maxResults` is clamped down, never up:** the handler uses `min(requested, policy.maxResults)`, and `performSearch` further clamps to 1..20.
