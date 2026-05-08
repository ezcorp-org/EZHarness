/**
 * agent-fuzzy-search-worker — pure ranking-function tests
 * (Phase 49.2).
 *
 * The worker module exports `rank(req)` directly so we can test the
 * scoring + ordering contract without the postMessage indirection.
 * This is the same test contract the bridge would exercise via the
 * worker's reply protocol; pinning it here lets us iterate on
 * scoring without spinning up a Worker stub.
 */

import { test, expect, describe } from "bun:test";
import { rank } from "../agent-fuzzy-search-worker";

describe("agent-fuzzy-search-worker — rank()", () => {
  test("ranks exact-prefix matches before subsequence matches", () => {
    const res = rank({
      type: "rank",
      id: "r1",
      query: "sum",
      candidates: [
        { name: "translator", description: "summarize text" },
        { name: "summarizer", description: "compresses input" },
        { name: "code-reviewer", description: "no match" },
      ],
    });
    // "summarizer" starts with "sum" → highest. "translator" matches
    // through its description → second. "code-reviewer" has no fuzzy
    // match anywhere → dropped entirely.
    expect(res.indices).toEqual([1, 0]);
    expect(res.scores.length).toBe(2);
    expect(res.scores[0]).toBeGreaterThan(res.scores[1]!);
  });

  test("ties broken by name ascending when scores are identical", () => {
    // Three names of identical length that all prefix-match the query
    // → identical fuzzyScore (5000 - len_diff). The bridge's secondary
    // sort key (`name.localeCompare`) decides the final order so the
    // user sees a stable list rather than insertion order.
    const res = rank({
      type: "rank",
      id: "r2",
      query: "abc",
      candidates: [
        { name: "abc-zzz" },
        { name: "abc-aaa" },
        { name: "abc-mmm" },
      ],
    });
    const names = res.indices.map((i) => ["abc-zzz", "abc-aaa", "abc-mmm"][i]);
    expect(names).toEqual(["abc-aaa", "abc-mmm", "abc-zzz"]);
    // Confirm the scores were equal — that's what triggers the tiebreak.
    expect(res.scores[0]).toBe(res.scores[1]!);
    expect(res.scores[1]).toBe(res.scores[2]!);
  });

  test("non-matching query returns no indices", () => {
    const res = rank({
      type: "rank",
      id: "r3",
      query: "qqqzzz-impossible",
      candidates: [
        { name: "alpha" },
        { name: "beta" },
      ],
    });
    expect(res.indices).toEqual([]);
    expect(res.scores).toEqual([]);
  });

  test("description match counts when name doesn't fuzzy-match", () => {
    const res = rank({
      type: "rank",
      id: "r4",
      query: "translate",
      candidates: [
        { name: "language-helper", description: "translate text fast" },
        { name: "summarizer", description: "shrink prose" },
      ],
    });
    expect(res.indices).toEqual([0]);
  });

  test("null / undefined description is tolerated", () => {
    const res = rank({
      type: "rank",
      id: "r5",
      query: "alpha",
      candidates: [
        { name: "alpha", description: null },
        { name: "beta" },
      ],
    });
    expect(res.indices).toEqual([0]);
  });

  test("response carries the request id back unchanged", () => {
    const res = rank({
      type: "rank",
      id: "carry-this-id",
      query: "x",
      candidates: [{ name: "x" }],
    });
    expect(res.id).toBe("carry-this-id");
    expect(res.type).toBe("ranked");
  });
});
