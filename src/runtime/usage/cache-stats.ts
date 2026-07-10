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
