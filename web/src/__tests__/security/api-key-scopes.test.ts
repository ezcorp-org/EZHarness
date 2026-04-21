import { test, expect, mock, beforeEach } from "bun:test";

// Replicate the requireScope logic to avoid importing hooks.server.ts side effects
// (same pattern as hooks-middleware.test.ts)

import type { ApiKeyScope } from "../../lib/server/security/api-keys";

// Mock settings for generateApiKey/verifyApiKey
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

import { generateApiKey, verifyApiKey, requireScope } from "../../lib/server/security/api-keys";

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
});

test("create key with read scope, requireScope(read) allows", () => {
  const locals = { apiKeyScopes: ["read"] as ApiKeyScope[] };
  expect(requireScope(locals, "read")).toBeNull();
});

test("create key with read scope, requireScope(chat) rejects with 403", () => {
  const locals = { apiKeyScopes: ["read"] as ApiKeyScope[] };
  const res = requireScope(locals, "chat");
  expect(res).not.toBeNull();
  expect(res!.status).toBe(403);
});

test("create key with read scope, requireScope(admin) rejects", () => {
  const locals = { apiKeyScopes: ["read"] as ApiKeyScope[] };
  const res = requireScope(locals, "admin");
  expect(res).not.toBeNull();
  expect(res!.status).toBe(403);
});

test("key with multiple scopes allows each", () => {
  const locals = { apiKeyScopes: ["read", "chat"] as ApiKeyScope[] };
  expect(requireScope(locals, "read")).toBeNull();
  expect(requireScope(locals, "chat")).toBeNull();
  const res = requireScope(locals, "admin");
  expect(res).not.toBeNull();
  expect(res!.status).toBe(403);
});

test("cookie auth (no apiKeyScopes) allows all scopes", () => {
  expect(requireScope({}, "admin")).toBeNull();
  expect(requireScope({}, "read")).toBeNull();
  expect(requireScope({}, "chat")).toBeNull();
});

test("full lifecycle: generate key, store, verify, check scopes", async () => {
  const { raw, hash, keyId } = generateApiKey();
  const userId = "user-scope-test";
  const scopes: ApiKeyScope[] = ["read"];

  // Store in mock settings
  mockSettings[`apikey:${userId}:${keyId}`] = {
    hash,
    userId,
    scopes,
    name: "Scope Test Key",
  };

  // Verify the key
  const verified = await verifyApiKey(raw);
  expect(verified).not.toBeNull();
  expect(verified!.userId).toBe(userId);
  expect(verified!.scopes).toEqual(["read"]);

  // Check scope enforcement using verified scopes
  const locals = { apiKeyScopes: verified!.scopes };
  expect(requireScope(locals, "read")).toBeNull();
  const chatResult = requireScope(locals, "chat");
  expect(chatResult).not.toBeNull();
  expect(chatResult!.status).toBe(403);
});
