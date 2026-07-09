import { test, expect, describe } from "bun:test";
import {
  computeTurnCacheStats,
  aggregateCacheStats,
  type CacheTurnInput,
} from "../runtime/usage/cache-stats";

describe("computeTurnCacheStats", () => {
  test("splits prompt into fresh + cached + written and derives hit-rate", () => {
    const s = computeTurnCacheStats({ input: 100, output: 50, cacheRead: 800, cacheWrite: 100 });
    expect(s.cachedTokens).toBe(800);
    expect(s.cacheWriteTokens).toBe(100);
    // promptTokens = 100 + 800 + 100
    expect(s.promptTokens).toBe(1000);
    // hitRate = 800 / 1000
    expect(s.hitRate).toBeCloseTo(0.8, 10);
  });

  test("first turn (cache write only, no read) reports 0% hit-rate", () => {
    const s = computeTurnCacheStats({ input: 200, output: 30, cacheRead: 0, cacheWrite: 900 });
    expect(s.cachedTokens).toBe(0);
    expect(s.cacheWriteTokens).toBe(900);
    expect(s.promptTokens).toBe(1100);
    expect(s.hitRate).toBe(0);
  });

  test("no prompt tokens at all → hit-rate 0 (no divide-by-zero)", () => {
    const s = computeTurnCacheStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(s.promptTokens).toBe(0);
    expect(s.hitRate).toBe(0);
  });

  test("non-finite fields (NaN) coerce to 0", () => {
    const s = computeTurnCacheStats({ input: Number.NaN, output: Number.NaN, cacheRead: 500, cacheWrite: Number.NaN });
    expect(s.cachedTokens).toBe(500);
    expect(s.cacheWriteTokens).toBe(0);
    expect(s.promptTokens).toBe(500);
    expect(s.hitRate).toBe(1);
  });

  test("cacheWrite1h (1h-retention subset) is surfaced but NEVER double-counted", () => {
    // 120 of the 300 written tokens carry 1h retention — they are a SUBSET of
    // cacheWrite, so promptTokens/cacheWriteTokens must be identical to the
    // same turn without the split.
    const s = computeTurnCacheStats({ input: 100, output: 50, cacheRead: 800, cacheWrite: 300, cacheWrite1h: 120 });
    expect(s.cacheWrite1hTokens).toBe(120);
    expect(s.cacheWriteTokens).toBe(300);
    // promptTokens = 100 + 800 + 300 — the 120 must NOT be added again.
    expect(s.promptTokens).toBe(1200);
    expect(s.hitRate).toBeCloseTo(800 / 1200, 10);
    const without = computeTurnCacheStats({ input: 100, output: 50, cacheRead: 800, cacheWrite: 300 });
    expect(s.promptTokens).toBe(without.promptTokens);
    expect(s.cacheWriteTokens).toBe(without.cacheWriteTokens);
    expect(s.hitRate).toBe(without.hitRate);
  });

  test("missing cacheWrite1h (non-Anthropic providers) coerces to 0", () => {
    const s = computeTurnCacheStats({ input: 10, output: 5, cacheRead: 0, cacheWrite: 90 });
    expect(s.cacheWrite1hTokens).toBe(0);
  });

  test("non-finite cacheWrite1h (NaN) coerces to 0", () => {
    const s = computeTurnCacheStats({ input: 10, output: 5, cacheRead: 0, cacheWrite: 90, cacheWrite1h: Number.NaN });
    expect(s.cacheWrite1hTokens).toBe(0);
  });
});

describe("aggregateCacheStats", () => {
  test("empty conversation → empty segments + zeroed overall", () => {
    const agg = aggregateCacheStats([]);
    expect(agg.segments).toEqual([]);
    expect(agg.overall.turnCount).toBe(0);
    expect(agg.overall.provider).toBe("*");
    expect(agg.overall.model).toBe("*");
    expect(agg.overall.hitRate).toBe(0);
    expect(agg.overall.promptTokens).toBe(0);
  });

  test("multiple turns on one provider+model fold into a single segment", () => {
    const turns: CacheTurnInput[] = [
      { provider: "anthropic", model: "claude", input: 100, output: 40, cacheRead: 0, cacheWrite: 900 },
      { provider: "anthropic", model: "claude", input: 50, output: 30, cacheRead: 900, cacheWrite: 0 },
    ];
    const agg = aggregateCacheStats(turns);
    expect(agg.segments).toHaveLength(1);
    const seg = agg.segments[0]!;
    expect(seg.provider).toBe("anthropic");
    expect(seg.model).toBe("claude");
    expect(seg.turnCount).toBe(2);
    expect(seg.input).toBe(150);
    expect(seg.output).toBe(70);
    expect(seg.cacheRead).toBe(900);
    expect(seg.cacheWrite).toBe(900);
    expect(seg.cachedTokens).toBe(900);
    expect(seg.cacheWriteTokens).toBe(900);
    // promptTokens = 150 + 900 + 900 = 1950 ; hitRate = 900/1950
    expect(seg.promptTokens).toBe(1950);
    expect(seg.hitRate).toBeCloseTo(900 / 1950, 10);
  });

  test("segments are kept SEPARATE by provider+model; overall rolls up both", () => {
    const turns: CacheTurnInput[] = [
      { provider: "anthropic", model: "claude", input: 100, output: 10, cacheRead: 900, cacheWrite: 0 },
      { provider: "openai", model: "gpt", input: 100, output: 10, cacheRead: 100, cacheWrite: 0 },
    ];
    const agg = aggregateCacheStats(turns);
    expect(agg.segments.map((s) => `${s.provider}/${s.model}`)).toEqual(["anthropic/claude", "openai/gpt"]);
    const anthropic = agg.segments.find((s) => s.provider === "anthropic")!;
    const openai = agg.segments.find((s) => s.provider === "openai")!;
    expect(anthropic.hitRate).toBeCloseTo(900 / 1000, 10);
    expect(openai.hitRate).toBeCloseTo(100 / 200, 10);
    // overall: cacheRead 1000, prompt = 200 input + 1000 read = 1200
    expect(agg.overall.turnCount).toBe(2);
    expect(agg.overall.cacheRead).toBe(1000);
    expect(agg.overall.promptTokens).toBe(1200);
    expect(agg.overall.hitRate).toBeCloseTo(1000 / 1200, 10);
  });

  test("same model name under two providers does not collide", () => {
    const turns: CacheTurnInput[] = [
      { provider: "anthropic", model: "shared", input: 10, output: 1, cacheRead: 10, cacheWrite: 0 },
      { provider: "openrouter", model: "shared", input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
    ];
    const agg = aggregateCacheStats(turns);
    expect(agg.segments).toHaveLength(2);
  });

  test("cacheWrite1h sums across turns without inflating cacheWrite/promptTokens", () => {
    const turns: CacheTurnInput[] = [
      // Turn 1: 900 written, 120 of them at 1h. Turn 2: mixed provider missing
      // the field entirely (must fold as 0, not NaN).
      { provider: "anthropic", model: "claude", input: 100, output: 10, cacheRead: 0, cacheWrite: 900, cacheWrite1h: 120 },
      { provider: "anthropic", model: "claude", input: 50, output: 5, cacheRead: 900, cacheWrite: 30, cacheWrite1h: 30 },
      { provider: "openai", model: "gpt", input: 40, output: 4, cacheRead: 0, cacheWrite: 0 },
    ];
    const agg = aggregateCacheStats(turns);
    const anthropic = agg.segments.find((s) => s.provider === "anthropic")!;
    expect(anthropic.cacheWrite1h).toBe(150);
    expect(anthropic.cacheWrite1hTokens).toBe(150);
    // Sums stay subset-safe: cacheWrite = 930, promptTokens = 150 + 900 + 930.
    expect(anthropic.cacheWrite).toBe(930);
    expect(anthropic.promptTokens).toBe(1980);
    const openai = agg.segments.find((s) => s.provider === "openai")!;
    expect(openai.cacheWrite1hTokens).toBe(0);
    // Overall roll-up carries the 1h subset too.
    expect(agg.overall.cacheWrite1hTokens).toBe(150);
    expect(agg.overall.cacheWrite).toBe(930);
  });
});
