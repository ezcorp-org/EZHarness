/**
 * Provider routing with fallback suggestions.
 */

import type { AnyModel } from "./model-types";
import {
  resolveModelObject,
  findModelForProviderInTier,
  findRunnableModelForProviderInTier,
  isKnownCatalogModel,
  resolveDiscoveredModel,
} from "./registry";
// Catalog-gap reporting. The decision + dedup are pure and live under
// runtime/routing so they are coverage-gated; this module owns the memo and
// the log call.
import { reportCatalogGapOnce } from "../runtime/routing/dropped-models";
import { logger } from "../logger";

const log = logger.child("providers.router");

/** Process-wide memo so a retired pin warns ONCE, not once per turn. The
 *  once-only property is tested on the pure `reportCatalogGapOnce` (which
 *  takes the Set), so this needs no reset hook. */
const reportedCatalogGaps = new Set<string>();
import { getCircuitBreaker } from "./circuit-breaker";
import { tryGetCredential } from "./credentials";
import { getSetting } from "../db/queries/settings";
import { isTestSurfaceEnabled, MOCK_PROVIDER, mockLlmBaseUrl } from "../test-surface";
// Tier vocabulary lives in the pure routing classifier (single source of
// truth). Type-only import — erased at build, so it adds no runtime dep.
import type { RoutingTier } from "../runtime/tier-classifier";
import {
  parseTierLadder,
  TIER_LADDER_SETTING_KEY,
  type TierLadder,
} from "../runtime/routing/tier-ladder";
import {
  parseCustomModelEntries,
  providersWithCustomModels,
  type CustomModelEntry,
} from "../runtime/routing/custom-models";
import { hasKeylessFreeTier, LLM_PROVIDER_IDS } from "../runtime/routing/llm-providers";
import { kiloRoutingEntries } from "./kilo";
// `src/types.ts` has no imports of its own, so this cannot cycle.
import { CURRENT_MODEL_SENTINEL } from "../types";

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

const DEFAULT_PREFERENCE_ORDER = LLM_PROVIDER_IDS;
const DEFAULT_TIER: TierName = "balanced";

/** The onboarding wizard historically stored `provider:defaultTier` as
 *  quality/budget; the router vocabulary is fast/balanced/powerful. Accept
 *  the legacy values at read time so stored settings keep their intent. */
const TIER_ALIASES: Record<string, TierName> = { quality: "powerful", budget: "fast" };

/** Configured default routing tier (`provider:defaultTier` setting, falling
 *  back to "balanced"). Exported so the stream-chat wiring can label a turn
 *  whose tier classification failed with the same tier `resolveModel` used. */
export async function getDefaultTier(): Promise<TierName> {
  const tier = await getSetting("provider:defaultTier");
  if (tier && typeof tier === "string") {
    if (["fast", "balanced", "powerful"].includes(tier)) return tier as TierName;
    if (TIER_ALIASES[tier]) return TIER_ALIASES[tier];
  }
  return DEFAULT_TIER;
}

/**
 * The operator-configured tier ladder (`provider:tierModels`), or `undefined`
 * when unset OR malformed — routing then keeps its pre-ladder behaviour rather
 * than failing a turn (see `runtime/routing/tier-ladder.ts`). Deliberately
 * returns undefined instead of the built-in default: the registry applies the
 * built-in itself, and only for the providers whose built-in rung was already
 * in force, so an unconfigured deployment routes exactly as before.
 */
export async function getConfiguredTierLadder(): Promise<TierLadder | undefined> {
  return parseTierLadder(await getSetting(TIER_LADDER_SETTING_KEY));
}

/**
 * The operator's custom/local models (`provider:customModels`), normalized.
 * Loaded once per routing decision and threaded into the registry's tier
 * lookup — see `findModelForProviderInTier`'s precedence note for why they
 * are consulted only after the pi-ai catalog.
 */
export async function getCustomModelEntries(): Promise<CustomModelEntry[]> {
  return parseCustomModelEntries(await getSetting("provider:customModels"));
}

/**
 * Every routable model pi-ai's static catalog does NOT list: the operator's
 * custom/local rows, plus Kilo's.
 *
 * They share one channel because they are the same problem. `getModels(p)` is
 * `[]` for both `ollama` and `kilo`, so tier routing can only reach either by
 * being handed the models explicitly — which is precisely what
 * `custom-models.ts` was built for and what `findModelForProviderInTier`'s
 * `customModels` parameter already accepts. Threading Kilo through a second,
 * parallel parameter would duplicate that plumbing (and its precedence rules)
 * for no gain.
 *
 * Order matters and is deliberate: custom models FIRST. Both lists are
 * consulted only after the pi-ai catalog is exhausted, so neither can shadow a
 * built-in model — but an operator's own registered model should outrank a
 * third-party gateway's.
 *
 * Kilo's rows arrive access-filtered (free-only until a key is saved) and may
 * repeat `kilo-auto/free` across tiers; see `kiloRoutingEntries`.
 */
export async function getRoutableOverlayModels(): Promise<CustomModelEntry[]> {
  const [custom, kilo] = await Promise.all([getCustomModelEntries(), kiloRoutingEntries()]);
  return [...custom, ...kilo];
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

async function getPreferenceOrder(customModels: readonly CustomModelEntry[]): Promise<string[]> {
  const order = await getSetting("provider:preferenceOrder");
  const stored = Array.isArray(order) && order.length > 0 ? (order as string[]) : null;
  const base = stored ? mergePreferenceOrder(stored) : DEFAULT_PREFERENCE_ORDER;
  // A local provider (`ollama`, or whatever the operator named their custom
  // endpoint) is in NEITHER the stored order nor DEFAULT_PREFERENCE_ORDER, so
  // Level 3 below never even asked it for a model — a local-only deployment
  // fell straight through to "No available providers with credentials". They
  // go at the very END: a provider reached here is one every cloud provider
  // ahead of it was already skipped for, so this can only ADD an answer where
  // there was none, never re-route a deployment that has cloud credentials.
  const withCustom = mergePreferenceOrder([...base], providersWithCustomModels(customModels));

  // …except a KEYLESS-FREE provider, which goes after even those.
  //
  // Kilo authenticates with nothing configured, so on any deployment it would
  // otherwise outrank the operator's own local endpoint — a local-only install
  // that added an Ollama model would silently start sending prompts to a
  // third-party gateway. That is not merely surprising: Kilo marks its free
  // pool `mayTrainOnYourPrompts`, so it is a privacy regression, and it is
  // invisible because both paths "work".
  //
  // Demoted ONLY when the operator did not order it themselves. An admin who
  // explicitly puts `kilo` in `provider:preferenceOrder` has made a choice, and
  // this must not quietly override it — the demotion exists for the APPENDED
  // case (self-healed default), which is the only way kilo can arrive here
  // without anyone asking for it.
  const explicitlyOrdered = new Set(stored ?? []);
  const demoted = (p: string) => hasKeylessFreeTier(p) && !explicitlyOrdered.has(p);
  return [...withCustom.filter((p) => !demoted(p)), ...withCustom.filter(demoted)];
}

// ── Model Resolution ─────────────────────────────────────────────────

export async function resolveModel(
  rawProvider?: string,
  rawModelId?: string,
  requestedTier?: RoutingTier,
  // Circuit-breaker credential scope (the acting user's id). Defaults to
  // the process-wide "shared" breaker so context-free callers are
  // behavior-identical to the old provider-only keying.
  credentialScope = "shared",
): Promise<{ provider: string; model: string; piModel: AnyModel }> {
  // ── `__current__` IS AN INHERIT SENTINEL, NOT A PROVIDER ID ────────
  //
  // `CURRENT_MODEL_SENTINEL` means "use whatever model is in force", and
  // the ONE place that ever substituted it (`runtime/start-assignment.ts`)
  // reads the parent CONVERSATION. Anything with no conversation to inherit
  // from — every `agent` step in every workflow — therefore handed the
  // sentinel straight down: Level 1 below saw two truthy strings, took the
  // pinned passthrough, and `getCredential("__current__")` died with
  // `No credentials available for __current__`.
  //
  // That is not a niche path. Every config-based agent stored with the
  // sentinel (`ez-factory extractor|writer|validator`, `ez-code coder`) is
  // unrunnable from a workflow because of it, which is exactly the shape
  // the shipped ez-factory templates take: they bind `effort`/`maxTokens`
  // only and deliberately leave each agent's own binding standing, on the
  // documented promise that it means "whatever the operator configured".
  //
  // Resolving it HERE and not in `createPiLlmAdapter` is deliberate and
  // pinned by `src/__tests__/pi-llm-adapter-model-override.test.ts` — "the
  // agent-config inherit sentinel is the router's problem, not the
  // adapter's". Collapsing to `undefined` reproduces exactly what
  // `start-assignment.ts` does when its fallback is absent (`value ===
  // CURRENT_MODEL_SENTINEL ? fallback : value ?? undefined`), so the two
  // resolution sites agree instead of disagreeing.
  //
  // Half a sentinel is normalised the same way: `{provider: "__current__",
  // model: "gpt-5"}` becomes a provider-less pin and falls to Level 3's
  // credential-aware pick rather than searching for a provider named
  // `__current__`.
  const provider = rawProvider === CURRENT_MODEL_SENTINEL ? undefined : rawProvider;
  const modelId = rawModelId === CURRENT_MODEL_SENTINEL ? undefined : rawModelId;

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
      return {
        provider,
        model: modelId,
        piModel: resolveModelObject(provider, modelId, mockLlmBaseUrl()),
      };
    }
    // Prefer a model discovered via /api/providers/:provider/refresh-models — it carries
    // the correct api + baseUrl for provider-native calls (e.g. openai-responses for gpt-5.x).
    const discovered = await resolveDiscoveredModel(provider, modelId);
    if (discovered) {
      return { provider, model: modelId, piModel: discovered };
    }
    // Look up custom model's baseUrl so resolveModelObject can set the correct endpoint
    // Raw stored rows, not `CustomModelEntry`: this reads the setting straight
    // rather than through `parseCustomModelEntries`, so it must tolerate both
    // the `id` and the legacy `modelId` spelling — which is the only reason
    // the shape is stated here instead of imported.
    const customModels = (await getSetting("provider:customModels")) as
      | Array<{
          id?: string;
          modelId?: string;
          provider?: string;
          baseUrl?: string;
          contextWindow?: number;
        }>
      | undefined;
    const custom = customModels?.find(
      (m) => (m.id ?? m.modelId) === modelId && m.provider === provider,
    );
    // NAME A RETIRED PIN. This is the branch that honours an explicit
    // provider+model pin, so it is the one place where a user's saved model
    // choice meets the installed catalog. A pi-ai upgrade can retire an id
    // (0.80.6 → 0.83.0 retired 18 across the four providers EZCorp ships) and
    // the failure is SILENT: resolveModelObject synthesizes a stand-in with a
    // guessed 128k window and an all-zero rate table, so the thread is
    // compacted harder and spend reports as unmeasured, with no error until
    // the provider itself rejects the id — if it rejects it at all.
    //
    // Deliberately a log and not a throw: a retired catalog id is frequently
    // still servable, and hard-failing here would break working
    // conversations to make a bookkeeping point. Deduped per process by
    // `warnCatalogGapOnce`, because a pinned conversation resolves its model
    // on every single turn.
    const gapMessage = reportCatalogGapOnce(
      { provider, modelId, source: "conversation pin" },
      isKnownCatalogModel,
      reportedCatalogGaps,
      !!custom?.baseUrl,
    );
    if (gapMessage) log.warn(gapMessage, { provider, modelId });
    return {
      provider,
      model: modelId,
      piModel: resolveModelObject(provider, modelId, custom?.baseUrl, custom?.contextWindow),
    };
  }

  // Past the pinned-passthrough level, every remaining branch picks a model
  // for a tier — so the ladder and the custom-model list are loaded once,
  // here, and never on the pinned hot path above.
  const ladder = await getConfiguredTierLadder();
  const customModels = await getRoutableOverlayModels();

  // Level 2: Provider only -- find best model in default tier
  if (provider) {
    const entry = findModelForProviderInTier(provider, tier, ladder, customModels);
    if (entry) {
      // `entry.baseUrl` is set ONLY for a custom/local model; a catalog entry
      // leaves it undefined, which is the exact argument this call passed
      // before. Forwarding it is what makes a tier-ROUTED local model dial
      // its own endpoint instead of api.openai.com — the pinned Level-1 path
      // above already did this lookup, and the two now agree.
      return {
        provider,
        model: entry.id,
        // `entry.contextWindow` is the number the PICKER shows for this model.
        // Forwarding it is what keeps the compaction budget derived from the
        // same window the user is looking at — a catalog entry ignores it
        // (the catalog lookup wins), a custom or Kilo-discovered entry is the
        // only reason it is not already correct.
        piModel: resolveModelObject(provider, entry.id, entry.baseUrl, entry.contextWindow),
      };
    }
    // Fallback to the first model for this provider
    return { provider, model: provider, piModel: resolveModelObject(provider, provider) };
  }

  // Level 3: No provider -- iterate preference order, skipping providers
  // with an open circuit breaker, no model in the tier, or NO USABLE
  // CREDENTIAL.
  //
  // The credential check is what makes this branch honest. Having a model
  // in the tier says nothing about being able to CALL it: with the default
  // order below, a deployment that connected only OpenAI still resolved
  // every unpinned turn to `anthropic` (first in the order, and it always
  // has catalog models), then threw "No credentials available for
  // anthropic" from getCredential — while the model picker showed a
  // ChatGPT model. This branch runs whenever no provider is pinned, which
  // includes Auto-routing turns and any conversation whose row carries a
  // null provider, so the failure looked like it came from whatever the
  // user happened to be doing at the time.
  //
  // Cost is bounded: at most one probe per provider, short-circuited at
  // the first usable one, and the probe for the WINNER is the same lookup
  // the caller performs moments later.
  const order = await getPreferenceOrder(customModels);
  let skippedForCredentials: string | null = null;
  for (const p of order) {
    const cb = getCircuitBreaker(p, credentialScope);
    if (cb.isOpen()) continue;

    const cred = await tryGetCredential(p);
    if (!cred) {
      skippedForCredentials ??= p;
      continue;
    }

    // The credential's TYPE narrows the catalog: an OAuth token can only
    // serve subscription-eligible models. Picking from the api-key catalog
    // here is how a ChatGPT-plan deployment ended up pinned to `gpt-4`.
    const entry = findRunnableModelForProviderInTier(p, tier, cred.type, ladder, customModels);
    if (!entry) continue;

    // See Level 2: baseUrl is undefined for every catalog entry, set only
    // for a custom/local one.
    return {
      provider: p,
      model: entry.id,
      // See Level 2 — the picker's window and the trim point stay the same number.
      piModel: resolveModelObject(p, entry.id, entry.baseUrl, entry.contextWindow),
    };
  }

  // Name the real constraint. "No available providers" sent people looking
  // for a routing/catalog problem when the answer was "connect a provider".
  throw new Error(
    skippedForCredentials
      ? `No available providers with credentials (tier "${tier}"). ` +
          `Connect a provider via OAuth or add an API key — e.g. ${skippedForCredentials}.`
      : "No available providers",
  );
}

// ── Fallback suggestion ──────────────────────────────────────────────

export async function suggestFallback(
  failedProvider: string,
  tier: string,
  // Circuit-breaker credential scope (the acting user's id) — see
  // resolveModel. Default keeps context-free callers behavior-identical.
  credentialScope = "shared",
): Promise<FallbackSuggestion | null> {
  const ladder = await getConfiguredTierLadder();
  const customModels = await getRoutableOverlayModels();
  const order = await getPreferenceOrder(customModels);

  for (const provider of order) {
    if (provider === failedProvider) continue;

    const cb = getCircuitBreaker(provider, credentialScope);
    if (cb.isOpen()) continue;

    // Same rule as resolveModel's Level 3: a provider we cannot
    // authenticate is not a fallback. Suggesting one turns a recoverable
    // provider error into a second, more confusing credentials error, and
    // the user is shown a "try X instead" that could never have worked.
    const cred = await tryGetCredential(provider);
    if (!cred) continue;

    const entry = findRunnableModelForProviderInTier(
      provider,
      tier as TierName,
      cred.type,
      ladder,
      customModels,
    );
    if (!entry) continue;

    return { provider, model: entry.id, tier };
  }

  return null;
}
