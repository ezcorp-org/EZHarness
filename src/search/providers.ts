// Shared host-side search + URL-reader providers.
//
// Hoisted verbatim from `docs/extensions/examples/web-search/providers.ts`
// (the extension's provider chain) so the provider logic exists ONCE.
// The ONLY behavioral change vs the extension copy: the low-level
// transport swaps the extension's `fetchPermitted` (@ezcorp/sdk, sandbox
// PDP) for `src/search/egress.ts#guardedFetch` (the host SSRF guard).
//
// Search backends (SearXNG / DDG / BYOK) fetch in `mode:"backend"`
// (host allowlist — the sanctioned-internal SearXNG host included). The
// Jina URL reader fetches in `mode:"read"` (fully untrusted, private-IP
// rejecting). Transport is injectable so tests drive a mocked fetch with
// zero live network.
//
// Default path (keyless) is SearXNG (when `SEARXNG_BASE_URL` is set) with
// DuckDuckGo as the universal keyless fallback. URL reading stays on
// Jina's keyless `r.jina.ai`. BYOK providers take over at call time when
// their env var is set. `resolveProviders` is the single selection seam.
//
// Keyless Jina *search* (`s.jina.ai` without a key) was removed 2026-06:
// the upstream now returns 401 without a key.

import { guardedFetch, type EgressMode, type GuardedFetchOptions } from "./egress";

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

// ── Transport seam ──────────────────────────────────────────────────
// The host transport routes EVERY provider fetch through `guardedFetch`.
// Tests inject a `Transport` that captures calls + returns canned
// Responses (mirroring the substack-pilot live-transport ≥95% pattern:
// mock at the fetch boundary, never the network).

export interface TransportRequest {
  url: string;
  init: RequestInit;
  mode: EgressMode;
  /** Backend-mode host allowlist (sanctioned SearXNG host included). */
  allowedHosts?: readonly string[];
}

export type Transport = (req: TransportRequest) => Promise<Response>;

/** Production transport — delegates to the SSRF guard. Audit hook is
 *  threaded in by `src/search/index.ts` via `withAuditHook`. */
export function makeGuardedTransport(
  guardOpts?: Partial<GuardedFetchOptions>,
): Transport {
  return ({ url, init, mode, allowedHosts }) =>
    guardedFetch(url, init, {
      mode,
      ...(allowedHosts ? { allowedHosts } : {}),
      ...guardOpts,
    });
}

interface FetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  /** Response content type: "json" or "text". Default "json". */
  as?: "json" | "text";
  /** Egress mode for the SSRF guard. Default "backend" (search
   *  providers); the URL reader passes "read". */
  mode?: EgressMode;
  /** Backend-mode host allowlist. */
  allowedHosts?: readonly string[];
}

/**
 * Thin wrapper around the injected transport. Centralizes:
 *   - Content-Type for JSON bodies
 *   - Non-2xx → thrown Error containing provider-identifiable status
 *   - JSON parse errors surfaced as a distinct, readable failure
 *
 * `providerLabel` is prepended to every error so the host-side
 * `toolError` wrapper produces "Search failed via Tavily: …".
 */
async function doFetch<T = unknown>(
  transport: Transport,
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
  const res = await transport({
    url,
    init,
    mode: opts.mode ?? "backend",
    ...(opts.allowedHosts ? { allowedHosts: opts.allowedHosts } : {}),
  });
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

/** Hostname of a URL, lowercased — for the backend-mode allowlist. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// ── Jina (keyed search; keyless reader) ─────────────────────────────

export class JinaSearch implements SearchProvider {
  readonly name = "jina";
  constructor(
    private readonly transport: Transport,
    private readonly apiKey?: string,
  ) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = host("JINA_SEARCH_BASE_URL", "https://s.jina.ai");
    const url = `${base}/?q=${encodeURIComponent(query)}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const body = await doFetch<{ data?: Array<{ title?: string; url?: string; content?: string; description?: string }> }>(
      this.transport,
      "Jina",
      url,
      { headers, allowedHosts: [hostnameOf(url)] },
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
  constructor(
    private readonly transport: Transport,
    private readonly apiKey?: string,
  ) {}
  async read(url: string): Promise<string> {
    const base = host("JINA_READER_BASE_URL", "https://r.jina.ai");
    const target = `${base}/${url}`;
    const headers: Record<string, string> = { accept: "text/markdown" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    // The reader fetches Jina, which itself fetches the user URL. The
    // OUTER fetch (host → Jina) is backend-mode (Jina is a trusted,
    // allowlisted host); Jina sandboxes the inner fetch. We still pin
    // Jina's host. `mode:"read"` is reserved for direct URL fetches if a
    // future BYOK reader fetches the target host-side (then the private-IP
    // rejection matters). Today Jina is the only reader → backend mode.
    const text = await doFetch<string>(this.transport, "Jina", target, {
      headers,
      as: "text",
      allowedHosts: [hostnameOf(target)],
    });
    if (text.length === 0) throw new Error("Jina returned empty body (binary or unreachable URL)");
    return text;
  }
}

// ── Tavily (BYOK) ───────────────────────────────────────────────────

export class Tavily implements SearchProvider {
  readonly name = "tavily";
  constructor(
    private readonly transport: Transport,
    private readonly apiKey: string,
  ) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = host("TAVILY_BASE_URL", "https://api.tavily.com");
    const url = `${base}/search`;
    const body = await doFetch<{ results?: Array<{ title?: string; url?: string; content?: string }> }>(
      this.transport,
      "Tavily",
      url,
      {
        method: "POST",
        body: { api_key: this.apiKey, query, max_results: maxResults },
        allowedHosts: [hostnameOf(url)],
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
  constructor(
    private readonly transport: Transport,
    private readonly apiKey: string,
  ) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = host("BRAVE_BASE_URL", "https://api.search.brave.com");
    const url = `${base}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const body = await doFetch<{ web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }>(
      this.transport,
      "Brave",
      url,
      { headers: { accept: "application/json", "x-subscription-token": this.apiKey }, allowedHosts: [hostnameOf(url)] },
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
  constructor(
    private readonly transport: Transport,
    private readonly apiKey: string,
  ) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = host("EXA_BASE_URL", "https://api.exa.ai");
    const url = `${base}/search`;
    const body = await doFetch<{ results?: Array<{ title?: string; url?: string; text?: string }> }>(
      this.transport,
      "Exa",
      url,
      {
        method: "POST",
        headers: { "x-api-key": this.apiKey },
        body: { query, numResults: maxResults, contents: { text: { maxCharacters: 400 } } },
        allowedHosts: [hostnameOf(url)],
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
  constructor(
    private readonly transport: Transport,
    private readonly apiKey: string,
  ) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = host("SERPAPI_BASE_URL", "https://serpapi.com");
    const url = `${base}/search.json?q=${encodeURIComponent(query)}&num=${maxResults}&api_key=${encodeURIComponent(this.apiKey)}`;
    const body = await doFetch<{ organic_results?: Array<{ title?: string; link?: string; snippet?: string }> }>(
      this.transport,
      "SerpAPI",
      url,
      { allowedHosts: [hostnameOf(url)] },
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
  constructor(
    private readonly transport: Transport,
    private readonly baseUrl: string,
  ) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const base = this.baseUrl.replace(/\/+$/, "");
    const url = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
    // The SearXNG host is the sanctioned internal target — allow it by
    // its configured host (the egress guard still IP-pins).
    const body = await doFetch<{ results?: Array<{ title?: string; url?: string; content?: string }> }>(
      this.transport,
      "SearXNG",
      url,
      { headers: { accept: "application/json" }, allowedHosts: [hostnameOf(url)] },
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
// primary; `html.duckduckgo.com` is the in-class fallback. Without a
// browsery User-Agent DDG serves a challenge page → 0 results (no throw).

const DDG_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0";

interface DdgSelectors {
  link: string;
  snippet: string;
}

const DDG_LITE_SELECTORS: DdgSelectors = { link: "a.result-link", snippet: "td.result-snippet" };
const DDG_HTML_SELECTORS: DdgSelectors = { link: "a.result__a", snippet: ".result__snippet" };

/**
 * Minimal HTML-entity decode for the handful of entities DDG's markup
 * emits. `&amp;` LAST so `&amp;lt;` decodes to the literal `&lt;`.
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
  constructor(private readonly transport: Transport) {}
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    const q = encodeURIComponent(query);
    const headers = { accept: "text/html", "user-agent": DDG_USER_AGENT };
    let html: string;
    let selectors = DDG_LITE_SELECTORS;
    try {
      const base = host("DDG_LITE_BASE_URL", "https://lite.duckduckgo.com");
      const url = `${base}/lite/?q=${q}`;
      html = await doFetch<string>(this.transport, "DuckDuckGo", url, { headers, as: "text", allowedHosts: [hostnameOf(url)] });
    } catch {
      const base = host("DDG_HTML_BASE_URL", "https://html.duckduckgo.com");
      const url = `${base}/html/?q=${q}`;
      html = await doFetch<string>(this.transport, "DuckDuckGo", url, { headers, as: "text", allowedHosts: [hostnameOf(url)] });
      selectors = DDG_HTML_SELECTORS;
    }
    const results = await parseDdgResults(html, selectors);
    return results.slice(0, maxResults);
  }
}

// ── Connection-error fallback wrapper ───────────────────────────────

const CONNECTION_ERROR_RE =
  /connection\s*(refused|closed|reset)|econnrefused|econnreset|timed?\s*out|etimedout|dns|enotfound|eai_again|failed\s*to\s*(open|connect)|unable\s*to\s*(connect|resolve)|network\s*error|fetch\s*failed|socket|allowlist|permitted_hosts|requires\s*'network'\s*permission|network\s*denied|upstream\s*error|egress\s*blocked/i;

export function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = String((err as Error & { code?: unknown }).code ?? "");
  return CONNECTION_ERROR_RE.test(`${code} ${err.name} ${err.message}`);
}

export interface SearchOutcome {
  providerName: string;
  results: SearchResult[];
}

export interface FallbackSearchProvider extends SearchProvider {
  readonly fallbackName?: string;
  searchWithOutcome(query: string, maxResults: number): Promise<SearchOutcome>;
}

export function hasOutcome(p: SearchProvider): p is FallbackSearchProvider {
  return typeof (p as FallbackSearchProvider).searchWithOutcome === "function";
}

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
      `[search] ${primary.name} unreachable (${primaryErr.message}); falling back to ${fallback.name}`,
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
 *   JINA_API_KEY (keyed Jina search) > SEARXNG_BASE_URL (SearXNG with a
 *   one-shot DuckDuckGo fallback) > DuckDuckGo (keyless default).
 *
 * URL reading always uses Jina (the only keyless HTML-to-markdown
 * service we trust). The injected `transport` carries the SSRF guard.
 */
export function resolveProviders(
  transport: Transport,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedProviders {
  const jinaKey = env.JINA_API_KEY;
  const reader = new JinaReader(transport, jinaKey);
  if (env.TAVILY_API_KEY)  return { search: new Tavily(transport, env.TAVILY_API_KEY),   reader };
  if (env.BRAVE_API_KEY)   return { search: new Brave(transport, env.BRAVE_API_KEY),    reader };
  if (env.EXA_API_KEY)     return { search: new Exa(transport, env.EXA_API_KEY),        reader };
  if (env.SERPAPI_API_KEY) return { search: new SerpApi(transport, env.SERPAPI_API_KEY), reader };
  if (jinaKey)             return { search: new JinaSearch(transport, jinaKey),          reader };
  const duckduckgo = new DuckDuckGo(transport);
  if (env.SEARXNG_BASE_URL) {
    return { search: withFallback(new SearXNG(transport, env.SEARXNG_BASE_URL), duckduckgo), reader };
  }
  return { search: duckduckgo, reader };
}
