import { getAllSettings } from "$server/db/queries/settings";
import {
  type ApiKeyEntry,
  type ApiKeyScope,
  hashApiKey,
} from "$server/auth/api-key";

// Re-export the pure key primitives from the shared backend module so the
// SvelteKit server and the CLI (`src/cli.ts key:mint`) share ONE definition.
// See `src/auth/api-key.ts`.
export {
  type ApiKeyEntry,
  type ApiKeyScope,
  type GeneratedKey,
  API_KEY_SCOPES,
  apiKeySettingsKey,
  apiKeySettingsPrefix,
  generateApiKey,
  hashApiKey,
  isApiKeyScope,
} from "$server/auth/api-key";

interface VerifiedKey {
  userId: string;
  scopes: ApiKeyScope[];
  name: string;
}

export async function verifyApiKey(raw: string): Promise<VerifiedKey | null> {
  const hash = hashApiKey(raw);
  const all = await getAllSettings();
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith("apikey:")) continue;
    const entry = value as ApiKeyEntry;
    if (entry.hash === hash) {
      return { userId: entry.userId, scopes: entry.scopes, name: entry.name };
    }
  }
  return null;
}

export function requireScope(
  locals: { apiKeyScopes?: ApiKeyScope[] },
  scope: ApiKeyScope,
): Response | null {
  if (!locals.apiKeyScopes) return null; // cookie auth -- allow all
  if (locals.apiKeyScopes.includes(scope)) return null;
  return Response.json({ error: "Insufficient scope", required: scope }, { status: 403 });
}
