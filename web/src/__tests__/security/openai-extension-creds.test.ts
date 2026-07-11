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
let getOAuthApiKeyImpl: (providerId: string, creds: any) => any = async () => null;

mock.module("$server/db/queries/settings", () => ({
  getSetting: async (key: string) => {
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
mock.module("@earendil-works/pi-ai/oauth", () => ({
  getOAuthApiKey: (providerId: string, creds: any) => getOAuthApiKeyImpl(providerId, creds),
}));

import {
  buildOpenAIInjectedEnv,
  resolveOpenAIApiKey,
  resolveOpenAIAccessToken,
  wireOpenAIExtensionCredentials,
  OPENAI_IMAGE_GEN_EXT_NAME,
} from "$lib/server/security/openai-extension-creds";

class FakeRegistry {
  resolvers = new Map<string, () => Promise<Readonly<Record<string, string>>>>();
  setInjectedEnvResolver(
    name: string,
    fn: () => Promise<Readonly<Record<string, string>>>,
  ): void {
    this.resolvers.set(name, fn);
  }
}

beforeEach(() => {
  storedApiKey = undefined;
  storedOAuth = undefined;
  envApiKey = undefined;
  decryptImpl = (s) => s;
  encryptImpl = (s) => s;
  upsertCalls = [];
  getOAuthApiKeyImpl = async () => null;
});

describe("buildOpenAIInjectedEnv", () => {
  test("injects OPENAI_API_KEY when only an sk-... key is available", () => {
    expect(buildOpenAIInjectedEnv("sk-abc", null)).toEqual({ OPENAI_API_KEY: "sk-abc" });
  });

  test("injects OPENAI_ACCESS_TOKEN when only an OAuth token is available", () => {
    expect(buildOpenAIInjectedEnv(null, "oa-token")).toEqual({ OPENAI_ACCESS_TOKEN: "oa-token" });
  });

  test("injects BOTH when both are available — extension picks the right path", () => {
    expect(buildOpenAIInjectedEnv("sk-abc", "oa-token")).toEqual({
      OPENAI_API_KEY: "sk-abc",
      OPENAI_ACCESS_TOKEN: "oa-token",
    });
  });

  test("returns empty map when both are missing", () => {
    expect(buildOpenAIInjectedEnv(null, null)).toEqual({});
    expect(buildOpenAIInjectedEnv(undefined, undefined)).toEqual({});
    expect(buildOpenAIInjectedEnv("", "")).toEqual({});
  });
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

  test("refreshes via pi-ai/oauth when the token is within 60s of expiry", async () => {
    storedOAuth = "enc";
    decryptImpl = () => makeCreds({ access: "almost-gone", expires: Date.now() + 5_000 });
    getOAuthApiKeyImpl = async () => ({
      apiKey: "refreshed-access",
      newCredentials: {
        access: "refreshed-access",
        refresh: "next-refresh",
        expires: Date.now() + 60 * 60 * 1000,
      },
    });
    const tok = await resolveOpenAIAccessToken();
    expect(tok).toBe("refreshed-access");
    expect(upsertCalls.length).toBe(1);
    expect(upsertCalls[0]!.key).toBe("provider:oauth:openai");
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
    getOAuthApiKeyImpl = async () => {
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

  test("falls back to newCredentials.access when getOAuthApiKey returns no apiKey", async () => {
    storedOAuth = "enc";
    decryptImpl = () => makeCreds({ expires: Date.now() + 5_000 });
    getOAuthApiKeyImpl = async () => ({
      apiKey: undefined,
      newCredentials: {
        access: "from-new-creds",
        refresh: "r",
        expires: Date.now() + 60 * 60 * 1000,
      },
    });
    expect(await resolveOpenAIAccessToken()).toBe("from-new-creds");
  });
});

describe("wireOpenAIExtensionCredentials", () => {
  let registry: FakeRegistry;
  beforeEach(() => {
    registry = new FakeRegistry();
  });

  test("registers a resolver under the extension's canonical name", () => {
    wireOpenAIExtensionCredentials(registry as any, {
      apiKey: async () => "sk-test",
      accessToken: async () => null,
    });
    expect(registry.resolvers.has(OPENAI_IMAGE_GEN_EXT_NAME)).toBe(true);
  });

  test("injects only OPENAI_API_KEY when only BYOK is available", async () => {
    wireOpenAIExtensionCredentials(registry as any, {
      apiKey: async () => "sk-byok",
      accessToken: async () => null,
    });
    const env = await registry.resolvers.get(OPENAI_IMAGE_GEN_EXT_NAME)!();
    expect(env).toEqual({ OPENAI_API_KEY: "sk-byok" });
  });

  test("injects only OPENAI_ACCESS_TOKEN when only OAuth is connected", async () => {
    wireOpenAIExtensionCredentials(registry as any, {
      apiKey: async () => null,
      accessToken: async () => "oa-subscription",
    });
    const env = await registry.resolvers.get(OPENAI_IMAGE_GEN_EXT_NAME)!();
    expect(env).toEqual({ OPENAI_ACCESS_TOKEN: "oa-subscription" });
  });

  test("injects BOTH when both are configured", async () => {
    wireOpenAIExtensionCredentials(registry as any, {
      apiKey: async () => "sk-byok",
      accessToken: async () => "oa-subscription",
    });
    const env = await registry.resolvers.get(OPENAI_IMAGE_GEN_EXT_NAME)!();
    expect(env).toEqual({
      OPENAI_API_KEY: "sk-byok",
      OPENAI_ACCESS_TOKEN: "oa-subscription",
    });
  });

  test("returns empty env map when neither resolver yields a credential", async () => {
    wireOpenAIExtensionCredentials(registry as any, {
      apiKey: async () => null,
      accessToken: async () => null,
    });
    const env = await registry.resolvers.get(OPENAI_IMAGE_GEN_EXT_NAME)!();
    expect(env).toEqual({});
  });

  test("swallows errors from either resolver and returns empty map", async () => {
    wireOpenAIExtensionCredentials(registry as any, {
      apiKey: async () => {
        throw new Error("apiKey failed");
      },
      accessToken: async () => "oa-token",
    });
    const env = await registry.resolvers.get(OPENAI_IMAGE_GEN_EXT_NAME)!();
    expect(env).toEqual({});
  });

  test("resolvers are called fresh each spawn (OAuth refresh, BYOK rotation)", async () => {
    let n = 0;
    wireOpenAIExtensionCredentials(registry as any, {
      apiKey: async () => null,
      accessToken: async () => `oa-${n++}`,
    });
    const r = registry.resolvers.get(OPENAI_IMAGE_GEN_EXT_NAME)!;
    expect(await r()).toEqual({ OPENAI_ACCESS_TOKEN: "oa-0" });
    expect(await r()).toEqual({ OPENAI_ACCESS_TOKEN: "oa-1" });
    expect(await r()).toEqual({ OPENAI_ACCESS_TOKEN: "oa-2" });
  });

  test("last wire wins (re-wire-able)", async () => {
    wireOpenAIExtensionCredentials(registry as any, {
      apiKey: async () => "sk-old",
      accessToken: async () => null,
    });
    wireOpenAIExtensionCredentials(registry as any, {
      apiKey: async () => "sk-new",
      accessToken: async () => null,
    });
    const env = await registry.resolvers.get(OPENAI_IMAGE_GEN_EXT_NAME)!();
    expect(env).toEqual({ OPENAI_API_KEY: "sk-new" });
  });
});
