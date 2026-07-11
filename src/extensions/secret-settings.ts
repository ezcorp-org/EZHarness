/**
 * Host-side write/probe/clear path for `type: "secret"` settings fields.
 *
 * A secret field's value is written into EXTENSION STORAGE — not the
 * settings JSON blob — at `(extensionId, scope: "user", scopeId: userId,
 * key: field.storageKey)`, encrypted exactly like the storage RPC's
 * `encrypted: true` write path (`storage-handler.ts` delegates its
 * encrypted branch to `encryptStorageValue` below, so the two paths are
 * byte-identical by construction). That makes the value readable from the
 * sandboxed extension through its existing SDK Storage surface with zero
 * extension-code changes — e.g. graded-card-scanner's `resolveToken`
 * reading key `psa-token`.
 *
 * Values are NEVER returned by these helpers: the read surface is a
 * row-existence probe (`isSecretSettingSet`) only.
 */

import { encrypt } from "../providers/encryption";
import {
  deleteStorageValue,
  getStorageValue,
  setStorageValue,
} from "../db/queries/extension-storage";
import type { SettingsFieldSecret, SettingsSchema } from "./types";

/**
 * Canonical encrypted-storage write encoding, shared with the storage
 * RPC's `encrypted: true` path (see `storage-handler.ts` `handleSet`):
 * the stored value is `encrypt(JSON.stringify(value))` and `sizeBytes`
 * is the PLAINTEXT serialized byte length (pre-encryption), matching the
 * quota accounting the RPC path uses.
 */
export function encryptStorageValue(value: unknown): {
  stored: string;
  sizeBytes: number;
} {
  const serialized = JSON.stringify(value);
  return {
    stored: encrypt(serialized),
    sizeBytes: Buffer.byteLength(serialized, "utf-8"),
  };
}

/** Pure: the secret-typed entries of a settings schema, as
 *  `[settingKey, field]` pairs. `[]` for a missing/empty schema. */
export function secretFieldEntries(
  schema: SettingsSchema | null | undefined,
): Array<[string, SettingsFieldSecret]> {
  if (!schema) return [];
  return Object.entries(schema).filter(
    (entry): entry is [string, SettingsFieldSecret] =>
      entry[1].type === "secret",
  );
}

/**
 * Encrypt + upsert a secret value into the caller's user-scoped extension
 * storage row. The plaintext never touches logs, audit rows, or responses
 * — callers must have validated it already (`isValidForField`).
 */
export async function setSecretSetting(
  extensionId: string,
  userId: string,
  storageKey: string,
  value: string,
): Promise<void> {
  const { stored, sizeBytes } = encryptStorageValue(value);
  await setStorageValue(
    extensionId,
    "user",
    userId,
    storageKey,
    stored,
    true,
    sizeBytes,
  );
}

/** Delete the caller's stored secret. Returns whether a row existed. */
export async function clearSecretSetting(
  extensionId: string,
  userId: string,
  storageKey: string,
): Promise<boolean> {
  return deleteStorageValue(extensionId, "user", userId, storageKey);
}

/** Row-existence probe — the ONLY read surface. Never decrypts, never
 *  returns the value. */
export async function isSecretSettingSet(
  extensionId: string,
  userId: string,
  storageKey: string,
): Promise<boolean> {
  return (await getStorageValue(extensionId, "user", userId, storageKey)) !== null;
}

/** The `secrets` payload the settings routes return: per secret field a
 *  bare `{ isSet }` existence flag (never the value). `{}` when the
 *  schema declares no secret fields. */
export async function probeSecretSettings(
  extensionId: string,
  userId: string,
  schema: SettingsSchema | null | undefined,
): Promise<Record<string, { isSet: boolean }>> {
  const out: Record<string, { isSet: boolean }> = {};
  for (const [key, field] of secretFieldEntries(schema)) {
    out[key] = {
      isSet: await isSecretSettingSet(extensionId, userId, field.storageKey),
    };
  }
  return out;
}
