/**
 * Wires the user's configured OpenAI credential into the
 * `openai-image-gen-2` extension's subprocess at spawn time.
 *
 * Rationale. The extension is OpenAI-only (per its manifest) and needs
 * either an `sk-…` API key or an OAuth access token to authenticate.
 * Rather than making the user duplicate that into the container's
 * process.env, we read whatever is already configured in the platform
 * (BYOK key via admin settings OR OAuth via the OpenAI sign-in flow)
 * and inject it only into THIS extension's subprocess.
 *
 * We register an *async resolver* with the ExtensionRegistry so the
 * credential is fetched fresh on every spawn. That way an OAuth token
 * that expires mid-session is refreshed transparently by the
 * credential layer before it reaches the extension.
 *
 * If no credential is configured, the resolver returns an empty env
 * map; the extension produces its own clean "set OPENAI_API_KEY or
 * OPENAI_ACCESS_TOKEN" error for the caller.
 */

import { ExtensionRegistry } from "$server/extensions/registry";
import { getSetting, upsertSetting } from "$server/db/queries/settings";
import { decrypt, encrypt } from "$server/providers/encryption";
import { getEnvApiKey } from "@mariozechner/pi-ai";
import { getOAuthApiKey, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";

export const OPENAI_IMAGE_GEN_EXT_NAME = "openai-image-gen-2";
const OAUTH_PROVIDER_ID = "openai-codex";

/** Build the env map from whichever credentials are available. Both are
 *  injected when both exist — the extension picks the right path
 *  (OAuth → Codex Responses; API key → public Images API). Exported
 *  for tests. */
export function buildOpenAIInjectedEnv(
  apiKey: string | null | undefined,
  accessToken: string | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof apiKey === "string" && apiKey.length > 0) out.OPENAI_API_KEY = apiKey;
  if (typeof accessToken === "string" && accessToken.length > 0) out.OPENAI_ACCESS_TOKEN = accessToken;
  return out;
}

/**
 * Resolve the OpenAI BYOK API key (`sk-…`) from admin settings, falling
 * back to `OPENAI_API_KEY` on the server env. The extension uses this
 * for the public Images API path when no OAuth token is available.
 * Returns null when no usable key is configured.
 *
 * Exported for tests.
 */
export async function resolveOpenAIApiKey(): Promise<string | null> {
  try {
    const stored = await getSetting(`provider:apiKey:openai`);
    if (typeof stored === "string" && stored.length > 0) {
      try {
        const decoded = decrypt(stored);
        if (decoded.length > 0) return decoded;
      } catch {
        // Decrypt failed (encryption secret rotated? corrupted value?) —
        // fall through to env fallback rather than wedging the tool.
      }
    }
  } catch {
    // Settings DB unavailable — fall through to env.
  }
  const envKey = getEnvApiKey("openai" as any);
  if (envKey) return envKey;
  return null;
}

/**
 * Resolve the user's subscription OAuth *access token*, refreshing it
 * with the stored refresh token if it's within 60s of expiry. This is
 * the Codex-scoped token that the extension uses for the Codex
 * Responses API path (chatgpt.com/backend-api/codex/responses) — the
 * only way to hit image_generation under a subscription.
 *
 * Returns null if OAuth isn't connected, or if the stored credential
 * can't be decrypted/refreshed. Exported for tests.
 */
export async function resolveOpenAIAccessToken(): Promise<string | null> {
  let stored: unknown;
  try {
    stored = await getSetting(`provider:oauth:openai`);
  } catch {
    return null;
  }
  if (typeof stored !== "string" || stored.length === 0) return null;

  let creds: OAuthCredentials;
  try {
    creds = JSON.parse(decrypt(stored)) as OAuthCredentials;
  } catch {
    return null;
  }
  if (!creds.access || typeof creds.access !== "string") return null;

  // Refresh when inside the 60s pre-expiry window; leaves a buffer for
  // the subsequent POST to the Codex endpoint.
  if (creds.expires > Date.now() + 60_000) return creds.access;
  if (!creds.refresh) return null;

  try {
    const result = await getOAuthApiKey(OAUTH_PROVIDER_ID, { [OAUTH_PROVIDER_ID]: creds });
    if (!result) return null;
    const newCreds = result.newCredentials ?? creds;
    if (newCreds !== creds) {
      try {
        await upsertSetting(`provider:oauth:openai`, encrypt(JSON.stringify(newCreds)));
      } catch {
        // Persisting the refreshed creds is best-effort; if it fails we
        // still return the freshly minted access token so the current
        // spawn succeeds. The next spawn will re-refresh.
      }
    }
    // `getOAuthApiKey` returns the provider's API key string, which for
    // `openai-codex` is the raw OAuth access token (a JWT). Fall back to
    // newCreds.access if the result shape is unexpected.
    return typeof result.apiKey === "string" && result.apiKey.length > 0
      ? result.apiKey
      : (newCreds.access ?? null);
  } catch {
    return null;
  }
}

/** Register a per-spawn resolver for the openai-image-gen-2 extension. */
export function wireOpenAIExtensionCredentials(
  registry: ExtensionRegistry = ExtensionRegistry.getInstance(),
  resolvers: {
    apiKey?: () => Promise<string | null>;
    accessToken?: () => Promise<string | null>;
  } = {},
): void {
  const apiKeyFn = resolvers.apiKey ?? resolveOpenAIApiKey;
  const accessTokenFn = resolvers.accessToken ?? resolveOpenAIAccessToken;
  registry.setInjectedEnvResolver(OPENAI_IMAGE_GEN_EXT_NAME, async () => {
    try {
      const [apiKey, accessToken] = await Promise.all([apiKeyFn(), accessTokenFn()]);
      return buildOpenAIInjectedEnv(apiKey, accessToken);
    } catch {
      return {};
    }
  });
}
