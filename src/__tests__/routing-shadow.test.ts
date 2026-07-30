import { describe, expect, test } from "bun:test";
import {
  ROUTING_SHADOW_SETTING_KEY,
  THRESHOLD_IMMUNE_REASONS,
  evaluateShadow,
  parseShadowThresholds,
  replayWithThresholds,
  validateShadowThresholds,
} from "../runtime/routing/shadow";
import {
  DEFAULT_TIER_THRESHOLDS,
  FAST_MAX_TOKENS,
  POWERFUL_MIN_TOKENS,
  classifyTierVerdict,
} from "../runtime/tier-classifier";

/** ~1 token per 4 chars — sized so the tier is unambiguous under the shipped
 *  thresholds, then re-scored under a candidate pair. */
function charsForTokens(tokens: number): number {
  return tokens * 4;
}

describe("ROUTING_SHADOW_SETTING_KEY", () => {
  test("is the documented admin-gated key", () => {
    expect(ROUTING_SHADOW_SETTING_KEY).toBe("provider:routingShadow");
  });
});

describe("parseShadowThresholds", () => {
  test("accepts a well-formed candidate pair", () => {
    expect(parseShadowThresholds({ fastMaxTokens: 250, powerfulMinTokens: 4000 })).toEqual({
      fastMaxTokens: 250,
      powerfulMinTokens: 4000,
    });
  });

  test.each([
    ["unset", undefined],
    ["null", null],
    ["a string", "250/4000"],
    ["a number", 250],
    ["an array", [250, 4000]],
    ["an empty object", {}],
    ["a missing powerful bound", { fastMaxTokens: 250 }],
    ["a missing fast bound", { powerfulMinTokens: 4000 }],
    ["a non-numeric bound", { fastMaxTokens: "250", powerfulMinTokens: 4000 }],
    ["a fractional bound", { fastMaxTokens: 250.5, powerfulMinTokens: 4000 }],
    ["NaN", { fastMaxTokens: Number.NaN, powerfulMinTokens: 4000 }],
    ["Infinity", { fastMaxTokens: 250, powerfulMinTokens: Number.POSITIVE_INFINITY }],
    ["a zero bound", { fastMaxTokens: 0, powerfulMinTokens: 4000 }],
    ["a negative bound", { fastMaxTokens: -1, powerfulMinTokens: 4000 }],
  ])("rejects %s — shadow mode stays off rather than breaking routing", (_label, value) => {
    expect(parseShadowThresholds(value)).toBeUndefined();
  });

  test("rejects an INVERTED pair, which would silently make everything powerful", () => {
    expect(parseShadowThresholds({ fastMaxTokens: 8000, powerfulMinTokens: 500 })).toBeUndefined();
    // Equal bounds collapse the middle band the same way.
    expect(parseShadowThresholds({ fastMaxTokens: 500, powerfulMinTokens: 500 })).toBeUndefined();
  });
});

describe("replayWithThresholds", () => {
  test("reproduces the live classifier when handed the shipped thresholds", () => {
    // The guarantee the whole feature rests on: shadow runs the REAL
    // classifier, so with today's numbers it must agree on every turn.
    for (const tokens of [10, 100, 499, 500, 501, 4000, 7999, 8000, 12000]) {
      const signals = { promptChars: charsForTokens(tokens) };
      expect(replayWithThresholds(signals, DEFAULT_TIER_THRESHOLDS)).toBe(
        classifyTierVerdict({ promptChars: charsForTokens(tokens) }).tier,
      );
    }
  });

  test("a tighter fast bound moves a mid-size turn up off the fast tier", () => {
    const signals = { promptChars: charsForTokens(400) };
    expect(replayWithThresholds(signals, DEFAULT_TIER_THRESHOLDS)).toBe("fast");
    expect(replayWithThresholds(signals, { fastMaxTokens: 200, powerfulMinTokens: 8000 })).toBe(
      "balanced",
    );
  });

  test("a lower powerful bound pulls a large turn up to powerful", () => {
    const signals = { promptChars: charsForTokens(5000) };
    expect(replayWithThresholds(signals, DEFAULT_TIER_THRESHOLDS)).toBe("balanced");
    expect(replayWithThresholds(signals, { fastMaxTokens: 500, powerfulMinTokens: 4000 })).toBe(
      "powerful",
    );
  });

  test("structural signals still dominate the thresholds", () => {
    // A tool-loop turn is powerful regardless of how the candidate is tuned —
    // thresholds must not be able to undo a structural predicate.
    const signals = { promptChars: 4, hasToolMessages: true };
    expect(replayWithThresholds(signals, { fastMaxTokens: 100_000, powerfulMinTokens: 200_000 })).toBe(
      "powerful",
    );
  });

  test("counts history and system chars, not just the prompt", () => {
    const promptOnly = { promptChars: charsForTokens(100) };
    const withHistory = { promptChars: charsForTokens(100), historyChars: charsForTokens(6000) };
    const thresholds = { fastMaxTokens: 500, powerfulMinTokens: 4000 };
    expect(replayWithThresholds(promptOnly, thresholds)).toBe("fast");
    expect(replayWithThresholds(withHistory, thresholds)).toBe("powerful");
  });
});

describe("evaluateShadow", () => {
  const heuristicSignals = {
    promptChars: charsForTokens(400),
    tier: "fast" as const,
    reason: "size" as const,
  };

  test("writes nothing when shadow mode is off", () => {
    expect(evaluateShadow(heuristicSignals, undefined)).toBeUndefined();
  });

  test("reports agreement when the candidate matches the acted tier", () => {
    const v = evaluateShadow(heuristicSignals, DEFAULT_TIER_THRESHOLDS);
    expect(v).toEqual({ tier: "fast", agreed: true });
  });

  test("reports the DISAGREEMENT and what the candidate would have served", () => {
    const v = evaluateShadow(heuristicSignals, { fastMaxTokens: 200, powerfulMinTokens: 8000 });
    expect(v).toEqual({ tier: "balanced", agreed: false });
  });

  test.each([...THRESHOLD_IMMUNE_REASONS])(
    "writes nothing for a %s turn — thresholds could never have moved it",
    (reason: string) => {
      // Absent, NOT `agreed: true`. Counting an unmovable turn as agreement
      // would flatter every candidate ever shadowed.
      const v = evaluateShadow(
        { promptChars: charsForTokens(400), tier: "powerful", reason },
        { fastMaxTokens: 1, powerfulMinTokens: 2 },
      );
      expect(v).toBeUndefined();
    },
  );

  test("compares against the CLASSIFIER's tier, not an exploration deviation", () => {
    // Exploration serves one rung below on purpose; the signals keep the
    // classifier's own verdict, which is what the candidate is scored against.
    const v = evaluateShadow(
      { promptChars: charsForTokens(9000), tier: "powerful", reason: "size" },
      DEFAULT_TIER_THRESHOLDS,
    );
    expect(v).toEqual({ tier: "powerful", agreed: true });
  });

  test("the shipped thresholds as a candidate agree on every heuristic turn", () => {
    for (const tokens of [10, 400, 600, 5000, 9000]) {
      const tier = classifyTierVerdict({ promptChars: charsForTokens(tokens) }).tier;
      const v = evaluateShadow(
        { promptChars: charsForTokens(tokens), tier, reason: "size" },
        DEFAULT_TIER_THRESHOLDS,
      );
      expect(v?.agreed).toBe(true);
    }
  });

  test("DEFAULT_TIER_THRESHOLDS really are the shipped constants", () => {
    expect(DEFAULT_TIER_THRESHOLDS).toEqual({
      fastMaxTokens: FAST_MAX_TOKENS,
      powerfulMinTokens: POWERFUL_MIN_TOKENS,
    });
  });
});

/**
 * WRITE-time validation. The read path is tolerant on purpose (shadow must
 * never fail a turn), which is exactly why the write has to be strict: a typo
 * that silently disabled the feature would be indistinguishable from never
 * having configured it.
 */
describe("validateShadowThresholds", () => {
  test("accepts a well-formed candidate and returns the normalized pair", () => {
    const result = validateShadowThresholds({ fastMaxTokens: 250, powerfulMinTokens: 4000 });
    expect(result).toEqual({ ok: true, thresholds: { fastMaxTokens: 250, powerfulMinTokens: 4000 } });
  });

  test("drops unknown keys — only the two thresholds are stored", () => {
    const result = validateShadowThresholds({
      fastMaxTokens: 250,
      powerfulMinTokens: 4000,
      note: "from last week's sweep",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.thresholds).toEqual({ fastMaxTokens: 250, powerfulMinTokens: 4000 });
  });

  test.each([
    ["a non-object", "250/4000", "expected an object"],
    ["null", null, "expected an object"],
    ["an array", [250, 4000], "expected an object"],
    ["a missing fast bound", { powerfulMinTokens: 4000 }, "fastMaxTokens"],
    ["a missing powerful bound", { fastMaxTokens: 250 }, "powerfulMinTokens"],
    ["a fractional fast bound", { fastMaxTokens: 1.5, powerfulMinTokens: 4000 }, "fastMaxTokens"],
    ["a zero bound", { fastMaxTokens: 0, powerfulMinTokens: 4000 }, "fastMaxTokens"],
    ["a negative bound", { fastMaxTokens: 250, powerfulMinTokens: -1 }, "powerfulMinTokens"],
    ["NaN", { fastMaxTokens: Number.NaN, powerfulMinTokens: 4000 }, "fastMaxTokens"],
  ])("rejects %s with an explanatory error", (_label, value, expectedFragment) => {
    const result = validateShadowThresholds(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(expectedFragment as string);
  });

  test("rejects an INVERTED pair and explains what it would have done", () => {
    const result = validateShadowThresholds({ fastMaxTokens: 8000, powerfulMinTokens: 500 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("must be BELOW");
      // The operator is told the CONSEQUENCE, not just "invalid".
      expect(result.error).toContain("powerful");
    }
  });

  test("everything the strict write accepts, the tolerant read also accepts", () => {
    // The two must never disagree, or a value could pass validation and then be
    // silently ignored at routing time — the exact failure this pairing exists
    // to prevent.
    for (const candidate of [
      { fastMaxTokens: 1, powerfulMinTokens: 2 },
      { fastMaxTokens: 250, powerfulMinTokens: 4000 },
      { fastMaxTokens: 500, powerfulMinTokens: 8000 },
    ]) {
      const written = validateShadowThresholds(candidate);
      expect(written.ok).toBe(true);
      if (written.ok) expect(parseShadowThresholds(written.thresholds)).toEqual(written.thresholds);
    }
  });
});
