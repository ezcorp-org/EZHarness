/**
 * Resolves the user's configured OpenAI credential for the
 * `openai-image-gen-2` extension.
 *
 * The extension is OpenAI-only (per its manifest) and needs either an
 * `sk-…` API key or an OAuth access token. Rather than making the user
 * duplicate that into an env var, we read whatever is already configured
 * in the platform (BYOK key via admin settings OR OAuth via the OpenAI
 * sign-in flow). The credential broker
 * (`src/extensions/credential-broker.ts`, wired by
 * `$lib/server/extensions/credential-resolver.ts`) calls these resolvers
 * on each `ezcorp/env.get`, so an OAuth token that expires mid-session is
 * refreshed before use. The worker only ever sees a short-lived handle.
 *
 * If no credential is configured, a resolver returns null; the extension
 * produces its own clean "set OPENAI_API_KEY or OPENAI_ACCESS_TOKEN"
 * error for the caller.
 */

import { getSetting } from "$server/db/queries/settings";
import { decrypt } from "$server/providers/encryption";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { resolveOAuthAuth } from "$server/providers/credential-store";

const OAUTH_PROVIDER_ID = "openai-codex";

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
  // biome-ignore lint/suspicious/noExplicitAny: `getEnvApiKey` is keyed on the provider-id union built from the settings schema, which this module cannot import without pulling the whole settings surface into a security helper.
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
  // the subsequent POST to the Codex endpoint. `resolveOAuthAuth` applies
  // the same 60s buffer internally (MIN_OAUTH_VALIDITY_MS), so this early
  // return is a fast path over identical arithmetic, not a second policy.
  if (creds.expires > Date.now() + 60_000) return creds.access;
  if (!creds.refresh) return null;

  try {
    // pi-ai 0.83.0 removed `getOAuthApiKey`; refresh + key derivation now run
    // inside the shared credential store's `modify()` lock. That also removes
    // the write this function used to do itself — persisting the refreshed
    // credential is the store's job, and doing it here as well raced the
    // chat path's refresh for the same `provider:oauth:openai` row.
    //
    // For `openai-codex` the derived apiKey IS the raw OAuth access token
    // (a JWT), which is what the extension's Codex Responses path needs.
    const auth = await resolveOAuthAuth(OAUTH_PROVIDER_ID);
    return typeof auth?.apiKey === "string" && auth.apiKey.length > 0 ? auth.apiKey : null;
  } catch {
    // Unchanged contract: this resolver is best-effort. A failed refresh
    // yields no token and the extension emits its own "set OPENAI_API_KEY or
    // OPENAI_ACCESS_TOKEN" error, rather than failing the call.
    return null;
  }
}
