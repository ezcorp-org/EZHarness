# web-search

Pre-installed extension exposing two tools:

- **`search-web`** — free-text web search; returns ranked results as markdown.
- **`read-url`** — fetch any URL and return its main content as clean markdown, ready for summarization.

> **Architecture (shared-search Phase 1):** this extension is now a **thin
> shim** over the host `ctx.search` capability. The provider chain
> (SearXNG / DuckDuckGo / BYOK), the SSRF egress guard, and the shared
> cache all live ONCE in the host module **`src/search/`** — reachable by
> any extension and by host code via `ctx.search`. The two tools simply
> forward to `ctx.search.web` / `ctx.search.read`; the LLM surface (tool
> names, schemas, cardTypes) is unchanged. The extension owns **no
> network hosts, no provider-key env vars, and no filesystem grant** —
> only `permissions.search`. The provider details below now describe the
> **host** behavior, and the env vars configure the **host process**.

## Just works (no API key)

On first launch this extension is installed automatically via `BUNDLED_EXTENSIONS` in `src/extensions/bundled.ts` with the `search` capability pre-granted (`"inherit"` = the full instance default). Keyless search works out of the box, host-side, through two providers:

1. **SearXNG sidecar** — both compose stacks ship a [SearXNG](https://docs.searxng.org/) container (`searxng` service). When `SEARXNG_BASE_URL` is set (the compose files set it automatically), search queries go to `{SEARXNG_BASE_URL}/search?format=json`.
2. **DuckDuckGo** — the universal keyless fallback. Used when `SEARXNG_BASE_URL` is unset, and as a one-shot retry when the SearXNG instance is unreachable (connection refused / timeout / DNS / network-permission denial). Parses the no-JS `lite.duckduckgo.com` endpoint (with `html.duckduckgo.com` as an in-class fallback) using Bun's built-in `HTMLRewriter` — no extra dependencies.

HTTP errors from a *reachable* SearXNG (e.g. 403 because the JSON format is disabled) do **not** fall back — they surface directly so misconfiguration isn't silently masked.

> Keyless **Jina search** was removed (2026-06): `s.jina.ai` now returns 401 without an API key. The Jina **reader** (`r.jina.ai`) still works keyless and remains the `read-url` backend.

## BYOK for higher quality / higher limits

Set any one of these env vars and the extension switches providers on the next call with no reinstall:

| Env var | Provider | Endpoint |
|---|---|---|
| `TAVILY_API_KEY`  | Tavily     | `api.tavily.com`        |
| `BRAVE_API_KEY`   | Brave      | `api.search.brave.com`  |
| `EXA_API_KEY`     | Exa        | `api.exa.ai`            |
| `SERPAPI_API_KEY` | SerpAPI    | `serpapi.com`           |
| `JINA_API_KEY`    | Jina (keyed) | `s.jina.ai`           |

Precedence: **Tavily > Brave > Exa > SerpAPI > keyed Jina > SearXNG (`SEARXNG_BASE_URL`) > DuckDuckGo**.

URL reading always goes through Jina Reader — it's the only keyless HTML-to-markdown service we rely on. Set `JINA_API_KEY` to raise Jina's per-key rate limit.

## Bring your own SearXNG

Point `SEARXNG_BASE_URL` at any SearXNG instance. Two requirements:

1. The instance must enable the JSON API — `search.formats` must include `json` in its `settings.yml` (upstream default is HTML-only; requests for `format=json` return 403). See the committed `deploy/searxng/settings.yml` for the exact shape.
2. The hostname must be allowed by the **host-side** egress guard. This extension owns no network grant — it declares only `search: "inherit"` and forwards to the host `ctx.search` capability, so host allowlisting (and the SSRF egress guard) lives host-side in `src/search/`, not in this extension's manifest. There is no `permissions.network` block, bundled-ceiling entry, or `manifest.lock.json` to edit here — a custom host (e.g. `searx.example.internal`) is configured host-side.

## Data locations

- Cache: an **in-process, host-side** map in `src/search/cache.ts` — no disk persistence, so no `cache.json` is ever written (the extension has no filesystem grant). Keys are plaintext `provider:kind:query:extra` (500-entry LRU, 15 min TTL for search, 60 min TTL for URL reads). The key embeds the provider name, so SearXNG and DuckDuckGo results never collide — a fallback result is cached under `duckduckgo`, never poisoning the `searxng` namespace. On a primary-namespace miss the handler also probes the fallback's namespace, so repeated identical queries during a SearXNG outage serve from cache instead of re-scraping DuckDuckGo.
- Rate-limit counters: a **host-side, per-extension, per-calendar-day** quota (`src/search/search-quota.ts`), durably persisted in the `extension_search_calls_daily` table and hydrated from it on startup — so a host restart does **not** reset the day's count. In-process counters are authoritative for the live process; the DB is the durable record. There is no per-provider 60/hour Jina cap.

## Install (manual, for developers)

```
ezcorp ext install ./docs/extensions/examples/web-search
```

End users do not need to run this — the extension is in `BUNDLED_EXTENSIONS` and installs on first launch.

## Run the tests

```
bun test docs/extensions/examples/web-search
```

The DuckDuckGo tests parse real captured (sanitized) pages from `testdata/` — no test ever touches the live network.

## Non-goals for v1

- One-click summarize slash command (no extension → slash-command wiring today).
- Streaming results.
- Binary/PDF URL handling — Jina Reader returns markdown for HTML only; binaries surface a friendly error.
- Cross-provider re-ranking / dedup.
- Fully-local readability reader (offline `read-url`) — stretch item.
