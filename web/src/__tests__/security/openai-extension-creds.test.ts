import { describe, expect, test, beforeEach, mock } from "bun:test";

// Mock settings + encryption + pi-ai env resolver + pi-ai/oauth BEFORE
// importing the module under test so resolveOpenAIApiKey / resolveOpenAIAccessToken
// dependencies are deterministic.
let storedApiKey: unknown ;
let storedOAuth: unknown ;
let envApiKey: string | undefined ;
let decryptImpl: (s: string) => string = (s) => s;
let encryptImpl: (s: string) => string = (s) => s;
let upsertCalls: Array<{ key: string; value: unknown }> = [];
// pi-ai 0.83.0 removed `getOAuthApiKey`; refresh + key derivation now run
// through the shared credential store, so THAT is the seam this suite stubs.
let resolveOAuthAuthImpl: (providerId: string) => any = async () => undefined;
// Simulates the settings store being unreachable (DB down / not yet booted).
// Both resolvers must fail CLOSED when this happens rather than surfacing a
// stale or partial credential.
let getSettingThrows = false;

mock.module("$server/db/queries/settings", () => ({
  getSetting: async (key: string) => {
    if (getSettingThrows) throw new Error("settings store unavailable");
    if (key === "provider:apiKey:openai") return storedApiKey;
    if (key === "provider:oauth:openai") return storedOAuth;
    return undefined;
  },
  upsertSetting: async (key: string, value: unknown) => {
    upsertCalls.push({ key, value });
  },
}));
mock.module("$server/providers/encryption", () => ({
  decrypt: (s: string) => decryptImpl(s),
  encrypt: (s: string) => encryptImpl(s),
}));
mock.module("@earendil-works/pi-ai/compat", () => ({
  getEnvApiKey: (_p: string) => envApiKey,
}));
mock.module("$server/providers/credential-store", () => ({
  resolveOAuthAuth: (providerId: string) => resolveOAuthAuthImpl(providerId),
}));

import {
  resolveOpenAIApiKey,
  resolveOpenAIAccessToken,
} from "$lib/server/security/openai-extension-creds";

beforeEach(() => {
  storedApiKey = undefined;
  storedOAuth = undefined;
  envApiKey = undefined;
  decryptImpl = (s) => s;
  encryptImpl = (s) => s;
  upsertCalls = [];
  resolveOAuthAuthImpl = async () => undefined;
  getSettingThrows = false;
});

describe("resolveOpenAIApiKey — lookup order", () => {
  test("returns decrypted BYOK key from settings when present", async () => {
    storedApiKey = "enc";
    decryptImpl = (s) => (s === "enc" ? "sk-byok" : "");
    expect(await resolveOpenAIApiKey()).toBe("sk-byok");
  });

  test("falls back to env OPENAI_API_KEY when settings row is missing", async () => {
    storedApiKey = undefined;
    envApiKey = "sk-env";
    expect(await resolveOpenAIApiKey()).toBe("sk-env");
  });

  test("falls back to env when decrypt throws", async () => {
    storedApiKey = "bad";
    decryptImpl = () => {
      throw new Error("decrypt failed");
    };
    envApiKey = "sk-env";
    expect(await resolveOpenAIApiKey()).toBe("sk-env");
  });

  test("falls back to env when decrypted value is empty", async () => {
    storedApiKey = "x";
    decryptImpl = () => "";
    envApiKey = "sk-env";
    expect(await resolveOpenAIApiKey()).toBe("sk-env");
  });

  test("returns null when neither BYOK nor env is configured", async () => {
    expect(await resolveOpenAIApiKey()).toBeNull();
  });
});

describe("resolveOpenAIAccessToken", () => {
  function makeCreds(overrides: Partial<{ access: string; refresh: string; expires: number }> = {}): string {
    return JSON.stringify({
      access: "initial-access",
      refresh: "initial-refresh",
      expires: Date.now() + 60 * 60 * 1000,
      ...overrides,
    });
  }

  test("returns null when no OAuth credential is stored", async () => {
    expect(await resolveOpenAIAccessToken()).toBeNull();
  });

  test("returns the stored access token when not near expiry", async () => {
    storedOAuth = "enc";
    decryptImpl = () => makeCreds({ access: "still-fresh", expires: Date.now() + 10 * 60 * 1000 });
    expect(await resolveOpenAIAccessToken()).toBe("still-fresh");
  });

  test("refreshes through the credential store when the token is within 60s of expiry", async () => {
    storedOAuth = "enc";
    decryptImpl = () => makeCreds({ access: "almost-gone", expires: Date.now() + 5_000 });
    resolveOAuthAuthImpl = async () => ({ apiKey: "refreshed-access" });
    const tok = await resolveOpenAIAccessToken();
    expect(tok).toBe("refreshed-access");
    // This module no longer PERSISTS the refreshed credential: the store
    // does that inside `modify()`. Writing here as well raced the chat
    // path's refresh for the same `provider:oauth:openai` row, and dropping
    // it is the point of routing through one serialized write path.
    expect(upsertCalls.length).toBe(0);
  });

  test("returns null when decrypt throws (corrupted ciphertext)", async () => {
    storedOAuth = "bad";
    decryptImpl = () => {
      throw new Error("decrypt failed");
    };
    expect(await resolveOpenAIAccessToken()).toBeNull();
  });

  test("returns null when refresh flow fails", async () => {
    storedOAuth = "enc";
    decryptImpl = () => makeCreds({ expires: Date.now() + 5_000 });
    resolveOAuthAuthImpl = async () => {
      throw new Error("refresh failed");
    };
    expect(await resolveOpenAIAccessToken()).toBeNull();
  });

  test("returns null when stored credential has no refresh token and is expired", async () => {
    storedOAuth = "enc";
    decryptImpl = () =>
      JSON.stringify({ access: "dead", refresh: undefined, expires: Date.now() + 5_000 });
    expect(await resolveOpenAIAccessToken()).toBeNull();
  });

  test("returns null when the refresh yields no apiKey", async () => {
    // There is no longer a "fall back to newCredentials.access" arm: the
    // store owns the credential and `resolveOAuthAuth` returns only the
    // derived request auth. No apiKey means no token to inject, and the
    // extension emits its own missing-credential error.
    storedOAuth = "enc";
    decryptImpl = () => makeCreds({ expires: Date.now() + 5_000 });
    resolveOAuthAuthImpl = async () => ({ apiKey: undefined });
    expect(await resolveOpenAIAccessToken()).toBeNull();
    resolveOAuthAuthImpl = async () => undefined;
    expect(await resolveOpenAIAccessToken()).toBeNull();
  });

  test("fails CLOSED when the settings store is unreachable (no token, no throw)", async () => {
    // A usable credential IS stored — but the store itself errors on read.
    // The resolver must swallow the error and yield null rather than
    // propagating (which would crash the spawn) or returning anything.
    storedOAuth = "enc";
    decryptImpl = () => makeCreds({ expires: Date.now() + 60 * 60 * 1000 });
    getSettingThrows = true;

    expect(await resolveOpenAIAccessToken()).toBeNull();
    // The BYOK path shares the fail-closed contract: with no env fallback
    // configured, an unreachable store must yield null, never a partial value.
    expect(await resolveOpenAIApiKey()).toBeNull();
  });

});
