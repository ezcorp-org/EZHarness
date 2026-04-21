// Pluggable search + URL-reader providers.
//
// Default path (keyless) is Jina AI — `s.jina.ai` for search and `r.jina.ai`
// for URL-to-markdown. BYOK providers (Tavily / Brave / Exa / SerpAPI) take
// over at call time when their corresponding env var is set. `resolveProviders`
// is the single selection seam; every tool handler goes through it so that
// adding an API key to a running subprocess's env takes effect on the next
// invocation with no reinstall.

import { fetchPermitted } from "@ezcorp/sdk/runtime";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, maxResults: number): Promise<SearchResult[]>;
}

export interface UrlReader {
  readonly name: string;
  read(url: string): Promise<string>;
}

// ── Shared HTTP helper ──────────────────────────────────────────────

interface FetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  /** Response content type: "json" or "text". Default "json". */
  as?: "json" | "text";
}

/**
 * Thin wrapper around `fetchPermitted`. Centralizes:
 *   - Content-Type for JSON bodies
 *   - Non-2xx → thrown Error containing provider-identifiable status
 *   - JSON parse errors surfaced as a distinct, readable failure
 *
 * `providerLabel` is prepended to every error so the host-side `toolError`
 * wrapper produces a useful "Search failed via Tavily: …" message without
 * each provider repeating itself.
 */
async function doFetch<T = unknown>(
  providerLabel: string,
  url: string,
  opts: FetchOptions = {},
): Promise<T> {
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
  };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetchPermitted(url, init);
  if (!res.ok) {
    throw new Error(`${providerLabel} HTTP ${res.status}`);
  }
  if ((opts.as ?? "json") === "text") {
    return (await res.text()) as unknown as T;
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${providerLabel} returned malformed JSON`);
  }
}

// ── Default host overrides (tests only) ─────────────────────────────
// Production never sets these; they exist so the e2e subprocess test can
// point a provider at a localhost stub without rewriting the manifest.

function host(envVar: string, defaultHost: string): string {
  const v = process.env[envVar];
  return v && v.length > 0 ? v : defaultHost;
}

// ── Jina (default, keyless) ─────────────────────────────────────────

export class JinaSearch implements SearchProvider {
  readonly name = "jina";
  constructor(private readonly apiKey?: string) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = host("JINA_SEARCH_BASE_URL", "https://s.jina.ai");
    const url = `${base}/?q=${encodeURIComponent(query)}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const body = await doFetch<{ data?: Array<{ title?: string; url?: string; content?: string; description?: string }> }>(
      "Jina",
      url,
      { headers },
    );
    const data = Array.isArray(body?.data) ? body.data : [];
    return data.slice(0, maxResults).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.description ?? r.content ?? ""),
    }));
  }
}

export class JinaReader implements UrlReader {
  readonly name = "jina";
  constructor(private readonly apiKey?: string) {}
  async read(url: string): Promise<string> {
    const base = host("JINA_READER_BASE_URL", "https://r.jina.ai");
    const target = `${base}/${url}`;
    const headers: Record<string, string> = { accept: "text/markdown" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const text = await doFetch<string>("Jina", target, { headers, as: "text" });
    if (text.length === 0) throw new Error("Jina returned empty body (binary or unreachable URL)");
    return text;
  }
}

// ── Tavily (BYOK) ───────────────────────────────────────────────────

export class Tavily implements SearchProvider {
  readonly name = "tavily";
  constructor(private readonly apiKey: string) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = host("TAVILY_BASE_URL", "https://api.tavily.com");
    const body = await doFetch<{ results?: Array<{ title?: string; url?: string; content?: string }> }>(
      "Tavily",
      `${base}/search`,
      {
        method: "POST",
        body: { api_key: this.apiKey, query, max_results: maxResults },
      },
    );
    const results = Array.isArray(body?.results) ? body.results : [];
    return results.slice(0, maxResults).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.content ?? ""),
    }));
  }
}

// ── Brave (BYOK) ────────────────────────────────────────────────────

export class Brave implements SearchProvider {
  readonly name = "brave";
  constructor(private readonly apiKey: string) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = host("BRAVE_BASE_URL", "https://api.search.brave.com");
    const url = `${base}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const body = await doFetch<{ web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }>(
      "Brave",
      url,
      { headers: { accept: "application/json", "x-subscription-token": this.apiKey } },
    );
    const results = Array.isArray(body?.web?.results) ? body.web!.results! : [];
    return results.slice(0, maxResults).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.description ?? ""),
    }));
  }
}

// ── Exa (BYOK) ──────────────────────────────────────────────────────

export class Exa implements SearchProvider {
  readonly name = "exa";
  constructor(private readonly apiKey: string) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = host("EXA_BASE_URL", "https://api.exa.ai");
    const body = await doFetch<{ results?: Array<{ title?: string; url?: string; text?: string }> }>(
      "Exa",
      `${base}/search`,
      {
        method: "POST",
        headers: { "x-api-key": this.apiKey },
        body: { query, numResults: maxResults, contents: { text: { maxCharacters: 400 } } },
      },
    );
    const results = Array.isArray(body?.results) ? body.results : [];
    return results.slice(0, maxResults).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.text ?? ""),
    }));
  }
}

// ── SerpAPI (BYOK) ──────────────────────────────────────────────────

export class SerpApi implements SearchProvider {
  readonly name = "serpapi";
  constructor(private readonly apiKey: string) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = host("SERPAPI_BASE_URL", "https://serpapi.com");
    const url = `${base}/search.json?q=${encodeURIComponent(query)}&num=${maxResults}&api_key=${encodeURIComponent(this.apiKey)}`;
    const body = await doFetch<{ organic_results?: Array<{ title?: string; link?: string; snippet?: string }> }>(
      "SerpAPI",
      url,
    );
    const results = Array.isArray(body?.organic_results) ? body.organic_results : [];
    return results.slice(0, maxResults).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.link ?? ""),
      snippet: String(r.snippet ?? ""),
    }));
  }
}

// ── Resolver ────────────────────────────────────────────────────────

export interface ResolvedProviders {
  search: SearchProvider;
  reader: UrlReader;
}

/**
 * Select providers based on env vars. Precedence (highest first):
 *   TAVILY_API_KEY > BRAVE_API_KEY > EXA_API_KEY > SERPAPI_API_KEY > Jina
 *
 * URL reading always uses Jina — it's the only keyless keys-to-markdown
 * service we trust. BYOK readers can be added later.
 */
export function resolveProviders(env: NodeJS.ProcessEnv = process.env): ResolvedProviders {
  const jinaKey = env.JINA_API_KEY;
  const reader = new JinaReader(jinaKey);
  if (env.TAVILY_API_KEY)  return { search: new Tavily(env.TAVILY_API_KEY),   reader };
  if (env.BRAVE_API_KEY)   return { search: new Brave(env.BRAVE_API_KEY),    reader };
  if (env.EXA_API_KEY)     return { search: new Exa(env.EXA_API_KEY),        reader };
  if (env.SERPAPI_API_KEY) return { search: new SerpApi(env.SERPAPI_API_KEY), reader };
  return { search: new JinaSearch(jinaKey), reader };
}
