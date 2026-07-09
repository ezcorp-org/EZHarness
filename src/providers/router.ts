/**
 * Provider routing with fallback suggestions.
 */

import { type Model } from "@earendil-works/pi-ai";
import { resolveModelObject, findModelForProviderInTier, resolveDiscoveredModel } from "./registry";
import { getCircuitBreaker } from "./circuit-breaker";
import { getSetting } from "../db/queries/settings";
import { isTestSurfaceEnabled, MOCK_PROVIDER, mockLlmBaseUrl } from "../test-surface";
// Tier vocabulary lives in the pure routing classifier (single source of
// truth). Type-only import — erased at build, so it adds no runtime dep.
import type { RoutingTier } from "../runtime/tier-classifier";

// ── Types ────────────────────────────────────────────────────────────

export interface FallbackSuggestion {
  provider: string;
  model: string;
  tier: string;
}

export class ProviderUnavailableError extends Error {
  constructor(
    message: string,
    public readonly failedProvider: string,
    public readonly failedModel: string,
    public readonly suggestion: FallbackSuggestion | null,
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

// ── Settings helpers ─────────────────────────────────────────────────

type TierName = RoutingTier;

const DEFAULT_PREFERENCE_ORDER = ["anthropic", "openai", "google", "openrouter"];
const DEFAULT_TIER: TierName = "balanced";

/** Configured default routing tier (`provider:defaultTier` setting, falling
 *  back to "balanced"). Exported so the stream-chat wiring can label a turn
 *  whose tier classification failed with the same tier `resolveModel` used. */
export async function getDefaultTier(): Promise<TierName> {
  const tier = await getSetting("provider:defaultTier");
  if (tier && typeof tier === "string" && ["fast", "balanced", "powerful"].includes(tier)) {
    return tier as TierName;
  }
  return DEFAULT_TIER;
}

/**
 * Merge a stored preference order with the known defaults: preserve the
 * stored order, then append any DEFAULT_PREFERENCE_ORDER providers missing
 * from it. This self-heals orders saved before a provider (e.g. openrouter)
 * was added — without it, resolveModel()'s tier routing and suggestFallback()
 * would never consider a newly-known provider on any deployment where an admin
 * had previously reordered providers. Mirrored (separate build) in
 * web/src/lib/settings-models.ts so the settings UI shows the same appended
 * providers.
 */
export function mergePreferenceOrder(
  stored: string[],
  defaults: readonly string[] = DEFAULT_PREFERENCE_ORDER,
): string[] {
  return [...stored, ...defaults.filter((p) => !stored.includes(p))];
}

async function getPreferenceOrder(): Promise<string[]> {
  const order = await getSetting("provider:preferenceOrder");
  if (Array.isArray(order) && order.length > 0) {
    return mergePreferenceOrder(order as string[]);
  }
  return DEFAULT_PREFERENCE_ORDER;
}

// ── Model Resolution ─────────────────────────────────────────────────

export async function resolveModel(
  provider?: string,
  modelId?: string,
  requestedTier?: RoutingTier,
  // Circuit-breaker credential scope (the acting user's id). Defaults to
  // the process-wide "shared" breaker so context-free callers are
  // behavior-identical to the old provider-only keying.
  credentialScope = "shared",
): Promise<{ provider: string; model: string; piModel: Model<any> }> {
  // WS3 quality-tier routing. When the caller passes a tier (the heuristic
  // classifier picked it for a thread with NO established model — see
  // stream-chat/setup-tools.ts), route by that tier; otherwise fall back to
  // the configured default tier (`provider:defaultTier`). Explicit
  // provider+model pins (Level 1 below) ignore tier entirely and pass
  // through unchanged, so an established/pinned model is never re-routed.
  const tier = requestedTier ?? (await getDefaultTier());

  // Level 1: Explicit provider + model -- passthrough
  if (provider && modelId) {
    // Deterministic mock provider for the remote-test harness. The baseUrl
    // is injected SERVER-SIDE here (never via user `provider:customModels`),
    // so the admin-only, DNS-pinned SSRF validation for user-supplied
    // baseUrls is not in play. Gated: with the test surface off this
    // provider does not resolve and falls through to normal lookup (which
    // has no `ezcorp-mock` models → custom openai-completions w/ default
    // OpenAI baseUrl, requiring credentials it won't have → clean failure).
    if (provider === MOCK_PROVIDER && isTestSurfaceEnabled()) {
      return { provider, model: modelId, piModel: resolveModelObject(provider, modelId, mockLlmBaseUrl()) };
    }
    // Prefer a model discovered via /api/providers/:provider/refresh-models — it carries
    // the correct api + baseUrl for provider-native calls (e.g. openai-responses for gpt-5.x).
    const discovered = await resolveDiscoveredModel(provider, modelId);
    if (discovered) {
      return { provider, model: modelId, piModel: discovered };
    }
    // Look up custom model's baseUrl so resolveModelObject can set the correct endpoint
    const customModels = (await getSetting("provider:customModels")) as any[] | undefined;
    const custom = customModels?.find((m: any) => (m.id ?? m.modelId) === modelId && m.provider === provider);
    return { provider, model: modelId, piModel: resolveModelObject(provider, modelId, custom?.baseUrl) };
  }

  // Level 2: Provider only -- find best model in default tier
  if (provider) {
    const entry = findModelForProviderInTier(provider, tier);
    if (entry) {
      return { provider, model: entry.id, piModel: resolveModelObject(provider, entry.id) };
    }
    // Fallback to the first model for this provider
    return { provider, model: provider, piModel: resolveModelObject(provider, provider) };
  }

  // Level 3: No provider -- iterate preference order, skip open circuit breakers
  const order = await getPreferenceOrder();
  for (const p of order) {
    const cb = getCircuitBreaker(p, credentialScope);
    if (cb.isOpen()) continue;

    const entry = findModelForProviderInTier(p, tier);
    if (entry) {
      return { provider: p, model: entry.id, piModel: resolveModelObject(p, entry.id) };
    }
  }

  throw new Error("No available providers");
}

// ── Fallback suggestion ──────────────────────────────────────────────

export async function suggestFallback(
  failedProvider: string,
  tier: string,
  // Circuit-breaker credential scope (the acting user's id) — see
  // resolveModel. Default keeps context-free callers behavior-identical.
  credentialScope = "shared",
): Promise<FallbackSuggestion | null> {
  const order = await getPreferenceOrder();

  for (const provider of order) {
    if (provider === failedProvider) continue;

    const cb = getCircuitBreaker(provider, credentialScope);
    if (cb.isOpen()) continue;

    const entry = findModelForProviderInTier(provider, tier as TierName);
    if (entry) {
      return { provider, model: entry.id, tier };
    }
  }

  return null;
}

