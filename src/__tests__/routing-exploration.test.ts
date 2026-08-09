/**
 * WS7 — bounded routing exploration (`src/runtime/routing/exploration.ts`).
 *
 * Four contracts, all of them safety properties rather than behaviour niceties:
 *   1. OFF by default — an unset/malformed setting explores nothing, so no
 *      deployment starts trading answer quality for data by upgrading.
 *   2. Never above a DECLARED tier or an explicit HINT. A declared tier is a
 *      correctness requirement; downgrading it would be a bug, not an experiment.
 *   3. Exactly ONE rung down, and never below the bottom of the ladder.
 *   4. Deterministic under an injected `random`, so this file asserts outcomes
 *      instead of sampling them.
 */
import { test, expect, describe } from "bun:test";
import {
  applyExploration,
  DEFAULT_EXPLORATION_RATE,
  EXPLORATION_RATE_SETTING_KEY,
  parseExplorationRate,
  validateExplorationRate,
} from "../runtime/routing/exploration";
import { tierBelow, VALID_TIERS, type TierReason } from "../runtime/tier-classifier";

/** Always explores when a draw happens at all. */
const alwaysDraw = () => 0;
/** Never explores at any rate ≤ 1. */
const neverDraw = () => 0.999999;

describe("parseExplorationRate", () => {
  test("a probability inside [0,1] is honored verbatim", () => {
    expect(parseExplorationRate(0)).toBe(0);
    expect(parseExplorationRate(0.05)).toBe(0.05);
    expect(parseExplorationRate(1)).toBe(1);
  });

  test("an unset setting is OFF", () => {
    expect(parseExplorationRate(undefined)).toBe(DEFAULT_EXPLORATION_RATE);
    expect(parseExplorationRate(null)).toBe(0);
  });

  test("an OUT-OF-RANGE value is rejected as off, never clamped to 'always'", () => {
    // The load-bearing case: `100` almost certainly means "percent". Clamping it
    // to 1 would explore every single turn on a deployment that asked for 1%.
    expect(parseExplorationRate(100)).toBe(0);
    expect(parseExplorationRate(1.5)).toBe(0);
    expect(parseExplorationRate(-0.2)).toBe(0);
  });

  test("a non-numeric or non-finite value is off", () => {
    expect(parseExplorationRate("0.5")).toBe(0);
    expect(parseExplorationRate({ rate: 0.5 })).toBe(0);
    expect(parseExplorationRate(Number.NaN)).toBe(0);
    expect(parseExplorationRate(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("the settings key is the documented one", () => {
    expect(EXPLORATION_RATE_SETTING_KEY).toBe("provider:explorationRate");
  });
});

describe("validateExplorationRate — the WRITE-time gate", () => {
  test("accepts a probability", () => {
    expect(validateExplorationRate(0)).toEqual({ ok: true, rate: 0 });
    expect(validateExplorationRate(0.05)).toEqual({ ok: true, rate: 0.05 });
    expect(validateExplorationRate(1)).toEqual({ ok: true, rate: 1 });
  });

  test("REJECTS out of range with the unit mistake named", () => {
    // Where the tolerant read would silently store 100 and explore nothing,
    // the write tells the operator why. That difference is the whole point.
    const result = validateExplorationRate(100);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("not a probability");
  });

  test("REJECTS a non-number", () => {
    for (const bad of ["0.5", null, undefined, {}, Number.NaN]) {
      const result = validateExplorationRate(bad);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toContain("between 0 and 1");
    }
  });
});

describe("tierBelow", () => {
  test("walks exactly one rung down and stops at the bottom", () => {
    expect(tierBelow("powerful")).toBe("balanced");
    expect(tierBelow("balanced")).toBe("fast");
    expect(tierBelow("fast")).toBeUndefined();
  });

  test("every tier except the weakest has a rung below it", () => {
    const withBelow = VALID_TIERS.filter((t) => tierBelow(t) !== undefined);
    expect(withBelow).toEqual(["balanced", "powerful"]);
  });
});

describe("applyExploration — off by default", () => {
  test("rate 0 never explores, and does not even draw", () => {
    let draws = 0;
    const decision = applyExploration({
      verdict: { tier: "powerful", reason: "context-size" },
      rate: 0,
      random: () => {
        draws += 1;
        return 0;
      },
    });
    expect(decision).toEqual({ tier: "powerful", exploration: false });
    expect(draws).toBe(0);
  });

  test("a negative rate cannot fire", () => {
    expect(
      applyExploration({
        verdict: { tier: "powerful", reason: "context-size" },
        rate: -1,
        random: alwaysDraw,
      }),
    ).toEqual({ tier: "powerful", exploration: false });
  });
});

describe("applyExploration — never overrides correctness or explicit intent", () => {
  test("a DECLARED tier is never explored, even at rate 1", () => {
    expect(
      applyExploration({
        verdict: { tier: "powerful", reason: "declared" },
        rate: 1,
        random: alwaysDraw,
      }),
    ).toEqual({ tier: "powerful", exploration: false });
  });

  test("an explicit HINT is never explored, even at rate 1", () => {
    expect(
      applyExploration({
        verdict: { tier: "balanced", reason: "hint" },
        rate: 1,
        random: alwaysDraw,
      }),
    ).toEqual({ tier: "balanced", exploration: false });
  });

  test("every OTHER reason — including a future scorer — is explorable", () => {
    const explorable: TierReason[] = [
      "scorer",
      "tool-messages",
      "history-depth",
      "system-size",
      "complex-tools",
      "context-size",
      "tool-count",
      "midsize-turn",
    ];
    for (const reason of explorable) {
      expect(
        applyExploration({ verdict: { tier: "powerful", reason }, rate: 1, random: alwaysDraw }),
      ).toEqual({ tier: "balanced", exploration: true });
    }
  });
});

describe("applyExploration — the draw", () => {
  test("a won draw routes exactly one rung down and flags it", () => {
    expect(
      applyExploration({
        verdict: { tier: "powerful", reason: "context-size" },
        rate: 0.5,
        random: () => 0.1,
      }),
    ).toEqual({ tier: "balanced", exploration: true });
    expect(
      applyExploration({
        verdict: { tier: "balanced", reason: "tool-count" },
        rate: 0.5,
        random: () => 0.1,
      }),
    ).toEqual({ tier: "fast", exploration: true });
  });

  test("a lost draw leaves the verdict untouched", () => {
    expect(
      applyExploration({
        verdict: { tier: "powerful", reason: "context-size" },
        rate: 0.5,
        random: neverDraw,
      }),
    ).toEqual({ tier: "powerful", exploration: false });
  });

  test("the draw is strictly `< rate`, so the boundary does not fire", () => {
    expect(
      applyExploration({
        verdict: { tier: "powerful", reason: "context-size" },
        rate: 0.25,
        random: () => 0.25,
      }),
    ).toEqual({ tier: "powerful", exploration: false });
    expect(
      applyExploration({
        verdict: { tier: "powerful", reason: "context-size" },
        rate: 0.25,
        random: () => 0.2499,
      }),
    ).toEqual({ tier: "balanced", exploration: true });
  });

  test("the FAST tier is never explored — there is no cheaper rung", () => {
    expect(
      applyExploration({
        verdict: { tier: "fast", reason: "short-turn" },
        rate: 1,
        random: alwaysDraw,
      }),
    ).toEqual({ tier: "fast", exploration: false });
  });

  test("omitting `random` falls back to Math.random without throwing", () => {
    // Rate 1 makes the real Math.random's value irrelevant (any draw < 1), so
    // this exercises the default source deterministically.
    expect(
      applyExploration({ verdict: { tier: "powerful", reason: "context-size" }, rate: 1 }),
    ).toEqual({ tier: "balanced", exploration: true });
  });
});
