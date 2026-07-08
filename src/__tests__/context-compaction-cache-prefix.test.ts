/**
 * WS1 PROOF TEST — "the cached prefix survives compaction".
 *
 * This is the test that would have caught the cache/compaction war: on a
 * long thread the OLD `trim` evicted the oldest turns and prepended a
 * per-turn-CHANGING marker at index 0, so Anthropic's PREFIX-matched cache
 * missed the whole conversation body every compacted turn (a guaranteed
 * miss + 25% write surcharge → possible net cost INCREASE).
 *
 * It drives two consecutive compacted turns through the REAL compaction
 * transform, models Anthropic's prefix cache against the transform output,
 * feeds the resulting synthetic usage through WS-H's mock-LLM usage shape
 * (`buildChunkUsage`) and WS0's cache-stats math
 * (`computeTurnCacheStats` / `aggregateCacheStats`), and asserts the
 * compacted turn's hit-rate does NOT collapse to 0. The fraction-0 knob
 * reproduces the pre-fix front-marker behavior for a crisp before/after.
 */
import { test, expect, describe } from "bun:test";
import {
  DEFAULTS,
  estimateTokens,
  isCompactionMarker,
  makeCompactionTransform,
  type CompactionConfig,
} from "../runtime/stream-chat/context-compaction";
import {
  computeTurnCacheStats,
  aggregateCacheStats,
} from "../runtime/usage/cache-stats";
// WS-H mock-LLM synthetic usage shape (pure module — safe to import from src,
// mirrors mock-llm-pi-ai.integration.test.ts).
import { buildChunkUsage, type MockUsage } from "../../web/src/lib/server/mock-llm";

type Msg = any;
const userMsg = (text: string): Msg => ({ role: "user", content: text, timestamp: 1 });
const asstText = (text: string): Msg => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "x", provider: "x", model: "x", usage: {}, stopReason: "stop", timestamp: 1,
});

// Small window so a dozen turns overflow; reserves zeroed so budget == window.
const OVERRIDE: Partial<CompactionConfig> = {
  safetyFraction: 0,
  responseReserveFloor: 0,
  responseReserveCap: 0,
};
const model = { id: "claude-cache", contextWindow: 800, maxTokens: 800 } as any;

/**
 * Model Anthropic's prefix cache: the number of tokens in the longest
 * BYTE-identical leading run of messages shared by the previous send
 * (`prev`, already cached) and the current send (`curr`).
 */
function bytePrefixCacheTokens(prev: Msg[], curr: Msg[], cfg: CompactionConfig): number {
  let i = 0;
  while (
    i < prev.length &&
    i < curr.length &&
    JSON.stringify(prev[i]) === JSON.stringify(curr[i])
  ) {
    i++;
  }
  return estimateTokens(prev.slice(0, i), cfg);
}

/** Two consecutive sends of a growing thread, both over budget. */
async function twoCompactedTurns(cacheAnchorFraction: number) {
  const cfg: CompactionConfig = { ...DEFAULTS, ...OVERRIDE, cacheAnchorFraction };
  const transform = makeCompactionTransform(model, { ...OVERRIDE, cacheAnchorFraction });

  const turnsN: Msg[] = Array.from({ length: 14 }, (_, i) => userMsg("x".repeat(400) + "_" + i));
  // The thread grows: an assistant reply + a fresh user prompt are appended.
  const turnsN1: Msg[] = [...turnsN, asstText("reply ".repeat(80)), userMsg("summarize please")];

  const sentN = await transform(turnsN);
  const sentN1 = await transform(turnsN1);
  return { cfg, sentN, sentN1 };
}

describe("WS1: cache prefix survives compaction", () => {
  test("compacted turn keeps a non-zero cache hit-rate (WS-H usage → WS0 stats)", async () => {
    const { cfg, sentN, sentN1 } = await twoCompactedTurns(DEFAULTS.cacheAnchorFraction);

    // Both sends actually compacted.
    expect(sentN.some(isCompactionMarker)).toBe(true);
    expect(sentN1.some(isCompactionMarker)).toBe(true);
    // The cache-stable prefix leads (NOT a marker).
    expect(isCompactionMarker(sentN[0]!)).toBe(false);
    expect(isCompactionMarker(sentN1[0]!)).toBe(false);

    // Anthropic serves the byte-stable leading prefix from cache.
    const hit = bytePrefixCacheTokens(sentN, sentN1, cfg);
    expect(hit).toBeGreaterThan(0);

    // Turn N: first compacted send → nothing cached yet (all write, 0% hit).
    const usageN: MockUsage = { input: 0, cacheRead: 0, cacheWrite: estimateTokens(sentN, cfg), output: 1 };
    // Turn N+1: the stable prefix is a cache READ; the rest is freshly written.
    const total1 = estimateTokens(sentN1, cfg);
    const usageN1: MockUsage = { input: 0, cacheRead: hit, cacheWrite: total1 - hit, output: 1 };

    // WS-H: the mock-LLM wire shape faithfully carries the cached-token count.
    const wire = buildChunkUsage(usageN1);
    expect((wire.prompt_tokens_details as { cached_tokens: number }).cached_tokens).toBe(hit);

    // WS0: per-turn stats — the compacted turn's hit-rate did NOT collapse to 0.
    const statsN = computeTurnCacheStats({ input: 0, output: 1, cacheRead: 0, cacheWrite: usageN.cacheWrite! });
    const statsN1 = computeTurnCacheStats({ input: 0, output: 1, cacheRead: usageN1.cacheRead!, cacheWrite: usageN1.cacheWrite! });
    expect(statsN.hitRate).toBe(0); // baseline: first turn is all-write
    expect(statsN1.hitRate).toBeGreaterThan(0); // ← the fix: prefix survived the trim

    // WS0 conversation roll-up: overall hit-rate is positive across the run.
    const agg = aggregateCacheStats([
      { provider: "anthropic", model: "claude", input: 0, output: 1, cacheRead: 0, cacheWrite: usageN.cacheWrite! },
      { provider: "anthropic", model: "claude", input: 0, output: 1, cacheRead: usageN1.cacheRead!, cacheWrite: usageN1.cacheWrite! },
    ]);
    expect(agg.overall.hitRate).toBeGreaterThan(0);
    expect(agg.overall.cachedTokens).toBe(hit);
  });

  test("structural before/after: fraction 0 puts a changing marker at the FRONT", async () => {
    const stable = await twoCompactedTurns(0.5);
    const naive = await twoCompactedTurns(0);

    // NEW (anchored): the oldest original turn leads → stable prefix.
    expect(isCompactionMarker(stable.sentN[0]!)).toBe(false);
    expect(isCompactionMarker(stable.sentN1[0]!)).toBe(false);
    const stableHit = bytePrefixCacheTokens(stable.sentN, stable.sentN1, stable.cfg);
    expect(stableHit).toBeGreaterThan(0);

    // OLD behavior (fraction 0): a marker leads — exactly the shape that
    // invalidated the cache every compacted turn.
    expect(isCompactionMarker(naive.sentN[0]!)).toBe(true);
    expect(isCompactionMarker(naive.sentN1[0]!)).toBe(true);
  });

  test("a changing FRONT marker collapses the prefix cache to 0 (the caught bug)", () => {
    // Two otherwise-identical sends that differ ONLY by a per-turn-changing
    // leading marker — the pre-fix front-marker shape.
    const common = [userMsg("shared-a"), userMsg("shared-b")];
    const marker = (n: number): Msg => ({
      role: "user",
      content: `[Context note: ${n} earlier messages omitted to fit this model's ~800-token context window.]`,
      timestamp: 1,
    });
    const oldN = [marker(23), ...common];
    const oldN1 = [marker(25), ...common];

    const hit = bytePrefixCacheTokens(oldN, oldN1, DEFAULTS);
    expect(hit).toBe(0);
    // WS0 confirms: with a zero-token prefix the compacted turn hit-rate is 0.
    const stats = computeTurnCacheStats({
      input: 0,
      output: 1,
      cacheRead: hit,
      cacheWrite: estimateTokens(oldN1, DEFAULTS),
    });
    expect(stats.hitRate).toBe(0);
  });
});
