/**
 * Shared provider-chain unit tests — `src/search/providers.ts`.
 *
 * Moved from the web-search extension's `providers.test.ts` (the provider
 * logic now lives ONCE in the host module). The host providers take an
 * INJECTED transport — no `mock.module` of the SDK needed; we drive a
 * capturing transport that returns canned Responses (the substack-pilot
 * ≥95% live-transport pattern: mock at the fetch boundary, never the
 * network).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Brave,
  DuckDuckGo,
  Exa,
  hasOutcome,
  isConnectionError,
  JinaReader,
  JinaSearch,
  makeGuardedTransport,
  resolveProviders,
  SearXNG,
  SerpApi,
  Tavily,
  unwrapDdgRedirect,
  withFallback,
  type SearchProvider,
  type SearchResult,
  type Transport,
  type TransportRequest,
} from "../search/providers";
import type { FetchLike, ResolveHost } from "../search/egress";

// ── Capturing transport ─────────────────────────────────────────────

interface Captured {
  url: string;
  init: RequestInit;
  mode: string;
  allowedHosts?: readonly string[];
}
const calls: Captured[] = [];
let nextResponse: (call: Captured) => Response = () => new Response("{}");

const transport: Transport = (req: TransportRequest) => {
  const c: Captured = {
    url: req.url,
    init: req.init,
    mode: req.mode,
    ...(req.allowedHosts ? { allowedHosts: req.allowedHosts } : {}),
  };
  calls.push(c);
  return Promise.resolve(nextResponse(c));
};

// REAL captured DuckDuckGo pages (sanitized).
const FIXTURES = join(import.meta.dir, "..", "..", "docs", "extensions", "examples", "web-search", "testdata");
const DDG_LITE_FIXTURE = readFileSync(join(FIXTURES, "ddg-lite.html"), "utf8");
const DDG_HTML_FIXTURE = readFileSync(join(FIXTURES, "ddg-html.html"), "utf8");
const DDG_CHALLENGE_FIXTURE = readFileSync(join(FIXTURES, "ddg-challenge.html"), "utf8");

beforeEach(() => {
  calls.length = 0;
  nextResponse = () => new Response("{}");
});
afterEach(() => {
  calls.length = 0;
});

// ── makeGuardedTransport (production transport → SSRF guard) ─────────

describe("makeGuardedTransport", () => {
  test("routes a backend request through guardedFetch with the host allowlist", async () => {
    let dialed = "";
    const fetchImpl: FetchLike = async (url) => {
      dialed = new URL(url).hostname;
      return new Response("ok", { status: 200 });
    };
    const resolveHost: ResolveHost = async () => ["8.8.8.8"];
    const t = makeGuardedTransport({ fetchImpl, resolveHost });
    const res = await t({
      url: "https://api.tavily.com/search",
      init: { method: "GET" },
      mode: "backend",
      allowedHosts: ["api.tavily.com"],
    });
    expect(await res.text()).toBe("ok");
    expect(dialed).toBe("8.8.8.8"); // IP-pinned by the guard
  });

  test("a guarded backend request to a non-allowlisted host is blocked", async () => {
    const t = makeGuardedTransport({
      fetchImpl: async () => new Response("x"),
      resolveHost: async () => ["8.8.8.8"],
    });
    await expect(
      t({ url: "https://evil.test/x", init: {}, mode: "backend", allowedHosts: ["api.tavily.com"] }),
    ).rejects.toThrow(/Backend host not allowed/);
  });
});

// ── resolveProviders selection matrix ──────────────────────────────

describe("resolveProviders", () => {
  test("no env at all → DuckDuckGo search, Jina reader", () => {
    const { search, reader } = resolveProviders(transport, {} as NodeJS.ProcessEnv);
    expect(search.name).toBe("duckduckgo");
    expect(search).toBeInstanceOf(DuckDuckGo);
    expect(reader.name).toBe("jina");
  });

  test("PIN: keyless Jina search is GONE — no env never resolves JinaSearch", () => {
    const { search } = resolveProviders(transport, {} as NodeJS.ProcessEnv);
    expect(search.name).not.toBe("jina");
    expect(search).not.toBeInstanceOf(JinaSearch);
  });

  test("SEARXNG_BASE_URL → searxng-named fallback wrapper", () => {
    const { search } = resolveProviders(transport, { SEARXNG_BASE_URL: "http://localhost:8889" } as NodeJS.ProcessEnv);
    expect(search.name).toBe("searxng");
    expect(hasOutcome(search)).toBe(true);
  });

  test("no SEARXNG_BASE_URL → bare DuckDuckGo (no fallback wrapper)", () => {
    const { search } = resolveProviders(transport, {} as NodeJS.ProcessEnv);
    expect(hasOutcome(search)).toBe(false);
  });

  test("JINA_API_KEY → keyed Jina search beats SearXNG and DuckDuckGo", () => {
    const { search, reader } = resolveProviders(transport, {
      JINA_API_KEY: "jk",
      SEARXNG_BASE_URL: "http://localhost:8889",
    } as NodeJS.ProcessEnv);
    expect(search.name).toBe("jina");
    expect(search).toBeInstanceOf(JinaSearch);
    expect(reader.name).toBe("jina");
  });

  test("Tavily key → Tavily; reader stays Jina", () => {
    const { search, reader } = resolveProviders(transport, { TAVILY_API_KEY: "x" } as NodeJS.ProcessEnv);
    expect(search.name).toBe("tavily");
    expect(reader.name).toBe("jina");
  });

  test("Brave key → Brave", () => {
    expect(resolveProviders(transport, { BRAVE_API_KEY: "x" } as NodeJS.ProcessEnv).search.name).toBe("brave");
  });

  test("Exa key → Exa", () => {
    expect(resolveProviders(transport, { EXA_API_KEY: "x" } as NodeJS.ProcessEnv).search.name).toBe("exa");
  });

  test("SerpAPI key → SerpAPI", () => {
    expect(resolveProviders(transport, { SERPAPI_API_KEY: "x" } as NodeJS.ProcessEnv).search.name).toBe("serpapi");
  });

  test("full precedence: Tavily > Brave > Exa > SerpAPI > keyed Jina > SearXNG > DuckDuckGo", () => {
    const all = {
      TAVILY_API_KEY: "t",
      BRAVE_API_KEY: "b",
      EXA_API_KEY: "e",
      SERPAPI_API_KEY: "s",
      JINA_API_KEY: "j",
      SEARXNG_BASE_URL: "http://localhost:8889",
    };
    const drop = (k: keyof typeof all, env: Partial<typeof all>): Partial<typeof all> => {
      const next = { ...env };
      delete next[k];
      return next;
    };
    let env: Partial<typeof all> = { ...all };
    expect(resolveProviders(transport, env as NodeJS.ProcessEnv).search.name).toBe("tavily");
    env = drop("TAVILY_API_KEY", env);
    expect(resolveProviders(transport, env as NodeJS.ProcessEnv).search.name).toBe("brave");
    env = drop("BRAVE_API_KEY", env);
    expect(resolveProviders(transport, env as NodeJS.ProcessEnv).search.name).toBe("exa");
    env = drop("EXA_API_KEY", env);
    expect(resolveProviders(transport, env as NodeJS.ProcessEnv).search.name).toBe("serpapi");
    env = drop("SERPAPI_API_KEY", env);
    expect(resolveProviders(transport, env as NodeJS.ProcessEnv).search.name).toBe("jina");
    env = drop("JINA_API_KEY", env);
    expect(resolveProviders(transport, env as NodeJS.ProcessEnv).search.name).toBe("searxng");
    env = drop("SEARXNG_BASE_URL", env);
    expect(resolveProviders(transport, env as NodeJS.ProcessEnv).search.name).toBe("duckduckgo");
  });

  test("default env source is process.env when no arg passed", () => {
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.SERPAPI_API_KEY;
    delete process.env.JINA_API_KEY;
    delete process.env.SEARXNG_BASE_URL;
    expect(resolveProviders(transport).search.name).toBe("duckduckgo");
  });
});

// ── JinaSearch ──────────────────────────────────────────────────────

describe("JinaSearch", () => {
  test("parses data[] into SearchResult[] and slices to maxResults", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({
        data: [
          { title: "T1", url: "https://a", description: "D1" },
          { title: "T2", url: "https://b", content: "C2" },
          { title: "T3", url: "https://c", description: "D3" },
        ],
      }));
    const out = await new JinaSearch(transport).search("bun", 2);
    expect(out).toEqual([
      { title: "T1", url: "https://a", snippet: "D1" },
      { title: "T2", url: "https://b", snippet: "C2" },
    ]);
    expect(calls[0]!.url).toContain("https://s.jina.ai");
    expect(calls[0]!.url).toContain("q=bun");
    // Backend mode + the Jina host allowlisted.
    expect(calls[0]!.mode).toBe("backend");
    expect(calls[0]!.allowedHosts).toEqual(["s.jina.ai"]);
  });

  test("uses JINA_SEARCH_BASE_URL override when present", async () => {
    process.env.JINA_SEARCH_BASE_URL = "http://127.0.0.1:9";
    try {
      nextResponse = () => new Response(JSON.stringify({ data: [] }));
      await new JinaSearch(transport).search("q", 1);
      expect(calls[0]!.url.startsWith("http://127.0.0.1:9/")).toBe(true);
    } finally {
      delete process.env.JINA_SEARCH_BASE_URL;
    }
  });

  test("adds Authorization header when apiKey supplied", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [] }));
    await new JinaSearch(transport, "sk-1").search("q", 1);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-1");
  });

  test("omits Authorization header when no apiKey", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [] }));
    await new JinaSearch(transport).search("q", 1);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test("returns [] when data field is missing", async () => {
    nextResponse = () => new Response(JSON.stringify({}));
    expect(await new JinaSearch(transport).search("q", 5)).toEqual([]);
  });

  test("non-2xx throws with status in message", async () => {
    nextResponse = () => new Response("nope", { status: 503 });
    await expect(new JinaSearch(transport).search("q", 5)).rejects.toThrow("Jina HTTP 503");
  });

  test("malformed JSON throws the dedicated malformed-JSON error", async () => {
    nextResponse = () => new Response("not json", { status: 200 });
    await expect(new JinaSearch(transport).search("q", 5)).rejects.toThrow("Jina returned malformed JSON");
  });
});

// ── JinaReader ──────────────────────────────────────────────────────

describe("JinaReader", () => {
  test("returns body text as markdown", async () => {
    nextResponse = () => new Response("# Hi\n\nbody", { status: 200 });
    const out = await new JinaReader(transport).read("https://example.com");
    expect(out).toBe("# Hi\n\nbody");
    expect(calls[0]!.url).toBe("https://r.jina.ai/https://example.com");
    expect(calls[0]!.allowedHosts).toEqual(["r.jina.ai"]);
  });

  test("empty body → friendly binary/unreachable error", async () => {
    nextResponse = () => new Response("", { status: 200 });
    await expect(new JinaReader(transport).read("https://x")).rejects.toThrow(/binary or unreachable/);
  });

  test("non-2xx throws with provider-tagged status", async () => {
    nextResponse = () => new Response("nope", { status: 404 });
    await expect(new JinaReader(transport).read("https://x")).rejects.toThrow("Jina HTTP 404");
  });

  test("adds Authorization header when apiKey supplied", async () => {
    nextResponse = () => new Response("md", { status: 200 });
    await new JinaReader(transport, "sk-2").read("https://x");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-2");
  });

  test("uses JINA_READER_BASE_URL override when present", async () => {
    process.env.JINA_READER_BASE_URL = "http://127.0.0.1:7";
    try {
      nextResponse = () => new Response("md", { status: 200 });
      await new JinaReader(transport).read("https://x");
      expect(calls[0]!.url.startsWith("http://127.0.0.1:7/")).toBe(true);
    } finally {
      delete process.env.JINA_READER_BASE_URL;
    }
  });
});

// ── Tavily ──────────────────────────────────────────────────────────

describe("Tavily", () => {
  test("POSTs api_key + query and parses results[]", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({
        results: [
          { title: "T", url: "https://a", content: "C" },
          { title: "T2", url: "https://b", content: "C2" },
        ],
      }));
    const out = await new Tavily(transport, "tav-k").search("bun", 5);
    expect(out).toEqual([
      { title: "T", url: "https://a", snippet: "C" },
      { title: "T2", url: "https://b", snippet: "C2" },
    ]);
    expect(calls[0]!.url).toBe("https://api.tavily.com/search");
    expect(calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.api_key).toBe("tav-k");
    expect(body.query).toBe("bun");
    expect(body.max_results).toBe(5);
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  test("missing results[] → empty array", async () => {
    nextResponse = () => new Response(JSON.stringify({}));
    expect(await new Tavily(transport, "k").search("q", 3)).toEqual([]);
  });

  test("non-2xx throws with Tavily tag", async () => {
    nextResponse = () => new Response("", { status: 401 });
    await expect(new Tavily(transport, "k").search("q", 3)).rejects.toThrow("Tavily HTTP 401");
  });

  test("TAVILY_BASE_URL override is respected", async () => {
    process.env.TAVILY_BASE_URL = "http://127.0.0.1:8";
    try {
      nextResponse = () => new Response(JSON.stringify({ results: [] }));
      await new Tavily(transport, "k").search("q", 3);
      expect(calls[0]!.url).toBe("http://127.0.0.1:8/search");
    } finally {
      delete process.env.TAVILY_BASE_URL;
    }
  });
});

// ── Brave ───────────────────────────────────────────────────────────

describe("Brave", () => {
  test("GETs /res/v1/web/search and parses web.results[]", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ web: { results: [{ title: "B", url: "https://b", description: "D" }] } }));
    const out = await new Brave(transport, "br-k").search("bun", 1);
    expect(out).toEqual([{ title: "B", url: "https://b", snippet: "D" }]);
    expect(calls[0]!.url).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(calls[0]!.url).toContain("q=bun");
    expect(calls[0]!.url).toContain("count=1");
    expect((calls[0]!.init.headers as Record<string, string>)["x-subscription-token"]).toBe("br-k");
  });

  test("missing web.results → empty", async () => {
    nextResponse = () => new Response(JSON.stringify({ web: {} }));
    expect(await new Brave(transport, "k").search("q", 5)).toEqual([]);
  });

  test("non-2xx throws with Brave tag", async () => {
    nextResponse = () => new Response("", { status: 429 });
    await expect(new Brave(transport, "k").search("q", 1)).rejects.toThrow("Brave HTTP 429");
  });

  test("BRAVE_BASE_URL override is respected", async () => {
    process.env.BRAVE_BASE_URL = "http://127.0.0.1:6";
    try {
      nextResponse = () => new Response(JSON.stringify({ web: { results: [] } }));
      await new Brave(transport, "k").search("q", 1);
      expect(calls[0]!.url.startsWith("http://127.0.0.1:6/res/v1/web/search")).toBe(true);
    } finally {
      delete process.env.BRAVE_BASE_URL;
    }
  });
});

// ── Exa ─────────────────────────────────────────────────────────────

describe("Exa", () => {
  test("POSTs { query, numResults } with x-api-key", async () => {
    nextResponse = () => new Response(JSON.stringify({ results: [{ title: "E", url: "https://e", text: "T" }] }));
    const out = await new Exa(transport, "ex-k").search("bun", 4);
    expect(out).toEqual([{ title: "E", url: "https://e", snippet: "T" }]);
    expect(calls[0]!.url).toBe("https://api.exa.ai/search");
    expect(calls[0]!.init.method).toBe("POST");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.query).toBe("bun");
    expect(body.numResults).toBe(4);
    expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("ex-k");
  });

  test("missing results[] → empty", async () => {
    nextResponse = () => new Response(JSON.stringify({}));
    expect(await new Exa(transport, "k").search("q", 3)).toEqual([]);
  });

  test("non-2xx throws with Exa tag", async () => {
    nextResponse = () => new Response("", { status: 500 });
    await expect(new Exa(transport, "k").search("q", 3)).rejects.toThrow("Exa HTTP 500");
  });

  test("EXA_BASE_URL override is respected", async () => {
    process.env.EXA_BASE_URL = "http://127.0.0.1:5";
    try {
      nextResponse = () => new Response(JSON.stringify({ results: [] }));
      await new Exa(transport, "k").search("q", 1);
      expect(calls[0]!.url).toBe("http://127.0.0.1:5/search");
    } finally {
      delete process.env.EXA_BASE_URL;
    }
  });
});

// ── SerpAPI ─────────────────────────────────────────────────────────

describe("SerpApi", () => {
  test("GETs with api_key in query string and parses organic_results", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ organic_results: [{ title: "S", link: "https://s", snippet: "X" }] }));
    const out = await new SerpApi(transport, "sa-k").search("bun", 7);
    expect(out).toEqual([{ title: "S", url: "https://s", snippet: "X" }]);
    expect(calls[0]!.url).toContain("https://serpapi.com/search.json");
    expect(calls[0]!.url).toContain("q=bun");
    expect(calls[0]!.url).toContain("num=7");
    expect(calls[0]!.url).toContain("api_key=sa-k");
  });

  test("missing organic_results → empty", async () => {
    nextResponse = () => new Response(JSON.stringify({}));
    expect(await new SerpApi(transport, "k").search("q", 1)).toEqual([]);
  });

  test("non-2xx throws with SerpAPI tag", async () => {
    nextResponse = () => new Response("", { status: 403 });
    await expect(new SerpApi(transport, "k").search("q", 1)).rejects.toThrow("SerpAPI HTTP 403");
  });

  test("SERPAPI_BASE_URL override is respected", async () => {
    process.env.SERPAPI_BASE_URL = "http://127.0.0.1:4";
    try {
      nextResponse = () => new Response(JSON.stringify({ organic_results: [] }));
      await new SerpApi(transport, "k").search("q", 1);
      expect(calls[0]!.url.startsWith("http://127.0.0.1:4/search.json")).toBe(true);
    } finally {
      delete process.env.SERPAPI_BASE_URL;
    }
  });
});

// ── SearXNG ─────────────────────────────────────────────────────────

describe("SearXNG", () => {
  const SX_BODY = JSON.stringify({
    results: [
      { title: "S1", url: "https://a", content: "C1" },
      { title: "S2", url: "https://b", content: "C2" },
      { title: "S3", url: "https://c", content: "C3" },
    ],
  });

  test("GETs /search?q&format=json&safesearch=1 with accept header; sanctioned host allowlisted", async () => {
    nextResponse = () => new Response(SX_BODY);
    await new SearXNG(transport, "http://searxng:8080").search("bun runtime", 5);
    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("http://searxng:8080");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("bun runtime");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("safesearch")).toBe("1");
    expect((calls[0]!.init.headers as Record<string, string>).accept).toBe("application/json");
    // The sanctioned internal host is passed in the backend allowlist.
    expect(calls[0]!.mode).toBe("backend");
    expect(calls[0]!.allowedHosts).toEqual(["searxng"]);
  });

  test("trailing slash(es) on base URL are stripped", async () => {
    nextResponse = () => new Response(SX_BODY);
    await new SearXNG(transport, "http://localhost:8889//").search("q", 1);
    expect(calls[0]!.url.startsWith("http://localhost:8889/search?")).toBe(true);
  });

  test("parses results[] into SearchResult[] and truncates to maxResults", async () => {
    nextResponse = () => new Response(SX_BODY);
    const out = await new SearXNG(transport, "http://x").search("q", 2);
    expect(out).toEqual([
      { title: "S1", url: "https://a", snippet: "C1" },
      { title: "S2", url: "https://b", snippet: "C2" },
    ]);
  });

  test("missing results[] → empty array", async () => {
    nextResponse = () => new Response(JSON.stringify({}));
    expect(await new SearXNG(transport, "http://x").search("q", 5)).toEqual([]);
  });

  test("result entries with missing fields → empty-string tolerance, no throw", async () => {
    nextResponse = () => new Response(JSON.stringify({ results: [{}] }));
    expect(await new SearXNG(transport, "http://x").search("q", 5)).toEqual([{ title: "", url: "", snippet: "" }]);
  });

  test("malformed JSON throws the dedicated malformed-JSON error", async () => {
    nextResponse = () => new Response("<html>not json</html>", { status: 200 });
    await expect(new SearXNG(transport, "http://x").search("q", 5)).rejects.toThrow("SearXNG returned malformed JSON");
  });

  test("non-2xx throws with status", async () => {
    nextResponse = () => new Response("Forbidden", { status: 403 });
    await expect(new SearXNG(transport, "http://x").search("q", 5)).rejects.toThrow("SearXNG HTTP 403");
  });
});

// ── DuckDuckGo ──────────────────────────────────────────────────────

describe("DuckDuckGo", () => {
  test("lite happy path: parses the real captured fixture", async () => {
    nextResponse = () => new Response(DDG_LITE_FIXTURE, { headers: { "content-type": "text/html" } });
    const out = await new DuckDuckGo(transport).search("bun javascript runtime", 10);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://lite.duckduckgo.com/lite/?q=bun%20javascript%20runtime");
    expect(out.length).toBe(10);
    expect(out[0]).toEqual({
      title: "Bun — A fast all-in-one JavaScript runtime",
      url: "https://bun.sh/",
      snippet:
        "Bundle, install, and run JavaScript & TypeScript — all in Bun. Bun is a new JavaScript runtime with a native bundler, transpiler, task runner, and npm client built-in.",
    });
    for (const r of out) {
      expect(r.url).not.toContain("duckduckgo.com/l/");
      expect(r.url).not.toContain("uddg=");
    }
  });

  test("sends a desktop User-Agent and accept: text/html", async () => {
    nextResponse = () => new Response(DDG_LITE_FIXTURE);
    await new DuckDuckGo(transport).search("q", 1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["user-agent"]).toContain("Mozilla/5.0");
    expect(headers.accept).toBe("text/html");
  });

  test("maxResults truncation", async () => {
    nextResponse = () => new Response(DDG_LITE_FIXTURE);
    const out = await new DuckDuckGo(transport).search("q", 3);
    expect(out.length).toBe(3);
  });

  test("lite HTTP error → falls back to html.duckduckgo.com and parses its markup", async () => {
    nextResponse = (c) =>
      c.url.includes("lite.duckduckgo.com")
        ? new Response("blocked", { status: 500 })
        : new Response(DDG_HTML_FIXTURE, { headers: { "content-type": "text/html" } });
    const out = await new DuckDuckGo(transport).search("bun javascript runtime", 5);
    expect(calls.length).toBe(2);
    expect(calls[1]!.url).toBe("https://html.duckduckgo.com/html/?q=bun%20javascript%20runtime");
    expect((calls[1]!.init.headers as Record<string, string>)["user-agent"]).toContain("Mozilla/5.0");
    expect(out.length).toBe(5);
    expect(out[0]!.url).toBe("https://bun.sh/");
    expect(out[0]!.title).toBe("Bun — A fast all-in-one JavaScript runtime");
  });

  test("lite connection error → falls back to html variant", async () => {
    nextResponse = (c) => {
      if (c.url.includes("lite.duckduckgo.com")) {
        throw new Error("ConnectionRefused: Unable to connect");
      }
      return new Response(DDG_HTML_FIXTURE);
    };
    const out = await new DuckDuckGo(transport).search("q", 2);
    expect(out.length).toBe(2);
  });

  test("challenge page (real no-UA capture) → 0 results, no throw", async () => {
    nextResponse = () => new Response(DDG_CHALLENGE_FIXTURE, { status: 202 });
    const out = await new DuckDuckGo(transport).search("q", 5);
    expect(out).toEqual([]);
  });

  test("both endpoints erroring → throws with DuckDuckGo tag", async () => {
    nextResponse = () => new Response("nope", { status: 503 });
    await expect(new DuckDuckGo(transport).search("q", 5)).rejects.toThrow("DuckDuckGo HTTP 503");
    expect(calls.length).toBe(2);
  });

  test("decodes HTML entities in titles and snippets (named + numeric forms)", async () => {
    const html = `<table><tr><td>
      <a rel="nofollow" href="https://example.com/a" class='result-link'>R&amp;D &#x27;quoted&#x27; &#8212; ok</a>
      </td></tr><tr><td class='result-snippet'>1 &lt; 2 &gt; 0, &quot;q&quot; &#39;a&#39;&nbsp;end</td></tr></table>`;
    nextResponse = () => new Response(html);
    const out = await new DuckDuckGo(transport).search("q", 5);
    expect(out).toEqual([
      { title: "R&D 'quoted' — ok", url: "https://example.com/a", snippet: `1 < 2 > 0, "q" 'a' end` },
    ]);
  });

  test("DDG_LITE_BASE_URL / DDG_HTML_BASE_URL overrides are respected", async () => {
    process.env.DDG_LITE_BASE_URL = "http://127.0.0.1:3";
    process.env.DDG_HTML_BASE_URL = "http://127.0.0.1:2";
    try {
      nextResponse = (c) =>
        c.url.startsWith("http://127.0.0.1:3")
          ? new Response("err", { status: 500 })
          : new Response(DDG_HTML_FIXTURE);
      await new DuckDuckGo(transport).search("q", 1);
      expect(calls[0]!.url.startsWith("http://127.0.0.1:3/lite/?q=")).toBe(true);
      expect(calls[1]!.url.startsWith("http://127.0.0.1:2/html/?q=")).toBe(true);
    } finally {
      delete process.env.DDG_LITE_BASE_URL;
      delete process.env.DDG_HTML_BASE_URL;
    }
  });
});

// ── unwrapDdgRedirect ───────────────────────────────────────────────

describe("unwrapDdgRedirect", () => {
  test("protocol-relative redirect → decoded target URL", () => {
    expect(unwrapDdgRedirect("//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2F&rut=0000")).toBe("https://bun.sh/");
  });
  test("absolute redirect → decoded target URL", () => {
    expect(unwrapDdgRedirect("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1")).toBe(
      "https://example.com/a?b=1",
    );
  });
  test("direct URL passes through unchanged", () => {
    expect(unwrapDdgRedirect("https://bun.sh")).toBe("https://bun.sh");
  });
  test("double-encoded uddg → exactly one decode pass", () => {
    expect(unwrapDdgRedirect("//duckduckgo.com/l/?uddg=https%253A%252F%252Fbun.sh%252F&rut=0000")).toBe(
      "https%3A%2F%2Fbun.sh%2F",
    );
  });
  test("duckduckgo URL without uddg param passes through", () => {
    expect(unwrapDdgRedirect("https://duckduckgo.com/l/?rut=abc")).toBe("https://duckduckgo.com/l/?rut=abc");
  });
  test("malformed href passes through", () => {
    expect(unwrapDdgRedirect("not a url")).toBe("not a url");
  });
});

// ── isConnectionError ───────────────────────────────────────────────

describe("isConnectionError", () => {
  test.each([
    "ConnectionRefused: Unable to connect. Is the computer able to access the url?",
    "ECONNREFUSED",
    "The operation timed out",
    "ETIMEDOUT",
    "DNS lookup failed",
    "getaddrinfo ENOTFOUND searxng",
    "fetch failed",
    "socket hang up",
    'fetch to "http://my-searxng:8080/" blocked: hostname not in EZCORP_PERMITTED_HOSTS allowlist',
    "blocked — extension requires 'network' permission",
    "Network denied: missing network grant for host 'my-searxng'",
    "Upstream error: Unable to connect. Is the computer able to access the url?",
    // Host SSRF guard block — treated as connection-class so SearXNG→DDG
    // fallback still triggers when the guard rejects an internal target.
    "Egress blocked (private-ip): searxng → 10.0.0.7",
  ])("true for %p", (msg) => {
    expect(isConnectionError(new Error(msg))).toBe(true);
  });

  test("true when the code property is connection-class", () => {
    const err = Object.assign(new Error("request failed"), { code: "ECONNRESET" });
    expect(isConnectionError(err)).toBe(true);
  });

  test.each([
    "SearXNG HTTP 503",
    "SearXNG HTTP 403",
    "SearXNG returned malformed JSON",
    "something else entirely",
  ])("false for %p", (msg) => {
    expect(isConnectionError(new Error(msg))).toBe(false);
  });

  test("false for non-Error values", () => {
    expect(isConnectionError("ECONNREFUSED")).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});

// ── withFallback ────────────────────────────────────────────────────

describe("withFallback", () => {
  const RESULTS: SearchResult[] = [{ title: "T", url: "https://u", snippet: "S" }];

  function fakeProvider(name: string, impl: () => Promise<SearchResult[]>): SearchProvider & { calls: number } {
    const p = {
      name,
      calls: 0,
      async search(): Promise<SearchResult[]> {
        p.calls++;
        return impl();
      },
    };
    return p;
  }

  let errorSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("wrapper keeps the primary's name (cache GET namespace)", () => {
    const wrapped = withFallback(fakeProvider("searxng", async () => RESULTS), fakeProvider("duckduckgo", async () => []));
    expect(wrapped.name).toBe("searxng");
  });

  test("wrapper exposes fallbackName", () => {
    const wrapped = withFallback(fakeProvider("searxng", async () => RESULTS), fakeProvider("duckduckgo", async () => []));
    expect(wrapped.fallbackName).toBe("duckduckgo");
  });

  test("primary success → primary's outcome, fallback untouched", async () => {
    const primary = fakeProvider("searxng", async () => RESULTS);
    const fallback = fakeProvider("duckduckgo", async () => []);
    const outcome = await withFallback(primary, fallback).searchWithOutcome("q", 5);
    expect(outcome).toEqual({ providerName: "searxng", results: RESULTS });
    expect(fallback.calls).toBe(0);
  });

  test("connection error → one-shot fallback; outcome carries the FALLBACK's name", async () => {
    const primary = fakeProvider("searxng", async () => {
      throw new Error("ConnectionRefused: Unable to connect");
    });
    const fallback = fakeProvider("duckduckgo", async () => RESULTS);
    const outcome = await withFallback(primary, fallback).searchWithOutcome("q", 5);
    expect(outcome).toEqual({ providerName: "duckduckgo", results: RESULTS });
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("HTTP error from a healthy primary → NO fallback, error surfaces as-is", async () => {
    const primary = fakeProvider("searxng", async () => {
      throw new Error("SearXNG HTTP 503");
    });
    const fallback = fakeProvider("duckduckgo", async () => RESULTS);
    await expect(withFallback(primary, fallback).searchWithOutcome("q", 5)).rejects.toThrow("SearXNG HTTP 503");
    expect(fallback.calls).toBe(0);
  });

  test("both fail → combined error naming both providers", async () => {
    const primary = fakeProvider("searxng", async () => {
      throw new Error("ECONNREFUSED");
    });
    const fallback = fakeProvider("duckduckgo", async () => {
      throw new Error("DuckDuckGo HTTP 503");
    });
    await expect(withFallback(primary, fallback).searchWithOutcome("q", 5)).rejects.toThrow(
      "searxng unreachable (ECONNREFUSED); duckduckgo fallback failed: DuckDuckGo HTTP 503",
    );
  });

  test("plain SearchProvider.search() delegates through the same path", async () => {
    const primary = fakeProvider("searxng", async () => {
      throw new Error("ECONNREFUSED");
    });
    const fallback = fakeProvider("duckduckgo", async () => RESULTS);
    const out = await withFallback(primary, fallback).search("q", 5);
    expect(out).toEqual(RESULTS);
  });

  test("hasOutcome distinguishes wrapped from bare providers", () => {
    const bare = fakeProvider("duckduckgo", async () => RESULTS);
    expect(hasOutcome(bare)).toBe(false);
    expect(hasOutcome(withFallback(bare, bare))).toBe(true);
  });
});
