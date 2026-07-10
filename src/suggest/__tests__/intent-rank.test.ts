import { test, expect, describe } from "bun:test";
import { cosineSimilarity, rankCandidates, RANK_DEFAULTS } from "../intent-rank";

describe("cosineSimilarity", () => {
  test("identical unit vectors → 1", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  test("orthogonal vectors → 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  test("opposite vectors → -1", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  test("unnormalized inputs are normalized by magnitude", () => {
    expect(cosineSimilarity([3, 0], [7, 0])).toBeCloseTo(1);
  });

  test("mismatched lengths → 0", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  test("empty vectors → 0", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test("zero-norm vector → 0 (no NaN)", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("rankCandidates", () => {
  const draft = [1, 0, 0];
  const relevant = { key: "ext__match", embedding: [0.9, 0.1, 0] };
  const partial = { key: "ext__partial", embedding: [0.5, 0.5, 0] };
  const irrelevant = { key: "ext__off", embedding: [0, 0, 1] };

  test("orders by blended score, filters below minScore", () => {
    const out = rankCandidates(draft, [irrelevant, partial, relevant], {});
    expect(out.map((c) => c.key)).toEqual(["ext__match", "ext__partial"]);
    expect(out[0]!.cosine).toBeGreaterThan(out[1]!.cosine);
  });

  test("minScore gates on RAW cosine — a huge prior cannot rescue an irrelevant tool", () => {
    const out = rankCandidates(draft, [irrelevant], { ext__off: 1 });
    expect(out).toEqual([]);
  });

  test("prior boosts among relevant candidates", () => {
    const a = { key: "ext__a", embedding: [0.8, 0.6, 0] };
    const b = { key: "ext__b", embedding: [0.8, 0.6, 0] };
    const out = rankCandidates(draft, [a, b], { ext__b: 1 });
    expect(out[0]!.key).toBe("ext__b");
    expect(out[0]!.prior).toBe(1);
    expect(out[1]!.prior).toBe(0);
  });

  test("cold start: unused relevant tool still surfaces with zero prior", () => {
    const out = rankCandidates(draft, [relevant], {});
    expect(out).toHaveLength(1);
    expect(out[0]!.prior).toBe(0);
  });

  test("topK caps the result", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      key: `ext__t${i}`,
      embedding: [1, 0, 0],
    }));
    const out = rankCandidates(draft, many, {}, { topK: 3 });
    expect(out).toHaveLength(3);
  });

  test("equal scores tie-break deterministically by key", () => {
    const out = rankCandidates(
      draft,
      [
        { key: "ext__b", embedding: [1, 0, 0] },
        { key: "ext__a", embedding: [1, 0, 0] },
      ],
      {},
    );
    expect(out.map((c) => c.key)).toEqual(["ext__a", "ext__b"]);
  });

  test("option overrides apply on top of defaults", () => {
    const out = rankCandidates(draft, [partial], {}, { minScore: 0.9 });
    expect(out).toEqual([]);
    expect(RANK_DEFAULTS.minScore).toBeLessThan(0.9);
  });

  test("blended score formula: cosine*(1-w) + prior*w", () => {
    const [c] = rankCandidates(draft, [{ key: "k", embedding: [1, 0, 0] }], { k: 0.5 }, { priorWeight: 0.4 });
    expect(c!.score).toBeCloseTo(1 * 0.6 + 0.5 * 0.4);
  });
});
