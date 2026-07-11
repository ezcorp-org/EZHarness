/**
 * Host-side secret-settings write/probe/clear path (secret-settings.ts).
 *
 * Pins the LOCKED contract of the secret settings feature:
 *   - the value is stored ENCRYPTED at rest (raw DB row ≠ plaintext,
 *     encrypted=true, sizeBytes = plaintext serialized bytes)
 *   - it decrypts through the SAME read path the sandboxed extension
 *     uses (`handleStorageRpc` action:"get", scope:"user") — i.e. the
 *     graded-card-scanner's `resolveToken` works with ZERO changes
 *   - `isSecretSettingSet` is a row-existence probe (never the value)
 *   - clear deletes the row
 *   - cross-user isolation: user A's secret is invisible to user B
 *   - `encryptStorageValue` is byte-identical to the storage RPC's
 *     `encrypted: true` write path
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
  getTestDb,
} from "./helpers/test-pglite";

// Deterministic key material — mirrors storage-handler-coverage.test.ts.
process.env.EZCORP_ENCRYPTION_SECRET ??= "0".repeat(64);

mockDbConnection();

const {
  encryptStorageValue,
  secretFieldEntries,
  setSecretSetting,
  clearSecretSetting,
  isSecretSettingSet,
  probeSecretSettings,
} = await import("../extensions/secret-settings");
const { handleStorageRpc } = await import("../extensions/storage-handler");
const { decrypt } = await import("../providers/encryption");
const { getStorageValue } = await import("../db/queries/extension-storage");
const { extensions, extensionStorage, users } = await import("../db/schema");

import type { ExtensionManifestV2, SettingsSchema } from "../extensions/types";

const EXT_ID = "ext-scanner";
const SECRET = "psa-live-token-1234567890";
const STORAGE_KEY = "psa-token";

function buildManifest(settings?: SettingsSchema): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "scanner",
    version: "1.0.0",
    description: "test",
    author: { name: "test" },
    permissions: { storage: true },
    settings,
  } as ExtensionManifestV2;
}

async function seedExtension(): Promise<void> {
  await getTestDb()
    .insert(extensions)
    .values({
      id: EXT_ID,
      name: "scanner",
      version: "1.0.0",
      description: "scanner test",
      manifest: buildManifest(),
      source: `test:${EXT_ID}`,
      installPath: `/tmp/${EXT_ID}`,
      enabled: true,
      grantedPermissions: { storage: true, grantedAt: {} } as never,
    } as never);
}

async function seedUser(id: string, email: string): Promise<void> {
  await getTestDb()
    .insert(users)
    .values({
      id,
      email,
      passwordHash: "x",
      name: email,
      role: "member",
      status: "active",
    } as never);
}

async function rawRow(userId: string) {
  const { and, eq } = await import("drizzle-orm");
  const rows = await getTestDb()
    .select()
    .from(extensionStorage)
    .where(
      and(
        eq(extensionStorage.extensionId, EXT_ID),
        eq(extensionStorage.scope, "user"),
        eq(extensionStorage.scopeId, userId),
        eq(extensionStorage.key, STORAGE_KEY),
      ),
    );
  return rows[0];
}

/** The exact read path the sandboxed extension's SDK Storage uses. */
async function extensionReads(userId: string): Promise<{
  value: unknown;
  exists: boolean;
}> {
  const res = await handleStorageRpc(
    EXT_ID,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "ezcorp/storage",
      params: { action: "get", scope: "user", key: STORAGE_KEY },
    },
    {
      conversationId: "conv-1",
      userId,
      manifest: buildManifest(),
      grantedPermissions: { storage: true } as never,
    },
  );
  expect(res.error).toBeUndefined();
  return res.result as { value: unknown; exists: boolean };
}

describe("encryptStorageValue — canonical encrypted-write encoding", () => {
  test("stored is decryptable ciphertext of JSON.stringify(value)", () => {
    const { stored } = encryptStorageValue(SECRET);
    expect(stored).not.toContain(SECRET);
    expect(decrypt(stored)).toBe(JSON.stringify(SECRET));
  });

  test("sizeBytes is the PLAINTEXT serialized byte length", () => {
    const { sizeBytes } = encryptStorageValue(SECRET);
    expect(sizeBytes).toBe(Buffer.byteLength(JSON.stringify(SECRET), "utf-8"));
  });

  test("handles non-string values identically to the RPC path (objects)", () => {
    const value = { nested: ["a", 1, true] };
    const { stored, sizeBytes } = encryptStorageValue(value);
    expect(JSON.parse(decrypt(stored))).toEqual(value);
    expect(sizeBytes).toBe(Buffer.byteLength(JSON.stringify(value), "utf-8"));
  });
});

describe("secretFieldEntries", () => {
  const schema: SettingsSchema = {
    psa_api_token: { type: "secret", label: "Token", storageKey: "psa-token" },
    voice: {
      type: "select",
      label: "Voice",
      options: [{ value: "a", label: "A" }],
    },
    speed: { type: "number", label: "Speed" },
  };

  test("returns only secret-typed entries with their keys", () => {
    expect(secretFieldEntries(schema)).toEqual([
      [
        "psa_api_token",
        { type: "secret", label: "Token", storageKey: "psa-token" },
      ],
    ]);
  });

  test("returns [] for undefined / null / empty schema", () => {
    expect(secretFieldEntries(undefined)).toEqual([]);
    expect(secretFieldEntries(null)).toEqual([]);
    expect(secretFieldEntries({})).toEqual([]);
  });
});

describe("secret-settings storage round-trip (PGlite)", () => {
  beforeEach(async () => {
    await setupTestDb();
    await seedExtension();
    await seedUser("user-a", "a@test");
    await seedUser("user-b", "b@test");
  });
  afterAll(async () => await closeTestDb());

  test("setSecretSetting stores ENCRYPTED at rest — raw row never carries plaintext", async () => {
    await setSecretSetting(EXT_ID, "user-a", STORAGE_KEY, SECRET);

    const row = await rawRow("user-a");
    expect(row).toBeDefined();
    expect(row!.encrypted).toBe(true);
    // The raw persisted value must not contain the plaintext anywhere.
    expect(JSON.stringify(row!.value)).not.toContain(SECRET);
    // Size accounting matches the RPC path (plaintext serialized bytes).
    expect(row!.sizeBytes).toBe(
      Buffer.byteLength(JSON.stringify(SECRET), "utf-8"),
    );
    // And it decrypts back to the exact plaintext.
    expect(JSON.parse(decrypt(row!.value as string))).toBe(SECRET);
  });

  test("the sandboxed extension read path (storage RPC get) returns the plaintext", async () => {
    await setSecretSetting(EXT_ID, "user-a", STORAGE_KEY, SECRET);

    const got = await extensionReads("user-a");
    expect(got.exists).toBe(true);
    expect(got.value).toBe(SECRET);
  });

  test("upsert: setting again replaces the value", async () => {
    await setSecretSetting(EXT_ID, "user-a", STORAGE_KEY, SECRET);
    await setSecretSetting(EXT_ID, "user-a", STORAGE_KEY, "replacement-token-9876");

    const got = await extensionReads("user-a");
    expect(got.value).toBe("replacement-token-9876");
    expect(await isSecretSettingSet(EXT_ID, "user-a", STORAGE_KEY)).toBe(true);
  });

  test("isSecretSettingSet is a pure existence probe", async () => {
    expect(await isSecretSettingSet(EXT_ID, "user-a", STORAGE_KEY)).toBe(false);
    await setSecretSetting(EXT_ID, "user-a", STORAGE_KEY, SECRET);
    expect(await isSecretSettingSet(EXT_ID, "user-a", STORAGE_KEY)).toBe(true);
  });

  test("clearSecretSetting deletes the row and reports existence", async () => {
    await setSecretSetting(EXT_ID, "user-a", STORAGE_KEY, SECRET);
    expect(await clearSecretSetting(EXT_ID, "user-a", STORAGE_KEY)).toBe(true);
    expect(await isSecretSettingSet(EXT_ID, "user-a", STORAGE_KEY)).toBe(false);
    expect(await rawRow("user-a")).toBeUndefined();
    // Clearing again is a no-op that reports "nothing existed".
    expect(await clearSecretSetting(EXT_ID, "user-a", STORAGE_KEY)).toBe(false);
  });

  test("cross-user isolation: user A's token is invisible to user B", async () => {
    await setSecretSetting(EXT_ID, "user-a", STORAGE_KEY, SECRET);

    expect(await isSecretSettingSet(EXT_ID, "user-b", STORAGE_KEY)).toBe(false);
    const gotB = await extensionReads("user-b");
    expect(gotB.exists).toBe(false);
    expect(gotB.value).toBeNull();

    // And B clearing their (absent) row never touches A's.
    expect(await clearSecretSetting(EXT_ID, "user-b", STORAGE_KEY)).toBe(false);
    expect(await isSecretSettingSet(EXT_ID, "user-a", STORAGE_KEY)).toBe(true);
  });

  test("probeSecretSettings maps each secret field to its per-user isSet flag", async () => {
    const schema: SettingsSchema = {
      psa_api_token: { type: "secret", label: "Token", storageKey: STORAGE_KEY },
      other_token: { type: "secret", label: "Other", storageKey: "other-key" },
      voice: {
        type: "select",
        label: "Voice",
        options: [{ value: "a", label: "A" }],
      },
    };
    await setSecretSetting(EXT_ID, "user-a", STORAGE_KEY, SECRET);

    // Non-secret fields never appear; probes are scoped to the given user.
    expect(await probeSecretSettings(EXT_ID, "user-a", schema)).toEqual({
      psa_api_token: { isSet: true },
      other_token: { isSet: false },
    });
    expect(await probeSecretSettings(EXT_ID, "user-b", schema)).toEqual({
      psa_api_token: { isSet: false },
      other_token: { isSet: false },
    });
    // Missing/empty schema → empty probe map.
    expect(await probeSecretSettings(EXT_ID, "user-a", undefined)).toEqual({});
    expect(await probeSecretSettings(EXT_ID, "user-a", null)).toEqual({});
  });

  test("byte-identical to the storage RPC encrypted write path", async () => {
    // Write the same plaintext through BOTH paths (different users so the
    // rows coexist) and compare the persisted shape: same encrypted flag,
    // same sizeBytes, both decrypt to the same serialized plaintext.
    await setSecretSetting(EXT_ID, "user-a", STORAGE_KEY, SECRET);
    const rpcRes = await handleStorageRpc(
      EXT_ID,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "ezcorp/storage",
        params: {
          action: "set",
          scope: "user",
          key: STORAGE_KEY,
          value: SECRET,
          encrypted: true,
        },
      },
      {
        conversationId: "conv-1",
        userId: "user-b",
        manifest: buildManifest(),
        grantedPermissions: { storage: true } as never,
      },
    );
    expect(rpcRes.error).toBeUndefined();

    const hostRow = await rawRow("user-a");
    const rpcRow = await getStorageValue(EXT_ID, "user", "user-b", STORAGE_KEY);
    expect(hostRow!.encrypted).toBe(true);
    expect(rpcRow!.encrypted).toBe(true);
    expect(hostRow!.sizeBytes).toBe(rpcRow!.sizeBytes);
    expect(decrypt(hostRow!.value as string)).toBe(
      decrypt(rpcRow!.value as string),
    );
  });
});
