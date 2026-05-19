import { test, expect, beforeEach, mock, afterAll } from "bun:test";

import { restoreModuleMocks } from "./helpers/mock-cleanup";
// ── Mock setup ────────────────────────────────────────────────────────

// Mock data
const FAKE_ENCRYPTED = "encrypted-token-data";
const FAKE_ACCESS_TOKEN = "oauth-access-token-123";
const FAKE_REFRESH_TOKEN = "oauth-refresh-token-456";
const FAKE_REFRESHED_API_KEY = "refreshed-api-key-789";
const FAKE_API_KEY = "sk-test-api-key-abc";
const _FAKE_ENCRYPTED_API_KEY = "enc:sk-test-api-key-abc";

/** Build pi-ai OAuthCredentials JSON string */
function makeTokenData(overrides: Partial<{
  access: string;
  refresh: string;
  expires: number;
  projectId: string;
}> = {}) {
  return JSON.stringify({
    access: overrides.access ?? FAKE_ACCESS_TOKEN,
    refresh: overrides.refresh ?? FAKE_REFRESH_TOKEN,
    expires: overrides.expires ?? Date.now() + 3600_000, // 1 hour from now
    projectId: overrides.projectId ?? "test-project",
  });
}

// Track mock state
let settingsStore: Record<string, unknown> = {};
let decryptReturn: string = makeTokenData();

// Mock getOAuthApiKey from pi-ai/oauth
const mockGetOAuthApiKey = mock<(providerId: string, credMap: any) => Promise<unknown>>(
  async (_providerId, credMap) => {
    const creds = credMap[_providerId];
    return {
      newCredentials: { ...creds, access: "new-access" },
      apiKey: creds.access, // return the access token as apiKey for non-expired
    };
  },
);

// Mock getEnvApiKey from pi-ai
const mockGetEnvApiKey = mock((provider: string) => {
  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
  };
  const envKey = envMap[provider];
  return envKey ? process.env[envKey] : undefined;
});

// Mock modules before importing credentials
mock.module("../db/queries/settings", () => ({
  getSetting: mock(async (key: string) => settingsStore[key]),
  upsertSetting: mock(async (key: string, value: unknown) => {
    settingsStore[key] = value;
  }),
  getAllSettings: mock(async () => ({ ...settingsStore })),
  deleteSetting: mock(async (key: string) => { delete settingsStore[key]; return true; }),
  isListingInstalled: mock(async () => false),
}));

mock.module("../providers/encryption", () => ({
  encrypt: mock((plaintext: string) => `enc:${plaintext}`),
  decrypt: mock((_ciphertext: string) => decryptReturn),
  _resetKeyCache: () => {},
}));

mock.module("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: mockGetOAuthApiKey,
}));

mock.module("@mariozechner/pi-ai", () => ({
  getEnvApiKey: mockGetEnvApiKey,
  getModel: mock(() => ({})),
  getModels: mock(() => []),
  getProviders: mock(() => []),
}));

afterAll(() => restoreModuleMocks());

// Import after mocks are set up
const {
  getCredential,
  getApiKey,
  _clearRefreshLocks,
} = await import("../providers/credentials");

// Store original env
const _originalEnv = { ...process.env };

beforeEach(() => {
  settingsStore = {};
  decryptReturn = makeTokenData();
  mockGetOAuthApiKey.mockClear();
  mockGetOAuthApiKey.mockImplementation(async (_providerId: string, credMap: any) => {
    const creds = credMap[_providerId];
    return {
      newCredentials: { ...creds, access: "new-access" },
      apiKey: creds.access,
    };
  });
  mockGetEnvApiKey.mockClear();
  mockGetEnvApiKey.mockImplementation((provider: string) => {
    const envMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GOOGLE_API_KEY",
    };
    const envKey = envMap[provider];
    return envKey ? process.env[envKey] : undefined;
  });
  _clearRefreshLocks();
  // Set env vars for BYOK fallback
  process.env.OPENAI_API_KEY = FAKE_API_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE_API_KEY;
  process.env.GOOGLE_API_KEY = FAKE_API_KEY;
});

// ── OpenAI OAuth Tests ──────────────────────────────────────────────

test("getCredential('openai') returns oauth credential when valid OAuth token exists", async () => {
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai");

  expect(cred.type).toBe("oauth");
  expect(cred.token).toBeTruthy();
});

test("getCredential('openai') returns refreshed: undefined when token is not expired", async () => {
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai");

  expect(cred.refreshed).toBeUndefined();
});

// ── Google OAuth Tests ──────────────────────────────────────────────

test("getCredential('google') returns oauth credential when valid OAuth token exists", async () => {
  settingsStore["provider:oauth:google"] = FAKE_ENCRYPTED;

  const cred = await getCredential("google");

  expect(cred.type).toBe("oauth");
  expect(cred.token).toBeTruthy();
});

// ── Anthropic Always BYOK Tests ─────────────────────────────────────

test("getCredential('anthropic') always returns apikey credential (never OAuth)", async () => {
  // Even if OAuth token exists, should not use it (anthropic skips OAuth)
  settingsStore["provider:oauth:anthropic"] = FAKE_ENCRYPTED;

  const cred = await getCredential("anthropic");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY);
});

// ── Token Refresh Tests ─────────────────────────────────────────────

test("getCredential('openai') auto-refreshes expired token and returns refreshed: true", async () => {
  decryptReturn = makeTokenData({ expires: Date.now() - 1000 }); // expired
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  mockGetOAuthApiKey.mockImplementationOnce(async (_pid, _creds) => ({
    newCredentials: { access: "new-access", refresh: FAKE_REFRESH_TOKEN, expires: Date.now() + 3600_000 },
    apiKey: FAKE_REFRESHED_API_KEY,
  }));

  const cred = await getCredential("openai");

  expect(cred.type).toBe("oauth");
  expect(cred.token).toBe(FAKE_REFRESHED_API_KEY);
  expect(cred.refreshed).toBe(true);
  expect(mockGetOAuthApiKey).toHaveBeenCalledTimes(1);
});

test("getCredential('openai') refreshes token expiring within 60s buffer", async () => {
  decryptReturn = makeTokenData({ expires: Date.now() + 30_000 }); // 30s left (within 60s buffer)
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  mockGetOAuthApiKey.mockImplementationOnce(async (_pid, _creds) => ({
    newCredentials: { access: "new-access", refresh: FAKE_REFRESH_TOKEN, expires: Date.now() + 3600_000 },
    apiKey: FAKE_REFRESHED_API_KEY,
  }));

  const cred = await getCredential("openai");

  expect(cred.refreshed).toBe(true);
  expect(mockGetOAuthApiKey).toHaveBeenCalledTimes(1);
});

test("getCredential('openai') throws when expired with no refresh token and preference is oauth", async () => {
  decryptReturn = makeTokenData({
    expires: Date.now() - 1000,
    refresh: "",
  });
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;
  settingsStore["provider:accessMode:openai"] = "oauth"; // explicitly wants OAuth

  await expect(getCredential("openai")).rejects.toThrow("no refresh token");
});

test("getCredential('openai') with expired token and no refresh falls back to BYOK by default", async () => {
  decryptReturn = makeTokenData({
    expires: Date.now() - 1000,
    refresh: "",
  });
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai");
  expect(cred.type).toBe("apikey");
});

// ── Fallback Tests ──────────────────────────────────────────────────

test("getCredential('openai') falls back to BYOK when refresh fails and BYOK key exists", async () => {
  decryptReturn = makeTokenData({ expires: Date.now() - 1000 });
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  // Make getOAuthApiKey return null (refresh failed)
  mockGetOAuthApiKey.mockImplementationOnce(async () => null);

  const cred = await getCredential("openai");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY);
});

test("getCredential('openai') throws when refresh fails and no BYOK key", async () => {
  decryptReturn = makeTokenData({ expires: Date.now() - 1000 });
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  // Make getOAuthApiKey return null (refresh failed)
  mockGetOAuthApiKey.mockImplementationOnce(async () => null);
  // Remove env var so BYOK also fails
  delete process.env.OPENAI_API_KEY;

  await expect(getCredential("openai")).rejects.toThrow(
    "No credentials available for openai",
  );
});

// ── Concurrent Refresh Lock Tests ───────────────────────────────────

test("concurrent getCredential calls with expired token share a single refresh request", async () => {
  decryptReturn = makeTokenData({ expires: Date.now() - 1000 });
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  mockGetOAuthApiKey.mockImplementation(async (_pid, _creds) => ({
    newCredentials: { access: "new-access", refresh: FAKE_REFRESH_TOKEN, expires: Date.now() + 3600_000 },
    apiKey: FAKE_REFRESHED_API_KEY,
  }));

  // Launch two concurrent calls
  const [cred1, cred2] = await Promise.all([
    getCredential("openai"),
    getCredential("openai"),
  ]);

  // Both should succeed with the same refreshed token
  expect(cred1.token).toBe(FAKE_REFRESHED_API_KEY);
  expect(cred2.token).toBe(FAKE_REFRESHED_API_KEY);
  // Only ONE getOAuthApiKey call for refresh
  expect(mockGetOAuthApiKey).toHaveBeenCalledTimes(1);
});

// ── Conversation Override Tests ─────────────────────────────────────

test("getCredential('openai', conversationId) with conversation override 'apikey' returns BYOK key", async () => {
  settingsStore["conversation:conv-123:accessMode:openai"] = "apikey";
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai", "conv-123");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY);
});

test("getCredential('openai', conversationId) with conversation override 'oauth' returns OAuth token", async () => {
  settingsStore["conversation:conv-123:accessMode:openai"] = "oauth";
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai", "conv-123");

  expect(cred.type).toBe("oauth");
  expect(cred.token).toBeTruthy();
});

// ── User Preference Tests ───────────────────────────────────────────

test("getCredential('openai') with user preference 'apikey' returns BYOK key even when OAuth available", async () => {
  settingsStore["provider:accessMode:openai"] = "apikey";
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY);
});

// ── Resolution Chain Order Tests ────────────────────────────────────

test("resolution chain: conversation override takes precedence over user preference", async () => {
  settingsStore["provider:accessMode:openai"] = "oauth"; // user prefers OAuth
  settingsStore["conversation:conv-123:accessMode:openai"] = "apikey"; // but conversation overrides to apikey
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai", "conv-123");

  expect(cred.type).toBe("apikey"); // conversation override wins
});

test("resolution chain: falls back from OAuth to BYOK when no OAuth token stored", async () => {
  // No OAuth token stored, no preferences set
  const cred = await getCredential("openai");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY);
});

test("resolution chain: getApiKey reads BYOK from settings then env var", async () => {
  // getApiKey should try settings first, then env var
  const key = await getApiKey("openai");
  expect(key).toBe(FAKE_API_KEY); // from env var since no BYOK in settings
});

// ── Exact 60s Boundary ──────────────────────────────────────────────

test("getCredential('openai') does NOT refresh token expiring well beyond 60s buffer", async () => {
  // Token expires in 2 minutes -- well outside the 60s refresh buffer
  decryptReturn = makeTokenData({ expires: Date.now() + 120_000 });
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai");

  expect(cred.type).toBe("oauth");
  expect(cred.refreshed).toBeUndefined();
});

test("getCredential('openai') refreshes token expiring at 59999ms (just under 60s)", async () => {
  decryptReturn = makeTokenData({ expires: Date.now() + 59_999 });
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  mockGetOAuthApiKey.mockImplementationOnce(async (_pid, _creds) => ({
    newCredentials: { access: "new-access", refresh: FAKE_REFRESH_TOKEN, expires: Date.now() + 3600_000 },
    apiKey: FAKE_REFRESHED_API_KEY,
  }));

  const cred = await getCredential("openai");

  expect(cred.refreshed).toBe(true);
  expect(mockGetOAuthApiKey).toHaveBeenCalledTimes(1);
});

// ── getSetting throws in getApiKey ──────────────────────────────────

test("getApiKey falls back to env var when getSetting throws", async () => {
  const { getSetting } = await import("../db/queries/settings");
  (getSetting as any).mockImplementationOnce(() => { throw new Error("DB down"); });

  const key = await getApiKey("openai");
  expect(key).toBe(FAKE_API_KEY); // from env var fallback
});

// ── decrypt throws on corrupted stored token (getApiKey path) ───────

test("getApiKey falls back to env var when decrypt throws on corrupted stored key", async () => {
  settingsStore["provider:apiKey:openai"] = "corrupted-data";
  const { decrypt: decryptFn } = await import("../providers/encryption");
  (decryptFn as any).mockImplementationOnce(() => { throw new Error("bad data"); });

  const key = await getApiKey("openai");
  expect(key).toBe(FAKE_API_KEY); // env var fallback
});

// ── getApiKey throws when no stored key AND no env var ──────────────

test("getApiKey throws when no stored key and env var is missing", async () => {
  delete process.env.OPENAI_API_KEY;

  await expect(getApiKey("openai")).rejects.toThrow("Missing API key for openai");
});

test("getApiKey throws with correct message for each provider", async () => {
  delete process.env.GOOGLE_API_KEY;
  await expect(getApiKey("google")).rejects.toThrow("Missing API key for google");

  delete process.env.ANTHROPIC_API_KEY;
  await expect(getApiKey("anthropic")).rejects.toThrow("Missing API key for anthropic");
});

// ── Concurrent refresh: lock cleanup after failure ──────────────────

test("concurrent refresh lock is cleaned up after refresh failure", async () => {
  decryptReturn = makeTokenData({ expires: Date.now() - 1000 });
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  // First call: make getOAuthApiKey return null (refresh fails)
  mockGetOAuthApiKey.mockImplementationOnce(async () => null);

  // This should fail (oauth fails, then BYOK fallback succeeds in default resolution)
  const cred1 = await getCredential("openai");
  expect(cred1.type).toBe("apikey"); // fell back to BYOK

  // Now set up a successful refresh for the second call
  decryptReturn = makeTokenData({ expires: Date.now() - 1000 });
  mockGetOAuthApiKey.mockImplementationOnce(async (_pid, _creds) => ({
    newCredentials: { access: "new-access", refresh: FAKE_REFRESH_TOKEN, expires: Date.now() + 3600_000 },
    apiKey: FAKE_REFRESHED_API_KEY,
  }));

  // Second call should work -- lock was cleaned up by `finally`
  settingsStore["provider:accessMode:openai"] = "oauth";
  const cred2 = await getCredential("openai");
  expect(cred2.type).toBe("oauth");
  expect(cred2.refreshed).toBe(true);
});

// ── Resolution chain: conversation override unknown value ───────────

test("getCredential ignores unknown conversation override value and falls to user preference", async () => {
  settingsStore["conversation:conv-123:accessMode:openai"] = "auto"; // not 'apikey' or 'oauth'
  settingsStore["provider:accessMode:openai"] = "apikey";

  const cred = await getCredential("openai", "conv-123");

  expect(cred.type).toBe("apikey"); // user preference kicks in
});

// ── Resolution chain: conv override oauth + user pref apikey ────────

test("resolution chain: conversation override 'oauth' wins over user preference 'apikey'", async () => {
  settingsStore["provider:accessMode:openai"] = "apikey"; // user prefers BYOK
  settingsStore["conversation:conv-123:accessMode:openai"] = "oauth"; // conv overrides to OAuth
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai", "conv-123");

  expect(cred.type).toBe("oauth"); // conversation override wins
});

// ── User preference 'oauth' explicitly ──────────────────────────────

test("getCredential('openai') with user preference 'oauth' returns OAuth token", async () => {
  settingsStore["provider:accessMode:openai"] = "oauth";
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai");

  expect(cred.type).toBe("oauth");
  expect(cred.token).toBeTruthy();
});

test("getCredential('openai') with user preference 'oauth' throws when no OAuth token stored", async () => {
  settingsStore["provider:accessMode:openai"] = "oauth";
  // No OAuth token stored

  await expect(getCredential("openai")).rejects.toThrow("No OAuth token for openai");
});

// ── No conversationId skips conversation override check ─────────────

test("getCredential without conversationId skips conversation override", async () => {
  settingsStore["conversation:conv-123:accessMode:openai"] = "apikey";
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  // No conversationId passed -- should ignore the conversation override
  const cred = await getCredential("openai");
  expect(cred.type).toBe("oauth");
});

// ── Default fallback: both OAuth and BYOK fail ──────────────────────

test("getCredential('google') throws when both OAuth and BYOK are unavailable", async () => {
  // No OAuth token, no env var
  delete process.env.GOOGLE_API_KEY;

  await expect(getCredential("google")).rejects.toThrow(
    "No credentials available for google",
  );
});

// ── Local Provider Custom Model Fallback Tests ─────────────────────

test("getCredential returns empty credential for local provider with baseUrl in customModels", async () => {
  // No env var or BYOK for "ollama" (beforeEach doesn't set one)
  settingsStore["provider:customModels"] = [
    { modelId: "llama3", provider: "ollama", baseUrl: "http://localhost:11434" },
  ];

  const cred = await getCredential("ollama");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe("no-key-needed");
});

test("getCredential still throws for provider with no credentials and no custom models with baseUrl", async () => {
  // No env var, no BYOK, no custom models for "unknown-provider"
  await expect(getCredential("unknown-provider")).rejects.toThrow(
    "No credentials available for unknown-provider",
  );
});

test("custom model without baseUrl does not trigger local provider fallback", async () => {
  settingsStore["provider:customModels"] = [
    { modelId: "custom-model", provider: "some-provider" }, // no baseUrl
  ];

  await expect(getCredential("some-provider")).rejects.toThrow(
    "No credentials available for some-provider",
  );
});

test("regular provider with env var still returns API key (custom model fallback not reached)", async () => {
  // anthropic has env var set in beforeEach
  settingsStore["provider:customModels"] = [
    { modelId: "claude-local", provider: "anthropic", baseUrl: "http://localhost:8080" },
  ];

  const cred = await getCredential("anthropic");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY); // env var, not empty string
});
