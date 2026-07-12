import { test, expect, describe } from "bun:test";
import {
  contentTokens,
  cosineSimilarity,
  EXTENSION_SUGGEST_DEFAULTS,
  lexicalScore,
  maxExampleCosine,
  rankCandidates,
  RANK_DEFAULTS,
} from "../intent-rank";

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

  test("blended score formula: relevance*(1-w) + prior*w", () => {
    const [c] = rankCandidates(draft, [{ key: "k", embedding: [1, 0, 0] }], { k: 0.5 }, { priorWeight: 0.4 });
    expect(c!.score).toBeCloseTo(1 * 0.6 + 0.5 * 0.4);
  });
});

describe("maxExampleCosine", () => {
  const draft = [1, 0, 0];

  test("no examples → plain description cosine (back-compat)", () => {
    const desc = [0.5, Math.sqrt(1 - 0.25), 0]; // cosine 0.5
    expect(maxExampleCosine(draft, desc)).toBeCloseTo(0.5);
    expect(maxExampleCosine(draft, desc, [])).toBeCloseTo(0.5);
  });

  test("folds in the best example when it beats the description cosine", () => {
    const desc = [0.1, Math.sqrt(1 - 0.01), 0]; // 0.1
    const examples = [
      [0.3, Math.sqrt(1 - 0.09), 0], // 0.3
      [0.8, Math.sqrt(1 - 0.64), 0], // 0.8 ← best
    ];
    expect(maxExampleCosine(draft, desc, examples)).toBeCloseTo(0.8);
  });

  test("a weak example never drags the score below the description cosine", () => {
    const desc = [0.9, Math.sqrt(1 - 0.81), 0]; // 0.9
    expect(maxExampleCosine(draft, desc, [[0, 1, 0]])).toBeCloseTo(0.9);
  });
});

describe("rankCandidates — example-aware cosine (suggestExamples)", () => {
  const draft = [1, 0, 0];

  test("an authored example rescues a candidate whose description cosine is below the gate", () => {
    // Description cosine 0.2 (below the 0.28 default gate), but an example
    // matches the draft head-on — the candidate qualifies and its reported
    // cosine is the example max.
    const candidate = {
      key: "file-organizer",
      embedding: [0.2, Math.sqrt(1 - 0.04), 0],
      exampleEmbeddings: [[1, 0, 0]],
    };
    const [out] = rankCandidates(draft, [candidate], {});
    expect(out!.key).toBe("file-organizer");
    expect(out!.cosine).toBeCloseTo(1);
    expect(out!.relevance).toBeCloseTo(1);
  });

  test("without a matching example the low-cosine candidate stays gated out", () => {
    const candidate = {
      key: "file-organizer",
      embedding: [0.2, Math.sqrt(1 - 0.04), 0],
      exampleEmbeddings: [[0, 1, 0]], // orthogonal example — no rescue
    };
    expect(rankCandidates(draft, [candidate], {})).toEqual([]);
  });
});

describe("EXTENSION_SUGGEST_DEFAULTS", () => {
  test("2 slots, gate above the 0.32 live noise cosine, shared prior weight", () => {
    expect(EXTENSION_SUGGEST_DEFAULTS.topK).toBe(2);
    expect(EXTENSION_SUGGEST_DEFAULTS.minScore).toBe(0.35);
    expect(EXTENSION_SUGGEST_DEFAULTS.minScore).toBeGreaterThan(0.32);
    expect(EXTENSION_SUGGEST_DEFAULTS.priorWeight).toBe(RANK_DEFAULTS.priorWeight);
  });
});

describe("contentTokens", () => {
  test("lowercases, splits on non-alphanumerics, drops stop-words and short tokens", () => {
    expect(contentTokens("Search the Web for MY trip-notes!")).toEqual(
      new Set(["search", "web", "trip", "notes"]),
    );
  });

  test("empty/stop-word-only text → empty set", () => {
    expect(contentTokens("the for and")).toEqual(new Set());
    expect(contentTokens("")).toEqual(new Set());
  });
});

describe("lexicalScore", () => {
  const draft = contentTokens("search the web for the latest bun runtime release notes");

  test("name hits count double, capped at 1", () => {
    // 2 name hits (search, web) ×2 = 4 over 7 draft tokens.
    const name = contentTokens("web-search search-web");
    const desc = contentTokens("Search the web for a query. Returns a ranked markdown list.");
    expect(lexicalScore(draft, name, desc)).toBeCloseTo(4 / 7);
  });

  test("no overlap → 0; empty draft → 0; missing token sets → 0", () => {
    const name = contentTokens("generate-morning-briefing");
    const desc = contentTokens("Deterministic end-to-end briefing report synthesis.");
    expect(lexicalScore(draft, name, desc)).toBe(0);
    expect(lexicalScore(new Set(), name, desc)).toBe(0);
    expect(lexicalScore(draft)).toBe(0);
  });

  test("saturates at 1 when every draft token hits a name token", () => {
    const tokens = contentTokens("search web");
    expect(lexicalScore(tokens, tokens, new Set())).toBe(1);
  });
});

describe("rankCandidates — hybrid relevance (live regression 2026-07-10)", () => {
  // Reproduces the measured production miss: the RIGHT tool's cosine was
  // 0.19 (below the 0.28 gate) while an unrelated tool cleared it at 0.32.
  // Lexical overlap must qualify the right tool AND outrank the impostor.
  const draftTokens = contentTokens("search the web for the latest bun runtime release notes");
  // Orthogonal-ish embeddings tuned to the live cosines.
  const draft = [1, 0, 0];
  const searchWeb = {
    key: "web-search__search-web",
    embedding: [0.19, Math.sqrt(1 - 0.19 ** 2), 0], // cosine ≈ 0.19
    nameTokens: contentTokens("web-search search-web"),
    descTokens: contentTokens("Search the web for a query. Returns a ranked markdown list of results."),
  };
  const briefing = {
    key: "cash-recovery-agent__generate-morning-briefing",
    embedding: [0.32, Math.sqrt(1 - 0.32 ** 2), 0], // cosine ≈ 0.32
    nameTokens: contentTokens("cash-recovery-agent generate-morning-briefing"),
    descTokens: contentTokens("Deterministic end-to-end briefing report synthesis step."),
  };

  test("lexical overlap rescues the low-cosine right tool and ranks it first", () => {
    const out = rankCandidates(draft, [briefing, searchWeb], {}, undefined, draftTokens);
    expect(out.map((c) => c.key)).toEqual([
      "web-search__search-web",
      "cash-recovery-agent__generate-morning-briefing",
    ]);
    expect(out[0]!.lexical).toBeCloseTo(4 / 7);
    expect(out[0]!.relevance).toBeCloseTo(4 / 7); // max(cosine, lexical)
    expect(out[1]!.relevance).toBeCloseTo(0.32, 1);
  });

  test("without draft tokens the old embedding-only behavior holds (back-compat)", () => {
    const out = rankCandidates(draft, [briefing, searchWeb], {});
    expect(out.map((c) => c.key)).toEqual(["cash-recovery-agent__generate-morning-briefing"]);
  });

  test("lexical cannot drag DOWN a strong cosine (relevance is the max)", () => {
    const strong = { key: "k", embedding: [1, 0, 0], nameTokens: new Set<string>(), descTokens: new Set<string>() };
    const [c] = rankCandidates(draft, [strong], {}, undefined, draftTokens);
    expect(c!.relevance).toBeCloseTo(1);
    expect(c!.lexical).toBe(0);
  });
});
