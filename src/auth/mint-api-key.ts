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
  type ApiKeyEntry,
  type ApiKeyScope,
} from "./api-key";
import { upsertSetting } from "../db/queries/settings";

export interface MintedApiKey {
  raw: string;
  keyId: string;
}

export async function mintApiKeyForUser(
  userId: string,
  scopes: ApiKeyScope[],
  name: string,
): Promise<MintedApiKey> {
  const { raw, hash, keyId } = generateApiKey();
  const entry: ApiKeyEntry = { hash, userId, scopes, name, createdAt: Date.now() };
  await upsertSetting(apiKeySettingsKey(userId, keyId), entry);
  return { raw, keyId };
}
