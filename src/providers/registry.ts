/**
 * Model registry backed by pi-ai's getModel()/getModels().
 * Replaces ~480 lines of CURATED_MODELS array and live API fetching.
 */

import {
  getModel,
  getModels,
  getProviders,
  type Model,
  type KnownProvider,
} from "@mariozechner/pi-ai";
import { getSetting } from "../db/queries/settings";

// ── ModelEntry: API response shape for the frontend ──────────────────

export interface ModelEntry {
  id: string;
  provider: string;
  tier: "fast" | "balanced" | "powerful";
  contextWindow: number;
  vision: boolean;
  reasoning: boolean;
  costTier: "low" | "medium" | "high";
  displayName?: string;
  /** Base URL for custom/local model endpoints (e.g. http://localhost:11434). */
  baseUrl?: string;
}

// ── Tier/Cost inference from model name ──────────────────────────────

function inferTier(id: string): { tier: ModelEntry["tier"]; costTier: ModelEntry["costTier"] } {
  const lower = id.toLowerCase();

  if (/\bmini\b|nano|flash|lite|haiku/.test(lower)) {
    return { tier: "fast", costTier: "low" };
  }
  if (/opus|^o[1-9]$|pro|codex-max/.test(lower)) {
    return { tier: "powerful", costTier: "high" };
  }
  return { tier: "balanced", costTier: "medium" };
}

// ── Convert pi-ai Model to local ModelEntry ──────────────────────────

function piModelToEntry(model: Model<any>): ModelEntry {
  const { tier, costTier } = inferTier(model.id);
  return {
    id: model.id,
    provider: model.provider,
    tier,
    contextWindow: model.contextWindow,
    vision: model.input.includes("image"),
    reasoning: !!model.reasoning,
    costTier,
    displayName: model.name,
  };
}

// ── Registry functions ───────────────────────────────────────────────

export async function getModelRegistry(): Promise<ModelEntry[]> {
  const entries: ModelEntry[] = [];

  for (const provider of getProviders()) {
    for (const model of getModels(provider)) {
      entries.push(piModelToEntry(model));
    }
  }

  // Append user-defined custom models from settings (normalize shape)
  const rawCustom = (await getSetting("provider:customModels")) as any[] | undefined;
  if (rawCustom && Array.isArray(rawCustom)) {
    for (const cm of rawCustom) {
      entries.push({
        id: cm.id ?? cm.modelId,
        provider: cm.provider ?? "ollama",
        tier: cm.tier ?? "balanced",
        contextWindow: cm.contextWindow ?? 128_000,
        vision: cm.vision ?? false,
        reasoning: cm.reasoning ?? false,
        costTier: cm.costTier ?? "low",
        displayName: cm.displayName ?? cm.id ?? cm.modelId,
        baseUrl: cm.baseUrl,
      });
    }
  }

  return entries;
}

export function getModelsForTier(tier: "fast" | "balanced" | "powerful"): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const provider of getProviders()) {
    for (const model of getModels(provider)) {
      const entry = piModelToEntry(model);
      if (entry.tier === tier) entries.push(entry);
    }
  }
  return entries;
}

export function findModelForProviderInTier(
  provider: string,
  tier: "fast" | "balanced" | "powerful",
): ModelEntry | null {
  const models = getModels(provider as KnownProvider);
  for (const model of models) {
    const entry = piModelToEntry(model);
    if (entry.tier === tier) return entry;
  }
  return null;
}

/**
 * Mapping from user-facing providers to their OAuth-compatible pi-ai provider.
 * When OAuth is active, only models from the OAuth provider are supported
 * because the standard API endpoints require API key auth (not OAuth tokens).
 *
 * - google → google-gemini-cli (Cloud Code Assist API, Bearer token auth)
 * - openai → openai-codex (ChatGPT Codex API, different endpoint + scopes)
 */
const OAUTH_PROVIDER_MAP: Record<string, KnownProvider> = {
  google: "google-gemini-cli" as KnownProvider,
  openai: "openai-codex" as KnownProvider,
};

/**
 * Returns the set of model IDs supported by a provider's OAuth-compatible variant.
 * Used to filter the model list when OAuth is active.
 */
export function getOAuthModelIds(provider: string): Set<string> | null {
  const oauthProvider = OAUTH_PROVIDER_MAP[provider];
  if (!oauthProvider) return null;
  return new Set(getModels(oauthProvider).map((m) => m.id));
}

/**
 * Resolve the OAuth-compatible Model object for a given provider + model ID.
 * Returns null if the model isn't available in the OAuth provider variant.
 */
export function resolveOAuthModel(provider: string, modelId: string): Model<any> | null {
  const oauthProvider = OAUTH_PROVIDER_MAP[provider];
  if (!oauthProvider) return null;
  try {
    return getModel(oauthProvider, modelId as never);
  } catch {
    return null;
  }
}

/**
 * Resolve a pi-ai Model object from provider + modelId.
 * Falls back to creating a custom model if not found in registry.
 */
export function resolveModelObject(provider: string, modelId: string, baseUrl?: string): Model<any> {
  try {
    const found = getModel(provider as KnownProvider, modelId as never);
    if (found) return found;
  } catch {
    // fall through
  }

  // Model not in pi-ai registry -- create a custom model entry
  // Assume OpenAI-compatible API for unknown providers
  // Ensure baseUrl ends with /v1 (required by pi-ai's openai-completions API)
  let resolvedUrl = baseUrl ?? "https://api.openai.com/v1";
  if (resolvedUrl && !resolvedUrl.endsWith("/v1")) {
    resolvedUrl = resolvedUrl.replace(/\/+$/, "") + "/v1";
  }
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions" as any,
    provider: provider as any,
    baseUrl: resolvedUrl,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}
