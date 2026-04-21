/**
 * Circuit-breaker wrapped LLM calls using pi-ai stream/complete.
 * Provider routing with fallback suggestions.
 */

import {
  stream,
  complete,
  type Model,
  type Context,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { getCredential } from "./credentials";
import { resolveModelObject, findModelForProviderInTier } from "./registry";
import { getCircuitBreaker } from "./circuit-breaker";
import { getSetting } from "../db/queries/settings";

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

// ── Routed Stream/Complete ───────────────────────────────────────────

export async function createRoutedStream(
  model: Model<any>,
  context: Context,
  opts?: { signal?: AbortSignal; conversationId?: string },
): Promise<AssistantMessageEventStream> {
  const cb = getCircuitBreaker(model.provider);

  if (cb.isOpen()) {
    const suggestion = await suggestFallback(model.provider, await getDefaultTier());
    throw new ProviderUnavailableError(
      `${model.provider} is unavailable right now`,
      model.provider,
      model.id,
      suggestion,
    );
  }

  try {
    const cred = await getCredential(model.provider, opts?.conversationId);
    const s = stream(model, context, {
      apiKey: cred.token,
      signal: opts?.signal,
    });
    cb.recordSuccess();
    return s;
  } catch (err) {
    cb.recordFailure();
    const suggestion = await suggestFallback(model.provider, await getDefaultTier());
    throw new ProviderUnavailableError(
      `${model.provider} is unavailable right now`,
      model.provider,
      model.id,
      suggestion,
    );
  }
}

export async function createRoutedComplete(
  model: Model<any>,
  context: Context,
  opts?: { conversationId?: string },
): Promise<AssistantMessage> {
  const cb = getCircuitBreaker(model.provider);

  if (cb.isOpen()) {
    const suggestion = await suggestFallback(model.provider, await getDefaultTier());
    throw new ProviderUnavailableError(
      `${model.provider} is unavailable right now`,
      model.provider,
      model.id,
      suggestion,
    );
  }

  try {
    const cred = await getCredential(model.provider, opts?.conversationId);
    const result = await complete(model, context, { apiKey: cred.token });
    cb.recordSuccess();
    return result;
  } catch (err) {
    cb.recordFailure();
    const suggestion = await suggestFallback(model.provider, await getDefaultTier());
    throw new ProviderUnavailableError(
      `${model.provider} is unavailable right now`,
      model.provider,
      model.id,
      suggestion,
    );
  }
}
