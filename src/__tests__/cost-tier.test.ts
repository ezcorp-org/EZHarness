/**
 * `costTierForBlendedRate` — the $3/$30 blended-rate thresholds shared by
 * `src/providers/registry.ts#inferTier` and `src/providers/kilo.ts#kiloCostTier`.
 */
import { test, expect, describe } from "bun:test";
import { costTierForBlendedRate } from "../runtime/routing/cost-tier";

describe("costTierForBlendedRate", () => {
  test("zero is low", () => {
    expect(costTierForBlendedRate(0)).toBe("low");
  });

  test("at and below the $3 boundary is low", () => {
    expect(costTierForBlendedRate(2.99)).toBe("low");
    expect(costTierForBlendedRate(3)).toBe("low");
  });

  test("just above $3 and up to $30 is medium", () => {
    expect(costTierForBlendedRate(3.01)).toBe("medium");
    expect(costTierForBlendedRate(15)).toBe("medium");
    expect(costTierForBlendedRate(30)).toBe("medium");
  });

  test("above $30 is high", () => {
    expect(costTierForBlendedRate(30.01)).toBe("high");
    expect(costTierForBlendedRate(1000)).toBe("high");
  });
});
