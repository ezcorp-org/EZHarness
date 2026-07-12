/**
 * Model registry backed by pi-ai's getModel()/getModels().
 * Replaces ~480 lines of CURATED_MODELS array and live API fetching.
 */

import { getModel, getModels, getProviders } from "@earendil-works/pi-ai/compat";
import type { Model, KnownProvider } from "@earendil-works/pi-ai";
import { getSetting } from "../db/queries/settings";
// Tier vocabulary single source of truth (type-only — erased at build).
import type { RoutingTier } from "../runtime/tier-classifier";

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

/**
 * Routing tier of a resolved pi-ai model — thin public wrapper over the
 * private `inferTier` heuristic (which stays the single source of tier
 * truth). Lets the stream-chat wiring label a PINNED turn with the tier of
 * the model that actually serves it, so pre-stream failover searches for a
 * tier PEER (a pinned Opus falls back to another powerful-tier model)
 * instead of silently dropping to the "balanced" default.
 */
export function tierForModel(model: Model<any>): RoutingTier {
  return inferTier(model).tier;
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

/**
 * Provider → preferred model-id overrides consulted before the alphabetical
 * tier scan in findModelForProviderInTier. pi-ai lists openrouter's ~259
 * models in alphabetical order, so the plain scan picks e.g.
 * `ai21/jamba-large-1.7` (balanced) or `amazon/nova-2-lite-v1` (fast) — poor
 * implicit defaults for tier routing / fallback / the summarizer. OpenRouter's
 * own `openrouter/auto` router chooses a sensible model server-side, so we
 * prefer it for every tier when present. Falls through to the scan if the
 * preferred id is not in the registry.
 */
const PREFERRED_TIER_MODELS: Record<string, string> = {
  openrouter: "openrouter/auto",
};

export function findModelForProviderInTier(
  provider: string,
  tier: "fast" | "balanced" | "powerful",
): ModelEntry | null {
  const models = getModels(provider as KnownProvider);
  const preferredId = PREFERRED_TIER_MODELS[provider];
  if (preferredId) {
    const preferred = models.find((m) => m.id === preferredId);
    if (preferred) return piModelToEntry(preferred);
  }
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
 * Swap a resolved model for its OAuth-compatible sibling when the turn's
 * credential is an OAuth token. The standard API endpoints
 * (google-generative-ai, openai-responses) use API-key auth an OAuth token
 * cannot satisfy — e.g. a ChatGPT-plan token 401s api.openai.com with
 * "Missing scopes: api.responses.write" — so the subscription backend's
 * Model object (correct api + baseUrl + metadata) must be used instead.
 * The ORIGINAL provider name is kept on the swapped model so credential
 * lookups still resolve against "openai"/"google", not
 * "openai-codex"/"google-gemini-cli".
 *
 * No-op for API-key credentials and for providers with no OAuth variant.
 * Throws for google/openai models with no subscription-eligible sibling —
 * the call would be a guaranteed auth failure, and the error names the
 * real constraint instead.
 *
 * Shared by build-pi-agent (the chat run path) and providers/llm.ts
 * (streamLLM/completeLLM — summarizers, background LLM calls) so the two
 * paths can never diverge on OAuth handling again.
 */
export function resolveModelForCredential(
  model: Model<any>,
  provider: string,
  credType: "oauth" | "apikey",
): Model<any> {
  if (credType !== "oauth") return model;
  const oauthModel = resolveOAuthModel(provider, model.id);
  if (oauthModel) return { ...oauthModel, provider };
  if (provider === "google" || provider === "openai") {
    throw new Error(
      `Model "${model.id}" is not supported with ${provider} OAuth. ` +
      `Only subscription-eligible models are available with OAuth authentication.`,
    );
  }
  return model;
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

  // Known catalog provider + unknown model id (and no explicit baseUrl): a
  // persisted id that pi-ai has since dropped — e.g. pi-ai 0.80.6 retired the
  // claude-3-5 snapshot family, so a saved `claude-3-5-sonnet-20241022` pinned
  // on provider "anthropic" no longer resolves. Synthesize the fallback using
  // THIS provider's native wire shape (api + baseUrl borrowed from a sibling
  // catalog model) instead of the OpenAI-completions default below. Otherwise
  // an Anthropic pin is misrouted to api.openai.com with Anthropic credentials,
  // producing a confusing wrong-provider failure. With the native shape a
  // still-servable id works, and a truly-retired id fails at the correct
  // provider with an accurate model-not-found message. The sibling's baseUrl is
  // borrowed verbatim — the `/v1` suffix munging below exists for the
  // custom-BYOK path only and is NOT applied here. An explicit baseUrl arg
  // (custom models + the ezcorp-mock test provider) and unknown providers keep
  // the legacy behavior.
  if (baseUrl === undefined) {
    const sibling = getModels(provider as KnownProvider)[0];
    if (sibling) {
      return {
        id: modelId,
        name: modelId,
        api: sibling.api,
        provider: provider as any,
        baseUrl: sibling.baseUrl,
        reasoning: false,
        input: ["text"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      };
    }
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
