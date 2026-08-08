/**
 * The Kilo AI Gateway catalog — parsing, free/paid classification, and the two
 * projections routing and the picker each need.
 *
 * Kilo is an OpenAI-compatible gateway in front of ~350 models. Two facts about
 * it drive everything in this module, and both were measured against the live
 * API rather than read off a docs page:
 *
 *   1. **Its free models answer with no credential at all.** An anonymous
 *      `POST /api/gateway/chat/completions` for `kilo-auto/free` returns HTTP
 *      200 with `cost: "0"`; the same call for `anthropic/claude-sonnet-5`
 *      returns HTTP 401 `PAID_MODEL_AUTH_REQUIRED`. So "connected" is not a
 *      precondition for routing to Kilo — but "free" is, until a key is saved.
 *   2. **pi-ai has no `kilo` provider.** `getModels("kilo")` is `[]`, exactly
 *      like `getModels("ollama")`, so every Kilo model reaches routing through
 *      the same overlay mechanism `./custom-models` built for local models.
 *
 * ── Why free-vs-paid is enforced by CONSTRUCTION ──
 * {@link kiloModelsForAccess} filters the catalog before it reaches either the
 * picker or the router. A keyless deployment therefore has no paid Kilo model
 * to show OR to route to — the restriction is not a check someone can forget to
 * call at a fourth call site. (A hand-crafted API request can still pin a paid
 * id; Kilo's own 401 names that case better than we could.)
 *
 * ── Purity (why this lives in src/runtime, not src/providers) ──
 * Same rationale as `./tier-ladder`, `./custom-models` and `./llm-providers`:
 * `src/providers/**` is excluded from the coverage gate, and "which model may
 * this deployment call" is a routing decision that must be coverage-enforced.
 * No DB, no pi-ai, no network — the caller passes the fetched payload in.
 *
 * ── Failure posture ──
 * Identical to its siblings: a malformed row is DROPPED, never thrown on. The
 * catalog is third-party JSON fetched at runtime; a shape change upstream must
 * degrade to "fewer Kilo models" (and, at worst, back to the built-in seed),
 * never to a failed turn.
 */

import { type RoutingTier, isRoutingTier } from "../tier-classifier";

/** Gateway root. pi-ai's openai-completions client appends
 *  `/chat/completions`, so this is the path WITHOUT that suffix. */
export const KILO_BASE_URL = "https://api.kilo.ai/api/gateway";

/** Catalog endpoint. Deliberately unauthenticated upstream — a keyless
 *  deployment must be able to learn which models it may call. */
export const KILO_MODELS_URL = `${KILO_BASE_URL}/models`;

/** Kilo's server-side router over the free pool. A stable id whose backing
 *  models Kilo rotates, which is exactly why it is the seed's anchor: a
 *  hardcoded `vendor/model:free` list goes stale, this one cannot. */
export const KILO_FREE_AUTO_MODEL = "kilo-auto/free";

/**
 * What this deployment is allowed to call.
 *
 * `"free"` = no usable Kilo API key, so only the free pool. `"full"` = a key is
 * configured, so the whole catalog.
 */
export type KiloAccess = "free" | "full";

/** `"full"` iff a Kilo API key is configured. The one place the mapping from
 *  "has a key" to "may call paid models" is written down. */
export function kiloAccessForKey(hasKey: boolean): KiloAccess {
  return hasKey ? "full" : "free";
}

/**
 * A Kilo model, rich enough to build BOTH a picker `ModelEntry` and a pi-ai
 * `AnyModel` from without a second lookup.
 *
 * `cost` is in the repo-wide convention — USD per 1M tokens. Kilo's wire
 * format is USD per token as a decimal STRING, so {@link parseKiloCatalog}
 * does that conversion once, here, rather than at each consumer.
 */
export interface KiloModel {
  id: string;
  /** Display name, e.g. "NVIDIA: Nemotron 3 Ultra (free)". */
  name: string;
  contextWindow: number;
  maxTokens: number;
  vision: boolean;
  reasoning: boolean;
  /** USD per 1M tokens. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Callable with no credential. Read from the payload's `isFree`, never guessed. */
  free: boolean;
  /**
   * Declared quality class, when the model IS one (the `kilo-auto/*` routers).
   * Absent for ordinary models, whose tier the caller infers from price the
   * same way it does for every other provider.
   */
  declaredTier?: RoutingTier;
}

/**
 * Quality class of each `kilo-auto/*` router, declared rather than inferred.
 *
 * These ids carry no price signal worth tiering on — `frontier` blends to
 * $30/1M, which the cost heuristic reads as "medium" and would file under
 * `balanced`, and `free` blends to $0, which reads as "low"/`fast`. Their whole
 * purpose is to BE a quality class, so the mapping is stated.
 *
 * `kilo-auto/free` sits at `balanced` deliberately: it is the default a keyless
 * deployment lands on, and `balanced` is the router's own default tier.
 */
export const KILO_AUTO_TIERS: Readonly<Record<string, RoutingTier>> = {
  "kilo-auto/frontier": "powerful",
  "kilo-auto/balanced": "balanced",
  "kilo-auto/efficient": "balanced",
  "kilo-auto/small": "fast",
  [KILO_FREE_AUTO_MODEL]: "balanced",
};

/**
 * Free-ness of an id we hold no metadata for — a pinned model, or a catalog row
 * that failed to parse.
 *
 * Deliberately NOT the primary test: {@link parseKiloCatalog} reads the
 * payload's explicit `isFree` flag, because the naming rule has a known false
 * negative (`openrouter/free`, a free router whose id has no `:free` suffix).
 * This is the best answer available when there is no row to consult, and it is
 * conservative in the safe direction — an unrecognised id reads as paid.
 */
export function isFreeKiloModelId(id: string): boolean {
  return id === KILO_FREE_AUTO_MODEL || id.endsWith(":free");
}

// ── Wire payload parsing ─────────────────────────────────────────────
// Only the fields consumed are described. Everything is optional at the type
// level because this is third-party JSON: the parser proves each field rather
// than trusting the annotation.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Kilo prices in USD per token, as a decimal string. `undefined`/garbage → 0,
 *  which the repo reports as UNPRICED rather than as "$0.00". */
function perMillion(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n * 1_000_000;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Context window assumed for a row that omits one — the same 128k stand-in
 *  `resolveModelObject` synthesizes, so a Kilo gap reads like every other gap. */
export const KILO_DEFAULT_CONTEXT = 128_000;

/** Output cap assumed for a row that omits one. */
export const KILO_DEFAULT_MAX_TOKENS = 8_192;

/**
 * Chat-shaped filter, matching `model-discovery.ts`'s. Kilo's catalog carries
 * image and audio generation models (`google/lyria-3-pro-preview` and friends)
 * that cannot serve a chat turn.
 */
function isChatCapable(id: string, outputModalities: readonly string[]): boolean {
  if (outputModalities.length > 0 && !outputModalities.includes("text")) return false;
  return !/embedding|whisper|tts|moderation|dall-e|image-gen|audio-preview|lyria/.test(id.toLowerCase());
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Is this row one WE persisted (a pi-ai `AnyModel` + `free`) rather than a row
 * off the gateway wire?
 *
 * Both shapes reach {@link normalizeKiloModel}, and they are not
 * interchangeable: the wire says `context_length` / `pricing.prompt` /
 * `architecture.input_modalities`, ours says `contextWindow` / `cost.input` /
 * `input`. Reading a persisted row with the wire parser silently produced a
 * DEFAULTED model — measured on a real round-trip, a 1M-context vision
 * reasoning model came back as 128k, no vision, no reasoning, and
 * `openrouter/free` came back **paid**, which hides a genuinely free model from
 * the deployment that most needs it.
 *
 * That path is not hypothetical: `POST /api/providers/kilo/refresh-models`
 * persists exactly this shape, so every admin who pressed "Refresh models"
 * degraded their own catalog.
 */
function isPersistedShape(raw: Record<string, unknown>): boolean {
  return (
    typeof raw.contextWindow === "number" ||
    isPlainObject(raw.cost) ||
    Array.isArray(raw.input)
  );
}

/** Normalize a row WE wrote (`kiloModelToAnyModel` output + `free`). */
function normalizePersistedKiloModel(raw: Record<string, unknown>, id: string): KiloModel {
  const cost = isPlainObject(raw.cost) ? raw.cost : {};
  const input = stringArray(raw.input);
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : id,
    contextWindow: positiveInt(raw.contextWindow, KILO_DEFAULT_CONTEXT),
    maxTokens: positiveInt(raw.maxTokens, KILO_DEFAULT_MAX_TOKENS),
    vision: input.includes("image"),
    reasoning: raw.reasoning === true,
    // Already per-1M — persisted rows are written post-conversion, so they must
    // NOT be multiplied again.
    cost: {
      input: num(cost.input),
      output: num(cost.output),
      cacheRead: num(cost.cacheRead),
      cacheWrite: num(cost.cacheWrite),
    },
    free: typeof raw.free === "boolean" ? raw.free : isFreeKiloModelId(id),
    declaredTier: isRoutingTier(KILO_AUTO_TIERS[id]) ? KILO_AUTO_TIERS[id] : undefined,
  };
}

/**
 * Normalize ONE row — from the gateway wire OR from our own persisted cache —
 * or `null` when it cannot be called.
 */
export function normalizeKiloModel(raw: unknown): KiloModel | null {
  if (!isPlainObject(raw)) return null;
  const id = raw.id;
  if (typeof id !== "string" || id.trim() === "") return null;

  if (isPersistedShape(raw)) {
    // Chat-capability still applies: a persisted row for a non-chat model
    // should not come back into the picker.
    return isChatCapable(id, []) ? normalizePersistedKiloModel(raw, id) : null;
  }

  const architecture = isPlainObject(raw.architecture) ? raw.architecture : {};
  const inputs = stringArray(architecture.input_modalities);
  const outputs = stringArray(architecture.output_modalities);
  if (!isChatCapable(id, outputs)) return null;

  const topProvider = isPlainObject(raw.top_provider) ? raw.top_provider : {};
  const pricing = isPlainObject(raw.pricing) ? raw.pricing : {};
  const supported = stringArray(raw.supported_parameters);

  const contextWindow = positiveInt(
    raw.context_length,
    positiveInt(topProvider.context_length, KILO_DEFAULT_CONTEXT),
  );

  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : id,
    contextWindow,
    // Kilo omits `max_completion_tokens` on many rows. Falling back to the
    // context window would let a request ask for an output cap larger than the
    // model can produce, so take the documented default instead.
    maxTokens: positiveInt(topProvider.max_completion_tokens, KILO_DEFAULT_MAX_TOKENS),
    vision: inputs.includes("image"),
    reasoning: supported.includes("reasoning") || supported.includes("include_reasoning"),
    cost: {
      input: perMillion(pricing.prompt),
      output: perMillion(pricing.completion),
      cacheRead: perMillion(pricing.input_cache_read),
      cacheWrite: perMillion(pricing.input_cache_write),
    },
    // The payload's explicit flag is authoritative. The id-shape rule is only
    // the fallback for a row that omits it — see isFreeKiloModelId.
    free: typeof raw.isFree === "boolean" ? raw.isFree : isFreeKiloModelId(id),
    declaredTier: isRoutingTier(KILO_AUTO_TIERS[id]) ? KILO_AUTO_TIERS[id] : undefined,
  };
}

/**
 * Tolerant READ of a whole `GET /api/gateway/models` response.
 *
 * Accepts the documented `{ data: [...] }` envelope and a bare array, because
 * OpenAI-shaped list endpoints appear in the wild as both. Anything else yields
 * an empty list, which every consumer treats as "discovery found nothing" and
 * falls back to the built-in seed.
 */
export function parseKiloCatalog(payload: unknown): KiloModel[] {
  const rows = Array.isArray(payload)
    ? payload
    : isPlainObject(payload) && Array.isArray(payload.data)
      ? payload.data
      : [];
  const out: KiloModel[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const model = normalizeKiloModel(raw);
    // Kilo's catalog is stable but third-party; a duplicate id would render
    // twice in the picker and make the routing pick order-dependent.
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

// ── Access projections ───────────────────────────────────────────────

/**
 * The models this deployment may call, in catalog order.
 *
 * The whole free/paid enforcement, in one function: `"free"` access keeps only
 * rows the gateway serves anonymously. Callers get a list they can hand
 * straight to the picker or the router without re-checking anything.
 */
export function kiloModelsForAccess(
  models: readonly KiloModel[],
  access: KiloAccess,
): KiloModel[] {
  return access === "full" ? [...models] : models.filter((m) => m.free);
}

/**
 * Merge the built-in seed with a discovered catalog, discovery winning.
 *
 * Discovery is fresher (it is the live gateway) but optional — an admin may
 * never press "Refresh models", and a keyless deployment has no admin action to
 * wait on. So the seed is always present as a floor, and any id discovery also
 * returns is replaced by the discovered row. Seed order is preserved so the
 * `kilo-auto/*` routers stay at the front of the picker, where they belong.
 */
export function mergeKiloCatalog(
  seed: readonly KiloModel[],
  discovered: readonly KiloModel[],
): KiloModel[] {
  const byId = new Map(discovered.map((m) => [m.id, m]));
  const out: KiloModel[] = seed.map((m) => byId.get(m.id) ?? m);
  const seedIds = new Set(seed.map((m) => m.id));
  for (const m of discovered) {
    if (!seedIds.has(m.id)) out.push(m);
  }
  return out;
}

/**
 * Which tiers a set of models leaves EMPTY.
 *
 * Routing asks a provider for a model at a specific tier and moves on to the
 * next provider when there is none. That is fine for a provider with a full
 * catalog and fatal for a keyless Kilo deployment: with only the seed, `free`
 * access yields exactly one model (`kilo-auto/free`, at `balanced`), so the
 * first tool-using turn — which the classifier sends to `powerful` — finds
 * nothing and the whole deployment reports "No available providers".
 *
 * See {@link kiloRoutingFill} for what is done about it.
 */
export function emptyKiloTiers(tiers: readonly RoutingTier[]): RoutingTier[] {
  const present = new Set(tiers);
  return (["fast", "balanced", "powerful"] as const).filter((t) => !present.has(t));
}

/**
 * The extra ROUTING-only rungs that make a free Kilo deployment answerable at
 * every tier: `kilo-auto/free` repeated into each tier nothing else covers.
 *
 * This is not a fudge — `kilo-auto/free` is a server-side router across the
 * whole free pool, so it genuinely does serve any tier asked of it, and Kilo
 * updates what sits behind it as availability shifts. Repeating it is how a
 * one-model-per-tier lookup expresses "this model answers for all of them".
 *
 * Deliberately ROUTING-only. The picker projection must never show one id three
 * times, and a real free model always wins the tier it actually occupies
 * because the fill only covers tiers left empty.
 */
export function kiloRoutingFill(
  models: readonly KiloModel[],
  tiersInUse: readonly RoutingTier[],
): KiloModel[] {
  const router = models.find((m) => m.id === KILO_FREE_AUTO_MODEL);
  if (!router) return [];
  return emptyKiloTiers(tiersInUse).map((tier) => ({ ...router, declaredTier: tier }));
}
