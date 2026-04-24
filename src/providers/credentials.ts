/**
 * Credential resolution chain for LLM providers.
 * Uses pi-ai's OAuthCredentials format and getOAuthApiKey() for token refresh.
 * Supports OAuth tokens (OpenAI, Google) and BYOK API keys.
 */

import { getSetting, upsertSetting } from "../db/queries/settings";
import { decrypt, encrypt } from "./encryption";
import {
  getOAuthApiKey,
  type OAuthCredentials,
} from "@mariozechner/pi-ai/oauth";
import { getEnvApiKey } from "@mariozechner/pi-ai";

// ── Types ─────────────────────────────────────────────────────────────

export interface ProviderCredential {
  type: "oauth" | "apikey";
  token: string;
  refreshed?: boolean;
}

// Re-export pi-ai's OAuthCredentials for downstream usage
export type { OAuthCredentials };

// ── Provider-to-OAuth-ID mapping ──────────────────────────────────────

const OAUTH_PROVIDER_IDS: Record<string, string> = {
  openai: "openai-codex",
  google: "google-gemini-cli",
  anthropic: "anthropic",
};

// ── Refresh Lock ──────────────────────────────────────────────────────

const refreshLocks = new Map<string, Promise<ProviderCredential>>();

/** Exported for testing: clear all refresh locks */
export function _clearRefreshLocks(): void {
  refreshLocks.clear();
}

// ── Internal Credential Resolvers ─────────────────────────────────────

/** Discover Google Cloud project ID via Cloud Code Assist API. */
async function discoverGoogleProject(accessToken: string): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "X-Goog-Api-Client": "gl-node/22.17.0",
  };
  const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
    method: "POST",
    headers,
    body: JSON.stringify({
      metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
    }),
  });
  if (!res.ok) {
    throw new Error(`Google Cloud project discovery failed: ${res.status}`);
  }
  const data = await res.json() as { cloudaicompanionProject?: string; currentTier?: unknown };
  if (data.cloudaicompanionProject) return data.cloudaicompanionProject;
  throw new Error("No Google Cloud project found. Set GOOGLE_CLOUD_PROJECT env var or run Gemini CLI login.");
}

async function getOAuthCredential(
  provider: string,
): Promise<ProviderCredential> {
  const stored = await getSetting(`provider:oauth:${provider}`);
  if (!stored || typeof stored !== "string") {
    throw new Error(`No OAuth token for ${provider}`);
  }

  const creds = JSON.parse(decrypt(stored)) as OAuthCredentials;
  const oauthProviderId = OAUTH_PROVIDER_IDS[provider];
  if (!oauthProviderId) {
    throw new Error(`No OAuth provider mapping for ${provider}`);
  }

  // Google Cloud Code Assist requires a projectId. If missing (e.g. OAuth
  // callback didn't discover one), resolve it now and persist.
  // OAuthCredentials has a `[key: string]: unknown` index signature, so
  // `projectId` round-trips through it without a cast.
  if (provider === "google" && !creds.projectId) {
    const projectId = await discoverGoogleProject(creds.access);
    creds.projectId = projectId;
    await upsertSetting(`provider:oauth:${provider}`, encrypt(JSON.stringify(creds)));
  }

  // Check if expired (with 60s buffer)
  if (creds.expires < Date.now() + 60_000) {
    if (!creds.refresh) {
      throw new Error(`OAuth token expired for ${provider}, no refresh token`);
    }

    // Use refresh lock to prevent concurrent refresh requests
    if (refreshLocks.has(provider)) {
      return refreshLocks.get(provider)!;
    }

    const refreshPromise = (async (): Promise<ProviderCredential> => {
      try {
        const result = await getOAuthApiKey(oauthProviderId, { [oauthProviderId]: creds });
        if (!result) {
          throw new Error(`Token refresh failed for ${provider}`);
        }

        // Persist refreshed credentials if they changed
        if (result.newCredentials !== creds) {
          await upsertSetting(
            `provider:oauth:${provider}`,
            encrypt(JSON.stringify(result.newCredentials)),
          );
        }

        return {
          type: "oauth",
          token: result.apiKey,
          refreshed: true,
        };
      } finally {
        refreshLocks.delete(provider);
      }
    })();

    refreshLocks.set(provider, refreshPromise);
    return refreshPromise;
  }

  // Token not expired -- extract API key via pi-ai
  const result = await getOAuthApiKey(oauthProviderId, { [oauthProviderId]: creds });
  if (!result) {
    // Fallback: use the access token directly
    return { type: "oauth", token: creds.access };
  }

  return { type: "oauth", token: result.apiKey };
}

// ── BYOK API Key ──────────────────────────────────────────────────────

/** @deprecated Use getCredential() instead */
export async function getApiKey(provider: string): Promise<string> {
  // Check BYOK stored key first
  try {
    const stored = await getSetting(`provider:apiKey:${provider}`);
    if (stored && typeof stored === "string") {
      try {
        return decrypt(stored);
      } catch {
        // Decrypt failed -- fall through to env var
      }
    }
  } catch {
    // Settings DB unavailable -- fall through to env var
  }

  // Try pi-ai's env key resolver (checks standard env vars like ANTHROPIC_API_KEY)
  const envKey = getEnvApiKey(provider);
  if (envKey) return envKey;

  throw new Error(`Missing API key for ${provider}`);
}

async function getApiKeyCredential(
  provider: string,
): Promise<ProviderCredential> {
  const token = await getApiKey(provider);
  return { type: "apikey", token };
}

// ── Main Credential Resolution ────────────────────────────────────────

export async function getCredential(
  provider: string,
  conversationId?: string,
): Promise<ProviderCredential> {
  // 1. Check conversation-level override
  if (conversationId) {
    const override = await getSetting(
      `conversation:${conversationId}:accessMode:${provider}`,
    );
    if (override === "apikey") return getApiKeyCredential(provider);
    if (override === "oauth") return getOAuthCredential(provider);
  }

  // 2. Check user-level preference
  const preference = await getSetting(`provider:accessMode:${provider}`);
  if (preference === "apikey") return getApiKeyCredential(provider);
  if (preference === "oauth") return getOAuthCredential(provider);

  // 3. Default: try DB OAuth -> BYOK -> env var
  //    (Skip DB OAuth for anthropic -- BYOK-only, no pi-managed OAuth flow)
  if (provider !== "anthropic") {
    try {
      return await getOAuthCredential(provider);
    } catch {
      // Fall through
    }
  }

  try {
    return await getApiKeyCredential(provider);
  } catch {
    // Last resort: local providers with baseUrl don't need credentials
    try {
      const customModels = await getSetting("provider:customModels");
      if (
        Array.isArray(customModels) &&
        customModels.some((m: unknown): boolean => {
          if (!m || typeof m !== "object") return false;
          const r = m as { provider?: unknown; baseUrl?: unknown };
          return r.provider === provider && typeof r.baseUrl === "string";
        })
      ) {
        return { type: "apikey", token: "no-key-needed" };
      }
    } catch {}

    throw new Error(
      `No credentials available for ${provider}. Connect via OAuth or add an API key.`,
    );
  }
}
