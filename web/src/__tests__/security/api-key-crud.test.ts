import { test, expect, describe, mock, beforeEach } from "bun:test";

// Mock settings DB before importing modules that use it
const mockSettings: Record<string, unknown> = {};

mock.module("$server/db/queries/settings", () => ({
  getSetting: async (key: string) => mockSettings[key],
  upsertSetting: async (key: string, value: unknown) => {
    mockSettings[key] = value;
  },
  deleteSetting: async (key: string) => {
    const existed = key in mockSettings;
    delete mockSettings[key];
    return existed;
  },
  getAllSettings: async () => ({ ...mockSettings }),
}));

import { generateApiKey, hashApiKey, verifyApiKey, type ApiKeyScope } from "../../lib/server/security/api-keys";
import { createApiKeySchema, deleteApiKeySchema } from "../../routes/api/settings/developer/schema";
import { validationError } from "../../lib/server/security/validation";

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
});

describe("API key CRUD: schema validation", () => {
  test("createApiKeySchema accepts valid input", () => {
    const result = createApiKeySchema.safeParse({ name: "My Key", scopes: ["read"] });
    expect(result.success).toBe(true);
  });

  test("createApiKeySchema requires name", () => {
    const result = createApiKeySchema.safeParse({ scopes: ["read"] });
    expect(result.success).toBe(false);
  });

  test("createApiKeySchema requires at least one scope", () => {
    const result = createApiKeySchema.safeParse({ name: "My Key", scopes: [] });
    expect(result.success).toBe(false);
  });

  test("createApiKeySchema rejects invalid scope", () => {
    const result = createApiKeySchema.safeParse({ name: "My Key", scopes: ["invalid"] });
    expect(result.success).toBe(false);
  });

  test("createApiKeySchema accepts all valid scopes", () => {
    const result = createApiKeySchema.safeParse({
      name: "Full Key",
      scopes: ["read", "chat", "extensions", "admin"],
    });
    expect(result.success).toBe(true);
  });

  test("createApiKeySchema rejects name over 100 chars", () => {
    const result = createApiKeySchema.safeParse({ name: "x".repeat(101), scopes: ["read"] });
    expect(result.success).toBe(false);
  });

  test("createApiKeySchema rejects empty name", () => {
    const result = createApiKeySchema.safeParse({ name: "", scopes: ["read"] });
    expect(result.success).toBe(false);
  });

  test("deleteApiKeySchema accepts valid UUID", () => {
    const result = deleteApiKeySchema.safeParse({ keyId: "550e8400-e29b-41d4-a716-446655440000" });
    expect(result.success).toBe(true);
  });

  test("deleteApiKeySchema rejects non-UUID", () => {
    const result = deleteApiKeySchema.safeParse({ keyId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });
});

describe("API key CRUD: full lifecycle", () => {
  test("generate, store, list, verify, delete", async () => {
    const userId = "user-crud-test";

    // 1. Generate
    const { raw, hash, keyId } = generateApiKey();
    expect(raw.startsWith("ezk_")).toBe(true);

    // 2. Store (simulating POST handler logic)
    const entry = { hash, userId, scopes: ["read", "chat"], name: "Test Key", createdAt: Date.now() };
    mockSettings[`apikey:${userId}:${keyId}`] = entry;

    // 3. List (simulating GET handler logic)
    const prefix = `apikey:${userId}:`;
    const keys = Object.entries(mockSettings)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => {
        const e = v as { name: string; scopes: string[]; createdAt: number };
        return { keyId: k.slice(prefix.length), name: e.name, scopes: e.scopes, createdAt: e.createdAt };
      });
    expect(keys).toHaveLength(1);
    expect(keys[0].name).toBe("Test Key");
    expect(keys[0].scopes).toEqual(["read", "chat"]);

    // 4. Verify with raw key
    const verified = await verifyApiKey(raw);
    expect(verified).not.toBeNull();
    expect(verified!.userId).toBe(userId);
    expect(verified!.scopes).toEqual(["read", "chat"]);

    // 5. Delete
    delete mockSettings[`apikey:${userId}:${keyId}`];
    const afterDelete = await verifyApiKey(raw);
    expect(afterDelete).toBeNull();
  });

  test("multiple keys for same user are independent", async () => {
    const userId = "user-multi";

    const key1 = generateApiKey();
    const key2 = generateApiKey();

    mockSettings[`apikey:${userId}:${key1.keyId}`] = {
      hash: key1.hash, userId, scopes: ["read"], name: "Key 1",
    };
    mockSettings[`apikey:${userId}:${key2.keyId}`] = {
      hash: key2.hash, userId, scopes: ["admin"], name: "Key 2",
    };

    const v1 = await verifyApiKey(key1.raw);
    const v2 = await verifyApiKey(key2.raw);
    expect(v1!.scopes).toEqual(["read"]);
    expect(v2!.scopes).toEqual(["admin"]);

    // Delete key1, key2 still works
    delete mockSettings[`apikey:${userId}:${key1.keyId}`];
    expect(await verifyApiKey(key1.raw)).toBeNull();
    expect((await verifyApiKey(key2.raw))!.name).toBe("Key 2");
  });

  test("keys from different users don't cross-verify", async () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();

    mockSettings[`apikey:user-A:${key1.keyId}`] = {
      hash: key1.hash, userId: "user-A", scopes: ["read"], name: "A's key",
    };
    mockSettings[`apikey:user-B:${key2.keyId}`] = {
      hash: key2.hash, userId: "user-B", scopes: ["admin"], name: "B's key",
    };

    const v1 = await verifyApiKey(key1.raw);
    expect(v1!.userId).toBe("user-A");
    const v2 = await verifyApiKey(key2.raw);
    expect(v2!.userId).toBe("user-B");
  });
});

describe("API key CRUD: edge cases", () => {
  test("verifyApiKey with empty string returns null", async () => {
    expect(await verifyApiKey("")).toBeNull();
  });

  test("verifyApiKey with arbitrary string returns null", async () => {
    expect(await verifyApiKey("not-a-real-key-at-all")).toBeNull();
  });

  test("hashApiKey is deterministic", () => {
    const a = hashApiKey("ezk_test123");
    const b = hashApiKey("ezk_test123");
    expect(a).toBe(b);
  });

  test("different keys produce different hashes", () => {
    const a = hashApiKey("ezk_key1");
    const b = hashApiKey("ezk_key2");
    expect(a).not.toBe(b);
  });

  test("generated keys are unique", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 50; i++) {
      keys.add(generateApiKey().raw);
    }
    expect(keys.size).toBe(50);
  });

  test("validation error from bad createApiKey input has structured fields", async () => {
    const result = createApiKeySchema.safeParse({ name: "", scopes: ["invalid"] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const response = validationError(result.error);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation failed");
      expect(body.fields).toBeDefined();
    }
  });
});
