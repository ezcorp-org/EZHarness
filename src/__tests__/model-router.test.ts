import { describe, test, expect, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { resetAllCircuitBreakers, getCircuitBreaker } from "../providers/circuit-breaker";

// Mock getSetting before importing router
const mockGetSetting = mock((_key?: string) => Promise.resolve(undefined));
mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

// Mock encryption
mock.module("../providers/encryption", () => ({
  encrypt: (text: string) => `encrypted:${text}`,
  decrypt: (text: string) => {
    if (text.startsWith("encrypted:")) return text.slice("encrypted:".length);
    throw new Error("Decryption failed");
  },
  _resetKeyCache: () => {},
}));

afterAll(() => restoreModuleMocks());

// Import after mocks
import {
  resolveModel,
  suggestFallback,
  ProviderUnavailableError,
} from "../providers/router";
import { getApiKey } from "../providers/credentials";

describe("resolveModel", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    mockGetSetting.mockReset();
    mockGetSetting.mockImplementation(() => Promise.resolve(undefined));
  });

  test("explicit provider+model passes through unchanged", async () => {
    const result = await resolveModel("anthropic", "claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-20250514");
  });

  test("provider only resolves to best model in default tier", async () => {
    const result = await resolveModel("anthropic");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBeDefined();
  });

  test("no provider resolves using preference order, skipping open circuit breakers", async () => {
    // Open anthropic's circuit breaker
    const cb = getCircuitBreaker("anthropic");
    for (let i = 0; i < 3; i++) cb.recordFailure();

    const result = await resolveModel();
    // anthropic skipped, should fall to openai
    expect(result.provider).toBe("openai");
    expect(result.model).toBeDefined();
  });

  test("no provider with all circuit breakers open throws", async () => {
    for (const p of ["anthropic", "openai", "google"]) {
      const cb = getCircuitBreaker(p);
      for (let i = 0; i < 3; i++) cb.recordFailure();
    }

    await expect(resolveModel()).rejects.toThrow("No available providers");
  });

  test("respects custom preference order from settings", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:preferenceOrder") return Promise.resolve(["google", "anthropic", "openai"]);
      // Override default tier to "fast" since all google models are fast
      if (key === "provider:defaultTier") return Promise.resolve("fast");
      return Promise.resolve(undefined);
    }) as any);

    const result = await resolveModel();
    expect(result.provider).toBe("google");
  });

  test("respects custom default tier from settings", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:defaultTier") return Promise.resolve("fast");
      return Promise.resolve(undefined);
    }) as any);

    const result = await resolveModel("anthropic");
    // fast tier anthropic = a haiku model
    expect(result.model).toBeDefined();
  });

  describe("resolveModel with custom models", () => {
    test("custom model with baseUrl passes it through to piModel", async () => {
      mockGetSetting.mockImplementation(((key: string) => {
        if (key === "provider:customModels")
          return Promise.resolve([
            {
              modelId: "llama3",
              provider: "ollama",
              tier: "balanced",
              baseUrl: "http://localhost:11434",
            },
          ]);
        return Promise.resolve(undefined);
      }) as any);

      const result = await resolveModel("ollama", "llama3");
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("llama3");
      expect(result.piModel.baseUrl).toBe("http://localhost:11434/v1");
    });

    test("custom model without baseUrl falls back to default openai URL", async () => {
      mockGetSetting.mockImplementation(((key: string) => {
        if (key === "provider:customModels")
          return Promise.resolve([
            {
              modelId: "my-custom-model",
              provider: "ollama",
              tier: "balanced",
            },
          ]);
        return Promise.resolve(undefined);
      }) as any);

      const result = await resolveModel("ollama", "my-custom-model");
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("my-custom-model");
      expect(result.piModel.baseUrl).toBe("https://api.openai.com/v1");
    });

    test("non-custom model (in pi-ai registry) is unaffected", async () => {
      const result = await resolveModel("anthropic", "claude-sonnet-4-20250514");
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-20250514");
      // Registry models have their own baseUrl set by pi-ai, not our custom logic
      expect(result.piModel).toBeDefined();
    });

    test("no custom models setting returns undefined baseUrl lookup, uses default", async () => {
      // mockGetSetting already returns undefined by default (from beforeEach)
      const result = await resolveModel("ollama", "some-model");
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("some-model");
      // No custom models found, so baseUrl is undefined -> falls back to default
      expect(result.piModel.baseUrl).toBe("https://api.openai.com/v1");
    });
  });
});

describe("suggestFallback", () => {
  beforeEach(() => {
    resetAllCircuitBreakers();
    mockGetSetting.mockReset();
    mockGetSetting.mockImplementation(() => Promise.resolve(undefined));
  });

  test("returns next available provider+model in same tier", async () => {
    const suggestion = await suggestFallback("anthropic", "balanced");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.provider).not.toBe("anthropic");
    expect(suggestion!.tier).toBe("balanced");
    expect(suggestion!.model).toBeDefined();
  });

  test("skips circuit-breaker-open providers", async () => {
    // Open openai's circuit breaker (next in default order after anthropic)
    const cb = getCircuitBreaker("openai");
    for (let i = 0; i < 3; i++) cb.recordFailure();

    // Use "fast" tier since google models are all classified as fast (gemini contains "mini")
    const suggestion = await suggestFallback("anthropic", "fast");
    expect(suggestion).not.toBeNull();
    expect(suggestion!.provider).toBe("google");
  });

  test("returns null when no alternatives available", async () => {
    // Open all other providers
    for (const p of ["openai", "google"]) {
      const cb = getCircuitBreaker(p);
      for (let i = 0; i < 3; i++) cb.recordFailure();
    }

    const suggestion = await suggestFallback("anthropic", "balanced");
    expect(suggestion).toBeNull();
  });
});

describe("ProviderUnavailableError", () => {
  test("carries failedProvider, failedModel, and suggestion fields", () => {
    const err = new ProviderUnavailableError(
      "Anthropic is unavailable",
      "anthropic",
      "claude-sonnet-4-20250514",
      { provider: "openai", model: "gpt-4o", tier: "balanced" },
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.failedProvider).toBe("anthropic");
    expect(err.failedModel).toBe("claude-sonnet-4-20250514");
    expect(err.suggestion).toEqual({ provider: "openai", model: "gpt-4o", tier: "balanced" });
    expect(err.message).toBe("Anthropic is unavailable");
  });

  test("suggestion can be null", () => {
    const err = new ProviderUnavailableError("No providers", "anthropic", "claude-sonnet-4-20250514", null);
    expect(err.suggestion).toBeNull();
  });
});

describe("getApiKey (BYOK-aware)", () => {
  beforeEach(() => {
    mockGetSetting.mockReset();
    mockGetSetting.mockImplementation(() => Promise.resolve(undefined));
  });

  test("checks stored key before env var", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:apiKey:anthropic") return Promise.resolve("encrypted:sk-stored-key");
      return Promise.resolve(undefined);
    }) as any);

    const key = await getApiKey("anthropic");
    expect(key).toBe("sk-stored-key");
  });

  test("falls back to env var when no stored key", async () => {
    // No stored key, should use env var
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-env-key";
    try {
      const key = await getApiKey("anthropic");
      expect(key).toBe("sk-env-key");
    } finally {
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  test("falls through to env var when decrypt fails", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:apiKey:anthropic") return Promise.resolve("bad-encrypted-data");
      return Promise.resolve(undefined);
    }) as any);

    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-fallback-key";
    try {
      const key = await getApiKey("anthropic");
      expect(key).toBe("sk-fallback-key");
    } finally {
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });
});
