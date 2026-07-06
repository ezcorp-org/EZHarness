import { test, expect, mock, beforeEach } from "bun:test";
import { generateApiKey, hashApiKey, verifyApiKey, requireScope, requireAdmin } from "../../lib/server/security/api-keys";
import { apiKeyHashIndexKey, apiKeySettingsKey } from "../../../../src/auth/api-key";

// Mock settings queries
const mockSettings: Record<string, unknown> = {};
// Count getAllSettings invocations so we can PROVE the fast path skips the
// full-table scan (Finding C: DoS amplification on every Bearer request).
let getAllCalls = 0;

mock.module("$server/db/queries/settings", () => ({
  getSetting: async (key: string) => mockSettings[key],
  upsertSetting: async (key: string, value: unknown) => {
    mockSettings[key] = value;
  },
  getAllSettings: async () => {
    getAllCalls++;
    return { ...mockSettings };
  },
}));

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  getAllCalls = 0;
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

// ── role axis ─────────────────────────────────────────────────────────
// verifyApiKey surfaces the key's stored role; a row minted before
// role-carrying keys existed (no `role` field) reads back as `member`.

test("verifyApiKey surfaces a stored admin role (fast path)", async () => {
  const { raw, hash, keyId } = generateApiKey();
  const userId = "user-admin-role";
  mockSettings[apiKeySettingsKey(userId, keyId)] = {
    hash, userId, scopes: ["read", "admin"], role: "admin", name: "Admin Key", createdAt: 1,
  };
  mockSettings[apiKeyHashIndexKey(hash)] = { userId, keyId };

  const result = await verifyApiKey(raw);
  expect(result!.role).toBe("admin");
});

test("verifyApiKey defaults a role-less legacy row to member (slow path)", async () => {
  const { raw, hash, keyId } = generateApiKey();
  const userId = "user-no-role";
  // Legacy row: no `role`, no index pointer → slow path + default.
  mockSettings[apiKeySettingsKey(userId, keyId)] = {
    hash, userId, scopes: ["read"], name: "Legacy", createdAt: 1,
  };

  const result = await verifyApiKey(raw);
  expect(result!.role).toBe("member");
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

// ── requireAdmin (FINDING A) ──────────────────────────────────────────
// Enforces the ROLE axis so an admin route can't be reached by a non-admin
// cookie session (which requireScope("admin") allow-alls) nor by an API-key
// principal (always role:"member", so it can never be admin by role).

test("requireAdmin allows an admin-role principal", () => {
  const result = requireAdmin({ user: { role: "admin" } } as any);
  expect(result).toBeNull();
});

test("requireAdmin denies a member-role principal with 403", async () => {
  const result = requireAdmin({ user: { role: "member" } } as any);
  expect(result).not.toBeNull();
  expect(result!.status).toBe(403);
  const body = (await result!.json()) as { error?: string };
  expect(body.error).toBe("Admin role required");
});

test("requireAdmin denies an API-key principal (role member even w/ admin scope)", () => {
  // bearer-auth mints API-key principals as role:"member" regardless of
  // scopes, so even an admin-SCOPED key is rejected by requireAdmin.
  const result = requireAdmin({ user: { role: "member" }, apiKeyScopes: ["admin"] } as any);
  expect(result).not.toBeNull();
  expect(result!.status).toBe(403);
});

test("requireAdmin denies an unauthenticated request (no user) with 403", () => {
  const result = requireAdmin({} as any);
  expect(result).not.toBeNull();
  expect(result!.status).toBe(403);
});

// ── verifyApiKey hash index (FINDING C) ───────────────────────────────

test("verifyApiKey takes the O(1) fast path via the hash index (no full scan)", async () => {
  const { raw, hash, keyId } = generateApiKey();
  const userId = "user-fast";
  mockSettings[apiKeySettingsKey(userId, keyId)] = {
    hash, userId, scopes: ["read"], name: "Fast", createdAt: 1,
  };
  // Index pointer written at mint time → verify resolves WITHOUT scanning.
  mockSettings[apiKeyHashIndexKey(hash)] = { userId, keyId };

  const result = await verifyApiKey(raw);
  expect(result).not.toBeNull();
  expect(result!.userId).toBe(userId);
  expect(result!.scopes).toEqual(["read"]);
  // The whole point of the index: getAllSettings() is never called.
  expect(getAllCalls).toBe(0);
});

test("verifyApiKey falls back to legacy scan AND lazily writes the index", async () => {
  const { raw, hash, keyId } = generateApiKey();
  const userId = "user-legacy";
  // Legacy key: per-user row exists but NO hash-index pointer.
  mockSettings[apiKeySettingsKey(userId, keyId)] = {
    hash, userId, scopes: ["chat"], name: "Legacy", createdAt: 1,
  };

  const first = await verifyApiKey(raw);
  expect(first).not.toBeNull();
  expect(first!.userId).toBe(userId);
  // Fell back to the scan…
  expect(getAllCalls).toBe(1);
  // …and lazily upgraded by writing the index pointer.
  expect(mockSettings[apiKeyHashIndexKey(hash)]).toEqual({ userId, keyId });

  // Next use is now the fast path: no further scan.
  const second = await verifyApiKey(raw);
  expect(second!.userId).toBe(userId);
  expect(getAllCalls).toBe(1);
});

test("verifyApiKey ignores a dangling index pointer and falls back", async () => {
  const { raw, hash, keyId } = generateApiKey();
  const userId = "user-dangling";
  // Index points at a per-user row that no longer exists (deleted out of
  // band). verify must NOT trust it; with no legacy row either → null.
  mockSettings[apiKeyHashIndexKey(hash)] = { userId, keyId };

  const result = await verifyApiKey(raw);
  expect(result).toBeNull();
  // It still tried the slow path after the pointer missed.
  expect(getAllCalls).toBe(1);
});

test("verifyApiKey rejects a key whose index pointer row has a mismatched hash", async () => {
  // Constant-time comparison still guards the fast path: a tampered/rotated
  // per-user row with a different hash must not authenticate the raw key.
  const { raw, hash } = generateApiKey();
  const other = generateApiKey();
  const userId = "user-mismatch";
  const keyId = "kid-mismatch";
  mockSettings[apiKeySettingsKey(userId, keyId)] = {
    hash: other.hash, userId, scopes: ["read"], name: "X", createdAt: 1,
  };
  mockSettings[apiKeyHashIndexKey(hash)] = { userId, keyId };

  const result = await verifyApiKey(raw);
  expect(result).toBeNull();
});
