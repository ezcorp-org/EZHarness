/**
 * "Can this deployment actually call that provider?" — one definition, shared.
 *
 * Two routes need the same answer and must not drift:
 *   - `GET /api/models` marks each model `available` for the picker.
 *   - `GET /api/models/capabilities?provider=auto` intersects the capabilities
 *     of the rungs the router could serve. A rung on a provider with no
 *     credential can never be served, so letting it into that intersection
 *     silently narrows what a user may attach — an Anthropic-only install would
 *     lose image support to an ollama rung it will never route to.
 *
 * Availability is credential presence, in the same precedence the credential
 * chain itself uses: env var, then BYOK setting, then OAuth. A provider that
 * looks configured but whose `getCredential` throws is NOT available — the same
 * conservative reading `/api/models` has always applied.
 */
import { getCredential } from "$server/providers/credentials";
import { getSetting } from "$server/db/queries/settings";
import { hasKeylessFreeTier, PROVIDER_ENV_KEYS } from "$server/runtime/routing/llm-providers";

/** Env var that supplies each provider's key, when it isn't stored in settings.
 *  Re-exported from the one provider table so this and the provider CRUD route
 *  cannot disagree about which env var backs which provider. */
export const ENV_KEYS: Record<string, string> = { ...PROVIDER_ENV_KEYS };

/** Credential kind per available provider (`"oauth"`, `"api-key"`, …), used by
 *  `/api/models` to narrow OAuth providers to their supported model variants. */
export type ProviderCredentialTypes = Map<string, string>;

export interface ProviderAvailability {
  /** Providers this deployment holds a usable credential for. */
  available: Set<string>;
  credentialTypes: ProviderCredentialTypes;
}

/**
 * Resolve availability for each DISTINCT provider named, preserving the
 * original per-provider semantics exactly (one `getCredential` probe each,
 * failures demote to unavailable rather than throwing).
 */
export async function resolveProviderAvailability(
  providers: Iterable<string>,
): Promise<ProviderAvailability> {
  const available = new Set<string>();
  const credentialTypes: ProviderCredentialTypes = new Map();

  for (const provider of new Set(providers)) {
    const envKey = ENV_KEYS[provider];
    const hasEnv = !!(envKey && process.env[envKey]);
    const hasByok = !!(await getSetting(`provider:apiKey:${provider}`));
    const hasOauth = !!(await getSetting(`provider:oauth:${provider}`));
    // A keyless-free-tier provider (Kilo) is available with NOTHING configured
    // — its gateway answers free models anonymously, measured. Skipping it here
    // would grey out every free model in the picker on exactly the deployment
    // that most needs them: one with no provider set up at all. What it may
    // CALL is still restricted to the free pool, by the catalog filter in
    // `kilo-catalog.ts`, not by this presence check.
    if (!(hasEnv || hasByok || hasOauth || hasKeylessFreeTier(provider))) continue;

    try {
      const cred = await getCredential(provider);
      credentialTypes.set(provider, cred.type);
      available.add(provider);
    } catch {
      // Configured but unusable (expired refresh token, unreadable secret) —
      // treat as unavailable rather than surfacing a model that cannot answer.
    }
  }

  return { available, credentialTypes };
}
