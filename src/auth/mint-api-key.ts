/**
 * Mint-and-store for EZCorp user API keys (`ezk_*`).
 *
 * The single place that turns a fresh key into a persisted settings row.
 * Shared by the CLI (`src/cli.ts key:mint`) and the developer-settings
 * HTTP route so the stored shape + settings-key format never drift. The
 * raw key is returned ONCE; only its hash is persisted.
 *
 * Kept separate from `./api-key.ts` (pure crypto, no I/O) because this
 * pulls in the settings store.
 */
import {
  generateApiKey,
  apiKeySettingsKey,
  apiKeyHashIndexKey,
  type ApiKeyEntry,
  type ApiKeyHashIndexEntry,
  type ApiKeyRole,
  type ApiKeyScope,
} from "./api-key";
import { upsertSetting, deleteSetting } from "../db/queries/settings";

export interface MintedApiKey {
  raw: string;
  keyId: string;
}

export async function mintApiKeyForUser(
  userId: string,
  scopes: ApiKeyScope[],
  name: string,
  role: ApiKeyRole = "member",
): Promise<MintedApiKey> {
  const { raw, hash, keyId } = generateApiKey();
  const entry: ApiKeyEntry = { hash, userId, scopes, role, name, createdAt: Date.now() };
  // Canonical per-user row (source of truth for GET-list / DELETE-by-keyId)…
  await upsertSetting(apiKeySettingsKey(userId, keyId), entry);
  // …plus the hash index so verifyApiKey is O(1) instead of a full scan.
  const indexEntry: ApiKeyHashIndexEntry = { userId, keyId };
  await upsertSetting(apiKeyHashIndexKey(hash), indexEntry);
  return { raw, keyId };
}

/**
 * Revoke a key by its per-user row, keeping the hash index in lock-step.
 * The canonical row carries the hash, so we read it first to learn which
 * index row to drop. Returns whether the canonical row existed (so the
 * route can still answer 404 unchanged). Tolerates a missing index row
 * (legacy keys minted before the index existed simply have none).
 */
export async function deleteApiKeyForUser(
  userId: string,
  keyId: string,
): Promise<boolean> {
  const { getSetting } = await import("../db/queries/settings");
  const existing = (await getSetting(apiKeySettingsKey(userId, keyId))) as
    | ApiKeyEntry
    | undefined;
  const deleted = await deleteSetting(apiKeySettingsKey(userId, keyId));
  if (existing?.hash) await deleteSetting(apiKeyHashIndexKey(existing.hash));
  return deleted;
}
