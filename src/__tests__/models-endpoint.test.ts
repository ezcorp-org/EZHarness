import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ModelEntry } from "../providers/registry";

// ── Mock state ────────────────────────────────────────────────────────

const mockGetSetting = mock<(key: string) => Promise<unknown>>(
  () => Promise.resolve(undefined),
);
const mockGetCredential = mock<(provider: string) => Promise<{ type: string; token: string }>>(
  () => Promise.resolve({ type: "apikey", token: "test-key" }),
);

// ── Mock models ──────────────────────────────────────────────────────

const MOCK_MODELS: ModelEntry[] = [
  { id: "claude-sonnet-4-20250514", provider: "anthropic", tier: "balanced", contextWindow: 200_000, vision: true, costTier: "medium", displayName: "Claude Sonnet 4", reasoning: false },
  { id: "gpt-4o", provider: "openai", tier: "balanced", contextWindow: 128_000, vision: true, costTier: "medium", displayName: "GPT-4o", reasoning: false },
  { id: "gemini-2.0-flash", provider: "google", tier: "fast", contextWindow: 1_000_000, vision: true, costTier: "low", displayName: "Gemini 2.0 Flash", reasoning: false },
  { id: "openrouter/auto", provider: "openrouter", tier: "balanced", contextWindow: 200_000, vision: false, costTier: "medium", displayName: "OpenRouter Auto", reasoning: false },
];

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

const ANTHROPIC_MODELS = MOCK_MODELS.filter((m) => m.provider === "anthropic");
const GOOGLE_MODELS = MOCK_MODELS.filter((m) => m.provider === "google");

// ── Mock modules ──────────────────────────────────────────────────────

mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

mock.module("../providers/credentials", () => ({
  getCredential: mockGetCredential,
  getApiKey: mock(() => Promise.resolve("test-key")),
  _clearRefreshLocks: mock(() => {}),
}));

mock.module("../providers/registry", () => ({
  getModelRegistry: mock(async () => [...MOCK_MODELS]),
  getModelsForTier: mock(() => []),
  findModelForProviderInTier: mock(() => null),
}));

mock.module("../auth/middleware", () => ({
  requireAuth: mock(() => ({ id: "test-user" })),
}));

// ── $server alias mocks ──────────────────────────────────────────────
const serverAliases: Record<string, string> = {
  "$server/providers/registry": "../providers/registry",
  "$server/providers/credentials": "../providers/credentials",
  "$server/db/queries/settings": "../db/queries/settings",
  "$server/auth/middleware": "../auth/middleware",
};
for (const [alias, path] of Object.entries(serverAliases)) {
  mock.module(alias, () => require(path));
}

afterAll(() => restoreModuleMocks());

// ── Import endpoint after mocks ───────────────────────────────────────

import { GET } from "../../web/src/routes/api/models/+server";

// ── Helpers ───────────────────────────────────────────────────────────

function makeRequest(): Request & { params: Record<string, string> } {
  return Object.assign(new Request("http://localhost/api/models"), { params: {} });
}

function makeLocals() {
  return { user: { id: "test-user" } } as any;
}

async function callEndpoint(): Promise<ReturnType<typeof mapResult>[]> {
  const response = (await (GET as (...args: unknown[]) => unknown)({
    locals: makeLocals(),
    request: makeRequest(),
  })) as Response;
  return response.json();
}

function mapResult(m: any) {
  return m as {
    provider: string;
    model: string;
    tier: string;
    contextWindow: number;
    vision: boolean;
    costTier: string;
    displayName: string;
    available: boolean;
  };
}

/** Configure getSetting to return a value for specific keys. */
function configureSetting(overrides: Record<string, unknown>) {
  mockGetSetting.mockImplementation((key: string) =>
    Promise.resolve(overrides[key] ?? undefined),
  );
}

// ── Setup ─────────────────────────────────────────────────────────────

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  mockGetSetting.mockReset();
  mockGetCredential.mockReset();

  mockGetSetting.mockImplementation(() => Promise.resolve(undefined));
  mockGetCredential.mockImplementation(() =>
    Promise.resolve({ type: "apikey", token: "test-key" }),
  );

  // Clear env vars
  for (const envKey of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"]) {
    savedEnv[envKey] = process.env[envKey];
    delete process.env[envKey];
  }
});

afterAll(() => {
  // Restore env vars
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

// ── Tests: Availability logic ─────────────────────────────────────────

describe("availability logic", () => {
  test("provider with env var set marks models as available", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";

    const result = await callEndpoint();
    const anthropicModels = result.filter((m) => m.provider === "anthropic");

    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(anthropicModels.every((m) => m.available === true)).toBe(true);
  });

  test("provider with BYOK key marks models as available", async () => {
    configureSetting({
      "provider:apiKey:openai": "encrypted-key",
    });

    const result = await callEndpoint();
    const openaiModels = result.filter((m) => m.provider === "openai");

    expect(openaiModels.length).toBeGreaterThan(0);
    expect(openaiModels.every((m) => m.available === true)).toBe(true);
  });

  test("provider with DB OAuth marks models as available", async () => {
    configureSetting({
      "provider:oauth:google": "encrypted-oauth-token",
    });

    const result = await callEndpoint();
    const googleModels = result.filter((m) => m.provider === "google");

    expect(googleModels.length).toBeGreaterThan(0);
    expect(googleModels.every((m) => m.available === true)).toBe(true);
  });

  test("provider with no credentials marks models as unavailable", async () => {
    // getCredential throws when no creds available
    mockGetCredential.mockImplementation(() =>
      Promise.reject(new Error("No credentials")),
    );

    const result = await callEndpoint();
    const allModels = result;

    expect(allModels.length).toBeGreaterThan(0);
    expect(allModels.every((m) => m.available === false)).toBe(true);
  });

  test("getCredential throwing sets available=false", async () => {
    // Set env var so hasEnv is true, but getCredential fails
    process.env.OPENAI_API_KEY = "sk-test";
    mockGetCredential.mockImplementation(() =>
      Promise.reject(new Error("credential resolution failed")),
    );

    const result = await callEndpoint();
    const openaiModels = result.filter((m) => m.provider === "openai");

    expect(openaiModels.length).toBeGreaterThan(0);
    expect(openaiModels.every((m) => m.available === false)).toBe(true);
  });
});

// ── Tests: Model listing ──────────────────────────────────────────────

describe("model listing", () => {
  test("returns all registry models", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";

    const result = await callEndpoint();
    const anthropicModels = result.filter((m) => m.provider === "anthropic");

    expect(anthropicModels).toHaveLength(ANTHROPIC_MODELS.length);
    const m = at(anthropicModels, 0, "anthropic model");
    expect(m.model).toBe("claude-sonnet-4-20250514");
  });

  test("models include display name and tier info", async () => {
    const result = await callEndpoint();
    const flash = result.find((m) => m.model === "gemini-2.0-flash");

    expect(flash).toBeDefined();
    expect(flash!.displayName).toBe("Gemini 2.0 Flash");
    expect(flash!.tier).toBe("fast");
    expect(flash!.costTier).toBe("low");
  });

  test("getCredential failure marks provider as unavailable", async () => {
    process.env.GOOGLE_API_KEY = "test-key";
    mockGetCredential.mockImplementation((p: string) => {
      if (p === "google") return Promise.reject(new Error("no creds"));
      return Promise.resolve({ type: "apikey", token: "key" });
    });

    const result = await callEndpoint();
    const googleModels = result.filter((m) => m.provider === "google");

    expect(googleModels.length).toBe(GOOGLE_MODELS.length);
    expect(googleModels.every((m) => m.available === false)).toBe(true);
  });
});

// ── Tests: Edge cases ─────────────────────────────────────────────────

describe("edge cases", () => {
  test("multiple providers with mixed availability", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    // OpenAI has BYOK, google has nothing
    configureSetting({
      "provider:apiKey:openai": "encrypted-openai-key",
    });

    const result = await callEndpoint();

    const anthropic = result.filter((m) => m.provider === "anthropic");
    const openai = result.filter((m) => m.provider === "openai");
    const google = result.filter((m) => m.provider === "google");

    expect(anthropic.every((m) => m.available === true)).toBe(true);
    expect(openai.every((m) => m.available === true)).toBe(true);
    expect(google.every((m) => m.available === false)).toBe(true);
    expect(google.length).toBe(GOOGLE_MODELS.length);
  });

  test("all providers available", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GOOGLE_API_KEY = "test-key";
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const result = await callEndpoint();

    expect(result.length).toBe(MOCK_MODELS.length);
    expect(result.every((m) => m.available === true)).toBe(true);

    const providers = new Set(result.map((m) => m.provider));
    expect(providers.has("anthropic")).toBe(true);
    expect(providers.has("openai")).toBe(true);
    expect(providers.has("google")).toBe(true);
    expect(providers.has("openrouter")).toBe(true);
  });
});

// ── Tests: OpenRouter availability ────────────────────────────────────

describe("openrouter availability", () => {
  test("openrouter model marked available when OPENROUTER_API_KEY env is set", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-env";

    const result = await callEndpoint();
    const openrouterModels = result.filter((m) => m.provider === "openrouter");

    expect(openrouterModels.length).toBeGreaterThan(0);
    expect(openrouterModels.every((m) => m.available === true)).toBe(true);
  });

  test("openrouter model marked available when provider:apiKey:openrouter BYOK is set", async () => {
    configureSetting({
      "provider:apiKey:openrouter": "encrypted-openrouter-key",
    });

    const result = await callEndpoint();
    const openrouterModels = result.filter((m) => m.provider === "openrouter");

    expect(openrouterModels.length).toBeGreaterThan(0);
    expect(openrouterModels.every((m) => m.available === true)).toBe(true);
  });

  test("openrouter model marked unavailable with no credentials", async () => {
    mockGetCredential.mockImplementation(() =>
      Promise.reject(new Error("No credentials")),
    );

    const result = await callEndpoint();
    const openrouterModels = result.filter((m) => m.provider === "openrouter");

    expect(openrouterModels.length).toBeGreaterThan(0);
    expect(openrouterModels.every((m) => m.available === false)).toBe(true);
  });
});
