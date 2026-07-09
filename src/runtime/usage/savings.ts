/**
 * Prompt-cache + model-routing SAVINGS math (analytics workstream C1).
 *
 * PURE functions only — no I/O (the one import below is type-only, erased at
 * build). Mirrors the sibling cache-stats.ts style: callers hand in per-turn
 * token usage (as persisted in `messages.usage`) plus $/1M `Model.cost`
 * pricing, and this module computes what caching/routing saved (or COST — a
 * negative number is a truthful answer here, never clamped).
 *
 * Pricing ground truth (pi-ai models.js `calculateCost`):
 *
 *   cost.cacheWrite = the 5-MINUTE cache-write price per 1M tokens;
 *   1h-retention writes bill at 2 × cost.input (hardcoded in pi-ai) —
 *   `computeServedCostUsd` replicates that exact algebra and is cross-checked
 *   against pi-ai's exported `calculateCost` by unit test so it cannot drift.
 *
 * Per-row cache savings, with ip/rp/wp = cost.input/cacheRead/cacheWrite,
 * long = cacheWrite1hTokens ?? 0, short = (cacheWriteTokens ?? 0) − long:
 *
 *   readSavedUsd        = cacheReadTokens × (ip − rp) / 1e6
 *   write5mSurchargeUsd = short × (wp − ip) / 1e6      (premium over base input)
 *   write1hPremiumUsd   = long × ip / 1e6              (the 2×ip − ip slice)
 *   cacheSavedUsd       = readSavedUsd − write5mSurchargeUsd − write1hPremiumUsd
 *
 * Routing savings apply ONLY to turns that were actually routed
 * (`requestedModel === null` — the user pinned nothing — AND a `routedTier`
 * was recorded): counterfactual cost (the balanced-tier peer the default
 * router would have picked) minus served cost, over the SAME token mix.
 * `routedTier === "balanced"` ⇒ 0 by definition (the counterfactual IS the
 * served tier). All-zero / missing `Model.cost` (custom or unknown models)
 * contributes 0 — graceful, never NaN.
 */

// Tier vocabulary single source of truth (type-only — erased at build).
import type { RoutingTier } from "../tier-classifier";

/** The subset of pi-ai `Model.cost` this module needs ($ per 1M tokens). */
export interface ModelCostLike {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache-write price. The 1h write price is 2 × `input` (pi-ai). */
  cacheWrite: number;
}

/** The subset of the persisted `messages.usage` JSONB this module needs.
 *  Fields are optional so legacy rows (pre-cache-meter) pass through — a
 *  missing field contributes 0 tokens, and rows with NO cache fields at all
 *  are excluded from hit-rate (see `aggregateSavings`). */
export interface SavingsUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Subset of cacheWriteTokens written with 1h retention (billed 2× input). */
  cacheWrite1hTokens?: number;
  /** Only used for cache-eligibility detection — never re-derived from it. */
  cacheHitRate?: number;
}

/** Per-row cache-savings breakdown (all USD; negative net allowed). */
export interface RowCacheSavings {
  readSavedUsd: number;
  write5mSurchargeUsd: number;
  write1hPremiumUsd: number;
  /** Net = readSaved − write5mSurcharge − write1hPremium. NEGATIVE when the
   *  write premiums dominate (the audit's honest-cost point). */
  cacheSavedUsd: number;
}

/** One assistant turn, priced and tagged, ready for aggregation. */
export interface SavingsTurnInput {
  /** SERVED provider/model (the messages.provider/model text columns). */
  provider: string;
  model: string;
  usage: SavingsUsageLike;
  /** User pin at request time; null ⇒ Auto/routed; undefined ⇒ legacy row. */
  requestedModel?: string | null;
  /** Tier the router selected — only present when routing fired. */
  routedTier?: RoutingTier;
  /** True when the served provider ≠ the initially resolved provider. */
  failover?: boolean;
  /** $/1M cost of the SERVED model; null/all-zero ⇒ $ figures contribute 0. */
  servedCost: ModelCostLike | null;
  /** $/1M cost of the balanced-tier counterfactual for routed turns;
   *  null when unresolvable (⇒ routing savings contribute 0). */
  counterfactualCost: ModelCostLike | null;
}

/** Aggregate stats across all turns (the API `stats` block). */
export interface SavingsStats {
  /** Net cache $ = Σ readSaved − Σ writeSurcharges. NEGATIVE allowed. */
  cacheSavedUsd: number;
  cacheReadSavedUsd: number;
  /** Total 5m + 1h write premium paid (≥0 for all real price sheets). */
  cacheWriteSurchargeUsd: number;
  /** The 1h (2× input) slice of the surcharge. */
  write1hPremiumUsd: number;
  /** Estimated routing $ vs the balanced counterfactual. NEGATIVE allowed. */
  routingSavedUsd: number;
  tokensCachedRead: number;
  tokensCacheWritten: number;
  /** Σread / Σprompt over cache-ELIGIBLE turns only (legacy rows without any
   *  cache fields are excluded); null when no cache-eligible turns exist. */
  cacheHitRate: number | null;
  turnsTotal: number;
  turnsRouted: number;
  turnsFailover: number;
}

/** Per served-provider+model roll-up (the API `perModel` rows). */
export interface PerModelSavings {
  provider: string;
  model: string;
  turns: number;
  cacheSavedUsd: number;
  routingSavedUsd: number;
  tokensCachedRead: number;
  cacheHitRate: number | null;
  /** True when this row's $ figures involve estimation beyond exact price
   *  math: the served model's cost was unknown/all-zero (figures forced to 0),
   *  or the group contains routed turns (routing $ is a counterfactual). */
  estimated: boolean;
}

/** Coerce anything non-finite (undefined, NaN, Infinity) to 0. */
function num(x: number | undefined): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

/**
 * True when a cost sheet is missing or carries no pricing signal at all
 * (custom/local/unknown models register `{0,0,0,0}`) — such rows contribute
 * $0 rather than fabricating savings from a zero price.
 */
export function isZeroCost(cost: ModelCostLike | null | undefined): boolean {
  if (!cost) return true;
  return (
    num(cost.input) === 0 &&
    num(cost.output) === 0 &&
    num(cost.cacheRead) === 0 &&
    num(cost.cacheWrite) === 0
  );
}

/**
 * What the provider actually billed for this turn, in USD. EXACTLY mirrors
 * pi-ai's `calculateCost` (models.js): 5m writes at `cost.cacheWrite`, 1h
 * writes at `2 × cost.input`. Cross-checked against pi-ai by unit test.
 */
export function computeServedCostUsd(cost: ModelCostLike, u: SavingsUsageLike): number {
  const long = num(u.cacheWrite1hTokens);
  const short = num(u.cacheWriteTokens) - long;
  return (
    (num(cost.input) * num(u.inputTokens) +
      num(cost.output) * num(u.outputTokens) +
      num(cost.cacheRead) * num(u.cacheReadTokens) +
      num(cost.cacheWrite) * short +
      num(cost.input) * 2 * long) /
    1e6
  );
}

/**
 * Per-row cache savings vs the no-cache counterfactual (every prompt token at
 * the base input price). See the module header for the algebra. Zero/missing
 * cost ⇒ all-zero result (graceful).
 */
export function computeRowCacheSavings(
  cost: ModelCostLike | null | undefined,
  u: SavingsUsageLike,
): RowCacheSavings {
  if (isZeroCost(cost)) {
    return { readSavedUsd: 0, write5mSurchargeUsd: 0, write1hPremiumUsd: 0, cacheSavedUsd: 0 };
  }
  const ip = num(cost!.input);
  const rp = num(cost!.cacheRead);
  const wp = num(cost!.cacheWrite);
  const read = num(u.cacheReadTokens);
  const long = num(u.cacheWrite1hTokens);
  const short = num(u.cacheWriteTokens) - long;
  const readSavedUsd = (read * (ip - rp)) / 1e6;
  const write5mSurchargeUsd = (short * (wp - ip)) / 1e6;
  const write1hPremiumUsd = (long * ip) / 1e6;
  return {
    readSavedUsd,
    write5mSurchargeUsd,
    write1hPremiumUsd,
    cacheSavedUsd: readSavedUsd - write5mSurchargeUsd - write1hPremiumUsd,
  };
}

/**
 * Per-row routing savings: what the balanced-tier counterfactual would have
 * billed minus what the served model billed, tokens held constant. Positive
 * when routing to a CHEAPER (fast) model saved money; NEGATIVE when routing
 * picked a pricier (powerful) model. `"balanced"` ⇒ 0 by definition; missing
 * or all-zero cost on either side ⇒ 0 (can't estimate honestly).
 */
export function computeRowRoutingSavings(
  servedCost: ModelCostLike | null | undefined,
  counterfactualCost: ModelCostLike | null | undefined,
  u: SavingsUsageLike,
  routedTier: RoutingTier | undefined,
): number {
  if (!routedTier || routedTier === "balanced") return 0;
  if (isZeroCost(servedCost) || isZeroCost(counterfactualCost)) return 0;
  return computeServedCostUsd(counterfactualCost!, u) - computeServedCostUsd(servedCost!, u);
}

/** A row is cache-ELIGIBLE when it carries any of the cache meter fields —
 *  legacy rows (plain inputTokens/outputTokens) predate the meter and must
 *  not drag the hit-rate toward 0 for turns that never had a cache chance. */
function isCacheEligible(u: SavingsUsageLike): boolean {
  return (
    u.cacheReadTokens !== undefined ||
    u.cacheWriteTokens !== undefined ||
    u.cacheHitRate !== undefined
  );
}

/** True when the turn was actually routed: no user pin (explicit null — a
 *  legacy `undefined` is NOT routed) and the router recorded a tier. */
function isRoutedTurn(t: SavingsTurnInput): boolean {
  return t.requestedModel === null && t.routedTier !== undefined;
}

interface GroupAcc {
  provider: string;
  model: string;
  turns: number;
  cacheSavedUsd: number;
  routingSavedUsd: number;
  tokensCachedRead: number;
  eligRead: number;
  eligPrompt: number;
  eligTurns: number;
  estimated: boolean;
}

function hitRate(eligTurns: number, eligRead: number, eligPrompt: number): number | null {
  if (eligTurns === 0) return null;
  return eligPrompt > 0 ? eligRead / eligPrompt : 0;
}

/**
 * Aggregate priced turns into the API's `stats` block plus per served
 * provider+model rows (first-appearance order, mirroring cache-stats.ts).
 */
export function aggregateSavings(turns: SavingsTurnInput[]): {
  stats: SavingsStats;
  perModel: PerModelSavings[];
} {
  const stats: SavingsStats = {
    cacheSavedUsd: 0,
    cacheReadSavedUsd: 0,
    cacheWriteSurchargeUsd: 0,
    write1hPremiumUsd: 0,
    routingSavedUsd: 0,
    tokensCachedRead: 0,
    tokensCacheWritten: 0,
    cacheHitRate: null,
    turnsTotal: 0,
    turnsRouted: 0,
    turnsFailover: 0,
  };
  let eligRead = 0;
  let eligPrompt = 0;
  let eligTurns = 0;
  const groups = new Map<string, GroupAcc>();

  for (const t of turns) {
    // Unambiguous, text-safe composite key (JSON escapes any separator).
    const key = JSON.stringify([t.provider, t.model]);
    let g = groups.get(key);
    if (!g) {
      g = {
        provider: t.provider,
        model: t.model,
        turns: 0,
        cacheSavedUsd: 0,
        routingSavedUsd: 0,
        tokensCachedRead: 0,
        eligRead: 0,
        eligPrompt: 0,
        eligTurns: 0,
        estimated: isZeroCost(t.servedCost),
      };
      groups.set(key, g);
    }

    const cache = computeRowCacheSavings(t.servedCost, t.usage);
    const routed = isRoutedTurn(t);
    const routing = routed
      ? computeRowRoutingSavings(t.servedCost, t.counterfactualCost, t.usage, t.routedTier)
      : 0;
    const read = num(t.usage.cacheReadTokens);
    const written = num(t.usage.cacheWriteTokens);

    stats.turnsTotal += 1;
    if (routed) stats.turnsRouted += 1;
    if (t.failover === true) stats.turnsFailover += 1;
    stats.cacheSavedUsd += cache.cacheSavedUsd;
    stats.cacheReadSavedUsd += cache.readSavedUsd;
    stats.cacheWriteSurchargeUsd += cache.write5mSurchargeUsd + cache.write1hPremiumUsd;
    stats.write1hPremiumUsd += cache.write1hPremiumUsd;
    stats.routingSavedUsd += routing;
    stats.tokensCachedRead += read;
    stats.tokensCacheWritten += written;

    g.turns += 1;
    g.cacheSavedUsd += cache.cacheSavedUsd;
    g.routingSavedUsd += routing;
    g.tokensCachedRead += read;
    if (routed) g.estimated = true;

    if (isCacheEligible(t.usage)) {
      const prompt = num(t.usage.inputTokens) + read + written;
      eligTurns += 1;
      eligRead += read;
      eligPrompt += prompt;
      g.eligTurns += 1;
      g.eligRead += read;
      g.eligPrompt += prompt;
    }
  }

  stats.cacheHitRate = hitRate(eligTurns, eligRead, eligPrompt);
  const perModel: PerModelSavings[] = [...groups.values()].map((g) => ({
    provider: g.provider,
    model: g.model,
    turns: g.turns,
    cacheSavedUsd: g.cacheSavedUsd,
    routingSavedUsd: g.routingSavedUsd,
    tokensCachedRead: g.tokensCachedRead,
    cacheHitRate: hitRate(g.eligTurns, g.eligRead, g.eligPrompt),
    estimated: g.estimated,
  }));
  return { stats, perModel };
}
