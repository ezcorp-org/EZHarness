/**
 * Model registry backed by pi-ai's getModel()/getModels().
 * Replaces ~480 lines of CURATED_MODELS array and live API fetching.
 */

import { getModel, getModels, getProviders } from "@earendil-works/pi-ai/compat";
// `BuiltinProvider` (pi-ai 0.83.0) is the provider key those three catalog
// reads actually accept: `keyof typeof MODELS`. It is NOT `KnownProvider` —
// `radius` is a `KnownProvider` with no MODELS entry, so `BuiltinProvider` is
// `KnownProvider` minus `radius` and a `KnownProvider`-typed argument no
// longer type-checks. Upstream defect (still present in 0.84.0), but the
// narrower type is the correct one here: everything below is a catalog read.
// Every value we cast is a runtime-supplied provider STRING, so the cast was
// already the unchecked step — `getModel`/`getModels` are wrapped in try/catch
// or tolerate an unknown id by returning `[]`.
import type { BuiltinProvider } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { getSetting } from "../db/queries/settings";
// Tier vocabulary single source of truth (type-only — erased at build).
import type { RoutingTier } from "../runtime/tier-classifier";
// Tier ladder: the operator-configured "which model for this tier" list. The
// pure resolution logic lives in src/runtime/** so it is coverage-gated.
import {
  DEFAULT_TIER_LADDER,
  isBuiltinRouterProvider,
  resolveLadderEntry,
  type TierLadder,
} from "../runtime/routing/tier-ladder";
// Custom/local models as routing candidates. Pure (no DB) for the same
// coverage reason as tier-ladder — the caller passes the parsed setting in.
import {
  customModelsForProvider,
  parseCustomModelEntries,
  type CustomModelEntry,
} from "../runtime/routing/custom-models";
// Price-rate shape single source of truth (type-only — erased at build).
import type { ModelPrices } from "../runtime/usage/cache-stats";

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
    const piIds = new Set(getModels(provider as BuiltinProvider).map((m) => m.id));
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

  // Append user-defined custom models from settings. Normalization is shared
  // with tier ROUTING (`parseCustomModelEntries`) rather than re-inlined here:
  // the picker showing a row as `balanced`/`ollama` while the router computed
  // something else is exactly the class of bug that made custom models
  // invisible to routing in the first place.
  for (const entry of parseCustomModelEntries(await getSetting("provider:customModels"))) {
    entries.push(entry);
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
 * Best model for a provider at a tier: the TIER LADDER first, then the
 * alphabetical catalog scan.
 *
 * `ladder` is the operator-configured ladder (`provider:tierModels`, loaded by
 * `router.ts`'s getConfiguredTierLadder) — `undefined` when unset or
 * malformed. Consulted first because the scan is close to arbitrary: pi-ai
 * lists openrouter's 300+ models alphabetically, so it picks
 * `ai21/jamba-large-1.7` (balanced) or `amazon/nova-2-lite-v1` (fast).
 *
 * With no configured ladder the answer is what it was before the ladder
 * existed: the built-in ladder is consulted only for
 * `BUILTIN_ROUTER_PROVIDERS` (openrouter → `openrouter/auto`, the old
 * `PREFERRED_TIER_MODELS`), and everything else runs the scan below verbatim.
 * A ladder entry naming a model this provider's catalog does not list is
 * skipped in favour of the next entry, then the scan — so a stale ladder
 * degrades, never fails.
 *
 * `customModels` is the parsed `provider:customModels` setting (loaded once by
 * `router.ts` alongside the ladder). Consulting it here is what makes a
 * local-only install routable at all: `getModels("ollama")` is `[]`, so
 * without this every tier lookup for a local provider returned null and every
 * tier-routed turn — which is every workflow agent step — was unanswerable.
 *
 * PRECEDENCE IS DELIBERATE, and it is the whole safety argument. Custom
 * models enter at exactly two points, both of them AFTER the corresponding
 * built-in step:
 *   1. configured ladder over the CATALOG        (unchanged)
 *   2. built-in ladder over the CATALOG          (unchanged, openrouter only)
 *   3. configured ladder over CUSTOM MODELS      (new) — an operator naming a
 *      custom model in a rung is an explicit request for it, so it outranks
 *      the near-arbitrary alphabetical scan below, but never a rung or a
 *      built-in rung that already resolved.
 *   4. catalog tier scan                         (unchanged)
 *   5. custom tier scan                          (new) — last. Reached only
 *      when this provider's catalog has NOTHING in the tier, so a custom
 *      model can never displace or shadow a built-in one, and a deployment
 *      with no custom models routes byte-identically to before.
 */
export function findModelForProviderInTier(
  provider: string,
  tier: "fast" | "balanced" | "powerful",
  ladder?: TierLadder,
  customModels?: readonly CustomModelEntry[],
): ModelEntry | null {
  const models = getModels(provider as BuiltinProvider);
  const laddered =
    resolveLadderEntry(ladder, tier, provider, models) ??
    (isBuiltinRouterProvider(provider)
      ? resolveLadderEntry(DEFAULT_TIER_LADDER, tier, provider, models)
      : undefined);
  if (laddered) return piModelToEntry(laddered);

  const custom = customModelsForProvider(customModels ?? [], provider);
  const customLaddered = resolveLadderEntry(ladder, tier, provider, custom);
  if (customLaddered) return customLaddered;

  for (const model of models) {
    const entry = piModelToEntry(model);
    if (entry.tier === tier) return entry;
  }
  return custom.find((c) => c.tier === tier) ?? null;
}

/**
 * Tier pick that the CREDENTIAL can actually run.
 *
 * `findModelForProviderInTier` answers out of the API-key catalog. Under an
 * OAuth (subscription) credential most of that catalog is unreachable:
 * `resolveModelForCredential` throws for any openai/google model with no
 * subscription-eligible sibling. Routing that consulted only the catalog
 * therefore handed a ChatGPT-plan token `gpt-4` and failed at the first
 * call with 'Model "gpt-4" is not supported with openai OAuth' — a dead end
 * the user could not fix from the picker, because they never chose it.
 *
 * Filter to models that HAVE an OAuth sibling, prefer the requested tier,
 * and fall back to the catalog answer for providers with no OAuth variant
 * (where the swap is a documented no-op).
 */
export function findRunnableModelForProviderInTier(
  provider: string,
  tier: "fast" | "balanced" | "powerful",
  credType: "oauth" | "apikey",
  ladder?: TierLadder,
  customModels?: readonly CustomModelEntry[],
): ModelEntry | null {
  const oauthProvider = OAUTH_PROVIDER_MAP[provider];
  if (credType !== "oauth" || !oauthProvider) {
    // The custom/local path lands here: a local provider has no OAuth
    // variant, and its credential is the synthetic `no-key-needed` apikey
    // (providers/credentials.ts), so `credType` is never "oauth" for one.
    return findModelForProviderInTier(provider, tier, ladder, customModels);
  }

  const candidates: ModelEntry[] = [];
  for (const model of getModels(provider as BuiltinProvider)) {
    if (resolveOAuthModel(provider, model.id)) candidates.push(piModelToEntry(model));
  }
  // OAuth-only ids (e.g. gpt-5.5) live in LOCAL_OAUTH_OVERRIDES and never
  // appear in the api-key catalog above, so they must be added explicitly —
  // on a ChatGPT-plan deployment they are frequently the ONLY runnable
  // models, which is exactly the case this function exists to serve.
  for (const model of LOCAL_OAUTH_OVERRIDES) {
    if (model.provider === oauthProvider && !candidates.some((c) => c.id === model.id)) {
      candidates.push(piModelToEntry(model));
    }
  }
  // A configured ladder wins here too, but only over the SUBSCRIPTION-eligible
  // candidates gathered above: a rung naming a model this OAuth credential
  // cannot run is exactly the dead end this function exists to prevent, so it
  // is skipped like any other unavailable entry.
  return (
    resolveLadderEntry(ladder, tier, provider, candidates) ??
    candidates.find((c) => c.tier === tier) ??
    candidates[0] ??
    null
  );
}

/**
 * Mapping from user-facing providers to their OAuth-compatible pi-ai provider.
 * When OAuth is active, only models from the OAuth provider are supported
 * because the standard API endpoints require API key auth (not OAuth tokens).
 *
 * - google → google-gemini-cli (Cloud Code Assist API, Bearer token auth)
 * - openai → openai-codex (ChatGPT Codex API, different endpoint + scopes)
 */
const OAUTH_PROVIDER_MAP: Record<string, BuiltinProvider> = {
  google: "google-gemini-cli" as BuiltinProvider,
  openai: "openai-codex" as BuiltinProvider,
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
    const found = getModel(provider as BuiltinProvider, modelId as never);
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
    // getModels is wrapped: a malformed provider id can throw, and a throw
    // here must degrade to the legacy fallback below, not escape.
    let sibling: Model<any> | undefined;
    try {
      sibling = getModels(provider as BuiltinProvider)[0];
    } catch {
      // Unknown/malformed provider → no sibling; fall through to fallback.
    }
    // Only borrow the sibling's wire shape when its baseUrl is a concrete,
    // usable endpoint. Some catalog providers ship a PLACEHOLDER baseUrl that
    // pi-ai fills in per-request from credentials/config: azure-openai-responses
    // ("" ), google-vertex ("https://{location}-aiplatform.googleapis.com"),
    // cloudflare ("…{CLOUDFLARE_ACCOUNT_ID}…"). Borrowing an empty or
    // still-templated URL verbatim would synthesize a model that dials a broken
    // endpoint, so skip the borrow and fall through to the legacy fallback (a
    // non-templated default) instead.
    if (sibling && sibling.baseUrl && !sibling.baseUrl.includes("{")) {
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
    // A user-supplied baseUrl is a BYOK/local OpenAI-compatible server, and
    // pi-ai's `detectCompat` (api/openai-completions) sends the output cap as
    // `max_completion_tokens` for every baseUrl outside its short
    // known-gateway list. Ollama, llama.cpp, vLLM and LM Studio all IGNORE
    // that field and honour only `max_tokens`, so the declared cap was
    // silently unenforced against every custom model. Measured against a live
    // Ollama (qwen3:1.7b, identical request otherwise):
    //     max_tokens: 40            -> completion_tokens 40,   finish "length"
    //     max_completion_tokens: 40 -> completion_tokens 3694, finish "stop"
    // i.e. a 92x overrun of a limit the caller asked for — and ez-factory's
    // workflow templates treat that limit as a resume PREREQUISITE
    // (extensions/ez-factory/docs-factory.workflow.yaml).
    //
    // `compat` is pi-ai's own documented override for exactly this ("If not
    // set, auto-detected from baseUrl"), so this is a local override and NOT
    // an upstream change: detectCompat cannot know whether an arbitrary URL
    // is a local runtime or an OpenAI endpoint — the operator who typed it
    // does.
    //
    // Applied ONLY when a baseUrl was actually supplied. Falling through to
    // the `https://api.openai.com/v1` default above must keep pi-ai's
    // detection: OpenAI's own newer models REJECT `max_tokens` and require
    // `max_completion_tokens`, so forcing it there would break the fallback.
    ...(baseUrl !== undefined
      ? { compat: { maxTokensField: "max_tokens" as const } }
      : {}),
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

/**
 * USD-per-1M-token rates for a provider+model — a thin LOOKUP over
 * `resolveModelObject` so OAuth overrides, retired pins and unknown providers
 * resolve exactly as they do everywhere else. Deliberately does NO arithmetic
 * and makes NO judgement about the numbers: `src/providers/**` is outside the
 * coverage gate, so all cost math (and the "is this model priced at all?"
 * decision) lives in `priceSegment` in src/runtime/usage/cache-stats.ts.
 *
 * Models `resolveModelObject` has to synthesize — and every OAuth-subscription
 * model, which is rate-limited rather than billed per token — carry all-zero
 * rates, which `priceSegment` reports as UNPRICED rather than as "$0.00".
 */
export function modelPrices(provider: string, modelId: string): ModelPrices {
  return resolveModelObject(provider, modelId).cost;
}
