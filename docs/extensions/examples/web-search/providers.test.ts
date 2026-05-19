import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "../../../../src/__tests__/helpers/mock-cleanup";

afterAll(() => {
  // The mock below replaces `@ezcorp/sdk/runtime` for the rest of the
  // bun-test run. Sibling tests need the real channel back; the global
  // preload's afterEach drops the channel singleton but does NOT undo
  // module mocks — this restores them.
  restoreModuleMocks();
});

// ── Mock the SDK runtime BEFORE importing providers ────────────────
// Capture every `fetchPermitted` call so assertions can inspect the URL,
// method, headers, and body. Returning a real `Response` exercises the
// providers' JSON/text parsing paths.

interface Captured {
  url: string;
  init: RequestInit;
}
const calls: Captured[] = [];
let nextResponse: (call: Captured) => Response = () => new Response("{}");

mock.module("@ezcorp/sdk/runtime", () => ({
  fetchPermitted: (url: string | URL, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return Promise.resolve(nextResponse(c));
  },
}));

// Import AFTER the mock is installed so providers resolve to the stub.
import {
  Brave,
  Exa,
  JinaReader,
  JinaSearch,
  resolveProviders,
  SerpApi,
  Tavily,
} from "./providers";

beforeEach(() => {
  calls.length = 0;
  nextResponse = () => new Response("{}");
});

// ── resolveProviders selection matrix ──────────────────────────────

describe("resolveProviders", () => {
  test("no keys → Jina for both", () => {
    const { search, reader } = resolveProviders({} as NodeJS.ProcessEnv);
    expect(search.name).toBe("jina");
    expect(reader.name).toBe("jina");
  });

  test("Tavily key → Tavily; reader stays Jina", () => {
    const { search, reader } = resolveProviders({ TAVILY_API_KEY: "x" } as NodeJS.ProcessEnv);
    expect(search.name).toBe("tavily");
    expect(reader.name).toBe("jina");
  });

  test("Brave key → Brave", () => {
    expect(resolveProviders({ BRAVE_API_KEY: "x" } as NodeJS.ProcessEnv).search.name).toBe("brave");
  });

  test("Exa key → Exa", () => {
    expect(resolveProviders({ EXA_API_KEY: "x" } as NodeJS.ProcessEnv).search.name).toBe("exa");
  });

  test("SerpAPI key → SerpAPI", () => {
    expect(resolveProviders({ SERPAPI_API_KEY: "x" } as NodeJS.ProcessEnv).search.name).toBe("serpapi");
  });

  test("precedence: Tavily > Brave > Exa > SerpAPI", () => {
    expect(
      resolveProviders({
        TAVILY_API_KEY: "t", BRAVE_API_KEY: "b", EXA_API_KEY: "e", SERPAPI_API_KEY: "s",
      } as NodeJS.ProcessEnv).search.name,
    ).toBe("tavily");
    expect(
      resolveProviders({ BRAVE_API_KEY: "b", EXA_API_KEY: "e", SERPAPI_API_KEY: "s" } as NodeJS.ProcessEnv).search.name,
    ).toBe("brave");
    expect(
      resolveProviders({ EXA_API_KEY: "e", SERPAPI_API_KEY: "s" } as NodeJS.ProcessEnv).search.name,
    ).toBe("exa");
  });

  test("default env source is process.env when no arg passed", () => {
    // Use a unique key that definitely isn't set.
    delete process.env.TAVILY_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.EXA_API_KEY;
    delete process.env.SERPAPI_API_KEY;
    expect(resolveProviders().search.name).toBe("jina");
  });
});

// ── JinaSearch ──────────────────────────────────────────────────────

describe("JinaSearch", () => {
  test("parses data[] into SearchResult[] and slices to maxResults", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          data: [
            { title: "T1", url: "https://a", description: "D1" },
            { title: "T2", url: "https://b", content: "C2" },
            { title: "T3", url: "https://c", description: "D3" },
          ],
        }),
      );
    const out = await new JinaSearch().search("bun", 2);
    expect(out).toEqual([
      { title: "T1", url: "https://a", snippet: "D1" },
      { title: "T2", url: "https://b", snippet: "C2" },
    ]);
    expect(calls[0]!.url).toContain("https://s.jina.ai");
    expect(calls[0]!.url).toContain("q=bun");
  });

  test("uses JINA_SEARCH_BASE_URL override when present", async () => {
    process.env.JINA_SEARCH_BASE_URL = "http://127.0.0.1:9";
    try {
      nextResponse = () => new Response(JSON.stringify({ data: [] }));
      await new JinaSearch().search("q", 1);
      expect(calls[0]!.url.startsWith("http://127.0.0.1:9/")).toBe(true);
    } finally {
      delete process.env.JINA_SEARCH_BASE_URL;
    }
  });

  test("adds Authorization header when apiKey supplied", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [] }));
    await new JinaSearch("sk-1").search("q", 1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-1");
  });

  test("omits Authorization header when no apiKey", async () => {
    nextResponse = () => new Response(JSON.stringify({ data: [] }));
    await new JinaSearch().search("q", 1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  test("returns [] when data field is missing", async () => {
    nextResponse = () => new Response(JSON.stringify({}));
    expect(await new JinaSearch().search("q", 5)).toEqual([]);
  });

  test("non-2xx throws with status in message", async () => {
    nextResponse = () => new Response("nope", { status: 503 });
    await expect(new JinaSearch().search("q", 5)).rejects.toThrow("Jina HTTP 503");
  });

  test("malformed JSON throws the dedicated malformed-JSON error", async () => {
    nextResponse = () => new Response("not json", { status: 200 });
    await expect(new JinaSearch().search("q", 5)).rejects.toThrow("Jina returned malformed JSON");
  });
});

// ── JinaReader ──────────────────────────────────────────────────────

describe("JinaReader", () => {
  test("returns body text as markdown", async () => {
    nextResponse = () => new Response("# Hi\n\nbody", { status: 200 });
    const out = await new JinaReader().read("https://example.com");
    expect(out).toBe("# Hi\n\nbody");
    expect(calls[0]!.url).toBe("https://r.jina.ai/https://example.com");
  });

  test("empty body → friendly binary/unreachable error", async () => {
    nextResponse = () => new Response("", { status: 200 });
    await expect(new JinaReader().read("https://x")).rejects.toThrow(/binary or unreachable/);
  });

  test("non-2xx throws with provider-tagged status", async () => {
    nextResponse = () => new Response("nope", { status: 404 });
    await expect(new JinaReader().read("https://x")).rejects.toThrow("Jina HTTP 404");
  });

  test("adds Authorization header when apiKey supplied", async () => {
    nextResponse = () => new Response("md", { status: 200 });
    await new JinaReader("sk-2").read("https://x");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-2");
  });

  test("uses JINA_READER_BASE_URL override when present", async () => {
    process.env.JINA_READER_BASE_URL = "http://127.0.0.1:7";
    try {
      nextResponse = () => new Response("md", { status: 200 });
      await new JinaReader().read("https://x");
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
      new Response(
        JSON.stringify({
          results: [
            { title: "T", url: "https://a", content: "C" },
            { title: "T2", url: "https://b", content: "C2" },
          ],
        }),
      );
    const out = await new Tavily("tav-k").search("bun", 5);
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
    expect(await new Tavily("k").search("q", 3)).toEqual([]);
  });

  test("non-2xx throws with Tavily tag", async () => {
    nextResponse = () => new Response("", { status: 401 });
    await expect(new Tavily("k").search("q", 3)).rejects.toThrow("Tavily HTTP 401");
  });

  test("TAVILY_BASE_URL override is respected", async () => {
    process.env.TAVILY_BASE_URL = "http://127.0.0.1:8";
    try {
      nextResponse = () => new Response(JSON.stringify({ results: [] }));
      await new Tavily("k").search("q", 3);
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
      new Response(
        JSON.stringify({
          web: { results: [{ title: "B", url: "https://b", description: "D" }] },
        }),
      );
    const out = await new Brave("br-k").search("bun", 1);
    expect(out).toEqual([{ title: "B", url: "https://b", snippet: "D" }]);
    expect(calls[0]!.url).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(calls[0]!.url).toContain("q=bun");
    expect(calls[0]!.url).toContain("count=1");
    expect((calls[0]!.init.headers as Record<string, string>)["x-subscription-token"]).toBe("br-k");
  });

  test("missing web.results → empty", async () => {
    nextResponse = () => new Response(JSON.stringify({ web: {} }));
    expect(await new Brave("k").search("q", 5)).toEqual([]);
  });

  test("non-2xx throws with Brave tag", async () => {
    nextResponse = () => new Response("", { status: 429 });
    await expect(new Brave("k").search("q", 1)).rejects.toThrow("Brave HTTP 429");
  });

  test("BRAVE_BASE_URL override is respected", async () => {
    process.env.BRAVE_BASE_URL = "http://127.0.0.1:6";
    try {
      nextResponse = () => new Response(JSON.stringify({ web: { results: [] } }));
      await new Brave("k").search("q", 1);
      expect(calls[0]!.url.startsWith("http://127.0.0.1:6/res/v1/web/search")).toBe(true);
    } finally {
      delete process.env.BRAVE_BASE_URL;
    }
  });
});

// ── Exa ─────────────────────────────────────────────────────────────

describe("Exa", () => {
  test("POSTs { query, numResults } with x-api-key", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({
          results: [{ title: "E", url: "https://e", text: "T" }],
        }),
      );
    const out = await new Exa("ex-k").search("bun", 4);
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
    expect(await new Exa("k").search("q", 3)).toEqual([]);
  });

  test("non-2xx throws with Exa tag", async () => {
    nextResponse = () => new Response("", { status: 500 });
    await expect(new Exa("k").search("q", 3)).rejects.toThrow("Exa HTTP 500");
  });

  test("EXA_BASE_URL override is respected", async () => {
    process.env.EXA_BASE_URL = "http://127.0.0.1:5";
    try {
      nextResponse = () => new Response(JSON.stringify({ results: [] }));
      await new Exa("k").search("q", 1);
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
      new Response(
        JSON.stringify({
          organic_results: [{ title: "S", link: "https://s", snippet: "X" }],
        }),
      );
    const out = await new SerpApi("sa-k").search("bun", 7);
    expect(out).toEqual([{ title: "S", url: "https://s", snippet: "X" }]);
    expect(calls[0]!.url).toContain("https://serpapi.com/search.json");
    expect(calls[0]!.url).toContain("q=bun");
    expect(calls[0]!.url).toContain("num=7");
    expect(calls[0]!.url).toContain("api_key=sa-k");
  });

  test("missing organic_results → empty", async () => {
    nextResponse = () => new Response(JSON.stringify({}));
    expect(await new SerpApi("k").search("q", 1)).toEqual([]);
  });

  test("non-2xx throws with SerpAPI tag", async () => {
    nextResponse = () => new Response("", { status: 403 });
    await expect(new SerpApi("k").search("q", 1)).rejects.toThrow("SerpAPI HTTP 403");
  });

  test("SERPAPI_BASE_URL override is respected", async () => {
    process.env.SERPAPI_BASE_URL = "http://127.0.0.1:4";
    try {
      nextResponse = () => new Response(JSON.stringify({ organic_results: [] }));
      await new SerpApi("k").search("q", 1);
      expect(calls[0]!.url.startsWith("http://127.0.0.1:4/search.json")).toBe(true);
    } finally {
      delete process.env.SERPAPI_BASE_URL;
    }
  });
});

afterEach(() => {
  // Keep module-level captured array small across tests.
  calls.length = 0;
});
