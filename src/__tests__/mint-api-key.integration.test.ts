/**
 * Integration test for the shared API-key mint helper against a REAL
 * migrated PGlite DB. Proves the CLI / HTTP cold-start path actually
 * persists a verifiable key — and that the raw key is NEVER stored.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  mockDbConnection,
  mockRealSettings,
  setupTestDb,
  closeTestDb,
} from "./helpers/test-pglite";

// Wire the real settings store to the test DB BEFORE importing modules
// that read/write settings.
mockDbConnection();
mockRealSettings();

const { mintApiKeyForUser } = await import("../auth/mint-api-key");
const { getAllSettings } = await import("../db/queries/settings");
const { hashApiKey, apiKeySettingsKey, apiKeySettingsPrefix } = await import("../auth/api-key");

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("mintApiKeyForUser (real DB)", () => {
  test("persists a hashed, verifiable key and returns the raw once", async () => {
    const { raw, keyId } = await mintApiKeyForUser("u-int-1", ["read", "chat"], "ci-key");

    expect(raw.startsWith("ezk_")).toBe(true);
    expect(keyId).toMatch(/^[0-9a-f-]{36}$/);

    const all = await getAllSettings();
    const entry = all[apiKeySettingsKey("u-int-1", keyId)] as {
      hash: string;
      userId: string;
      scopes: string[];
      name: string;
      createdAt: number;
    };

    expect(entry).toBeDefined();
    // Stored hash matches the raw key's hash → verifyApiKey would resolve it.
    expect(entry.hash).toBe(hashApiKey(raw));
    expect(entry.userId).toBe("u-int-1");
    expect(entry.scopes).toEqual(["read", "chat"]);
    expect(entry.name).toBe("ci-key");
    expect(typeof entry.createdAt).toBe("number");

    // The raw secret must NEVER be persisted anywhere in settings.
    expect(JSON.stringify(all)).not.toContain(raw);
  });

  test("two mints for the same user produce distinct rows under the user prefix", async () => {
    const a = await mintApiKeyForUser("u-int-2", ["read"], "a");
    const b = await mintApiKeyForUser("u-int-2", ["admin"], "b");
    expect(a.keyId).not.toBe(b.keyId);

    const all = await getAllSettings();
    const prefix = apiKeySettingsPrefix("u-int-2");
    const mine = Object.keys(all).filter((k) => k.startsWith(prefix));
    expect(mine.length).toBe(2);
  });
});
