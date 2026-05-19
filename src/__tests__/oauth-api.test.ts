import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER } from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────

// Mock settings store
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

// Mock the OAuth callback server (noop)
mock.module("../auth/oauth-callback-server", () => ({
  startOAuthCallbackServer: mock(() => {}),
}));

// Mock fetch for token exchange
const originalFetch = globalThis.fetch;
const fetchMockFn = mock(() =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  ),
);
globalThis.fetch = fetchMockFn as any;

// Register $server aliases + OAuth-specific ones
mockServerAlias();

for (const alias of [
  "$server/auth/oauth",
  "$server/auth/oauth-callback-server",
  "$server/providers/encryption",
]) {
  const relative = alias.replace("$server/", "../../");
  mock.module(alias, () => require(relative));
}

// $lib/server alias for shared oauth config
mock.module("$lib/server/oauth-config", () => require("../../web/src/lib/server/oauth-config"));

// Mock $types for all route paths
for (const path of [
  "../../web/src/routes/api/auth/oauth/$types",
  "../../web/src/routes/api/auth/oauth/callback/$types",
  "../../web/src/routes/api/providers/$types",
]) {
  mock.module(path, () => ({}));
}

// ── Handler imports ──────────────────────────────────────────────
import { GET as oauthGet } from "../../web/src/routes/api/auth/oauth/+server";
import { POST as callbackPost, DELETE as callbackDelete } from "../../web/src/routes/api/auth/oauth/callback/+server";
import { GET as providersGet } from "../../web/src/routes/api/providers/+server";

// updated for sec-M2: helper to pre-seed a server-side pending OAuth
// record so callback tests can hit the "found by state" path. Pre-fix
// the callback accepted codeVerifier + redirectUri straight from the
// request body; the regression test covers the new server-side lookup.
function seedPending(state: string, provider = "openai", overrides: Partial<{ codeVerifier: string; redirectUri: string; createdAt: number }> = {}) {
  settingsStore[`oauth:pending:${state}`] = {
    state,
    codeVerifier: overrides.codeVerifier ?? "server-stored-verifier",
    redirectUri: overrides.redirectUri ?? "http://localhost:1455/auth/callback",
    provider,
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

afterAll(() => {
  globalThis.fetch = originalFetch;
  restoreModuleMocks();
});

beforeEach(() => {
  settingsStore = {};
  fetchMockFn.mockClear();
  fetchMockFn.mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
});

// ── GET /api/auth/oauth ──────────────────────────────────────────

describe("GET /api/auth/oauth", () => {
  test("?provider=openai returns url and state", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/auth/oauth?provider=openai",
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    expect(body.url).toContain("auth.openai.com");
    expect(body.state).toBeTruthy();
    // updated for sec-M2: codeVerifier must NOT be in the JSON response —
    // it is stored server-side under oauth:pending:<state> instead.
    expect(body.codeVerifier).toBeUndefined();
    expect(body.redirectUri).toBeTruthy();
    // updated for sec-M2: initiator must have seeded the pending record.
    expect(settingsStore[`oauth:pending:${body.state}`]).toBeDefined();
  });

  test("?provider=google returns url with Google OAuth", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/auth/oauth?provider=google",
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    expect(body.url).toContain("accounts.google.com");
    expect(body.state).toBeTruthy();
  });

  test("?provider=anthropic returns 400 (BYOK-only)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/auth/oauth?provider=anthropic",
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(400);

    const body = await jsonFromResponse(res);
    expect(body.error).toContain("API keys");
  });

  test("missing provider returns 400", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/auth/oauth",
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(400);

    const body = await jsonFromResponse(res);
    expect(body.error).toBeTruthy();
  });

  test("invalid provider returns 400", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/auth/oauth?provider=invalid-provider",
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(400);

    const body = await jsonFromResponse(res);
    expect(body.error).toContain("Invalid provider");
  });
});

// ── POST /api/auth/oauth/callback ────────────────────────────────

describe("POST /api/auth/oauth/callback", () => {
  test("valid exchange stores encrypted token and returns success", async () => {
    // updated for sec-M2: callback now requires a server-side pending
    // record keyed by state. Seed it before the exchange.
    seedPending("valid-state-token", "openai");
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/oauth/callback",
      body: {
        provider: "openai",
        code: "auth-code-123",
        state: "valid-state-token",
      },
      user: ADMIN_USER,
    });
    const res = await callbackPost(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    expect(body.success).toBe(true);
    expect(body.provider).toBe("openai");

    // Token should be stored encrypted
    expect(settingsStore["provider:oauth:openai"]).toContain("enc:");
    // updated for sec-M2: pending record consumed one-shot.
    expect(settingsStore["oauth:pending:valid-state-token"]).toBeUndefined();
  });

  test("missing state returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/oauth/callback",
      body: {
        provider: "openai",
        code: "auth-code-123",
        codeVerifier: "verifier-456",
        redirectUri: "http://localhost:1455/auth/callback",
      },
      user: ADMIN_USER,
    });
    const res = await callbackPost(event);
    expect(res.status).toBe(400);

    const body = await jsonFromResponse(res);
    expect(body.error).toContain("state");
  });

  test("empty state returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/oauth/callback",
      body: {
        provider: "openai",
        code: "auth-code-123",
        codeVerifier: "verifier-456",
        redirectUri: "http://localhost:1455/auth/callback",
        state: "",
      },
      user: ADMIN_USER,
    });
    const res = await callbackPost(event);
    expect(res.status).toBe(400);

    const body = await jsonFromResponse(res);
    expect(body.error).toContain("state");
  });

  test("failed code exchange returns 400", async () => {
    // updated for sec-M2: pending record must exist for the handler to
    // even attempt the token exchange that's being made to fail here.
    seedPending("valid-state-token", "openai");
    fetchMockFn.mockImplementation(() =>
      Promise.resolve(new Response("error", { status: 401 })),
    );

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/oauth/callback",
      body: {
        provider: "openai",
        code: "bad-code",
        state: "valid-state-token",
      },
      user: ADMIN_USER,
    });
    const res = await callbackPost(event);
    expect(res.status).toBe(400);

    const body = await jsonFromResponse(res);
    expect(body.error).toContain("failed");
  });

  test("missing provider returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/oauth/callback",
      body: { code: "abc", codeVerifier: "def", redirectUri: "http://localhost" },
      user: ADMIN_USER,
    });
    const res = await callbackPost(event);
    expect(res.status).toBe(400);

    const body = await jsonFromResponse(res);
    expect(body.error).toContain("Invalid provider");
  });

  test("missing code returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/oauth/callback",
      body: { provider: "openai", codeVerifier: "def", redirectUri: "http://localhost" },
      user: ADMIN_USER,
    });
    const res = await callbackPost(event);
    expect(res.status).toBe(400);

    const body = await jsonFromResponse(res);
    expect(body.error).toContain("required");
  });

  test("codeVerifier in request body is ignored (sec-M2)", async () => {
    // updated for sec-M2: the handler no longer reads codeVerifier from
    // the request body — it pulls the verifier from the server-stored
    // pending record. Passing an attacker-controlled verifier in the
    // body must not influence the token exchange.
    seedPending("verifier-ignore-state", "openai", {
      codeVerifier: "server-stored-real-verifier",
    });
    fetchMockFn.mockClear();
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/oauth/callback",
      body: {
        provider: "openai",
        code: "abc",
        state: "verifier-ignore-state",
        codeVerifier: "attacker-planted-verifier",
      },
      user: ADMIN_USER,
    });
    const res = await callbackPost(event);
    expect(res.status).toBe(200);
    // The token request body must contain the server-stored verifier,
    // never the attacker-planted one from the request body.
    const tokenCall = fetchMockFn.mock.calls[0] as any;
    const tokenBody = String(tokenCall?.[1]?.body ?? "");
    expect(tokenBody).toContain("code_verifier=server-stored-real-verifier");
    expect(tokenBody).not.toContain("attacker-planted-verifier");
  });

  test("google exchange stores token correctly", async () => {
    // updated for sec-M2: seed a pending record for google state.
    seedPending("google-state-token", "google");
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/auth/oauth/callback",
      body: {
        provider: "google",
        code: "google-code",
        state: "google-state-token",
      },
      user: ADMIN_USER,
    });
    const res = await callbackPost(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    expect(body.success).toBe(true);
    expect(settingsStore["provider:oauth:google"]).toContain("enc:");
  });
});

// ── DELETE /api/auth/oauth/callback ──────────────────────────────

describe("DELETE /api/auth/oauth/callback", () => {
  test("valid provider removes setting and returns 200", async () => {
    settingsStore["provider:oauth:openai"] = "enc:some-token";

    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/auth/oauth/callback",
      body: { provider: "openai" },
      user: ADMIN_USER,
    });
    const res = await callbackDelete(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    expect(body.success).toBe(true);
    expect(settingsStore["provider:oauth:openai"]).toBeUndefined();
  });

  test("missing provider returns 400", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/auth/oauth/callback",
      body: {},
      user: ADMIN_USER,
    });
    const res = await callbackDelete(event);
    expect(res.status).toBe(400);

    const body = await jsonFromResponse(res);
    expect(body.error).toContain("Invalid provider");
  });

  test("invalid provider returns 400", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/auth/oauth/callback",
      body: { provider: "anthropic" },
      user: ADMIN_USER,
    });
    const res = await callbackDelete(event);
    expect(res.status).toBe(400);
  });
});

// ── GET /api/providers (OAuth fields) ────────────────────────────

describe("GET /api/providers (OAuth fields)", () => {
  test("returns oauthSupported=false for anthropic", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/providers",
      user: ADMIN_USER,
    });
    const res = await providersGet(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res) as any[];
    const anthropic = body.find((p: any) => p.provider === "anthropic");
    expect(anthropic).toBeTruthy();
    expect(anthropic.oauthSupported).toBe(false);
  });

  test("returns oauthConnected=true when encrypted token exists", async () => {
    const tokenData = {
      access: "tok",
      refresh: "ref",
      expires: Date.now() + 3600_000,
    };
    settingsStore["provider:oauth:openai"] = `enc:${JSON.stringify(tokenData)}`;

    const event = createMockEvent({
      url: "http://localhost/api/providers",
      user: ADMIN_USER,
    });
    const res = await providersGet(event);
    const body = await jsonFromResponse(res) as any[];
    const openai = body.find((p: any) => p.provider === "openai");
    expect(openai.oauthConnected).toBe(true);
    expect(openai.oauthExpired).toBe(false);
  });

  test("returns oauthExpired=true when token is expired", async () => {
    const tokenData = {
      access: "tok",
      refresh: "ref",
      expires: Date.now() - 10_000, // expired
    };
    settingsStore["provider:oauth:openai"] = `enc:${JSON.stringify(tokenData)}`;

    const event = createMockEvent({
      url: "http://localhost/api/providers",
      user: ADMIN_USER,
    });
    const res = await providersGet(event);
    const body = await jsonFromResponse(res) as any[];
    const openai = body.find((p: any) => p.provider === "openai");
    expect(openai.oauthConnected).toBe(true);
    expect(openai.oauthExpired).toBe(true);
  });

  test("returns oauthConnected=false when no token stored", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/providers",
      user: ADMIN_USER,
    });
    const res = await providersGet(event);
    const body = await jsonFromResponse(res) as any[];
    const openai = body.find((p: any) => p.provider === "openai");
    expect(openai.oauthConnected).toBe(false);
    expect(openai.oauthExpired).toBe(false);
    expect(openai.oauthSupported).toBe(true);
  });
});
