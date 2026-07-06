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
} from "@earendil-works/pi-ai";
import { getSetting } from "../db/queries/settings";

// Fallback entries for OAuth-only users (ChatGPT Codex login).
// The OAuth token can't call api.openai.com/v1/models, so discovery can't
// reach these — we hardcode them until pi-ai's openai-codex list catches up.
const LOCAL_OAUTH_OVERRIDES: Model<any>[] = [
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-codex-responses" as any,
    provider: "openai-codex" as any,
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
];

// Load discovered models from settings (populated by /api/providers/:provider/refresh-models).
// Returns a flat list across all providers, with pi-ai-registered IDs filtered out to avoid duplicates.
async function loadDiscoveredModels(): Promise<Model<any>[]> {
  const out: Model<any>[] = [];
  for (const provider of ["openai", "anthropic", "google", "openrouter"]) {
    const stored = (await getSetting(`provider:discoveredModels:${provider}`)) as Model<any>[] | undefined;
    if (!Array.isArray(stored)) continue;
    const piIds = new Set(getModels(provider as KnownProvider).map((m) => m.id));
    for (const m of stored) {
      if (!piIds.has(m.id)) out.push(m);
    }
  }
  return out;
}

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

// ── Tier/Cost inference ──────────────────────────────────────────────
// Prefers real pricing from the Model's cost field (provided by pi-ai and
// models.dev discovery). Falls back to name heuristics when cost is 0.
// Thresholds are blended input+output in USD per 1M tokens:
//   low    ≤ $3    (nano/flash/mini/haiku class)
//   medium ≤ $30   (sonnet / gpt-5 / gemini-pro class)
//   high   > $30   (opus / gpt-5-pro / reasoning tiers)

function inferTier(model: Model<any>): { tier: ModelEntry["tier"]; costTier: ModelEntry["costTier"] } {
  const lower = model.id.toLowerCase();
  const blended = (model.cost?.input ?? 0) + (model.cost?.output ?? 0);

  let costTier: ModelEntry["costTier"];
  if (blended <= 0) {
    // No pricing info — fall back to name hints
    if (/\bmini\b|nano|flash|lite|haiku/.test(lower)) costTier = "low";
    else if (/opus|^o[1-9]$|pro|codex-max/.test(lower)) costTier = "high";
    else costTier = "medium";
  } else if (blended <= 3) {
    costTier = "low";
  } else if (blended <= 30) {
    costTier = "medium";
  } else {
    costTier = "high";
  }

  let tier: ModelEntry["tier"];
  if (/\bmini\b|nano|flash|lite|haiku/.test(lower)) {
    tier = "fast";
  } else if (/opus|pro|codex-max|^o[1-9]$/.test(lower)) {
    tier = "powerful";
  } else if (costTier === "high") {
    tier = "powerful";
  } else if (costTier === "low") {
    tier = "fast";
  } else {
    tier = "balanced";
  }

  return { tier, costTier };
}

// ── Convert pi-ai Model to local ModelEntry ──────────────────────────

function piModelToEntry(model: Model<any>): ModelEntry {
  const { tier, costTier } = inferTier(model);
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

  for (const model of await loadDiscoveredModels()) {
    entries.push(piModelToEntry(model));
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
// fallow-ignore-next-line unused-export
export function getOAuthModelIds(provider: string): Set<string> | null {
  const oauthProvider = OAUTH_PROVIDER_MAP[provider];
  if (!oauthProvider) return null;
  const ids = new Set(getModels(oauthProvider).map((m) => m.id));
  for (const m of LOCAL_OAUTH_OVERRIDES) {
    if (m.provider === oauthProvider) ids.add(m.id);
  }
  return ids;
}

/**
 * Resolve the OAuth-compatible Model object for a given provider + model ID.
 * Returns null if the model isn't available in the OAuth provider variant.
 */
export function resolveOAuthModel(provider: string, modelId: string): Model<any> | null {
  const oauthProvider = OAUTH_PROVIDER_MAP[provider];
  if (!oauthProvider) return null;
  try {
    const found = getModel(oauthProvider, modelId as never);
    if (found) return found;
  } catch {
    // fall through to override lookup
  }
  const override = LOCAL_OAUTH_OVERRIDES.find((m) => m.provider === oauthProvider && m.id === modelId);
  return override ?? null;
}

/**
 * Resolve a pi-ai Model object from provider + modelId.
 * Falls back to creating a custom model if not found in registry.
 */
export async function resolveDiscoveredModel(provider: string, modelId: string): Promise<Model<any> | null> {
  const stored = (await getSetting(`provider:discoveredModels:${provider}`)) as Model<any>[] | undefined;
  if (!Array.isArray(stored)) return null;
  return stored.find((m) => m.id === modelId) ?? null;
}

export function resolveModelObject(provider: string, modelId: string, baseUrl?: string): Model<any> {
  try {
    const found = getModel(provider as KnownProvider, modelId as never);
    if (found) return found;
  } catch {
    // fall through
  }

  // OAuth-only models (e.g. gpt-5.5 via ChatGPT subscription) live under
  // the OAuth provider id ("openai-codex") in LOCAL_OAUTH_OVERRIDES, but
  // callers commonly pass the public provider id ("openai"). Consult the
  // OAuth map so capability lookups and model-shape queries return the
  // full definition (input: ["text", "image"], reasoning: true, correct
  // api + baseUrl) instead of silently falling through to the generic
  // text-only fallback below. Without this, any model capability check
  // for gpt-5.5 under "openai" returned supportsImage=false, causing the
  // history rehydrator to skip image injection on the one provider that
  // needed it most.
  const oauthOverride = resolveOAuthModel(provider, modelId);
  if (oauthOverride) return oauthOverride;

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
