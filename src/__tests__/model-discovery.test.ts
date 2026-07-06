/**
 * Unit tests for the hybrid model-discovery module.
 *
 * Exercises the real listModels() (reused from local-model-check) and the
 * real models.dev catalog parsing by stubbing globalThis.fetch and routing
 * by URL. Covers: provider-direct happy paths (with auth headers),
 * catalog enrichment, the chat-capability id filter, every fallback edge
 * (direct non-200 / empty / no-direct-provider / no-credential /
 * catalog-down), credential-less behaviour, and the catalog cache.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import {
  fetchProviderModels,
  _resetCatalogCache,
} from "../providers/model-discovery";
import type { ProviderCredential } from "../providers/credentials";

// ── Fixtures ──────────────────────────────────────────────────────────

const APIKEY: ProviderCredential = { type: "apikey", token: "sk-test-123" };

const CATALOG = {
  openai: {
    id: "openai",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: false,
        modalities: { input: ["text", "image"], output: ["text"] },
        cost: { input: 2.5, output: 10 },
        limit: { context: 200_000, output: 16_384 },
      },
      "text-embedding-3-large": {
        id: "text-embedding-3-large",
        modalities: { output: ["embedding"] },
      },
    },
  },
  anthropic: {
    id: "anthropic",
    models: {
      "claude-sonnet-4": {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        modalities: { output: ["text"] },
        cost: { input: 3, output: 15 },
        limit: { context: 200_000 },
      },
    },
  },
  google: {
    id: "google",
    models: {
      "gemini-2.0-flash": {
        id: "gemini-2.0-flash",
        name: "Gemini 2.0 Flash",
        modalities: { output: ["text"] },
        limit: { context: 1_000_000 },
      },
    },
  },
};

// ── Fetch mock ────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;
let calls: Array<{ url: string; init?: RequestInit }>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RouteCfg {
  catalogStatus?: number; // models.dev status (default 200)
  openaiModels?: unknown; // body for api.openai.com/v1/models
  openaiStatus?: number; // status for api.openai.com/v1/models (default 200)
  anthropicModels?: unknown;
  anthropicStatus?: number;
  openrouterModels?: unknown; // body for openrouter.ai/api/v1/models
  openrouterStatus?: number;
}

function route(cfg: RouteCfg) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("models.dev")) {
      const s = cfg.catalogStatus ?? 200;
      return Promise.resolve(s === 200 ? json(CATALOG) : json({}, s));
    }
    if (url.includes("api.openai.com/v1/models")) {
      const s = cfg.openaiStatus ?? 200;
      if (s !== 200) return Promise.resolve(json({}, s));
      return Promise.resolve(json(cfg.openaiModels ?? { data: [] }));
    }
    if (url.includes("api.anthropic.com/v1/models")) {
      const s = cfg.anthropicStatus ?? 200;
      if (s !== 200) return Promise.resolve(json({}, s));
      return Promise.resolve(json(cfg.anthropicModels ?? { data: [] }));
    }
    if (url.includes("openrouter.ai/api/v1/models")) {
      const s = cfg.openrouterStatus ?? 200;
      if (s !== 200) return Promise.resolve(json({}, s));
      return Promise.resolve(json(cfg.openrouterModels ?? { data: [] }));
    }
    if (url.includes("/api/tags")) return Promise.resolve(json({}, 404));
    return Promise.reject(new Error(`unmocked: ${url}`));
  });
}

beforeEach(() => {
  calls = [];
  mockFetch = mock(() => Promise.reject(new Error("unmocked fetch")));
  globalThis.fetch = mockFetch as any;
  _resetCatalogCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetCatalogCache();
});

// ── Provider-direct happy path ────────────────────────────────────────

describe("provider-direct discovery", () => {
  test("openai: lists from /v1/models with Bearer auth, enriched by catalog", async () => {
    route({
      openaiModels: {
        data: [
          { id: "gpt-5.2" },
          { id: "gpt-4o" },
          { id: "text-embedding-3-large" },
        ],
      },
    });

    const models = await fetchProviderModels("openai", APIKEY);
    const ids = models.map((m) => m.id).sort();

    // embedding id is filtered out
    expect(ids).toEqual(["gpt-4o", "gpt-5.2"]);

    // gpt-4o enriched from catalog (context 200k, real cost)
    const gpt4o = models.find((m) => m.id === "gpt-4o")!;
    expect(gpt4o.contextWindow).toBe(200_000);
    expect(gpt4o.cost.input).toBe(2.5);
    expect(gpt4o.provider).toBe("openai");

    // gpt-5.2 not in catalog → safe defaults
    const gpt52 = models.find((m) => m.id === "gpt-5.2")!;
    expect(gpt52.contextWindow).toBe(128_000);
    expect(gpt52.cost.input).toBe(0);

    // Bearer header was sent to the provider endpoint
    const providerCall = calls.find((c) =>
      c.url.includes("api.openai.com/v1/models"),
    )!;
    const headers = providerCall.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-123");
  });

  test("anthropic: sends x-api-key + anthropic-version headers", async () => {
    route({ anthropicModels: { data: [{ id: "claude-sonnet-4" }] } });

    const models = await fetchProviderModels("anthropic", APIKEY);
    expect(models.map((m) => m.id)).toEqual(["claude-sonnet-4"]);

    const providerCall = calls.find((c) =>
      c.url.includes("api.anthropic.com/v1/models"),
    )!;
    const headers = providerCall.init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test-123");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("openrouter: credential drives the DIRECT /v1/models path with Bearer auth", async () => {
    route({
      openrouterModels: {
        data: [{ id: "anthropic/claude-3.5-sonnet" }, { id: "openai/gpt-4o" }],
      },
    });

    const models = await fetchProviderModels("openrouter", APIKEY);
    const ids = models.map((m) => m.id).sort();
    expect(ids).toEqual(["anthropic/claude-3.5-sonnet", "openai/gpt-4o"]);

    // api + baseUrl come from PROVIDER_DEFAULTS for openrouter
    for (const m of models) {
      expect(m.provider).toBe("openrouter");
      expect(m.api).toBe("openai-completions");
      expect(m.baseUrl).toBe("https://openrouter.ai/api/v1");
    }

    // Bearer header was sent to the openrouter endpoint (DIRECT path used)
    const providerCall = calls.find((c) =>
      c.url.includes("openrouter.ai/api/v1/models"),
    )!;
    const headers = providerCall.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-123");
  });

  test("openrouter is a supported provider — not the unknown-provider guard", async () => {
    // No credential, and the catalog fixture has no openrouter entry, so this
    // still throws — but the message must be the catalog-miss, proving
    // openrouter cleared the PROVIDER_DEFAULTS "not supported" guard.
    route({});
    let err: unknown;
    try {
      await fetchProviderModels("openrouter");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/not supported for provider/);
    expect((err as Error).message).toMatch(/no "openrouter" entry/);
  });
});

// ── Fallbacks ─────────────────────────────────────────────────────────

describe("fallback to catalog", () => {
  test("direct non-200 → catalog", async () => {
    route({ openaiStatus: 401 });
    const models = await fetchProviderModels("openai", APIKEY);
    // catalog has gpt-4o (chat) and an embedding (filtered)
    expect(models.map((m) => m.id)).toEqual(["gpt-4o"]);
  });

  test("direct empty list → catalog", async () => {
    route({ openaiModels: { data: [] } });
    const models = await fetchProviderModels("openai", APIKEY);
    expect(models.map((m) => m.id)).toEqual(["gpt-4o"]);
  });

  test("google has no direct endpoint → catalog even with credential", async () => {
    route({});
    const models = await fetchProviderModels("google", APIKEY);
    expect(models.map((m) => m.id)).toEqual(["gemini-2.0-flash"]);
    // never attempted a google provider fetch
    expect(calls.some((c) => c.url.includes("generativelanguage"))).toBe(false);
  });

  test("no credential → catalog only, provider endpoint untouched", async () => {
    route({ openaiModels: { data: [{ id: "gpt-5.2" }] } });
    const models = await fetchProviderModels("openai");
    expect(models.map((m) => m.id)).toEqual(["gpt-4o"]);
    expect(calls.some((c) => c.url.includes("api.openai.com"))).toBe(false);
  });
});

// ── Catalog-down behaviour ────────────────────────────────────────────

describe("catalog unavailable", () => {
  test("direct still works with default metadata", async () => {
    route({ catalogStatus: 503, openaiModels: { data: [{ id: "gpt-5.2" }] } });
    const models = await fetchProviderModels("openai", APIKEY);
    expect(models.map((m) => m.id)).toEqual(["gpt-5.2"]);
    expect(models[0]!.contextWindow).toBe(128_000);
  });

  test("no direct + no catalog → throws", async () => {
    route({ catalogStatus: 503 });
    let err: unknown;
    try {
      await fetchProviderModels("openai");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/models\.dev is unavailable/);
  });
});

// ── Guards & cache ────────────────────────────────────────────────────

describe("guards and cache", () => {
  test("unknown provider throws", async () => {
    route({});
    let err: unknown;
    try {
      await fetchProviderModels("mistral", APIKEY);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/not supported for provider: mistral/);
  });

  test("catalog is cached across calls until reset", async () => {
    route({});
    await fetchProviderModels("google", APIKEY);
    await fetchProviderModels("google", APIKEY);
    const catalogHits = () =>
      calls.filter((c) => c.url.includes("models.dev")).length;
    expect(catalogHits()).toBe(1);

    _resetCatalogCache();
    await fetchProviderModels("google", APIKEY);
    expect(catalogHits()).toBe(2);
  });
});
