# web-search

Pre-installed extension exposing two tools:

- **`search-web`** — free-text web search; returns ranked results as markdown.
- **`read-url`** — fetch any URL and return its main content as clean markdown, ready for summarization.

## Just works (no API key)

On first launch this extension is installed automatically via `BUNDLED_EXTENSIONS` in `src/extensions/bundled.ts` and its default network permissions are pre-granted. The default provider is **Jina AI** (keyless):

- `https://s.jina.ai/?q=<query>` — search
- `https://r.jina.ai/<url>` — URL-to-markdown

No signup required. Jina's free tier is rate-limited, so the extension caps outbound calls at 60 requests/hour and surfaces a helpful "set an API key" error when the cap is hit.

## BYOK for higher quality / higher limits

Set any one of these env vars and the extension switches providers on the next call with no reinstall:

| Env var | Provider | Endpoint |
|---|---|---|
| `TAVILY_API_KEY`  | Tavily    | `api.tavily.com`        |
| `BRAVE_API_KEY`   | Brave     | `api.search.brave.com`  |
| `EXA_API_KEY`     | Exa       | `api.exa.ai`            |
| `SERPAPI_API_KEY` | SerpAPI   | `serpapi.com`           |

Precedence: Tavily > Brave > Exa > SerpAPI > Jina (default).

URL reading always goes through Jina Reader — it's the only keyless HTML-to-markdown service we rely on. Set `JINA_API_KEY` to raise Jina's per-key rate limit.

## Data locations

- Cache: `<projectRoot>/.ezcorp/extension-data/web-search/cache.json` (sha256 keys, 500-entry LRU, 15 min TTL for search, 60 min TTL for URL reads).
- Rate-limit counters: in-memory only; reset when the extension subprocess restarts.

## Install (manual, for developers)

```
ezcorp ext install ./docs/extensions/examples/web-search
```

End users do not need to run this — the extension is in `BUNDLED_EXTENSIONS` and installs on first launch.

## Run the tests

```
bun test docs/extensions/examples/web-search
```

## Non-goals for v1

- One-click summarize slash command (no extension → slash-command wiring today).
- Streaming results.
- Binary/PDF URL handling — Jina Reader returns markdown for HTML only; binaries surface a friendly error.
- Cross-provider re-ranking / dedup.
