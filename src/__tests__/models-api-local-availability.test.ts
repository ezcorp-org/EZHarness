/**
 * Tests that the models API endpoint marks local models (those with baseUrl)
 * as available regardless of provider-level credential status.
 *
 * Since the SvelteKit endpoint can't be imported directly, we test the
 * availability logic extracted from web/src/routes/api/models/+server.ts.
 */
import { describe, test, expect, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Mock settings so registry import doesn't need a real DB
const mockGetSetting = mock((_key?: string) => Promise.resolve(undefined));
mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

mock.module("../providers/encryption", () => ({
  encrypt: (text: string) => `encrypted:${text}`,
  decrypt: (text: string) =>
    text.startsWith("encrypted:")
      ? text.slice("encrypted:".length)
      : (() => { throw new Error("bad"); })(),
  _resetKeyCache: () => {},
}));

afterAll(() => restoreModuleMocks());

import { getModelRegistry, type ModelEntry } from "../providers/registry";

/**
 * Mirrors the availability logic from the models API endpoint:
 *   const isLocal = !!m.baseUrl;
 *   result.push(mapModel(m, isLocal || (availability.get(m.provider) ?? false)));
 */
function simulateAvailability(
  models: ModelEntry[],
  providerAvailability: Map<string, boolean>,
) {
  return models.map((m) => ({
    ...m,
    available: !!m.baseUrl || (providerAvailability.get(m.provider) ?? false),
  }));
}

describe("models API local availability logic", () => {
  test("model with baseUrl is available even when provider has no credentials", () => {
    const models: ModelEntry[] = [
      {
        id: "llama3:latest",
        provider: "ollama",
        tier: "balanced",
        contextWindow: 128_000,
        vision: false,
        reasoning: false,
        costTier: "low",
        displayName: "Llama 3",
        baseUrl: "http://localhost:11434",
      },
    ];

    const providerAvailability = new Map([["ollama", false]]);
    const result = simulateAvailability(models, providerAvailability);

    expect(result[0]!.available).toBe(true);
  });

  test("model without baseUrl respects provider availability (available)", () => {
    const models: ModelEntry[] = [
      {
        id: "claude-sonnet-4-20250514",
        provider: "anthropic",
        tier: "balanced",
        contextWindow: 200_000,
        vision: true,
        reasoning: false,
        costTier: "medium",
        displayName: "Claude Sonnet 4",
      },
    ];

    const providerAvailability = new Map([["anthropic", true]]);
    const result = simulateAvailability(models, providerAvailability);

    expect(result[0]!.available).toBe(true);
  });

  test("model without baseUrl respects provider availability (unavailable)", () => {
    const models: ModelEntry[] = [
      {
        id: "claude-sonnet-4-20250514",
        provider: "anthropic",
        tier: "balanced",
        contextWindow: 200_000,
        vision: true,
        reasoning: false,
        costTier: "medium",
        displayName: "Claude Sonnet 4",
      },
    ];

    const providerAvailability = new Map([["anthropic", false]]);
    const result = simulateAvailability(models, providerAvailability);

    expect(result[0]!.available).toBe(false);
  });

  test("custom model with baseUrl for cloud provider is available without credentials", () => {
    const models: ModelEntry[] = [
      {
        id: "my-local-gpt",
        provider: "openai",
        tier: "balanced",
        contextWindow: 128_000,
        vision: false,
        reasoning: false,
        costTier: "low",
        displayName: "My Local GPT",
        baseUrl: "http://localhost:8080/v1",
      },
    ];

    const providerAvailability = new Map([["openai", false]]);
    const result = simulateAvailability(models, providerAvailability);

    expect(result[0]!.available).toBe(true);
  });

  test("mixed models: local gets available, cloud depends on credentials", () => {
    const models: ModelEntry[] = [
      {
        id: "llama3:latest",
        provider: "ollama",
        tier: "balanced",
        contextWindow: 128_000,
        vision: false,
        reasoning: false,
        costTier: "low",
        displayName: "Llama 3",
        baseUrl: "http://localhost:11434",
      },
      {
        id: "gpt-4o",
        provider: "openai",
        tier: "powerful",
        contextWindow: 128_000,
        vision: true,
        reasoning: false,
        costTier: "high",
        displayName: "GPT-4o",
      },
      {
        id: "claude-sonnet-4-20250514",
        provider: "anthropic",
        tier: "balanced",
        contextWindow: 200_000,
        vision: true,
        reasoning: false,
        costTier: "medium",
        displayName: "Claude Sonnet 4",
      },
    ];

    const providerAvailability = new Map<string, boolean>([
      ["ollama", false],
      ["openai", true],
      ["anthropic", false],
    ]);

    const result = simulateAvailability(models, providerAvailability);

    expect(result[0]!.available).toBe(true);  // ollama local -> always available
    expect(result[1]!.available).toBe(true);  // openai has credentials
    expect(result[2]!.available).toBe(false); // anthropic has no credentials
  });

  test("unknown provider without baseUrl defaults to unavailable", () => {
    const models: ModelEntry[] = [
      {
        id: "some-model",
        provider: "unknown-provider",
        tier: "balanced",
        contextWindow: 32_000,
        vision: false,
        reasoning: false,
        costTier: "low",
      },
    ];

    // Provider not in the availability map at all
    const providerAvailability = new Map<string, boolean>();
    const result = simulateAvailability(models, providerAvailability);

    expect(result[0]!.available).toBe(false);
  });

  test("getModelRegistry includes custom models with baseUrl from settings", async () => {
    mockGetSetting.mockImplementation(((key?: string) => {
      if (key === "provider:customModels") {
        return Promise.resolve([
          {
            id: "mistral:latest",
            provider: "ollama",
            baseUrl: "http://localhost:11434",
            contextWindow: 32_000,
          },
        ]);
      }
      return Promise.resolve(undefined);
    }) as any);

    const models = await getModelRegistry();
    const ollamaModel = models.find((m) => m.id === "mistral:latest");

    expect(ollamaModel).toBeDefined();
    expect(ollamaModel!.provider).toBe("ollama");
    expect(ollamaModel!.baseUrl).toBe("http://localhost:11434");

    // Now verify the availability logic marks it available
    const providerAvailability = new Map([["ollama", false]]);
    const result = simulateAvailability(models, providerAvailability);
    const ollamaResult = result.find((m) => m.id === "mistral:latest");

    expect(ollamaResult!.available).toBe(true);

    // Reset mock
    mockGetSetting.mockImplementation(() => Promise.resolve(undefined));
  });
});
