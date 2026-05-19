// Regression test for sec-M2: OAuth state + codeVerifier must live
// server-side, not in the frontend. Pre-fix the initiator returned
// codeVerifier in the JSON response body (so it lived in frontend
// state), and the callback never compared `state` against anything
// stored server-side — relying purely on PKCE. Any shared-origin XSS
// would disclose the verifier, after which the state could be replayed
// freely against the callback.
//
// Exploit narrative:
//   1. Victim clicks "Sign in with OpenAI". Frontend calls the
//      initiator, receives {url, state, codeVerifier, redirectUri},
//      stores them in localStorage / state.
//   2. Attacker with shared-origin XSS (or a compromised
//      dependency-of-a-dependency running in the same origin) reads
//      the verifier out of localStorage.
//   3. Attacker intercepts / reuses the authorization code and calls
//      POST /api/auth/oauth/callback with {provider, code, codeVerifier,
//      state}. Pre-fix the handler trusted every field from the body
//      and completed the exchange.
//
// Fix (this commit):
//   - initiator writes {state, codeVerifier, redirectUri, provider,
//     createdAt} into settings KV under oauth:pending:<state>
//   - initiator no longer returns codeVerifier in the JSON response
//   - callback looks up the pending record by state; a missing record
//     is a 400. It uses the server-stored codeVerifier + redirectUri
//     for the PKCE token exchange, ignoring any values from the body.
//   - callback consumes the record one-shot after a successful persist.
//   - TTL of 10 min is enforced on the server-stored record.
//
// Strategy: handler-level probe. Mock the settings module with an
// in-memory store so we can assert on what the initiator writes and
// what the callback reads/deletes. Mock global fetch to capture the
// token exchange body so we can see which codeVerifier + redirectUri
// were actually used.
//
// Tests fix(sec-M2)

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
} from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ─────────────────

mockServerAlias();

// SvelteKit generated $types stubs.
mock.module("../../../web/src/routes/api/auth/oauth/$types", () => ({}));
mock.module("../../../web/src/routes/api/auth/oauth/callback/$types", () => ({}));

// In-memory settings store so we can assert on the pending record
// lifecycle without touching a real DB.
let store: Map<string, unknown>;
const settingsMock = () => ({
  async getAllSettings() {
    return Object.fromEntries(store.entries());
  },
  async getSetting(key: string) {
    return store.has(key) ? store.get(key) : undefined;
  },
  async upsertSetting(key: string, value: unknown) {
    store.set(key, value);
  },
  async deleteSetting(key: string) {
    return store.delete(key);
  },
  async isListingInstalled() {
    return false;
  },
});
mock.module("$server/db/queries/settings", settingsMock);
mock.module("../../db/queries/settings", settingsMock);

// Callback subprocess is a noop in tests.
const callbackServerMock = () => ({
  startOAuthCallbackServer: () => {},
});
mock.module("$server/auth/oauth-callback-server", callbackServerMock);
mock.module("../../auth/oauth-callback-server", callbackServerMock);

// Encryption helpers — round-trip plaintext through an "enc:" prefix so
// we can assert persistence without needing the real AES-GCM primitives.
mock.module("$server/providers/encryption", () => ({
  encrypt: (plaintext: string) => `enc:${plaintext}`,
  decrypt: (ciphertext: string) => ciphertext.replace(/^enc:/, ""),
  _resetKeyCache: () => {},
}));
mock.module("../../providers/encryption", () => ({
  encrypt: (plaintext: string) => `enc:${plaintext}`,
  decrypt: (ciphertext: string) => ciphertext.replace(/^enc:/, ""),
  _resetKeyCache: () => {},
}));

// $lib alias for the shared OAuth config.
mock.module("$lib/server/oauth-config", () =>
  require("../../../web/src/lib/server/oauth-config"),
);

// Capture every outbound fetch so we can inspect the token exchange
// body — specifically which codeVerifier the handler passed.
const tokenExchanges: Array<{ url: string; body: string }> = [];
const originalFetch = globalThis.fetch;
const fetchMock = mock(async (url: any, init?: any) => {
  tokenExchanges.push({
    url: String(url),
    body: String(init?.body ?? ""),
  });
  return new Response(
    JSON.stringify({
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_in: 3600,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
globalThis.fetch = fetchMock as any;

// ── Handler imports (AFTER mocks) ────────────────────────────────
import { GET as oauthGet } from "../../../web/src/routes/api/auth/oauth/+server";
import { POST as callbackPost } from "../../../web/src/routes/api/auth/oauth/callback/+server";

const BASE = "http://localhost:1455";

afterAll(() => {
  globalThis.fetch = originalFetch;
  restoreModuleMocks();
});

beforeEach(() => {
  store = new Map<string, unknown>();
  tokenExchanges.length = 0;
  fetchMock.mockClear();
});

// ── Tests ────────────────────────────────────────────────────────

describe("sec-M2: initiator response must not leak codeVerifier", () => {
  test("GET /api/auth/oauth response body has no codeVerifier field", async () => {
    const event = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=openai`,
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    expect(res.status).toBe(200);

    const body = await jsonFromResponse(res);
    // The url, state, and redirectUri are public / non-secret.
    expect(body.url).toBeTruthy();
    expect(body.state).toBeTruthy();
    expect(body.redirectUri).toBeTruthy();
    // Pre-fix these lived on the client as `codeVerifier` / `verifier`.
    // The response must not include any plausible alias.
    expect(body.codeVerifier).toBeUndefined();
    expect(body.code_verifier).toBeUndefined();
    expect(body.verifier).toBeUndefined();
    expect(body.pkceVerifier).toBeUndefined();
    // Defence-in-depth: scan raw JSON for "verifier" substring.
    expect(JSON.stringify(body).toLowerCase()).not.toContain("verifier");
  });
});

describe("sec-M2: initiator persists pending record server-side", () => {
  test("GET /api/auth/oauth seeds oauth:pending:<state> with codeVerifier + redirectUri", async () => {
    const event = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=openai`,
      user: ADMIN_USER,
    });
    const res = await oauthGet(event);
    const body = await jsonFromResponse(res);

    const key = `oauth:pending:${body.state}`;
    const pending = store.get(key) as any;
    expect(pending).toBeDefined();
    expect(pending.state).toBe(body.state);
    expect(pending.provider).toBe("openai");
    expect(typeof pending.codeVerifier).toBe("string");
    expect(pending.codeVerifier.length).toBeGreaterThan(20);
    expect(typeof pending.redirectUri).toBe("string");
    expect(typeof pending.createdAt).toBe("number");
    expect(pending.createdAt).toBeLessThanOrEqual(Date.now());
  });

  test("each initiation creates a distinct pending record keyed by state", async () => {
    const event1 = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=openai`,
      user: ADMIN_USER,
    });
    const event2 = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=google`,
      user: ADMIN_USER,
    });
    const body1 = await jsonFromResponse(await oauthGet(event1));
    const body2 = await jsonFromResponse(await oauthGet(event2));

    expect(body1.state).not.toBe(body2.state);
    expect(store.get(`oauth:pending:${body1.state}`)).toBeDefined();
    expect(store.get(`oauth:pending:${body2.state}`)).toBeDefined();
  });
});

describe("sec-M2: callback rejects unknown state", () => {
  test("POST callback with state that has no pending record → 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `${BASE}/api/auth/oauth/callback`,
      body: {
        provider: "openai",
        code: "auth-code",
        state: "never-issued-by-the-server",
      },
      user: ADMIN_USER,
    });
    const res = await callbackPost(event);
    expect(res.status).toBe(400);
    const body = await jsonFromResponse(res);
    expect(body.error).toMatch(/state/i);
    // No token exchange must occur when state lookup fails.
    expect(tokenExchanges.length).toBe(0);
  });

  test("POST callback with state mismatched to a different provider → 400", async () => {
    // Seed a pending record under provider=google, then try to consume
    // it as provider=openai — defence-in-depth provider check.
    store.set("oauth:pending:cross-provider-state", {
      state: "cross-provider-state",
      codeVerifier: "verifier-for-google",
      redirectUri: "http://localhost:1456/auth/callback",
      provider: "google",
      createdAt: Date.now(),
    });
    const event = createMockEvent({
      method: "POST",
      url: `${BASE}/api/auth/oauth/callback`,
      body: {
        provider: "openai",
        code: "auth-code",
        state: "cross-provider-state",
      },
      user: ADMIN_USER,
    });
    const res = await callbackPost(event);
    expect(res.status).toBe(400);
    expect(tokenExchanges.length).toBe(0);
    // Record is cleared so the attacker can't grind further attempts.
    expect(store.get("oauth:pending:cross-provider-state")).toBeUndefined();
  });
});

describe("sec-M2: callback uses server-stored codeVerifier for PKCE", () => {
  test("end-to-end initiate → callback uses server-stored verifier, not body value", async () => {
    // Run the real initiator to get a legitimate state + server-stored
    // pending record.
    const initEvent = createMockEvent({
      url: `${BASE}/api/auth/oauth?provider=openai`,
      user: ADMIN_USER,
    });
    const initBody = await jsonFromResponse(await oauthGet(initEvent));
    const { state } = initBody;

    const pending = store.get(`oauth:pending:${state}`) as any;
    const serverVerifier = pending.codeVerifier as string;
    expect(serverVerifier).toBeTruthy();

    // Callback with an attacker-planted codeVerifier in the body —
    // the handler must ignore it and use the server-stored one.
    const cbEvent = createMockEvent({
      method: "POST",
      url: `${BASE}/api/auth/oauth/callback`,
      body: {
        provider: "openai",
        code: "real-auth-code",
        state,
        codeVerifier: "ATTACKER-PLANTED-VERIFIER-DO-NOT-USE",
        redirectUri: "https://evil.tld/auth/callback",
      },
      user: ADMIN_USER,
    });
    const cbRes = await callbackPost(cbEvent);
    expect(cbRes.status).toBe(200);

    // Inspect the captured token-exchange POST body.
    expect(tokenExchanges.length).toBe(1);
    const body = tokenExchanges[0]!.body;
    expect(body).toContain(`code_verifier=${encodeURIComponent(serverVerifier)}`);
    expect(body).not.toContain("ATTACKER-PLANTED-VERIFIER-DO-NOT-USE");
    // The redirectUri in the token exchange is the server-stored one,
    // not the attacker-planted evil.tld value.
    expect(body).not.toContain("evil.tld");
  });
});

describe("sec-M2: callback consumes pending record one-shot", () => {
  test("second callback with the same state → 400 (record deleted)", async () => {
    // Initiate + complete once.
    const initBody = await jsonFromResponse(
      await oauthGet(
        createMockEvent({
          url: `${BASE}/api/auth/oauth?provider=openai`,
          user: ADMIN_USER,
        }),
      ),
    );
    const state = initBody.state;

    const ok = await callbackPost(
      createMockEvent({
        method: "POST",
        url: `${BASE}/api/auth/oauth/callback`,
        body: { provider: "openai", code: "code-1", state },
        user: ADMIN_USER,
      }),
    );
    expect(ok.status).toBe(200);
    // Pending record is gone after the first consumption.
    expect(store.get(`oauth:pending:${state}`)).toBeUndefined();

    // Second attempt with the same state must be rejected.
    const replay = await callbackPost(
      createMockEvent({
        method: "POST",
        url: `${BASE}/api/auth/oauth/callback`,
        body: { provider: "openai", code: "code-2", state },
        user: ADMIN_USER,
      }),
    );
    expect(replay.status).toBe(400);
    const replayBody = await jsonFromResponse(replay);
    expect(replayBody.error).toMatch(/state/i);
    // Only the first call should have reached the token endpoint.
    expect(tokenExchanges.length).toBe(1);
  });
});

describe("sec-M2: callback enforces TTL on pending record", () => {
  test("pending record older than 10 minutes → 400 and cleaned up", async () => {
    const state = "expired-state-uuid";
    store.set(`oauth:pending:${state}`, {
      state,
      codeVerifier: "verifier-from-eleven-minutes-ago",
      redirectUri: "http://localhost:1455/auth/callback",
      provider: "openai",
      createdAt: Date.now() - 11 * 60 * 1000,
    });

    const res = await callbackPost(
      createMockEvent({
        method: "POST",
        url: `${BASE}/api/auth/oauth/callback`,
        body: { provider: "openai", code: "stale-code", state },
        user: ADMIN_USER,
      }),
    );
    expect(res.status).toBe(400);
    expect(tokenExchanges.length).toBe(0);
    // Lazy cleanup: expired record removed on detection.
    expect(store.get(`oauth:pending:${state}`)).toBeUndefined();
  });

  test("pending record within TTL still works", async () => {
    const state = "fresh-state-uuid";
    store.set(`oauth:pending:${state}`, {
      state,
      codeVerifier: "fresh-verifier",
      redirectUri: "http://localhost:1455/auth/callback",
      provider: "openai",
      createdAt: Date.now() - 30 * 1000, // 30 s ago
    });

    const res = await callbackPost(
      createMockEvent({
        method: "POST",
        url: `${BASE}/api/auth/oauth/callback`,
        body: { provider: "openai", code: "fresh-code", state },
        user: ADMIN_USER,
      }),
    );
    expect(res.status).toBe(200);
    expect(tokenExchanges.length).toBe(1);
    expect(tokenExchanges[0]!.body).toContain("code_verifier=fresh-verifier");
  });
});
