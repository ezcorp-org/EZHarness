/**
 * Pure-math tests for src/runtime/usage/savings.ts.
 *
 * The served-cost algebra is CROSS-CHECKED against pi-ai's exported
 * `calculateCost` (the billing ground truth) so the two can never drift —
 * including the 5m-vs-1h cache-write split (1h bills at 2× base input,
 * hardcoded in pi-ai models.js).
 */

import { test, expect, describe } from "bun:test";
import { calculateCost, getModels, type Model, type Usage } from "@earendil-works/pi-ai";
import {
  aggregateSavings,
  computeRowCacheSavings,
  computeRowRoutingSavings,
  computeServedCostUsd,
  isZeroCost,
  type ModelCostLike,
  type SavingsTurnInput,
  type SavingsUsageLike,
} from "../runtime/usage/savings";

// Anthropic-like price sheet ($/1M): cacheRead = 0.1×input, cacheWrite = 1.25×input.
const COST: ModelCostLike = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
// A "powerful"-tier sheet (5× the balanced one).
const POWERFUL_COST: ModelCostLike = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
// A "fast"-tier sheet.
const FAST_COST: ModelCostLike = { input: 0.25, output: 1.25, cacheRead: 0.025, cacheWrite: 0.3125 };
const ZERO_COST: ModelCostLike = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function turn(overrides: Partial<SavingsTurnInput> = {}): SavingsTurnInput {
  return {
    provider: "anthropic",
    model: "claude-x",
    usage: {},
    servedCost: COST,
    counterfactualCost: null,
    ...overrides,
  };
}

describe("isZeroCost", () => {
  test("null/undefined/all-zero cost sheets are zero-cost", () => {
    expect(isZeroCost(null)).toBe(true);
    expect(isZeroCost(undefined)).toBe(true);
    expect(isZeroCost(ZERO_COST)).toBe(true);
  });

  test("any priced field makes the sheet non-zero", () => {
    expect(isZeroCost(COST)).toBe(false);
    expect(isZeroCost({ ...ZERO_COST, output: 1 })).toBe(false);
  });

  test("non-finite garbage fields coerce to 0", () => {
    expect(isZeroCost({ input: Number.NaN, output: Number.POSITIVE_INFINITY, cacheRead: 0, cacheWrite: 0 })).toBe(true);
  });
});

describe("computeServedCostUsd", () => {
  test("prices the full token mix incl. the 5m/1h write split", () => {
    const u: SavingsUsageLike = {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheWriteTokens: 3000,
      cacheWrite1hTokens: 1000, // 2000 short @ 3.75, 1000 long @ 2×3
    };
    const expected =
      (3 * 1000 + 15 * 200 + 0.3 * 5000 + 3.75 * 2000 + 3 * 2 * 1000) / 1e6;
    expect(computeServedCostUsd(COST, u)).toBeCloseTo(expected, 12);
  });

  test("missing fields contribute 0 tokens", () => {
    expect(computeServedCostUsd(COST, {})).toBe(0);
    expect(computeServedCostUsd(COST, { outputTokens: 100 })).toBeCloseTo((15 * 100) / 1e6, 12);
  });

  test("CROSS-CHECK: matches pi-ai calculateCost across real registry models", () => {
    // Pick real Anthropic models with a fully-priced cost sheet so the
    // cross-check runs against genuine registry prices, not fixtures.
    const priced = getModels("anthropic").filter(
      (m) => m.cost.input > 0 && m.cost.output > 0 && m.cost.cacheRead > 0 && m.cost.cacheWrite > 0,
    );
    expect(priced.length).toBeGreaterThan(0);

    const mixes: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number }> = [
      { input: 1234, output: 567, cacheRead: 8901, cacheWrite: 2345, cacheWrite1h: 1000 },
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 5000, cacheWrite1h: 5000 }, // all-1h writes
      { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },                    // no 1h split
      { input: 999999, output: 1, cacheRead: 0, cacheWrite: 0 },
    ];

    for (const model of priced.slice(0, 3) as Model<any>[]) {
      for (const mix of mixes) {
        const usage: Usage = {
          input: mix.input,
          output: mix.output,
          cacheRead: mix.cacheRead,
          cacheWrite: mix.cacheWrite,
          ...(mix.cacheWrite1h !== undefined ? { cacheWrite1h: mix.cacheWrite1h } : {}),
          totalTokens: mix.input + mix.output + mix.cacheRead + mix.cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        const piTotal = calculateCost(model, usage).total;
        const ours = computeServedCostUsd(model.cost, {
          inputTokens: mix.input,
          outputTokens: mix.output,
          cacheReadTokens: mix.cacheRead,
          cacheWriteTokens: mix.cacheWrite,
          cacheWrite1hTokens: mix.cacheWrite1h,
        });
        expect(ours).toBeCloseTo(piTotal, 12);
      }
    }
  });
});

describe("computeRowCacheSavings", () => {
  test("read-dominated turn saves money", () => {
    const s = computeRowCacheSavings(COST, { cacheReadTokens: 1_000_000 });
    expect(s.readSavedUsd).toBeCloseTo(3 - 0.3, 12); // (ip − rp) per 1M
    expect(s.write5mSurchargeUsd).toBe(0);
    expect(s.write1hPremiumUsd).toBe(0);
    expect(s.cacheSavedUsd).toBeCloseTo(2.7, 12);
  });

  test("NEGATIVE net when the 1h write premium dominates (audit case)", () => {
    // All writes at 1h retention, nothing ever read back.
    const s = computeRowCacheSavings(COST, { cacheWriteTokens: 1000, cacheWrite1hTokens: 1000 });
    expect(s.readSavedUsd).toBe(0);
    expect(s.write5mSurchargeUsd).toBe(0); // short = 0
    expect(s.write1hPremiumUsd).toBeCloseTo((1000 * 3) / 1e6, 12);
    expect(s.cacheSavedUsd).toBeCloseTo(-(1000 * 3) / 1e6, 12);
    expect(s.cacheSavedUsd).toBeLessThan(0);
  });

  test("5m writes bill the (wp − ip) premium", () => {
    const s = computeRowCacheSavings(COST, { cacheWriteTokens: 2000 });
    expect(s.write5mSurchargeUsd).toBeCloseTo((2000 * (3.75 - 3)) / 1e6, 12);
    expect(s.write1hPremiumUsd).toBe(0);
    expect(s.cacheSavedUsd).toBeCloseTo(-(2000 * 0.75) / 1e6, 12);
  });

  test("mixed read + 5m + 1h nets read savings minus both premiums", () => {
    const s = computeRowCacheSavings(COST, {
      cacheReadTokens: 10_000,
      cacheWriteTokens: 3000,
      cacheWrite1hTokens: 1000,
    });
    const readSaved = (10_000 * 2.7) / 1e6;
    const surcharge5m = (2000 * 0.75) / 1e6;
    const premium1h = (1000 * 3) / 1e6;
    expect(s.cacheSavedUsd).toBeCloseTo(readSaved - surcharge5m - premium1h, 12);
  });

  test("zero-cost model contributes 0 (graceful)", () => {
    const s = computeRowCacheSavings(ZERO_COST, { cacheReadTokens: 1_000_000, cacheWriteTokens: 500 });
    expect(s).toEqual({ readSavedUsd: 0, write5mSurchargeUsd: 0, write1hPremiumUsd: 0, cacheSavedUsd: 0 });
    expect(computeRowCacheSavings(null, { cacheReadTokens: 5 }).cacheSavedUsd).toBe(0);
  });

  test("missing usage fields contribute 0 tokens", () => {
    const s = computeRowCacheSavings(COST, {});
    expect(s.cacheSavedUsd).toBe(0);
  });
});

describe("computeRowRoutingSavings", () => {
  const usage: SavingsUsageLike = { inputTokens: 1000, outputTokens: 100 };

  test("powerful routed ⇒ NEGATIVE (counterfactual balanced is cheaper)", () => {
    const s = computeRowRoutingSavings(POWERFUL_COST, COST, usage, "powerful");
    const served = (15 * 1000 + 75 * 100) / 1e6;
    const counterfactual = (3 * 1000 + 15 * 100) / 1e6;
    expect(s).toBeCloseTo(counterfactual - served, 12);
    expect(s).toBeLessThan(0);
  });

  test("fast routed ⇒ POSITIVE (cheaper than the balanced counterfactual)", () => {
    const s = computeRowRoutingSavings(FAST_COST, COST, usage, "fast");
    const served = (0.25 * 1000 + 1.25 * 100) / 1e6;
    const counterfactual = (3 * 1000 + 15 * 100) / 1e6;
    expect(s).toBeCloseTo(counterfactual - served, 12);
    expect(s).toBeGreaterThan(0);
  });

  test("balanced tier ⇒ 0 by definition", () => {
    expect(computeRowRoutingSavings(COST, COST, usage, "balanced")).toBe(0);
  });

  test("no tier ⇒ 0", () => {
    expect(computeRowRoutingSavings(FAST_COST, COST, usage, undefined)).toBe(0);
  });

  test("zero/missing cost on either side ⇒ 0 (graceful)", () => {
    expect(computeRowRoutingSavings(ZERO_COST, COST, usage, "fast")).toBe(0);
    expect(computeRowRoutingSavings(FAST_COST, null, usage, "fast")).toBe(0);
  });

  test("routing accounts for cache token mix, not just input/output", () => {
    const cached: SavingsUsageLike = { inputTokens: 100, cacheReadTokens: 10_000, cacheWriteTokens: 2000, cacheWrite1hTokens: 500 };
    const s = computeRowRoutingSavings(POWERFUL_COST, COST, cached, "powerful");
    expect(s).toBeCloseTo(computeServedCostUsd(COST, cached) - computeServedCostUsd(POWERFUL_COST, cached), 12);
  });
});

describe("aggregateSavings", () => {
  test("empty input yields zeroed stats with null hit-rate", () => {
    const { stats, perModel } = aggregateSavings([]);
    expect(stats.turnsTotal).toBe(0);
    expect(stats.cacheHitRate).toBeNull();
    expect(stats.cacheSavedUsd).toBe(0);
    expect(perModel).toEqual([]);
  });

  test("groups by served provider+model in first-appearance order", () => {
    const { perModel } = aggregateSavings([
      turn({ provider: "anthropic", model: "a" }),
      turn({ provider: "openai", model: "b" }),
      turn({ provider: "anthropic", model: "a" }),
    ]);
    expect(perModel.map((g) => `${g.provider}/${g.model}`)).toEqual(["anthropic/a", "openai/b"]);
    expect(perModel[0]!.turns).toBe(2);
    expect(perModel[1]!.turns).toBe(1);
  });

  test("legacy rows (no cache fields) are EXCLUDED from hit-rate but counted as turns", () => {
    const { stats, perModel } = aggregateSavings([
      // Legacy: only input/output persisted — would drag hit-rate to 0 if counted.
      turn({ usage: { inputTokens: 99_999, outputTokens: 10 } }),
      // Cache-eligible: 800 read of 1000 prompt.
      turn({ usage: { inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 } }),
    ]);
    expect(stats.turnsTotal).toBe(2);
    expect(stats.cacheHitRate).toBeCloseTo(0.8, 12);
    expect(perModel[0]!.cacheHitRate).toBeCloseTo(0.8, 12);
  });

  test("all-legacy input yields null hit-rate (no cache-eligible turns)", () => {
    const { stats, perModel } = aggregateSavings([
      turn({ usage: { inputTokens: 10, outputTokens: 5 } }),
    ]);
    expect(stats.cacheHitRate).toBeNull();
    expect(perModel[0]!.cacheHitRate).toBeNull();
  });

  test("eligible turns with zero prompt tokens yield hit-rate 0, not null", () => {
    const { stats } = aggregateSavings([
      turn({ usage: { cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    ]);
    expect(stats.cacheHitRate).toBe(0);
  });

  test("routed turns require requestedModel === null AND a routedTier", () => {
    const { stats } = aggregateSavings([
      turn({ requestedModel: null, routedTier: "fast", servedCost: FAST_COST, counterfactualCost: COST, usage: { inputTokens: 1000 } }),
      turn({ requestedModel: "pinned-model", routedTier: "fast", counterfactualCost: COST }), // pinned — not routed
      turn({ requestedModel: null }), // no tier recorded — not routed
      turn({}), // legacy — not routed
    ]);
    expect(stats.turnsTotal).toBe(4);
    expect(stats.turnsRouted).toBe(1);
    expect(stats.routingSavedUsd).toBeCloseTo((3 * 1000 - 0.25 * 1000) / 1e6, 12);
  });

  test("failover turns are counted", () => {
    const { stats } = aggregateSavings([
      turn({ failover: true }),
      turn({ failover: false }),
      turn({}),
    ]);
    expect(stats.turnsFailover).toBe(1);
  });

  test("stats decompose: net = readSaved − surcharge; 1h premium is a slice of the surcharge", () => {
    const { stats } = aggregateSavings([
      turn({ usage: { inputTokens: 100, cacheReadTokens: 10_000, cacheWriteTokens: 3000, cacheWrite1hTokens: 1000 } }),
      turn({ usage: { cacheWriteTokens: 1000, cacheWrite1hTokens: 1000 } }),
    ]);
    const readSaved = (10_000 * 2.7) / 1e6;
    const surcharge5m = (2000 * 0.75) / 1e6;
    const premium1h = (2000 * 3) / 1e6; // 1000 long tokens in each turn
    expect(stats.cacheReadSavedUsd).toBeCloseTo(readSaved, 12);
    expect(stats.write1hPremiumUsd).toBeCloseTo(premium1h, 12);
    expect(stats.cacheWriteSurchargeUsd).toBeCloseTo(surcharge5m + premium1h, 12);
    expect(stats.cacheSavedUsd).toBeCloseTo(readSaved - surcharge5m - premium1h, 12);
    expect(stats.tokensCachedRead).toBe(10_000);
    expect(stats.tokensCacheWritten).toBe(4000);
  });

  test("NEGATIVE aggregate net savings is preserved, never clamped", () => {
    const { stats, perModel } = aggregateSavings([
      turn({ usage: { cacheWriteTokens: 5000, cacheWrite1hTokens: 5000 } }),
    ]);
    expect(stats.cacheSavedUsd).toBeLessThan(0);
    expect(perModel[0]!.cacheSavedUsd).toBeLessThan(0);
    // The surcharge itself is the (positive) premium paid.
    expect(stats.cacheWriteSurchargeUsd).toBeGreaterThan(0);
  });

  test("estimated flags: zero-cost model OR routed turns mark a group estimated", () => {
    const { perModel } = aggregateSavings([
      turn({ provider: "custom", model: "local", servedCost: ZERO_COST }),
      turn({ provider: "anthropic", model: "routed", requestedModel: null, routedTier: "fast", counterfactualCost: COST }),
      turn({ provider: "anthropic", model: "pinned", requestedModel: "pinned" }),
    ]);
    const byModel = Object.fromEntries(perModel.map((g) => [g.model, g.estimated]));
    expect(byModel).toEqual({ local: true, routed: true, pinned: false });
  });

  test("non-finite usage garbage coerces to 0 instead of poisoning sums", () => {
    const { stats } = aggregateSavings([
      turn({ usage: { inputTokens: Number.NaN, cacheReadTokens: 500, cacheWriteTokens: Number.POSITIVE_INFINITY } }),
    ]);
    expect(stats.tokensCachedRead).toBe(500);
    expect(stats.tokensCacheWritten).toBe(0);
    expect(Number.isFinite(stats.cacheSavedUsd)).toBe(true);
    expect(stats.cacheHitRate).toBe(1); // 500 read of 500 prompt
  });
});
