import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER } from "./helpers/mock-request";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";

// ── Module-level mocks (BEFORE handler imports) ──────────────────

const mockRequireAuth = mock(() => {});
const mockGetCredential = mock(async () => ({ type: "apikey" as const, token: "test-key" }));
const mockFindModel = mock<() => { id: string; name: string; provider: string; tier: string; contextWindow: number; vision: boolean; costTier: string } | null>(() => ({ id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", tier: "fast", contextWindow: 128000, vision: false, costTier: "low" }));
const mockResolveModel = mock(() => ({
  id: "gpt-4o-mini",
  name: "GPT-4o Mini",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
}));
const mockComplete = mock(async () => stubAssistantMessage("ok"));

mock.module("../auth/middleware", () => ({
  requireAuth: mockRequireAuth,
}));

mock.module("../providers/credentials", () => ({
  getCredential: mockGetCredential,
  getApiKey: mock(async () => "test-key"),
}));

mock.module("../providers/registry", () => ({
  findModelForProviderInTier: mockFindModel,
  resolveModelObject: mockResolveModel,
  getModelRegistry: mock(async () => []),
  getModelsForTier: mock(() => []),
}));

mock.module("@earendil-works/pi-ai", () => ({
  complete: mockComplete,
  stream: mock(() => ({})),
  getModel: mock(() => ({})),
  getModels: mock(() => []),
  getProviders: mock(() => ["anthropic", "openai", "google"]),
  getEnvApiKey: mock(() => undefined),
}));

mock.module("../db/queries/settings", () => ({
  getSetting: mock(async () => undefined),
  upsertSetting: mock(async () => {}),
  deleteSetting: mock(async () => true),
  getAllSettings: mock(async () => ({})),
  isListingInstalled: mock(async () => false),
}));

// Register $server aliases
mockServerAlias();

// Map $server aliases to the mock implementations directly
mock.module("$server/auth/middleware", () => ({
  requireAuth: mockRequireAuth,
}));
mock.module("$server/providers/credentials", () => ({
  getCredential: mockGetCredential,
  getApiKey: mock(async () => "test-key"),
}));
mock.module("$server/providers/registry", () => ({
  findModelForProviderInTier: mockFindModel,
  resolveModelObject: mockResolveModel,
  getModelRegistry: mock(async () => []),
  getModelsForTier: mock(() => []),
}));

// Mock $types for the route
mock.module("../../web/src/routes/api/providers/[provider]/test/$types", () => ({}));

// ── Handler import ──────────────────────────────────────────────

import { POST } from "../../web/src/routes/api/providers/[provider]/test/+server";

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  mockRequireAuth.mockClear();
  mockGetCredential.mockClear();
  mockGetCredential.mockImplementation(async () => ({ type: "apikey" as const, token: "test-key" }));
  mockFindModel.mockClear();
  mockFindModel.mockImplementation(() => ({ id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", tier: "fast", contextWindow: 128000, vision: false, costTier: "low" }));
  mockComplete.mockClear();
  mockComplete.mockImplementation(async () => stubAssistantMessage("ok"));
});

// ── Tests ────────────────────────────────────────────────────────

describe("POST /api/providers/:provider/test", () => {
  test("valid provider with valid credentials returns success: true", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/openai/test",
      params: { provider: "openai" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
  });

  test("getCredential failure returns success: false with error", async () => {
    mockGetCredential.mockImplementation(async () => {
      throw new Error("No credentials available for openai");
    });

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/openai/test",
      params: { provider: "openai" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(data.success).toBe(false);
    expect(data.error).toContain("No credentials available");
  });

  test("invalid provider returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/invalid/test",
      params: { provider: "invalid" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Invalid provider");
  });

  test("complete() failure returns success: false with error", async () => {
    mockComplete.mockImplementation(async () => {
      throw new Error("401 Unauthorized");
    });

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/openai/test",
      params: { provider: "openai" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(data.success).toBe(false);
    expect(data.error).toContain("401 Unauthorized");
  });

  test("no model available returns success: false", async () => {
    mockFindModel.mockImplementation(() => null);

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/openai/test",
      params: { provider: "openai" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(data.success).toBe(false);
    expect(data.error).toContain("No models available");
  });
});

// ── Per-provider tests ──────────────────────────────────────────

describe("POST /api/providers/:provider/test - per-provider coverage", () => {
  test("anthropic provider returns success: true", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/anthropic/test",
      params: { provider: "anthropic" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
  });

  test("google provider returns success: true", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/google/test",
      params: { provider: "google" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
  });

  test("openrouter provider is valid and returns success: true", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/openrouter/test",
      params: { provider: "openrouter" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    // openrouter is a VALID provider — not the 400 invalid-provider path.
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
  });
});

// ── Edge cases: invalid params ──────────────────────────────────

describe("POST /api/providers/:provider/test - invalid params edge cases", () => {
  test("empty string provider param returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers//test",
      params: { provider: "" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Invalid provider");
  });
});

// ── Mock argument verification ──────────────────────────────────

describe("POST /api/providers/:provider/test - mock argument verification", () => {
  test("resolveModelObject is called with correct provider and model ID", async () => {
    mockResolveModel.mockClear();

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/openai/test",
      params: { provider: "openai" },
      user: ADMIN_USER,
    });
    await POST(event as any);

    expect(mockResolveModel).toHaveBeenCalledTimes(1);
    expect(mockResolveModel).toHaveBeenCalledWith("openai", "gpt-4o-mini");
  });

  test("complete() receives correct options (apiKey, maxTokens)", async () => {
    mockComplete.mockClear();
    mockGetCredential.mockImplementation(async () => ({ type: "apikey" as const, token: "my-secret-key" }));

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/openai/test",
      params: { provider: "openai" },
      user: ADMIN_USER,
    });
    await POST(event as any);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const callArgs = mockComplete.mock.calls[0] as unknown[];
    // Third arg is the options object with apiKey, maxTokens, signal
    const opts = callArgs[2] as Record<string, unknown>;
    expect(opts.apiKey).toBe("my-secret-key");
    expect(opts.maxTokens).toBe(1);
    expect(opts.signal).toBeDefined();
  });
});

// ── Error handling edge cases ───────────────────────────────────

describe("POST /api/providers/:provider/test - error handling edge cases", () => {
  test("AbortError from complete() returns success: false with abort message", async () => {
    mockComplete.mockImplementation(async () => {
      const err = new DOMException("The operation was aborted", "AbortError");
      throw err;
    });

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/openai/test",
      params: { provider: "openai" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(data.success).toBe(false);
    expect(data.error).toContain("aborted");
  });

  test("non-Error throw (string) from complete() returns success: false", async () => {
    mockComplete.mockImplementation(async () => {
      throw "raw string error";
    });

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/openai/test",
      params: { provider: "openai" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(data.success).toBe(false);
    expect(data.error).toBe("raw string error");
  });
});
