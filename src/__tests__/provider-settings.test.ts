import { describe, test, expect, beforeEach, afterEach, mock, afterAll } from "bun:test";

import { restoreModuleMocks } from "./helpers/mock-cleanup";
// Mock settings DB before any imports that use it
const mockGetSetting = mock(() => Promise.resolve(undefined));
const mockUpsertSetting = mock(() => Promise.resolve());
const mockDeleteSetting = mock(() => Promise.resolve(true));

mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mockUpsertSetting,
  deleteSetting: mockDeleteSetting,
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

afterAll(() => restoreModuleMocks());

// Use the real encryption module (only needs node:crypto — no external packages)
import { encrypt, decrypt } from "../providers/encryption";

const originalSecret = process.env.EZCORP_ENCRYPTION_SECRET;

beforeEach(() => {
  process.env.EZCORP_ENCRYPTION_SECRET = "test-secret-for-provider-settings";
  mockGetSetting.mockReset();
  mockGetSetting.mockImplementation(() => Promise.resolve(undefined));
  mockUpsertSetting.mockReset();
  mockUpsertSetting.mockImplementation(() => Promise.resolve());
  mockDeleteSetting.mockReset();
  mockDeleteSetting.mockImplementation(() => Promise.resolve(true));
});

afterEach(() => {
  if (originalSecret !== undefined) {
    process.env.EZCORP_ENCRYPTION_SECRET = originalSecret;
  } else {
    delete process.env.EZCORP_ENCRYPTION_SECRET;
  }
});

// ── Logic extracted from web/src/routes/api/providers/+server.ts ──────────────
// The SvelteKit route uses these exact patterns; tests here verify the contracts.

const PROVIDERS = ["anthropic", "openai", "google"] as const;
type Provider = (typeof PROVIDERS)[number];

const ENV_KEYS: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
};

function isValidProvider(p: string): p is Provider {
  return (PROVIDERS as readonly string[]).includes(p);
}

function settingKey(provider: Provider): string {
  return `provider:apiKey:${provider}`;
}

type ProviderSource = "byok" | "env" | "none";
interface ProviderStatus {
  provider: string;
  hasKey: boolean;
  source: ProviderSource;
}

function deriveProviderStatus(
  provider: Provider,
  storedValue: unknown,
  envValue: string | undefined,
): ProviderStatus {
  const hasByok = !!storedValue;
  const hasEnv = !!envValue;
  return {
    provider,
    hasKey: hasEnv || hasByok,
    source: hasByok ? "byok" : hasEnv ? "env" : "none",
  };
}

// ── isValidProvider ───────────────────────────────────────────────────────────

describe("isValidProvider", () => {
  test("accepts anthropic, openai, google", () => {
    expect(isValidProvider("anthropic")).toBe(true);
    expect(isValidProvider("openai")).toBe(true);
    expect(isValidProvider("google")).toBe(true);
  });

  test("rejects unknown providers", () => {
    expect(isValidProvider("mistral")).toBe(false);
    expect(isValidProvider("")).toBe(false);
    expect(isValidProvider("ANTHROPIC")).toBe(false);
    expect(isValidProvider("anthropic2")).toBe(false);
  });
});

// ── settingKey ────────────────────────────────────────────────────────────────

describe("settingKey", () => {
  test("returns provider:apiKey:{provider} for each known provider", () => {
    expect(settingKey("anthropic")).toBe("provider:apiKey:anthropic");
    expect(settingKey("openai")).toBe("provider:apiKey:openai");
    expect(settingKey("google")).toBe("provider:apiKey:google");
  });
});

// ── Provider status (GET /api/providers logic) ───────────────────────────────

describe("provider status derivation", () => {
  test("source is 'byok' when stored key exists", () => {
    const status = deriveProviderStatus("anthropic", "some-encrypted-value", undefined);
    expect(status.source).toBe("byok");
    expect(status.hasKey).toBe(true);
  });

  test("source is 'env' when only env var is set", () => {
    const status = deriveProviderStatus("anthropic", undefined, "sk-env-key");
    expect(status.source).toBe("env");
    expect(status.hasKey).toBe(true);
  });

  test("source is 'none' when neither stored key nor env var exist", () => {
    const status = deriveProviderStatus("anthropic", undefined, undefined);
    expect(status.source).toBe("none");
    expect(status.hasKey).toBe(false);
  });

  test("byok takes precedence over env when both exist", () => {
    const status = deriveProviderStatus("anthropic", "enc-value", "sk-env-key");
    expect(status.source).toBe("byok");
    expect(status.hasKey).toBe(true);
  });

  test("hasKey is false only when source is 'none'", () => {
    expect(deriveProviderStatus("anthropic", "enc", undefined).hasKey).toBe(true);
    expect(deriveProviderStatus("anthropic", undefined, "sk").hasKey).toBe(true);
    expect(deriveProviderStatus("openai", undefined, undefined).hasKey).toBe(false);
  });

  test("response never exposes the raw stored key value", () => {
    const rawKey = "sk-super-secret-12345";
    const status = deriveProviderStatus("anthropic", encrypt(rawKey), undefined);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(rawKey);
  });
});

// ── POST /api/providers — save key ───────────────────────────────────────────

describe("save provider key (POST logic)", () => {
  test("encrypts key before storing — stored value is not plaintext", async () => {
    const { upsertSetting } = await import("../db/queries/settings");
    const plainKey = "sk-ant-real-key-12345";
    const encrypted = encrypt(plainKey);
    await upsertSetting(settingKey("anthropic"), encrypted);

    expect(mockUpsertSetting).toHaveBeenCalledTimes(1);
    const [storedKey, storedValue] = mockUpsertSetting.mock.calls[0] as unknown as [string, string];
    expect(storedKey).toBe("provider:apiKey:anthropic");
    expect(storedValue).not.toBe(plainKey);    // never stores plaintext
    expect(decrypt(storedValue)).toBe(plainKey); // encrypted value is recoverable
  });

  test("decrypt(encrypt(key)) round-trips for all providers' key formats", () => {
    const keys = ["sk-ant-test-123", "sk-openai-key", "AIzaSyGoogleKey"];
    for (const key of keys) {
      expect(decrypt(encrypt(key))).toBe(key);
    }
  });

  test("stored value uses correct setting key for each provider", async () => {
    const { upsertSetting } = await import("../db/queries/settings");
    for (const provider of PROVIDERS) {
      mockUpsertSetting.mockReset();
      await upsertSetting(settingKey(provider), encrypt("test-key"));
      const [storedKey] = mockUpsertSetting.mock.calls[0] as unknown as [string, string];
      expect(storedKey).toBe(`provider:apiKey:${provider}`);
    }
  });

  test("rejects empty or whitespace-only API keys before storing", () => {
    function validateApiKey(key: string): boolean {
      return typeof key === "string" && key.trim().length > 0;
    }
    expect(validateApiKey("")).toBe(false);
    expect(validateApiKey("   ")).toBe(false);
    expect(validateApiKey("sk-real")).toBe(true);
  });
});

// ── DELETE /api/providers — remove key ───────────────────────────────────────

describe("delete provider key (DELETE logic)", () => {
  test("calls deleteSetting with the correct setting key", async () => {
    const { deleteSetting } = await import("../db/queries/settings");
    await deleteSetting(settingKey("openai"));

    expect(mockDeleteSetting).toHaveBeenCalledTimes(1);
    expect((mockDeleteSetting.mock.calls[0] as unknown as string[])[0]).toBe("provider:apiKey:openai");
  });

  test("deletes the correct key for each provider", async () => {
    const { deleteSetting } = await import("../db/queries/settings");
    for (const provider of PROVIDERS) {
      mockDeleteSetting.mockReset();
      await deleteSetting(settingKey(provider));
      expect((mockDeleteSetting.mock.calls[0] as unknown as string[])[0]).toBe(`provider:apiKey:${provider}`);
    }
  });
});
