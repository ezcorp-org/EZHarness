import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER } from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────

let settingsStore: Record<string, unknown> = {};

mock.module("../db/queries/settings", () => ({
  getSetting: mock(async (key: string) => settingsStore[key]),
  upsertSetting: mock(async (key: string, value: unknown) => {
    settingsStore[key] = value;
  }),
  deleteSetting: mock(async (key: string) => {
    delete settingsStore[key];
    return true;
  }),
  getAllSettings: mock(async () => ({ ...settingsStore })),
  isListingInstalled: mock(async () => false),
}));

mock.module("../providers/encryption", () => ({
  encrypt: mock((plaintext: string) => `enc:${plaintext}`),
  decrypt: mock((ciphertext: string) => ciphertext.replace(/^enc:/, "")),
  _resetKeyCache: () => {},
}));

mock.module("../auth/middleware", () => ({
  requireAuth: mock(() => {}),
}));

// Register $server aliases for SvelteKit route handler imports
mockServerAlias();

// Map $server aliases to the mock implementations directly
mock.module("$server/providers/encryption", () => ({
  encrypt: mock((plaintext: string) => `enc:${plaintext}`),
  decrypt: mock((ciphertext: string) => ciphertext.replace(/^enc:/, "")),
  _resetKeyCache: () => {},
}));
mock.module("$server/auth/middleware", () => ({
  requireAuth: mock(() => {}),
}));

// Mock $types for the route
mock.module("../../web/src/routes/api/providers/$types", () => ({}));

// ── Handler imports ──────────────────────────────────────────────

import { GET } from "../../web/src/routes/api/providers/+server";

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  settingsStore = {};
  // Clear env vars for clean tests
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
});

// ── Tests ────────────────────────────────────────────────────────

describe("GET /api/providers - expiresAt field", () => {
  test("returns expiresAt as ISO string for OAuth-connected provider", async () => {
    const expires = Date.now() + 3600_000; // 1 hour from now
    const tokenData = JSON.stringify({ expires, access: "tok", refresh: "ref" });
    settingsStore["provider:oauth:openai"] = `enc:${tokenData}`;

    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    const openai = data.find((p: any) => p.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai.expiresAt).toBe(new Date(expires).toISOString());
    expect(openai.oauthConnected).toBe(true);
  });

  test("returns expiresAt: null for BYOK-only provider", async () => {
    settingsStore["provider:apiKey:anthropic"] = "enc:sk-test";

    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    const anthropic = data.find((p: any) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic.expiresAt).toBeNull();
  });

  test("returns expiresAt: null for provider with no credentials", async () => {
    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    const google = data.find((p: any) => p.provider === "google");
    expect(google).toBeDefined();
    expect(google.expiresAt).toBeNull();
  });

  test("all providers in response have expiresAt field", async () => {
    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    for (const provider of data) {
      expect(provider).toHaveProperty("expiresAt");
    }
  });
});

describe("GET /api/providers - expired OAuth token", () => {
  test("expired OAuth token returns oauthExpired: true with expiresAt still present", async () => {
    const expiredTs = Date.now() - 3600_000; // 1 hour ago
    const tokenData = JSON.stringify({ expires: expiredTs, access: "tok", refresh: "ref" });
    settingsStore["provider:oauth:openai"] = `enc:${tokenData}`;

    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    const openai = data.find((p: any) => p.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai.oauthExpired).toBe(true);
    expect(openai.oauthConnected).toBe(true);
    expect(openai.expiresAt).toBe(new Date(expiredTs).toISOString());
  });
});

describe("GET /api/providers - openrouter provider", () => {
  test("openrouter present with oauthSupported:false and oauthConnected:false (BYOK-only)", async () => {
    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    const openrouter = data.find((p: any) => p.provider === "openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter.oauthSupported).toBe(false);
    expect(openrouter.oauthConnected).toBe(false);
    expect(openrouter.source).toBe("none");
    expect(openrouter.hasKey).toBe(false);
    expect(openrouter.expiresAt).toBeNull();
  });

  test("openrouter BYOK key sets source 'byok' and hasKey true", async () => {
    settingsStore["provider:apiKey:openrouter"] = "enc:sk-or-test";

    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    const openrouter = data.find((p: any) => p.provider === "openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter.source).toBe("byok");
    expect(openrouter.hasKey).toBe(true);
    expect(openrouter.oauthSupported).toBe(false);
  });
});

describe("GET /api/providers - env-only provider", () => {
  test("env-only provider returns source 'env' and expiresAt null", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-key";

    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    const anthropic = data.find((p: any) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic.source).toBe("env");
    expect(anthropic.hasKey).toBe(true);
    expect(anthropic.expiresAt).toBeNull();

    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe("GET /api/providers - decrypt failure", () => {
  test("corrupt OAuth token causes oauthConnected: false", async () => {
    // Store a value that will fail JSON.parse after decrypt
    // The mock decrypt strips "enc:" prefix, leaving "not-json"
    settingsStore["provider:oauth:openai"] = "enc:not-json";

    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    const openai = data.find((p: any) => p.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai.oauthConnected).toBe(false);
    expect(openai.oauthExpired).toBe(false);
    expect(openai.expiresAt).toBeNull();
  });
});

describe("GET /api/providers - source precedence", () => {
  test("provider with both BYOK and env returns source 'byok'", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-env-key";
    settingsStore["provider:apiKey:anthropic"] = "enc:sk-byok-key";

    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    const anthropic = data.find((p: any) => p.provider === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic.source).toBe("byok");
    expect(anthropic.hasKey).toBe(true);

    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe("GET /api/providers - mixed states in single response", () => {
  test("multiple providers with different credential sources", async () => {
    // anthropic: BYOK only
    settingsStore["provider:apiKey:anthropic"] = "enc:sk-anthropic";

    // openai: OAuth connected (not expired)
    const futureExpires = Date.now() + 7200_000;
    const openaiToken = JSON.stringify({ expires: futureExpires, access: "oai-tok", refresh: "oai-ref" });
    settingsStore["provider:oauth:openai"] = `enc:${openaiToken}`;

    // google: env only
    process.env.GOOGLE_API_KEY = "goog-env-key";

    const event = createMockEvent({ url: "http://localhost/api/providers", user: ADMIN_USER });
    const res = await GET(event as any);
    const data = await jsonFromResponse(res);

    // Verify all providers are present (anthropic, openai, google, openrouter)
    expect(data).toHaveLength(4);

    const anthropic = data.find((p: any) => p.provider === "anthropic");
    expect(anthropic.source).toBe("byok");
    expect(anthropic.hasKey).toBe(true);
    expect(anthropic.oauthConnected).toBe(false);
    expect(anthropic.oauthSupported).toBe(false);
    expect(anthropic.expiresAt).toBeNull();

    const openai = data.find((p: any) => p.provider === "openai");
    expect(openai.source).toBe("none");
    expect(openai.oauthConnected).toBe(true);
    expect(openai.oauthExpired).toBe(false);
    expect(openai.expiresAt).toBe(new Date(futureExpires).toISOString());

    const google = data.find((p: any) => p.provider === "google");
    expect(google.source).toBe("env");
    expect(google.hasKey).toBe(true);
    expect(google.oauthConnected).toBe(false);
    expect(google.expiresAt).toBeNull();

    delete process.env.GOOGLE_API_KEY;
  });
});
