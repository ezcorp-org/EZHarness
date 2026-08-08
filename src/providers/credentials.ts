/**
 * Credential resolution chain for LLM providers.
 * Uses pi-ai's OAuthCredentials format; token refresh + key derivation run
 * through `Models.getAuth()` over EZCorp's `SettingsCredentialStore`
 * (see ./credential-store.ts — pi-ai 0.83.0 removed `getOAuthApiKey`).
 * Supports OAuth tokens (OpenAI, Google) and BYOK API keys.
 */

import { getSetting } from "../db/queries/settings";
import { decrypt } from "./encryption";
import { isTestSurfaceEnabled, MOCK_PROVIDER } from "../test-surface";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import {
  _resetCredentialStore,
  getCredentialStore,
  isBrokenOAuth,
  MIN_OAUTH_VALIDITY_MS,
  OAUTH_PROVIDER_IDS,
  oauthSettingKey,
  OAuthUnusableError,
  resolveOAuthAuth,
  tagOAuthCredential,
} from "./credential-store";
import {
  BYOK_ONLY_PROVIDERS,
  hasKeylessFreeTier,
  PROVIDER_ENV_KEYS,
} from "../runtime/routing/llm-providers";

// ── Types ─────────────────────────────────────────────────────────────

export interface ProviderCredential {
  type: "oauth" | "apikey";
  token: string;
  refreshed?: boolean;
}

// Re-export pi-ai's OAuthCredentials for downstream usage
export type { OAuthCredentials };

// ── Provider-to-OAuth-ID mapping ──────────────────────────────────────
// Lives in ./credential-store.ts (which needs the inverse to key the store)
// and is re-exported here so this module stays the one place that reads it.
export { OAUTH_PROVIDER_IDS };

// Providers that are BYOK-only (no pi-managed OAuth flow). The default
// credential chain skips the DB-OAuth attempt for these and goes straight
// to BYOK -> env var. anthropic, openrouter and kilo are all API-key-only.
//
// Derived from the one provider table (`runtime/routing/llm-providers.ts`)
// rather than restated, so a provider cannot be BYOK-only here and OAuth-
// capable in the settings UI.
//
// NOTE (pi-ai 0.83.0): `anthropic` and `openrouter` DO now carry
// `auth.oauth` in pi's catalog, so pi could in principle refresh a stored
// Anthropic subscription token. That is deliberately NOT enabled here.
// Nothing in EZCorp ever WRITES `provider:oauth:anthropic` — there is no
// Anthropic login flow — so `getOAuthCredential` still stops at the
// "no stored credential" check below, exactly as it did before the bump.
// Turning Anthropic subscription auth on is a feature (login flow, callback
// route, settings UI), not a side effect of a dependency upgrade.
const BYOK_ONLY_PROVIDER_SET = new Set<string>(BYOK_ONLY_PROVIDERS);

// ── Refresh serialization ─────────────────────────────────────────────
// Refresh is now serialized inside `SettingsCredentialStore.modify()` (pi
// runs the token exchange under that lock), so the old module-level
// `refreshLocks` Map is gone. This clears the store — and with it any
// per-provider chain — for tests.

/** Exported for testing: reset the credential store's serialization state. */
export function _clearRefreshLocks(): void {
  _resetCredentialStore();
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
  // A STORED credential is the precondition, checked here and not delegated.
  // `Models.getAuth()` resolves AMBIENT env credentials when the store has
  // nothing (measured: `getAuth("openai")` with OPENAI_API_KEY set returns
  // that key, `source: "OPENAI_API_KEY"`). Letting that reach the caller
  // would return an API key labelled `type: "oauth"` and silently promote an
  // env key over EZCorp's own BYOK precedence. Gate first, always.
  const stored = await getSetting(oauthSettingKey(provider));
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
  // `projectId` round-trips through it without a cast. Written THROUGH the
  // store's `modify` so every write to this row goes down one serialized
  // path and cannot interleave with a refresh.
  if (provider === "google" && !creds.projectId) {
    const projectId = await discoverGoogleProject(creds.access);
    creds.projectId = projectId;
    await getCredentialStore().modify(oauthProviderId, async () => tagOAuthCredential(creds));
  }

  // Whether this call is the one that needs a refresh, evaluated against the
  // SAME predicate `getAuth` applies internally via `minOAuthValidityMs`. We
  // still branch on it ourselves for two reasons the API cannot serve:
  //  - a missing refresh token deserves its own message, not a provider 401;
  //  - `ProviderCredential.refreshed` is part of this module's contract and
  //    `getAuth` does not report whether it exchanged (it returns only the
  //    resolved auth). This is exactly the predicate the pre-0.83 code
  //    branched on to set the flag, so the flag means what it always meant.
  // If a concurrent caller refreshes between this read and the exchange, we
  // report `refreshed: true` without having done the exchange ourselves —
  // the same window the old `refreshLocks` Map had.
  const needsRefresh = creds.expires < Date.now() + MIN_OAUTH_VALIDITY_MS;
  if (needsRefresh && !creds.refresh) {
    // Connected, but unrecoverable without a re-login — not "not configured".
    throw new OAuthUnusableError(`OAuth token expired for ${provider}, no refresh token`);
  }

  // Refresh (when inside the 60s expiry buffer) + key derivation, both under
  // the store lock. `getAuth` re-checks expiry INSIDE `modify`, so a caller
  // that queued behind another turn's refresh sees the fresh token instead of
  // triggering a second exchange — the one thing the old `refreshLocks` Map
  // could not do, because it decided expiry before taking the lock.
  const auth = await resolveOAuthAuth(oauthProviderId);

  if (!auth?.apiKey) {
    // pi has no such provider, or it yielded no key. `google-gemini-cli` is
    // the live case: pi-ai has never registered it, so Google OAuth lands
    // here on every call. Previously this threw `Unknown OAuth provider` and
    // was swallowed by getCredential's fall-through; the outcome is the same
    // (fall through to BYOK) but the message now says which provider and why,
    // instead of a generic refresh failure.
    //
    // NOTE the deliberate asymmetry with the throw below: this is "pi cannot
    // serve this provider", a CONFIGURATION fact. A refresh that genuinely
    // fails throws `ModelsError` with `code: "oauth"` out of `resolveOAuthAuth`
    // and is NOT caught here — see the comment at getCredential's step 3.
    throw new Error(
      `No pi-ai OAuth provider for ${provider} (${oauthProviderId}); cannot derive a token`,
    );
  }

  // NOTE: ModelAuth also carries `headers` and `baseUrl`. ProviderCredential
  // models a bare token and drops them — harmless for the four providers
  // EZCorp ships (none uses a per-credential baseUrl), silently wrong for a
  // Copilot-style provider. ~24 call sites consume `.token`, so widening the
  // type is its own change, not this one's.
  return needsRefresh
    ? { type: "oauth", token: auth.apiKey, refreshed: true }
    : { type: "oauth", token: auth.apiKey };
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

  // pi-ai only resolves env vars for providers IT knows. Kilo is not a pi-ai
  // provider, so `getEnvApiKey("kilo")` is always empty and `KILO_API_KEY` was
  // silently ignored — which, combined with the keyless fallback in
  // `getCredential`, meant a deployment that HAD configured a key still ran as
  // free-only. Consult this repo's own provider table for anything pi does not
  // cover.
  const ownEnvKey = PROVIDER_ENV_KEYS[provider];
  if (ownEnvKey && process.env[ownEnvKey]) return process.env[ownEnvKey];

  throw new Error(`Missing API key for ${provider}`);
}

async function getApiKeyCredential(
  provider: string,
): Promise<ProviderCredential> {
  const token = await getApiKey(provider);
  return { type: "apikey", token };
}

// ── Main Credential Resolution ────────────────────────────────────────

/**
 * The provider's credential, or null if it cannot authenticate right now.
 *
 * A non-throwing probe over `getCredential`, for callers that must CHOOSE
 * a provider rather than use one. Returns the credential rather than a
 * boolean because the CHOICE depends on its `type`: an OAuth token can only
 * run subscription-eligible models, so the caller needs the type to pick a
 * model the credential can actually serve. `resolveModel`'s no-provider branch used
 * to pick the first entry in the preference order (`anthropic` by default)
 * that merely had a model in the tier — availability of a model, not of a
 * credential. On a deployment with only OpenAI connected, every unpinned
 * turn resolved to anthropic and died with "No credentials available for
 * anthropic", no matter which model the picker showed.
 *
 * Deliberately delegates to `getCredential` instead of re-deriving the
 * OAuth → BYOK → env precedence (including the BYOK-only and local-baseUrl
 * carve-outs). A second copy of that order would drift from the real one,
 * and a probe that disagrees with the resolver is worse than no probe.
 */
export async function tryGetCredential(
  provider: string,
  conversationId?: string,
): Promise<ProviderCredential | null> {
  try {
    return await getCredential(provider, conversationId);
  } catch {
    return null;
  }
}

export async function getCredential(
  provider: string,
  conversationId?: string,
): Promise<ProviderCredential> {
  // 0. Deterministic mock provider (remote-test harness only). The mock
  //    LLM ignores the token, but pi-ai's createClient requires a non-empty
  //    key, so hand back a sentinel. Gated so this never resolves in prod.
  if (provider === MOCK_PROVIDER && isTestSurfaceEnabled()) {
    return { type: "apikey", token: "no-key-needed" };
  }

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
  //    (Skip DB OAuth for BYOK-only providers like anthropic and openrouter
  //     -- these have no pi-managed OAuth flow)
  //
  // The fall-through stays — a deployment with a broken OAuth token AND a
  // working BYOK key should keep serving turns. But it no longer DESTROYS the
  // reason. Since pi-ai 0.83.0 a genuine refresh failure arrives as a
  // `ModelsError` with `code: "oauth"` (invalid_grant, a 401 from the token
  // endpoint) and is a materially different event from "OAuth was never
  // connected": the user's subscription auth is broken and only a re-login
  // fixes it. Flattening both into "No credentials available" is what sends
  // someone to re-enter an API key they never configured. Keep the cause and
  // report it if the whole ladder fails.
  let oauthFailure: unknown;
  if (!BYOK_ONLY_PROVIDER_SET.has(provider)) {
    try {
      return await getOAuthCredential(provider);
    } catch (err) {
      if (isBrokenOAuth(err)) oauthFailure = err;
      // Fall through
    }
  }

  try {
    return await getApiKeyCredential(provider);
  } catch {
    // Keyless free tier: the provider serves SOME models to anonymous
    // callers, so "no key" is a usable state rather than a failure. Kilo is
    // the only such provider today — measured, its gateway answers a free
    // model with no credential at all (HTTP 200) and 401s a paid one with
    // PAID_MODEL_AUTH_REQUIRED.
    //
    // Handing back the same `no-key-needed` sentinel the local-provider
    // branch below uses is deliberate: pi-ai's createClient rejects an empty
    // key, and the gateway ignores an unusable bearer on free models
    // (measured: HTTP 200 with this exact token). It is NOT what restricts
    // this deployment to free models — `kilo-catalog.ts` does that by
    // filtering the catalog before routing ever sees a paid id.
    if (hasKeylessFreeTier(provider)) {
      return { type: "apikey", token: "no-key-needed" };
    }

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

    if (oauthFailure) {
      throw new Error(
        `OAuth for ${provider} is connected but could not be refreshed: ` +
        `${oauthFailure instanceof Error ? oauthFailure.message : String(oauthFailure)}. ` +
        `Sign in to ${provider} again, or add an API key.`,
        { cause: oauthFailure },
      );
    }

    throw new Error(
      `No credentials available for ${provider}. Connect via OAuth or add an API key.`,
    );
  }
}
