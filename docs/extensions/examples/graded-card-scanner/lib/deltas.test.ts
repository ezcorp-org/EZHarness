// Unit tests for the per-company adjacent-grade delta math. Pure — no I/O.

import { describe, expect, test } from "bun:test";
import { computeDeltas, round1 } from "./deltas";

describe("round1", () => {
  test("rounds to one decimal", () => {
    expect(round1(1063.28502)).toBe(1063.3);
    expect(round1(-12.44)).toBe(-12.4);
    expect(round1(5)).toBe(5);
  });
});

describe("computeDeltas", () => {
  test("adjacent priced grades produce % steps, rounded to 1 decimal", () => {
    const out = computeDeltas({
      PSA: { "9": 2587.5, "10": 30100, "8": 1201.99 },
    });
    expect(out).toEqual([
      {
        company: "PSA",
        steps: [
          { from: "8", to: "9", fromPrice: 1201.99, toPrice: 2587.5, pct: 115.3 },
          { from: "9", to: "10", fromPrice: 2587.5, toPrice: 30100, pct: 1063.3 },
        ],
      },
    ]);
  });

  test("null-priced grades are skipped — the step bridges to the next PRICED grade", () => {
    const out = computeDeltas({ BGS: { "8": 100, "9": null, "10": 500 } });
    expect(out).toEqual([
      {
        company: "BGS",
        steps: [{ from: "8", to: "10", fromPrice: 100, toPrice: 500, pct: 400 }],
      },
    ]);
  });

  test("companies with fewer than two priced grades are omitted (nothing to chart)", () => {
    const out = computeDeltas({
      CGC: { "10": 11300 },
      SGC: { "9": null, "10": null },
      PSA: {},
    });
    expect(out).toEqual([]);
  });

  test("half grades sort numerically (9 < 9.5 < 10), companies sort by name", () => {
    const out = computeDeltas({
      SGC: { "10": 8494.97, "9": 4000 },
      BGS: { "9.5": 3875, "10": 46000, "9": 2000 },
    });
    expect(out.map((c) => c.company)).toEqual(["BGS", "SGC"]);
    expect(out[0]!.steps.map((s) => `${s.from}→${s.to}`)).toEqual(["9→9.5", "9.5→10"]);
    expect(out[0]!.steps[0]!.pct).toBe(93.8); // (3875-2000)/2000*100 = 93.75 → 93.8
    expect(out[1]!.steps).toEqual([
      { from: "9", to: "10", fromPrice: 4000, toPrice: 8494.97, pct: 112.4 },
    ]);
  });

  test("a price DROP yields a negative pct (never clamped)", () => {
    const out = computeDeltas({ PSA: { "9": 200, "10": 150 } });
    expect(out[0]!.steps[0]!.pct).toBe(-25);
  });

  test("zero / negative prices cannot anchor a % comparison — treated as unpriced", () => {
    const out = computeDeltas({ PSA: { "8": 0, "9": 100, "10": 200 } });
    expect(out[0]!.steps).toEqual([
      { from: "9", to: "10", fromPrice: 100, toPrice: 200, pct: 100 },
    ]);
  });

  test("empty map → empty list", () => {
    expect(computeDeltas({})).toEqual([]);
  });
});
