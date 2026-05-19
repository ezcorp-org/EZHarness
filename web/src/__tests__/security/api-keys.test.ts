import { test, expect, mock, beforeEach } from "bun:test";
import { generateApiKey, hashApiKey, verifyApiKey, requireScope } from "../../lib/server/security/api-keys";

// Mock settings queries
const mockSettings: Record<string, unknown> = {};

mock.module("$server/db/queries/settings", () => ({
  getSetting: async (key: string) => mockSettings[key],
  upsertSetting: async (key: string, value: unknown) => {
    mockSettings[key] = value;
  },
  getAllSettings: async () => ({ ...mockSettings }),
}));

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
});

test("generateApiKey returns key with ezk_ prefix", () => {
  const result = generateApiKey();
  expect(result.raw.startsWith("ezk_")).toBe(true);
  expect(result.raw.length).toBeGreaterThanOrEqual(40);
  expect(result.hash).toBeDefined();
  expect(result.keyId).toBeDefined();
});

test("hashApiKey produces consistent SHA-256 hex digest", () => {
  const h1 = hashApiKey("test-key");
  const h2 = hashApiKey("test-key");
  expect(h1).toBe(h2);
  expect(h1.length).toBe(64); // SHA-256 hex
});

test("verifyApiKey finds matching key in settings", async () => {
  const { raw, hash, keyId } = generateApiKey();
  const userId = "user-123";
  mockSettings[`apikey:${userId}:${keyId}`] = {
    hash,
    userId,
    scopes: ["read", "chat"],
    name: "Test Key",
  };

  const result = await verifyApiKey(raw);
  expect(result).not.toBeNull();
  expect(result!.userId).toBe(userId);
  expect(result!.scopes).toContain("read");
  expect(result!.name).toBe("Test Key");
});

test("verifyApiKey returns null for invalid key", async () => {
  const result = await verifyApiKey("ezk_invalid");
  expect(result).toBeNull();
});

test("requireScope returns 403 when scope missing", () => {
  const result = requireScope({ apiKeyScopes: ["read"] } as any, "admin");
  expect(result).not.toBeNull();
  expect(result!.status).toBe(403);
});

test("requireScope returns null when scope present", () => {
  const result = requireScope({ apiKeyScopes: ["read", "admin"] } as any, "admin");
  expect(result).toBeNull();
});

test("requireScope allows all for cookie auth (no apiKeyScopes)", () => {
  const result = requireScope({} as any, "admin");
  expect(result).toBeNull();
});
