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

/**
 * The pi seam. pi-ai 0.83.0 removed `getOAuthApiKey`; refresh + key
 * derivation now run through `Models.getAuth()`, so THAT is what this suite
 * stubs — one function, at the network boundary. Everything on EZCorp's side
 * (the resolution ladder, the expiry predicate, and the real
 * `SettingsCredentialStore` including its per-provider lock) stays live.
 *
 * The default implementation MIRRORS pi's own `resolveRefreshCredential`
 * (models.js:119-133) so the store's serialization is exercised the way pi
 * actually drives it: read the stored credential, and when it is inside the
 * validity window run the exchange INSIDE `credentials.modify()`, re-checking
 * expiry there so a caller that queued behind another turn's refresh returns
 * `undefined` (leave unchanged) instead of exchanging again.
 *
 * The token exchange itself — the only thing that would touch the network —
 * is {@link mockRefreshExchange}. For `openai-codex` the derived apiKey IS
 * the access token, so one string models both.
 */
const mockRefreshExchange = mock<() => Promise<string>>(async () => FAKE_REFRESHED_API_KEY);

/** Which pi provider ids the fake catalog knows. `google-gemini-cli` is
 *  absent on purpose — pi-ai has never registered it. */
const KNOWN_PI_PROVIDERS = new Set(["openai-codex", "anthropic"]);

const mockGetAuth = mock<(providerId: string, overrides?: any) => Promise<unknown>>(
  async (providerId, overrides) => {
    if (!KNOWN_PI_PROVIDERS.has(providerId)) return undefined;
    const store = getCredentialStore();
    const current: any = await store.read(providerId);
    if (!current) return undefined;
    const minValidity = overrides?.minOAuthValidityMs ?? 300_000;
    if (Date.now() < current.expires - minValidity) {
      return { auth: { apiKey: current.access }, source: "OAuth" };
    }
    const post: any = await store.modify(providerId, async (inner: any) => {
      // pi's re-check INSIDE the lock: a queued caller sees the refreshed
      // credential and declines to exchange again.
      if (inner?.type !== "oauth" || Date.now() < inner.expires - minValidity) return undefined;
      const access = await mockRefreshExchange();
      return { ...inner, type: "oauth", access, expires: Date.now() + 3600_000 };
    });
    return post ? { auth: { apiKey: post.access }, source: "OAuth" } : undefined;
  },
);

// Mock getEnvApiKey from pi-ai
const mockGetEnvApiKey = mock((provider: string) => {
  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
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

// `encrypt`/`decrypt` ROUND-TRIP for anything written during a test, while
// the pre-seeded FAKE_ENCRYPTED sentinel still decrypts to `decryptReturn`.
// That matters now that refresh persists through the real credential store:
// with a decrypt that ignored its input, a re-read after a refresh would
// still yield the stale pre-refresh credential and the "second caller sees
// the fresh token" property would be untestable.
mock.module("../providers/encryption", () => ({
  encrypt: mock((plaintext: string) => `enc:${plaintext}`),
  decrypt: mock((ciphertext: string) =>
    typeof ciphertext === "string" && ciphertext.startsWith("enc:") ? ciphertext.slice(4) : decryptReturn,
  ),
  _resetKeyCache: () => {},
}));

mock.module("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({ getAuth: mockGetAuth }),
}));

mock.module("@earendil-works/pi-ai/compat", () => ({
  getEnvApiKey: mockGetEnvApiKey,
  getModel: mock(() => ({})),
  getModels: mock(() => []),
  getProviders: mock(() => []),
}));

afterAll(() => restoreModuleMocks());

// Import after mocks are set up
const { getCredentialStore } = await import("../providers/credential-store");
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
  mockGetAuth.mockClear();
  mockRefreshExchange.mockClear();
  mockRefreshExchange.mockImplementation(async () => FAKE_REFRESHED_API_KEY);
  mockGetEnvApiKey.mockClear();
  mockGetEnvApiKey.mockImplementation((provider: string) => {
    const envMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GOOGLE_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    };
    const envKey = envMap[provider];
    return envKey ? process.env[envKey] : undefined;
  });
  _clearRefreshLocks();
  // Set env vars for BYOK fallback
  process.env.OPENAI_API_KEY = FAKE_API_KEY;
  process.env.ANTHROPIC_API_KEY = FAKE_API_KEY;
  process.env.GOOGLE_API_KEY = FAKE_API_KEY;
  process.env.OPENROUTER_API_KEY = FAKE_API_KEY;
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

test("getCredential('google') falls through to BYOK — pi has no google OAuth provider", async () => {
  // BEHAVIOUR CORRECTION, not a regression. This test used to assert an
  // `oauth` credential, and passed only because the old suite stubbed
  // `getOAuthApiKey` to succeed for ANY provider id. `OAUTH_PROVIDER_IDS.google`
  // is `google-gemini-cli`, which pi-ai has NEVER registered — not in 0.80.6,
  // not in 0.83.0 (verified: `builtinModels().getProvider("google-gemini-cli")`
  // is undefined; `google` itself is apiKey-only). In production the old code
  // threw `Unknown OAuth provider`, getCredential swallowed it, and Google
  // resolved to BYOK exactly as it does here. The mock was the only place
  // Google OAuth ever worked.
  settingsStore["provider:oauth:google"] = FAKE_ENCRYPTED;

  const cred = await getCredential("google");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY);
  // Consulted, but yields nothing — so no token is derived and no exchange runs.
  expect(mockRefreshExchange).not.toHaveBeenCalled();
});

// ── Anthropic Always BYOK Tests ─────────────────────────────────────

test("getCredential('anthropic') always returns apikey credential (never OAuth)", async () => {
  // Even if OAuth token exists, should not use it (anthropic skips OAuth)
  settingsStore["provider:oauth:anthropic"] = FAKE_ENCRYPTED;

  const cred = await getCredential("anthropic");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY);
});

// ── OpenRouter Always BYOK Tests ────────────────────────────────────
// OpenRouter is API-key-only (BYOK), exactly like anthropic: no
// pi-managed OAuth flow, so the default chain must skip DB-OAuth and go
// straight to a stored key / env var.

test("getCredential('openrouter') returns apikey from stored provider:apiKey:openrouter", async () => {
  // `decrypt` round-trips an "enc:" value, so the stored ciphertext and the
  // expected plaintext must now agree (they used to be allowed to differ,
  // because decrypt ignored its argument entirely).
  settingsStore["provider:apiKey:openrouter"] = "enc:sk-or-stored-key";

  const cred = await getCredential("openrouter");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe("sk-or-stored-key");
  // BYOK-only: the OAuth arm is skipped entirely, so no exchange happens.
  expect(mockRefreshExchange).not.toHaveBeenCalled();
});

test("getCredential('openrouter') falls back to OPENROUTER_API_KEY env var when no stored key", async () => {
  // No stored key -- resolves via getEnvApiKey('openrouter') → OPENROUTER_API_KEY
  const cred = await getCredential("openrouter");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY);
  expect(mockRefreshExchange).not.toHaveBeenCalled();
});

test("getCredential('openrouter') is BYOK-only — never uses OAuth even if an OAuth token exists", async () => {
  // Even with an OAuth token stored, openrouter must skip the OAuth chain.
  settingsStore["provider:oauth:openrouter"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openrouter");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY); // env-var BYOK, not the OAuth token
  expect(mockRefreshExchange).not.toHaveBeenCalled();
});

// ── Token Refresh Tests ─────────────────────────────────────────────

test("getCredential('openai') auto-refreshes expired token and returns refreshed: true", async () => {
  decryptReturn = makeTokenData({ expires: Date.now() - 1000 }); // expired
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai");

  expect(cred.type).toBe("oauth");
  expect(cred.token).toBe(FAKE_REFRESHED_API_KEY);
  expect(cred.refreshed).toBe(true);
  expect(mockRefreshExchange).toHaveBeenCalledTimes(1);
});

test("getCredential('openai') refreshes token expiring within 60s buffer", async () => {
  decryptReturn = makeTokenData({ expires: Date.now() + 30_000 }); // 30s left (within 60s buffer)
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  const cred = await getCredential("openai");

  expect(cred.refreshed).toBe(true);
  expect(mockRefreshExchange).toHaveBeenCalledTimes(1);
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

  // A genuine refresh failure: pi surfaces `ModelsError` with code "oauth".
  mockRefreshExchange.mockImplementationOnce(async () => {
    throw Object.assign(new Error("invalid_grant"), { code: "oauth" });
  });

  const cred = await getCredential("openai");

  expect(cred.type).toBe("apikey");
  expect(cred.token).toBe(FAKE_API_KEY);
});

test("a BROKEN OAuth connection reports the refresh failure, not 'no credentials'", async () => {
  // The two failures the ladder must not flatten into each other:
  //   - nothing connected            -> "No credentials available for X"
  //   - connected but un-refreshable -> name the refresh failure + re-login
  // Flattening the second into the first is what sends someone to re-enter
  // an API key they never had, when the actual fix is signing in again.
  decryptReturn = makeTokenData({ expires: Date.now() - 1000 });
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  // A genuine refresh failure: pi surfaces `ModelsError` with code "oauth".
  const cause = Object.assign(new Error("invalid_grant"), { code: "oauth" });
  mockRefreshExchange.mockImplementationOnce(async () => {
    throw cause;
  });
  // Remove env var so BYOK also fails and the ladder runs out of options.
  delete process.env.OPENAI_API_KEY;

  const err = await getCredential("openai").then(
    () => { throw new Error("expected getCredential to reject"); },
    (e: unknown) => e as Error,
  );
  expect(err.message).toContain("could not be refreshed");
  expect(err.message).toContain("invalid_grant");
  expect(err.message).not.toContain("No credentials available");
  // The underlying error survives as `cause`, so callers/logs can inspect it.
  expect((err as { cause?: unknown }).cause).toBe(cause);
});

test("a provider with NOTHING connected still reports the generic message", async () => {
  // The contrast case for the test above: no stored OAuth, no BYOK, no env.
  delete process.env.OPENAI_API_KEY;

  await expect(getCredential("openai")).rejects.toThrow(
    "No credentials available for openai",
  );
});

// ── Concurrent Refresh Lock Tests ───────────────────────────────────

test("concurrent getCredential calls with expired token share a single refresh request", async () => {
  decryptReturn = makeTokenData({ expires: Date.now() - 1000 });
  settingsStore["provider:oauth:openai"] = FAKE_ENCRYPTED;

  // Launch two concurrent calls
  const [cred1, cred2] = await Promise.all([
    getCredential("openai"),
    getCredential("openai"),
  ]);

  // Both should succeed with the same refreshed token
  expect(cred1.token).toBe(FAKE_REFRESHED_API_KEY);
  expect(cred2.token).toBe(FAKE_REFRESHED_API_KEY);
  // Exactly ONE token exchange. This is the property the CredentialStore
  // buys over the old refreshLocks Map: the second caller queues on
  // `modify`, re-checks expiry INSIDE the lock, sees the already-refreshed
  // credential and declines to exchange again.
  expect(mockRefreshExchange).toHaveBeenCalledTimes(1);
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

  const cred = await getCredential("openai");

  expect(cred.refreshed).toBe(true);
  expect(mockRefreshExchange).toHaveBeenCalledTimes(1);
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

  // First call: the token exchange fails.
  mockRefreshExchange.mockImplementationOnce(async () => {
    throw Object.assign(new Error("invalid_grant"), { code: "oauth" });
  });

  // This should fail (oauth fails, then BYOK fallback succeeds in default resolution)
  const cred1 = await getCredential("openai");
  expect(cred1.type).toBe("apikey"); // fell back to BYOK

  // Now set up a successful refresh for the second call. The stored
  // credential is still the expired one — pi preserves it for retry when a
  // refresh throws, which is what makes the second attempt meaningful.
  decryptReturn = makeTokenData({ expires: Date.now() - 1000 });

  // Second call should work -- the serialization chain released after the
  // failure rather than wedging every later caller behind a rejected promise.
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
