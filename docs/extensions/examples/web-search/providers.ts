// Pluggable search + URL-reader providers.
//
// Default path (keyless) is SearXNG (when `SEARXNG_BASE_URL` points at the
// bundled sidecar or a BYO instance) with DuckDuckGo as the universal
// keyless fallback. URL reading stays on Jina's keyless `r.jina.ai`. BYOK
// providers (Tavily / Brave / Exa / SerpAPI / keyed Jina) take over at call
// time when their corresponding env var is set. `resolveProviders` is the
// single selection seam; every tool handler goes through it so that adding
// an API key to a running subprocess's env takes effect on the next
// invocation with no reinstall.
//
// Keyless Jina *search* (`s.jina.ai` without a key) was removed 2026-06:
// the upstream now returns 401 AuthenticationRequiredError without a key.

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

// ── Jina (keyed search; keyless reader) ─────────────────────────────

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

// ── SearXNG (keyless, self-hosted sidecar or BYO instance) ─────────

export class SearXNG implements SearchProvider {
  readonly name = "searxng";
  constructor(private readonly baseUrl: string) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = this.baseUrl.replace(/\/+$/, "");
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
    const body = await doFetch<{ results?: Array<{ title?: string; url?: string; content?: string }> }>(
      "SearXNG",
      url,
      { headers: { accept: "application/json" } },
    );
    const results = Array.isArray(body?.results) ? body.results : [];
    return results.slice(0, maxResults).map((r) => ({
      title: String(r.title ?? ""),
      url: String(r.url ?? ""),
      snippet: String(r.content ?? ""),
    }));
  }
}

// ── DuckDuckGo (keyless, universal fallback) ────────────────────────
// Scrapes the no-JS endpoints with Bun's built-in HTMLRewriter (locked
// decision: no new HTML-parsing dependencies). `lite.duckduckgo.com` is
// primary (simplest markup); `html.duckduckgo.com` is the in-class
// fallback when lite errors. Without a browsery User-Agent DDG serves a
// challenge page — it parses to 0 results (no throw; test-pinned).

const DDG_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";

interface DdgSelectors {
  link: string;
  snippet: string;
}

// Captured markup (testdata/ddg-lite.html): results are
// `<a class='result-link'>` + `<td class='result-snippet'>` pairs.
const DDG_LITE_SELECTORS: DdgSelectors = { link: "a.result-link", snippet: "td.result-snippet" };
// Captured markup (testdata/ddg-html.html): `<a class="result__a">` +
// `<a class="result__snippet">` pairs.
const DDG_HTML_SELECTORS: DdgSelectors = { link: "a.result__a", snippet: ".result__snippet" };

/**
 * Minimal HTML-entity decode for the handful of entities DDG's markup
 * emits. Numeric/named forms first; `&amp;` LAST so `&amp;lt;` correctly
 * decodes to the literal text `&lt;` rather than `<`.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * DDG wraps result hrefs in a redirect:
 *   `//duckduckgo.com/l/?uddg=<encoded-target>&rut=<tracker>`
 * Unwrap to the target URL; non-redirect hrefs pass through unchanged.
 */
export function unwrapDdgRedirect(href: string): string {
  try {
    const u = new URL(href.startsWith("//") ? `https:${href}` : href);
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname.startsWith("/l/")) {
      const target = u.searchParams.get("uddg");
      if (target) return target;
    }
  } catch {
    // Relative or malformed href — return as-is below.
  }
  return href;
}

/**
 * Collect `{ link, snippet }` pairs from a DDG results page. HTMLRewriter
 * is async-streaming — handlers fire in document order while the
 * transformed response is consumed, so we drain it fully (`.text()`)
 * before reading the accumulator (deterministic completion).
 */
async function parseDdgResults(html: string, sel: DdgSelectors): Promise<SearchResult[]> {
  interface Acc {
    title: string;
    url: string;
    snippet: string;
  }
  const collected: Acc[] = [];
  let current: Acc | null = null;
  const flush = (): void => {
    if (current && current.url.length > 0 && current.title.trim().length > 0) {
      collected.push(current);
    }
    current = null;
  };
  const rewriter = new HTMLRewriter()
    .on(sel.link, {
      element(el) {
        flush(); // a new result anchor closes the previous result
        const href = decodeEntities(el.getAttribute("href") ?? "");
        current = { title: "", url: unwrapDdgRedirect(href), snippet: "" };
      },
      text(t) {
        if (current) current.title += t.text;
      },
    })
    .on(sel.snippet, {
      text(t) {
        if (current) current.snippet += t.text;
      },
    });
  await rewriter.transform(new Response(html)).text();
  flush();
  return collected.map((r) => ({
    title: decodeEntities(r.title).replace(/\s+/g, " ").trim(),
    url: r.url,
    snippet: decodeEntities(r.snippet).replace(/\s+/g, " ").trim(),
  }));
}

export class DuckDuckGo implements SearchProvider {
  readonly name = "duckduckgo";
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const q = encodeURIComponent(query);
    const headers = { accept: "text/html", "user-agent": DDG_USER_AGENT };
    let html: string;
    let selectors = DDG_LITE_SELECTORS;
    try {
      const base = host("DDG_LITE_BASE_URL", "https://lite.duckduckgo.com");
      html = await doFetch<string>("DuckDuckGo", `${base}/lite/?q=${q}`, { headers, as: "text" });
    } catch {
      // Lite endpoint errored (HTTP or connection) — try the html variant
      // before giving up. If this throws too, the error propagates with
      // the usual "DuckDuckGo …" tag.
      const base = host("DDG_HTML_BASE_URL", "https://html.duckduckgo.com");
      html = await doFetch<string>("DuckDuckGo", `${base}/html/?q=${q}`, { headers, as: "text" });
      selectors = DDG_HTML_SELECTORS;
    }
    const results = await parseDdgResults(html, selectors);
    return results.slice(0, maxResults);
  }
}

// ── Connection-error fallback wrapper ───────────────────────────────

// Connection-class failures (refused / reset / timeout / DNS) plus
// sandbox-PDP denials — anything that means the primary never gave an
// HTTP answer. Internal hosts (localhost / RFC-1918, i.e. the SearXNG
// sidecar) are fetched HOST-side via the `ezcorp/network.internal`
// reverse-RPC: its PDP deny reads "Network denied: …" and a host-side
// fetch throw reads "Upstream error: <fetch message>" — both are
// no-HTTP-answer outcomes. HTTP errors like "SearXNG HTTP 503"
// deliberately do NOT match: a reachable-but-misconfigured SearXNG
// should surface its error instead of being silently masked.
const CONNECTION_ERROR_RE =
  /connection\s*(refused|closed|reset)|econnrefused|econnreset|timed?\s*out|etimedout|dns|enotfound|eai_again|failed\s*to\s*(open|connect)|unable\s*to\s*(connect|resolve)|network\s*error|fetch\s*failed|socket|allowlist|permitted_hosts|requires\s*'network'\s*permission|network\s*denied|upstream\s*error/i;

export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = String((err as Error & { code?: unknown }).code ?? "");
  return CONNECTION_ERROR_RE.test(`${code} ${err.name} ${err.message}`);
}

/** Which provider actually served the results — drives the cache key. */
export interface SearchOutcome {
  providerName: string;
  results: SearchResult[];
}

export interface FallbackSearchProvider extends SearchProvider {
  /**
   * Name of the wrapped fallback provider. Lets the handler probe the
   * fallback's cache namespace when the primary-name key misses, so
   * repeated queries during a primary outage serve from cache instead
   * of live-fetching the fallback on every call.
   */
  readonly fallbackName?: string;
  searchWithOutcome(query: string, maxResults: number): Promise<SearchOutcome>;
}

export function hasOutcome(p: SearchProvider): p is FallbackSearchProvider {
  return typeof (p as FallbackSearchProvider).searchWithOutcome === "function";
}

/**
 * One-shot connection-error fallback. Each inner provider keeps its own
 * `name`; `searchWithOutcome` reports which one served so the handler
 * caches under the right provider namespace (fallback results cache
 * under the fallback's name — never poisoning the primary's).
 */
export function withFallback(primary: SearchProvider, fallback: SearchProvider): FallbackSearchProvider {
  const searchWithOutcome = async (query: string, maxResults: number): Promise<SearchOutcome> => {
    let primaryErr: Error;
    try {
      return { providerName: primary.name, results: await primary.search(query, maxResults) };
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      primaryErr = err as Error;
    }
    console.error(
      `[web-search] ${primary.name} unreachable (${primaryErr.message}); falling back to ${fallback.name}`,
    );
    try {
      return { providerName: fallback.name, results: await fallback.search(query, maxResults) };
    } catch (fbErr) {
      throw new Error(
        `${primary.name} unreachable (${primaryErr.message}); ${fallback.name} fallback failed: ${(fbErr as Error).message}`,
      );
    }
  };
  return {
    name: primary.name,
    fallbackName: fallback.name,
    search: async (query, maxResults) => (await searchWithOutcome(query, maxResults)).results,
    searchWithOutcome,
  };
}

// ── Resolver ────────────────────────────────────────────────────────

export interface ResolvedProviders {
  search: SearchProvider;
  reader: UrlReader;
}

/**
 * Select providers based on env vars. Precedence (highest first):
 *   TAVILY_API_KEY > BRAVE_API_KEY > EXA_API_KEY > SERPAPI_API_KEY >
 *   JINA_API_KEY (keyed Jina search) > SEARXNG_BASE_URL (SearXNG, with a
 *   one-shot DuckDuckGo fallback on connection-class errors) >
 *   DuckDuckGo (keyless universal default).
 *
 * Keyless Jina search is GONE — `s.jina.ai` returns 401 without a key.
 *
 * URL reading always uses Jina — it's the only keyless HTML-to-markdown
 * service we trust. BYOK readers can be added later.
 */
export function resolveProviders(env: NodeJS.ProcessEnv = process.env): ResolvedProviders {
  const jinaKey = env.JINA_API_KEY;
  const reader = new JinaReader(jinaKey);
  if (env.TAVILY_API_KEY)  return { search: new Tavily(env.TAVILY_API_KEY),   reader };
  if (env.BRAVE_API_KEY)   return { search: new Brave(env.BRAVE_API_KEY),    reader };
  if (env.EXA_API_KEY)     return { search: new Exa(env.EXA_API_KEY),        reader };
  if (env.SERPAPI_API_KEY) return { search: new SerpApi(env.SERPAPI_API_KEY), reader };
  if (jinaKey)             return { search: new JinaSearch(jinaKey),          reader };
  const duckduckgo = new DuckDuckGo();
  if (env.SEARXNG_BASE_URL) {
    return { search: withFallback(new SearXNG(env.SEARXNG_BASE_URL), duckduckgo), reader };
  }
  return { search: duckduckgo, reader };
}
