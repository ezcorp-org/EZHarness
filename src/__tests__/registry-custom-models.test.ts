import { describe, test, expect, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Mock getSetting before importing registry
const mockGetSetting = mock((_key?: string) => Promise.resolve(undefined));
mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

afterAll(() => restoreModuleMocks());

// Import after mocks
import { getModelRegistry } from "../providers/registry";

describe("getModelRegistry custom model normalization", () => {
  beforeEach(() => {
    mockGetSetting.mockReset();
    mockGetSetting.mockImplementation(() => Promise.resolve(undefined));
  });

  test("normalizes modelId to id", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:customModels")
        return Promise.resolve([{ modelId: "llama3", provider: "ollama", tier: "balanced" }]);
      return Promise.resolve(undefined);
    }) as any);

    const registry = await getModelRegistry();
    const custom = registry.find((m) => m.id === "llama3");
    expect(custom).toBeDefined();
    expect(custom!.id).toBe("llama3");
    expect(custom!.provider).toBe("ollama");
  });

  test("preserves id if present", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:customModels")
        return Promise.resolve([{ id: "gpt-custom", provider: "openai", tier: "fast" }]);
      return Promise.resolve(undefined);
    }) as any);

    const registry = await getModelRegistry();
    const custom = registry.find((m) => m.id === "gpt-custom");
    expect(custom).toBeDefined();
    expect(custom!.id).toBe("gpt-custom");
    expect(custom!.provider).toBe("openai");
    expect(custom!.tier).toBe("fast");
  });

  test("provides defaults for missing fields", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:customModels")
        return Promise.resolve([{ modelId: "test" }]);
      return Promise.resolve(undefined);
    }) as any);

    const registry = await getModelRegistry();
    const custom = registry.find((m) => m.id === "test");
    expect(custom).toBeDefined();
    expect(custom!.contextWindow).toBe(128_000);
    expect(custom!.vision).toBe(false);
    expect(custom!.reasoning).toBe(false);
    expect(custom!.costTier).toBe("low");
    expect(custom!.provider).toBe("ollama");
    expect(custom!.tier).toBe("balanced");
  });

  test("preserves baseUrl", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:customModels")
        return Promise.resolve([
          { modelId: "local-llm", provider: "ollama", baseUrl: "http://localhost:11434" },
        ]);
      return Promise.resolve(undefined);
    }) as any);

    const registry = await getModelRegistry();
    const custom = registry.find((m) => m.id === "local-llm");
    expect(custom).toBeDefined();
    expect(custom!.baseUrl).toBe("http://localhost:11434");
  });

  test("preserves explicit values over defaults", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:customModels")
        return Promise.resolve([
          { modelId: "x", vision: true, contextWindow: 4096, costTier: "high" },
        ]);
      return Promise.resolve(undefined);
    }) as any);

    const registry = await getModelRegistry();
    const custom = registry.find((m) => m.id === "x");
    expect(custom).toBeDefined();
    expect(custom!.vision).toBe(true);
    expect(custom!.contextWindow).toBe(4096);
    expect(custom!.costTier).toBe("high");
  });

  test("empty custom models array returns only built-in models", async () => {
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "provider:customModels") return Promise.resolve([]);
      return Promise.resolve(undefined);
    }) as any);

    const registry = await getModelRegistry();
    // All entries should come from pi-ai (no custom ones)
    for (const entry of registry) {
      expect(entry.provider).not.toBe("ollama");
    }
    expect(registry.length).toBeGreaterThan(0);
  });

  test("missing setting returns only built-in models", async () => {
    // Default mock returns undefined for all keys
    const registry = await getModelRegistry();
    // Should still have built-in models from pi-ai
    expect(registry.length).toBeGreaterThan(0);
    // No ollama models since no custom models were added
    for (const entry of registry) {
      expect(entry.provider).not.toBe("ollama");
    }
  });
});
