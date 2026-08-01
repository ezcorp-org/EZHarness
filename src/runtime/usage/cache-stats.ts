/**
 * Prompt-cache observability math (WS0 — "measure first").
 *
 * PURE functions only — no I/O, no imports. Given the per-turn token usage
 * that pi-ai already parses off the provider stream (`cacheRead`/`cacheWrite`
 * flow through `ctx.totalUsage` and the `run:usage` bus event), compute:
 *
 *   - per-turn cache hit-rate + cached-token count (`computeTurnCacheStats`)
 *   - per-conversation aggregation, SEGMENTED BY provider + model
 *     (`aggregateCacheStats`)
 *   - the USD cost of any of the above (`priceSegment`), given the per-model
 *     rates the registry looks up (`modelPrices` in src/providers/registry.ts)
 *
 * Cost math lives HERE rather than beside the rate lookup on purpose:
 * `src/providers/**` is outside the coverage gate, so the registry stays a
 * math-free lookup and every arithmetic decision — including "is this model
 * priced at all?" — is exercised by tests.
 *
 * Segmentation matters because `cache_control` is Anthropic-specific, OpenAI
 * caches server-side, and other providers vary — a BYOK user on one provider
 * must never see another provider's cache math folded into theirs (see the
 * integration plan §2). Hit-rate is deliberately provider-agnostic: it's the
 * fraction of the prompt that was served from cache, so a provider that never
 * caches simply reports 0 (honest, not misleading).
 *
 * Nothing here logs, persists, or touches secrets — it only counts tokens.
 */

/** The subset of pi-ai's `Usage` this module needs. */
export interface CacheUsageLike {
  /** Fresh (non-cached) prompt input tokens. */
  input: number;
  /** Output/completion tokens. */
  output: number;
  /** Prompt tokens served FROM the provider cache this turn. */
  cacheRead: number;
  /** Prompt tokens WRITTEN INTO the provider cache this turn (cache creation). */
  cacheWrite: number;
  /**
   * SUBSET of `cacheWrite` written with 1h retention (pi-ai `Usage.cacheWrite1h`,
   * types.d.ts:194 — only Anthropic reports this split). Because it is already
   * counted inside `cacheWrite`, it must NEVER be added into the `promptTokens`
   * or `cacheWrite` sums — it is carried for display/observability of the 1h
   * write premium (Anthropic bills 1h writes at 2× the base input rate) only.
   */
  cacheWrite1h?: number;
}

/** Per-turn cache stats derived from a single turn's usage. */
export interface TurnCacheStats {
  /** Tokens served from the prompt cache this turn (== cacheRead). */
  cachedTokens: number;
  /** Tokens written into the cache this turn (== cacheWrite). */
  cacheWriteTokens: number;
  /** Subset of `cacheWriteTokens` written with 1h retention (== cacheWrite1h). */
  cacheWrite1hTokens: number;
  /** Total prompt tokens = input + cacheRead + cacheWrite. */
  promptTokens: number;
  /** cachedTokens / promptTokens, clamped to [0,1]; 0 when no prompt tokens. */
  hitRate: number;
}

/** A single turn's usage tagged with the provider+model that produced it. */
export interface CacheTurnInput extends CacheUsageLike {
  provider: string;
  model: string;
}

/** Aggregated cache stats for one provider+model segment (or the overall roll-up). */
export interface CacheSegment extends TurnCacheStats {
  provider: string;
  model: string;
  turnCount: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Raw sum of per-turn `cacheWrite1h` (subset of `cacheWrite`, see CacheUsageLike). */
  cacheWrite1h: number;
}

/** Per-conversation cache stats: one segment per provider+model, plus an overall roll-up. */
export interface ConversationCacheStats {
  segments: CacheSegment[];
  overall: CacheSegment;
}

/** Coerce anything non-finite (undefined from a test double, NaN, Infinity) to 0. */
function num(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

/**
 * Per-turn cache stats. Missing/garbage fields coerce to 0 so callers can pass
 * raw provider usage (some providers omit cache fields entirely).
 */
export function computeTurnCacheStats(u: CacheUsageLike): TurnCacheStats {
  const input = num(u.input);
  const cacheRead = num(u.cacheRead);
  const cacheWrite = num(u.cacheWrite);
  // Subset of cacheWrite — deliberately NOT part of the promptTokens sum below.
  const cacheWrite1h = num(u.cacheWrite1h ?? 0);
  const promptTokens = input + cacheRead + cacheWrite;
  const hitRate = promptTokens > 0 ? cacheRead / promptTokens : 0;
  return {
    cachedTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite1hTokens: cacheWrite1h,
    promptTokens,
    hitRate,
  };
}

function emptySegment(provider: string, model: string): CacheSegment {
  return {
    provider,
    model,
    turnCount: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    promptTokens: 0,
    hitRate: 0,
  };
}

/** Fold one turn's raw tokens into a running segment (before finalize). */
function accumulate(seg: CacheSegment, t: CacheUsageLike): void {
  seg.turnCount += 1;
  seg.input += num(t.input);
  seg.output += num(t.output);
  seg.cacheRead += num(t.cacheRead);
  seg.cacheWrite += num(t.cacheWrite);
  seg.cacheWrite1h += num(t.cacheWrite1h ?? 0);
}

/** Derive the cached-token / prompt-token / hit-rate fields from the folded totals. */
function finalizeSegment(seg: CacheSegment): void {
  seg.cachedTokens = seg.cacheRead;
  seg.cacheWriteTokens = seg.cacheWrite;
  seg.cacheWrite1hTokens = seg.cacheWrite1h;
  // cacheWrite1h is a SUBSET of cacheWrite — never folded into promptTokens.
  seg.promptTokens = seg.input + seg.cacheRead + seg.cacheWrite;
  seg.hitRate = seg.promptTokens > 0 ? seg.cacheRead / seg.promptTokens : 0;
}

/**
 * Aggregate many turns into per-provider+model segments plus an overall
 * roll-up. The overall segment uses `provider: "*"`, `model: "*"`. Segment
 * order follows first-appearance of each provider+model pair.
 */
export function aggregateCacheStats(turns: CacheTurnInput[]): ConversationCacheStats {
  const byKey = new Map<string, CacheSegment>();
  const overall = emptySegment("*", "*");
  for (const t of turns) {
    // Unambiguous, text-safe composite key (JSON escapes any separator).
    const key = JSON.stringify([t.provider, t.model]);
    let seg = byKey.get(key);
    if (!seg) {
      seg = emptySegment(t.provider, t.model);
      byKey.set(key, seg);
    }
    accumulate(seg, t);
    accumulate(overall, t);
  }
  const segments = [...byKey.values()];
  for (const seg of segments) finalizeSegment(seg);
  finalizeSegment(overall);
  return { segments, overall };
}

/**
 * Per-model rates in USD per 1M tokens — the units pi-ai's `Model.cost`
 * already uses (`src/providers/registry.ts:63` blends `input + output` against
 * plain-dollar thresholds; e.g. claude-sonnet-4-5 is
 * `{ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }`).
 * Structurally a subset of pi-ai's `ModelCost`, so the registry hands
 * `model.cost` straight in with no adapter.
 *
 * NOT modelled: `ModelCost.tiers`, the per-REQUEST long-context rate step that
 * 12 of ~1057 catalog models carry (OpenAI's `inputTokensAbove: 272_000`). A
 * tier is selected from ONE request's input size, so it cannot be applied to a
 * segment that folds many turns together — base rates are the honest floor
 * rather than a wrong guess.
 */
export interface ModelPrices {
  /** USD per 1M fresh (non-cached) input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M tokens served from the cache. */
  cacheRead: number;
  /**
   * USD per 1M cache-CREATION tokens at the provider's default retention
   * (Anthropic's 5m write, 1.25× input). Legitimately 0 where writes are free
   * — OpenAI charges nothing to populate its cache.
   */
  cacheWrite: number;
}

/**
 * Anthropic bills a 1h-retention cache write at 2× the BASE INPUT rate, not at
 * the `cacheWrite` (5m) rate. See `CacheUsageLike.cacheWrite1h`.
 */
const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;

/**
 * USD cost of one turn or segment. Mirrors pi-ai's `Usage.cost` shape
 * (`input`/`output`/`cacheRead`/`cacheWrite`/`total`) plus the 1h write line.
 */
export interface SegmentCost {
  input: number;
  output: number;
  cacheRead: number;
  /** ALL cache-write tokens: the 1h subset at 2× input, the remainder at `cacheWrite`. */
  cacheWrite: number;
  /**
   * The 1h-retention share of `cacheWrite` above, broken out for display.
   * Like `cacheWrite1h` vs `cacheWrite` in `CacheUsageLike` this is a SUBSET,
   * so it must NEVER be added into `total`.
   */
  cacheWrite1h: number;
  /** input + output + cacheRead + cacheWrite (cacheWrite1h already inside cacheWrite). */
  total: number;
}

/** USD for `tokens` at `rate` USD-per-1M. Garbage in either operand → 0. */
function priceTokens(tokens: number, rate: number): number {
  return (num(tokens) * num(rate)) / 1_000_000;
}

/**
 * True when at least one rate is a positive number. A single zero rate is NOT
 * enough to call a model unpriced — OpenAI really does charge 0 for cache
 * writes — but an all-zero table means "no pricing known" (see `priceSegment`).
 */
function isPriced(p: ModelPrices): boolean {
  return num(p.input) > 0 || num(p.output) > 0 || num(p.cacheRead) > 0 || num(p.cacheWrite) > 0;
}

/**
 * USD cost of a turn or a segment. Takes anything token-shaped, so a raw turn,
 * one `CacheSegment`, and the `overall` roll-up all price identically.
 *
 * Returns `null` for an UNPRICED model — `prices` absent, or every rate
 * 0/garbage, which is exactly how OAuth-SUBSCRIPTION models arrive (they are
 * rate-limited, not billed per token, so pi-ai reports `cost` as all zeros).
 * `null` is deliberately NOT the same as a `total` of 0: a caller must render
 * token counts for an unpriced model instead of a fabricated "$0.00" that
 * reads like a measured price. A priced model with no tokens still returns a
 * real, zeroed `SegmentCost` — that zero IS data.
 */
export function priceSegment(seg: CacheUsageLike, prices: ModelPrices | undefined): SegmentCost | null {
  if (!prices || !isPriced(prices)) return null;
  // cacheWrite1h is a SUBSET of cacheWrite (see CacheUsageLike). Clamp so
  // malformed provider usage can never bill more written tokens than were
  // written, then split the write: the 1h share at 2× base input, the rest at
  // the default-retention rate.
  const writeTokens = num(seg.cacheWrite);
  const write1hTokens = Math.min(num(seg.cacheWrite1h ?? 0), writeTokens);
  const cacheWrite1h = priceTokens(write1hTokens, num(prices.input) * CACHE_WRITE_1H_INPUT_MULTIPLIER);
  const cacheWrite = priceTokens(writeTokens - write1hTokens, prices.cacheWrite) + cacheWrite1h;
  const input = priceTokens(seg.input, prices.input);
  const output = priceTokens(seg.output, prices.output);
  const cacheRead = priceTokens(seg.cacheRead, prices.cacheRead);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    total: input + output + cacheRead + cacheWrite,
  };
}
