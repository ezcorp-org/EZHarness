import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";

// ── Mock modules BEFORE imports ─────────────────────────────────────

let mockDbUp = true;
let mockEmbeddingReady = false;
let mockSettings: Record<string, unknown> = {};
let mockReachabilityResults: Record<string, { reachable: boolean; endpointType: string | null; error?: string }> = {};

mock.module("../db/connection", () => ({
  getPglite: () => mockDbUp ? { query: async () => ({}) } : null,
}));

mock.module("../memory/embeddings", () => ({
  isEmbeddingReady: () => mockEmbeddingReady,
}));

mock.module("../providers/local-model-check", () => ({
  checkEndpointReachability: async (baseUrl: string) => {
    return mockReachabilityResults[baseUrl] ?? { reachable: false, endpointType: null, error: "Not mocked" };
  },
}));

mock.module("../db/queries/settings", () => ({
  getAllSettings: async () => ({ ...mockSettings }),
}));

import { buildHealthResponse } from "../health";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  mockDbUp = true;
  mockEmbeddingReady = false;
  mockSettings = {};
  mockReachabilityResults = {};
});

describe("buildHealthResponse - localModels", () => {
  test("detail response includes localModels when custom models with baseUrl exist", async () => {
    mockSettings = {
      "provider:customModels": [
        { modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
      ],
    };
    mockReachabilityResults = {
      "http://localhost:11434": { reachable: true, endpointType: "ollama" },
    };

    const result = await buildHealthResponse(true);
    expect(result.localModels).toBeDefined();
    expect(result.localModels!["llama3"]).toEqual({ status: "reachable" });
  });

  test("localModels shows unreachable status for unreachable endpoints", async () => {
    mockSettings = {
      "provider:customModels": [
        { modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:99999" },
      ],
    };
    mockReachabilityResults = {
      "http://localhost:99999": { reachable: false, endpointType: null, error: "Connection refused" },
    };

    const result = await buildHealthResponse(true);
    expect(result.localModels).toBeDefined();
    expect(result.localModels!["llama3"]).toEqual({ status: "unreachable" });
  });

  test("localModels not included when no custom models with baseUrl", async () => {
    mockSettings = {
      "provider:customModels": [
        { modelId: "gpt-4-turbo", provider: "openai", tier: "powerful" },
      ],
    };

    const result = await buildHealthResponse(true);
    expect(result.localModels).toBeUndefined();
  });

  test("localModels not included when no custom models at all", async () => {
    mockSettings = {};

    const result = await buildHealthResponse(true);
    expect(result.localModels).toBeUndefined();
  });

  test("non-detail response does not include localModels", async () => {
    mockSettings = {
      "provider:customModels": [
        { modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
      ],
    };

    const result = await buildHealthResponse(false);
    expect(result.localModels).toBeUndefined();
    expect(result.status).toBe("healthy");
  });

  test("multiple local models checked in parallel", async () => {
    mockSettings = {
      "provider:customModels": [
        { modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
        { modelId: "codellama", provider: "ollama", tier: "fast", baseUrl: "http://localhost:11435" },
      ],
    };
    mockReachabilityResults = {
      "http://localhost:11434": { reachable: true, endpointType: "ollama" },
      "http://localhost:11435": { reachable: false, endpointType: null, error: "Timeout" },
    };

    const result = await buildHealthResponse(true);
    expect(result.localModels).toBeDefined();
    expect(result.localModels!["llama3"]).toEqual({ status: "reachable" });
    expect(result.localModels!["codellama"]).toEqual({ status: "unreachable" });
  });
});
