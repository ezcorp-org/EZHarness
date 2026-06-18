/**
 * Shared host search module entry points — `src/search/index.ts`.
 *
 * `performSearch` / `performRead` over INJECTED providers + cache (no
 * live network, no DB): cache hit/miss, fallback-namespace probing,
 * input validation, provider-error wrapping, and result clamping.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { performSearch, performRead, ProviderNotAllowedError } from "../search/index";
import { SearchCache } from "../search/cache";
import type {
  ResolvedProviders,
  SearchProvider,
  SearchResult,
  UrlReader,
  FallbackSearchProvider,
  SearchOutcome,
  Transport,
} from "../search/providers";

afterAll(() => restoreModuleMocks());

// Backend-config bridge stub state (Phase A): the bridge reads
// `getSetting` + `decrypt`. Only the bridge-path tests below populate
// these; every other test in this file passes `env`/`providers` and never
// reaches `resolveSearchBackendEnv`.
let bridgeSettings: Map<string, unknown>;
beforeEach(() => {
  bridgeSettings = new Map();
});
mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => bridgeSettings.get(key),
}));
mock.module("../providers/encryption", () => ({
  decrypt: (ciphertext: string) =>
    ciphertext.startsWith("enc:") ? ciphertext.slice("enc:".length) : ciphertext,
}));

const RESULTS: SearchResult[] = [{ title: "T", url: "https://u", snippet: "S" }];
const MD = "- [T](https://u)\n  S";

function stubSearch(name: string, impl: (q: string, n: number) => Promise<SearchResult[]>): SearchProvider {
  return { name, search: impl };
}

function stubReader(name: string, impl: (url: string) => Promise<string>): UrlReader {
  return { name, read: impl };
}

function providers(search: SearchProvider, reader?: UrlReader): ResolvedProviders {
  return { search, reader: reader ?? stubReader("jina", async () => "md") };
}

let cache: SearchCache;
beforeEach(() => {
  cache = new SearchCache();
});

describe("performSearch", () => {
  test("rejects an empty query", async () => {
    await expect(performSearch("   ", { cache })).rejects.toThrow(/query.*required/);
  });

  test("resolves providers from an injected transport + env when no providers are supplied", async () => {
    // No `providers` → resolve() builds the chain via resolveProviders.
    // Force DuckDuckGo via empty env; the injected transport returns a
    // minimal DDG page (no results) so we exercise the default wiring
    // (index.ts line 74-77) without a live network.
    const transport: Transport = async () => new Response("<html></html>", { status: 200 });
    const out = await performSearch("bun", { cache, transport, env: {} as NodeJS.ProcessEnv });
    expect(out.providerName).toBe("duckduckgo");
    expect(out.markdown).toBe("_No results._");
    expect(out.cached).toBe(false);
  });

  test("runs the provider, formats markdown, and caches under the provider namespace", async () => {
    let calls = 0;
    const p = stubSearch("duckduckgo", async () => {
      calls++;
      return RESULTS;
    });
    const out = await performSearch("bun", { cache, providers: providers(p) });
    expect(out).toEqual({ markdown: MD, providerName: "duckduckgo", cached: false });
    // Second identical call serves from cache (no second provider hit).
    const out2 = await performSearch("bun", { cache, providers: providers(p) });
    expect(out2.cached).toBe(true);
    expect(out2.markdown).toBe(MD);
    expect(calls).toBe(1);
  });

  test("clamps maxResults out of range to the 5 default", async () => {
    let receivedN = -1;
    const p = stubSearch("duckduckgo", async (_q, n) => {
      receivedN = n;
      return [];
    });
    await performSearch("bun", { cache, providers: providers(p), maxResults: 999 });
    expect(receivedN).toBe(5);
  });

  test("honors a valid maxResults and keys the cache on it", async () => {
    const p = stubSearch("duckduckgo", async () => RESULTS);
    await performSearch("bun", { cache, providers: providers(p), maxResults: 3 });
    // A different maxResults is a cache MISS (extra segment differs).
    expect(cache.get(SearchCache.key("duckduckgo", "search", "bun", 3))).toBe(MD);
    expect(cache.get(SearchCache.key("duckduckgo", "search", "bun", 5))).toBeUndefined();
  });

  test("wraps a provider error with the provider name", async () => {
    const p = stubSearch("tavily", async () => {
      throw new Error("Tavily HTTP 401");
    });
    await expect(performSearch("bun", { cache, providers: providers(p) })).rejects.toThrow(
      "Search failed via tavily: Tavily HTTP 401",
    );
  });

  describe("policy provider allowlist (Phase 2)", () => {
    test("throws ProviderNotAllowedError BEFORE any fetch when the resolved provider is disallowed", async () => {
      let calls = 0;
      const p = stubSearch("tavily", async () => {
        calls++;
        return RESULTS;
      });
      await expect(
        performSearch("bun", { cache, providers: providers(p), allowedProviders: ["searxng"] }),
      ).rejects.toBeInstanceOf(ProviderNotAllowedError);
      // No network fetch and nothing cached — the gate is pre-fetch.
      expect(calls).toBe(0);
      expect(cache.get(SearchCache.key("tavily", "search", "bun", 5))).toBeUndefined();
    });

    test("allows the resolved provider when it is in the allowlist", async () => {
      const p = stubSearch("searxng", async () => RESULTS);
      const out = await performSearch("bun", { cache, providers: providers(p), allowedProviders: ["searxng"] });
      expect(out.providerName).toBe("searxng");
    });

    test("allowedProviders 'all' imposes no restriction", async () => {
      const p = stubSearch("tavily", async () => RESULTS);
      const out = await performSearch("bun", { cache, providers: providers(p), allowedProviders: "all" });
      expect(out.providerName).toBe("tavily");
    });
  });

  describe("backend-config bridge (Phase A)", () => {
    test("selects Tavily when a persisted BYOK key bridges (no env/providers supplied)", async () => {
      // Persisted Tavily key only — no opts.env, no opts.providers, so
      // resolve() bridges via resolveSearchBackendEnv → Tavily is selected.
      bridgeSettings.set("provider:apiKey:tavily", "enc:tav-key");
      let capturedUrl = "";
      const transport: Transport = async (req) => {
        capturedUrl = req.url;
        return new Response(
          JSON.stringify({ results: [{ title: "T", url: "https://u", content: "S" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const out = await performSearch("bun", { cache, transport });
      expect(out.providerName).toBe("tavily");
      expect(capturedUrl).toContain("tavily.com");
    });

    test("read path resolves the Jina reader through the bridged env", async () => {
      bridgeSettings.set("provider:apiKey:jina", "enc:jina-key");
      const transport: Transport = async () =>
        new Response("# Page\n\nbody", { status: 200, headers: { "content-type": "text/plain" } });
      const out = await performRead("https://example.com", { cache, transport });
      expect(out.providerName).toBe("jina");
    });
  });

  describe("fallback-namespace caching", () => {
    function fallbackProvider(outcome: SearchOutcome): FallbackSearchProvider {
      return {
        name: "searxng",
        fallbackName: "duckduckgo",
        search: async () => outcome.results,
        searchWithOutcome: async () => outcome,
      };
    }

    test("caches under the FALLBACK namespace when the fallback served", async () => {
      const p = fallbackProvider({ providerName: "duckduckgo", results: RESULTS });
      const out = await performSearch("bun", { cache, providers: providers(p) });
      expect(out.providerName).toBe("duckduckgo");
      // Cached under duckduckgo, NOT searxng (no primary-namespace poison).
      expect(cache.get(SearchCache.key("duckduckgo", "search", "bun", 5))).toBe(MD);
      expect(cache.get(SearchCache.key("searxng", "search", "bun", 5))).toBeUndefined();
    });

    test("a primary-namespace miss probes the fallback namespace before fetching", async () => {
      // Seed the fallback namespace directly.
      cache.set(SearchCache.key("duckduckgo", "search", "bun", 5), "CACHED-FB", 60_000);
      let fetched = false;
      const p: FallbackSearchProvider = {
        name: "searxng",
        fallbackName: "duckduckgo",
        search: async () => {
          fetched = true;
          return RESULTS;
        },
        searchWithOutcome: async () => {
          fetched = true;
          return { providerName: "searxng", results: RESULTS };
        },
      };
      const out = await performSearch("bun", { cache, providers: providers(p) });
      expect(out).toEqual({ markdown: "CACHED-FB", providerName: "duckduckgo", cached: true });
      expect(fetched).toBe(false); // served from the fallback cache, no fetch
    });

    test("primary-namespace hit wins over the fallback namespace", async () => {
      cache.set(SearchCache.key("searxng", "search", "bun", 5), "PRIMARY", 60_000);
      cache.set(SearchCache.key("duckduckgo", "search", "bun", 5), "FALLBACK", 60_000);
      const p: FallbackSearchProvider = {
        name: "searxng",
        fallbackName: "duckduckgo",
        search: async () => RESULTS,
        searchWithOutcome: async () => ({ providerName: "searxng", results: RESULTS }),
      };
      const out = await performSearch("bun", { cache, providers: providers(p) });
      expect(out.markdown).toBe("PRIMARY");
      expect(out.providerName).toBe("searxng");
    });
  });
});

describe("performRead", () => {
  test("rejects an empty url", async () => {
    await expect(performRead("  ", { cache })).rejects.toThrow(/url.*required/);
  });

  test("reads, caches, and truncates to maxChars", async () => {
    let calls = 0;
    const long = "x".repeat(800); // > the 500 floor so truncation is observable
    const reader = stubReader("jina", async () => {
      calls++;
      return long;
    });
    const out = await performRead("https://x", { cache, providers: providers(stubSearch("ddg", async () => []), reader), maxChars: 600 });
    expect(out.cached).toBe(false);
    expect(out.markdown.length).toBe(600);
    expect(out.markdown.endsWith("…")).toBe(true);
    // Second call serves from cache; a tighter maxChars truncation still applies.
    const out2 = await performRead("https://x", {
      cache,
      providers: providers(stubSearch("ddg", async () => []), reader),
      maxChars: 500,
    });
    expect(out2.cached).toBe(true);
    expect(out2.markdown.length).toBe(500);
    expect(calls).toBe(1); // served from cache, reader hit once
  });

  test("clamps maxChars out of range to the 20000 default", async () => {
    const long = "x".repeat(25000);
    const reader = stubReader("jina", async () => long);
    const out = await performRead("https://x", {
      cache,
      providers: providers(stubSearch("ddg", async () => []), reader),
      maxChars: 10, // below the 500 floor → clamped to 20000
    });
    expect(out.markdown.length).toBe(20000);
  });

  test("wraps a reader error with the provider name", async () => {
    const reader = stubReader("jina", async () => {
      throw new Error("Jina HTTP 404");
    });
    await expect(
      performRead("https://x", { cache, providers: providers(stubSearch("ddg", async () => []), reader) }),
    ).rejects.toThrow("Read failed via jina: Jina HTTP 404");
  });
});
