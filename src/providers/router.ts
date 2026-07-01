/**
 * Provider routing with fallback suggestions.
 */

import { type Model } from "@earendil-works/pi-ai";
import { resolveModelObject, findModelForProviderInTier, resolveDiscoveredModel } from "./registry";
import { getCircuitBreaker } from "./circuit-breaker";
import { getSetting } from "../db/queries/settings";
import { isTestSurfaceEnabled, MOCK_PROVIDER, mockLlmBaseUrl } from "../test-surface";

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

type TierName = "fast" | "balanced" | "powerful";

const DEFAULT_PREFERENCE_ORDER = ["anthropic", "openai", "google"];
const DEFAULT_TIER: TierName = "balanced";

async function getDefaultTier(): Promise<TierName> {
  const tier = await getSetting("provider:defaultTier");
  if (tier && typeof tier === "string" && ["fast", "balanced", "powerful"].includes(tier)) {
    return tier as TierName;
  }
  return DEFAULT_TIER;
}

async function getPreferenceOrder(): Promise<string[]> {
  const order = await getSetting("provider:preferenceOrder");
  if (Array.isArray(order) && order.length > 0) {
    return order as string[];
  }
  return DEFAULT_PREFERENCE_ORDER;
}

// ── Model Resolution ─────────────────────────────────────────────────

export async function resolveModel(
  provider?: string,
  modelId?: string,
): Promise<{ provider: string; model: string; piModel: Model<any> }> {
  const tier = await getDefaultTier();

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
    const cb = getCircuitBreaker(p);
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
): Promise<FallbackSuggestion | null> {
  const order = await getPreferenceOrder();

  for (const provider of order) {
    if (provider === failedProvider) continue;

    const cb = getCircuitBreaker(provider);
    if (cb.isOpen()) continue;

    const entry = findModelForProviderInTier(provider, tier as TierName);
    if (entry) {
      return { provider, model: entry.id, tier };
    }
  }

  return null;
}

