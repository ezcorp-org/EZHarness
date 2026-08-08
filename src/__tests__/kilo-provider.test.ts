/**
 * Kilo wired into the provider stack.
 *
 *   T1  the wire model — a Kilo id must dial the gateway, never api.openai.com
 *   T2  the picker: free-only until a key is saved, whole catalog after
 *   T3  the credential: keyless is a USABLE state for Kilo and only for Kilo
 *   T4  routing: a deployment with NOTHING configured resolves a free Kilo
 *       model at EVERY tier — the property the free tier exists to deliver
 *   T5  routing precedence: Kilo never displaces a configured provider
 *   T6  discovery parses the gateway's own catalog shape
 */

import { describe, test, expect, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const mockGetSetting = mock((_key?: string) => Promise.resolve<unknown>(undefined));
mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

afterAll(() => restoreModuleMocks());

import { getModelRegistry, resolveModelObject } from "../providers/registry";
import { getCredential } from "../providers/credentials";
import { resolveModel } from "../providers/router";
import { fetchProviderModels } from "../providers/model-discovery";
import {
  KILO_BASE_URL,
  KILO_FREE_AUTO_MODEL,
  KILO_SEED_MODELS,
  kiloPickerEntries,
  kiloRoutingEntries,
} from "../providers/kilo";
import { KILO_PROVIDER } from "../runtime/routing/llm-providers";

/** Every provider env var this process might inherit, so a developer's shell
 *  cannot decide which branch a routing test takes. */
const PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "KILO_API_KEY",
];
let savedEnv: Record<string, string | undefined> = {};

/** Settings state: nothing configured anywhere. */
function nothingConfigured() {
  mockGetSetting.mockImplementation(() => Promise.resolve(undefined));
}

/** Settings state: a Kilo BYOK key is saved. */
function kiloKeyConfigured() {
  mockGetSetting.mockImplementation(((key: string) =>
    Promise.resolve(key === `provider:apiKey:${KILO_PROVIDER}` ? "encrypted-blob" : undefined)) as never);
}

beforeEach(() => {
  savedEnv = {};
  for (const k of PROVIDER_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  mockGetSetting.mockReset();
  nothingConfigured();
});

afterEach(() => {
  for (const k of PROVIDER_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("T1 the wire model", () => {
  test("a seeded Kilo id resolves to the gateway with the OpenAI-completions api", () => {
    const model = resolveModelObject(KILO_PROVIDER, KILO_FREE_AUTO_MODEL);
    expect(model.provider).toBe(KILO_PROVIDER);
    expect(model.baseUrl).toBe(KILO_BASE_URL);
    expect(model.api).toBe("openai-completions");
    expect(model.contextWindow).toBe(256_000);
  });

  test("an UNSEEDED Kilo id still dials the gateway, not api.openai.com", () => {
    // The regression this branch exists for: without it the generic fallback
    // points a Kilo pin at OpenAI with Kilo credentials, which fails as a
    // baffling wrong-provider auth error instead of a model-not-found.
    const model = resolveModelObject(KILO_PROVIDER, "vendor/never-heard-of-it");
    expect(model.baseUrl).toBe(KILO_BASE_URL);
    expect(model.api).toBe("openai-completions");
  });

  test("the gateway root is passed through verbatim — no /v1 appended", () => {
    // pi-ai's client appends `/chat/completions`; the measured endpoint is
    // `…/api/gateway/chat/completions`, so a `/v1` here would 404 every turn.
    expect(resolveModelObject(KILO_PROVIDER, KILO_FREE_AUTO_MODEL).baseUrl).not.toContain("/v1");
  });

  test("no other provider is affected by the Kilo branch", () => {
    expect(resolveModelObject("anthropic", "claude-haiku-4-5-20251001").provider).toBe("anthropic");
  });
});

describe("T2 the picker", () => {
  test("with no key, ONLY free models are listed", async () => {
    const entries = await kiloPickerEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.id)).toEqual([KILO_FREE_AUTO_MODEL]);
    expect(entries.every((e) => e.provider === KILO_PROVIDER)).toBe(true);
  });

  test("with a key, the paid auto-routers appear too", async () => {
    kiloKeyConfigured();
    const ids = (await kiloPickerEntries()).map((e) => e.id);
    expect(ids).toEqual(KILO_SEED_MODELS.map((m) => m.id));
    expect(ids).toContain("kilo-auto/frontier");
  });

  test("a KILO_API_KEY env var unlocks the paid catalog too", async () => {
    process.env.KILO_API_KEY = "sk-kilo-test";
    expect((await kiloPickerEntries()).map((e) => e.id)).toContain("kilo-auto/frontier");
  });

  test("the picker never lists one id twice", async () => {
    kiloKeyConfigured();
    const ids = (await kiloPickerEntries()).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("Kilo's free model reaches the full model registry", async () => {
    const registry = await getModelRegistry();
    const free = registry.find((m) => m.id === KILO_FREE_AUTO_MODEL);
    expect(free).toBeDefined();
    expect(free!.provider).toBe(KILO_PROVIDER);
    expect(free!.costTier).toBe("low");
    // …and no paid Kilo model does, on a keyless deployment.
    expect(registry.some((m) => m.provider === KILO_PROVIDER && m.id === "kilo-auto/frontier")).toBe(false);
  });

  test("seeded auto-routers carry their DECLARED tier, not a price-inferred one", async () => {
    kiloKeyConfigured();
    const entries = await kiloPickerEntries();
    const tierOf = (id: string) => entries.find((e) => e.id === id)!.tier;
    // frontier blends to $30/1M, which the cost heuristic alone reads as
    // "medium" → balanced. It is the frontier class and must say so.
    expect(tierOf("kilo-auto/frontier")).toBe("powerful");
    expect(tierOf("kilo-auto/small")).toBe("fast");
    expect(tierOf("kilo-auto/balanced")).toBe("balanced");
  });
});

describe("T3 the credential", () => {
  test("Kilo authenticates with NO key configured", async () => {
    const cred = await getCredential(KILO_PROVIDER);
    expect(cred.type).toBe("apikey");
    expect(cred.token).toBe("no-key-needed");
  });

  test("every other provider still fails closed with no key", async () => {
    await expect(getCredential("anthropic")).rejects.toThrow(/No credentials available/);
    await expect(getCredential("openrouter")).rejects.toThrow(/No credentials available/);
  });

  test("a configured key wins over the keyless sentinel", async () => {
    process.env.KILO_API_KEY = "sk-kilo-real";
    const cred = await getCredential(KILO_PROVIDER);
    expect(cred.token).toBe("sk-kilo-real");
  });
});

describe("T4 a deployment with nothing configured", () => {
  test.each(["fast", "balanced", "powerful"] as const)(
    "resolves a FREE Kilo model at the %s tier",
    async (tier) => {
      const resolved = await resolveModel(undefined, undefined, tier);
      expect(resolved.provider).toBe(KILO_PROVIDER);
      expect(resolved.model).toBe(KILO_FREE_AUTO_MODEL);
      expect(resolved.piModel.baseUrl).toBe(KILO_BASE_URL);
    },
  );

  test("the routing projection covers all three tiers; the picker one does not", async () => {
    const routing = await kiloRoutingEntries();
    expect(new Set(routing.map((e) => e.tier))).toEqual(new Set(["fast", "balanced", "powerful"]));
    // The fill is routing-only — see kiloRoutingFill.
    expect((await kiloPickerEntries()).length).toBeLessThan(routing.length);
  });

  test("a pinned free Kilo model passes through untouched", async () => {
    const resolved = await resolveModel(KILO_PROVIDER, KILO_FREE_AUTO_MODEL);
    expect(resolved.model).toBe(KILO_FREE_AUTO_MODEL);
    expect(resolved.piModel.baseUrl).toBe(KILO_BASE_URL);
  });
});

describe("T5 precedence", () => {
  test("a configured provider still wins — Kilo is the last resort, not the default", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const resolved = await resolveModel(undefined, undefined, "balanced");
    expect(resolved.provider).toBe("anthropic");
  });

  test("Kilo is reached only after every provider ahead of it is skipped", async () => {
    // No credentials anywhere → the walk falls through to Kilo.
    const resolved = await resolveModel(undefined, undefined, "balanced");
    expect(resolved.provider).toBe(KILO_PROVIDER);
  });

  test("a LOCAL model outranks Kilo — the keyless gateway must not displace it", async () => {
    // Without the demotion, Kilo (which needs no credential) beats the
    // operator's own endpoint on every local-only install, quietly shipping
    // prompts to a third party whose free pool may train on them.
    mockGetSetting.mockImplementation(((key: string) =>
      Promise.resolve(
        key === "provider:customModels"
          ? [{ modelId: "qwen3:1.7b", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" }]
          : undefined,
      )) as never);

    const resolved = await resolveModel(undefined, undefined, "balanced");
    expect(resolved.provider).toBe("ollama");
  });

  test("an EXPLICIT operator ordering still wins over the demotion", async () => {
    // The demotion applies to the self-healed/appended case only. An admin who
    // types kilo into `provider:preferenceOrder` has made a decision.
    mockGetSetting.mockImplementation(((key: string) =>
      Promise.resolve(
        key === "provider:preferenceOrder"
          ? [KILO_PROVIDER, "ollama"]
          : key === "provider:customModels"
            ? [{ modelId: "qwen3:1.7b", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" }]
            : undefined,
      )) as never);

    const resolved = await resolveModel(undefined, undefined, "balanced");
    expect(resolved.provider).toBe(KILO_PROVIDER);
  });
});

describe("T6 discovery", () => {
  const payload = {
    data: [
      {
        id: "vendor/model:free",
        name: "Vendor Model (free)",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        top_provider: { context_length: 32000, max_completion_tokens: 4096 },
        pricing: { prompt: "0", completion: "0" },
        context_length: 32000,
        supported_parameters: ["max_tokens"],
        isFree: true,
      },
    ],
  };

  test("fetches the gateway catalog and maps it to pi-ai models", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const models = await fetchProviderModels(KILO_PROVIDER);
      expect(calls[0]).toBe(`${KILO_BASE_URL}/models`);
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        id: "vendor/model:free",
        provider: KILO_PROVIDER,
        baseUrl: KILO_BASE_URL,
        api: "openai-completions",
        contextWindow: 32000,
        maxTokens: 4096,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an HTTP failure is reported, not swallowed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("upstream down", { status: 503 })) as unknown as typeof fetch;
    try {
      await expect(fetchProviderModels(KILO_PROVIDER)).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an empty catalog is an error rather than a silently emptied provider", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(fetchProviderModels(KILO_PROVIDER)).rejects.toThrow(/no usable models/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("discovered models join the picker, still access-filtered", async () => {
    mockGetSetting.mockImplementation(((key: string) =>
      Promise.resolve(
        key === `provider:discoveredModels:${KILO_PROVIDER}`
          ? [
              ...payload.data,
              { ...payload.data[0], id: "vendor/paid", name: "Vendor Paid", isFree: false },
            ]
          : undefined,
      )) as never);

    const ids = (await kiloPickerEntries()).map((e) => e.id);
    expect(ids).toContain("vendor/model:free");
    expect(ids).not.toContain("vendor/paid");
  });
});
