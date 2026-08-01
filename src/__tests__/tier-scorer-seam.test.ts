/**
 * WS7 — the tier-scorer INFERENCE SEAM and the sweep's threshold override
 * (`src/runtime/tier-classifier.ts`).
 *
 * The headline contract is a NEGATIVE one: with no scorer injected — which is
 * every call in the shipped codebase — the classifier's output must be
 * byte-identical to the pre-seam function. That is proved the only way it can be
 * proved honestly: a VERBATIM reimplementation of the pre-seam classifier lives
 * in this file, and 80k+ generated inputs are asserted to serialize identically
 * through both. (Same technique WS3a used for the tier-ladder's registry scan.)
 *
 * The rest pins the precedence — `declaredTier` and `tierHint` still beat a
 * scorer, a scorer still beats the heuristic, and an abstaining scorer falls
 * through — plus the `thresholds` override the retroactive sweep replays with.
 */
import { test, expect, describe } from "bun:test";
import {
  AGENTIC_MIN_HISTORY_MESSAGES,
  AGENTIC_MIN_SYSTEM_TOKENS,
  ATTACHMENT_TOKEN_ESTIMATE,
  CHARS_PER_TOKEN,
  chooseTurnVerdict,
  classifyTier,
  classifyTierVerdict,
  DEFAULT_TIER_THRESHOLDS,
  FAST_MAX_TOKENS,
  POWERFUL_MIN_TOKENS,
  withScorerVersion,
  type RoutingConfig,
  type RoutingTier,
  type TierClassifierInput,
  type TierScorer,
} from "../runtime/tier-classifier";

// ── The pre-seam classifier, reimplemented verbatim ────────────────────
// Copied from the module as it stood BEFORE the scorer seam and the
// `thresholds` override landed. Deliberately independent: it re-derives the
// token estimate too, so a change to either half shows up as a mismatch.

function preSeamEstimate(input: TierClassifierInput): number {
  const chars =
    Math.max(0, input.promptChars) +
    Math.max(0, input.historyChars ?? 0) +
    Math.max(0, input.systemChars ?? 0);
  const attachmentTokens = Math.max(0, input.attachmentCount ?? 0) * ATTACHMENT_TOKEN_ESTIMATE;
  return Math.ceil(chars / CHARS_PER_TOKEN) + attachmentTokens;
}

function preSeamVerdict(input: TierClassifierInput): { tier: RoutingTier; reason: string; estTokens: number } {
  const estTokens = preSeamEstimate(input);
  if (input.declaredTier) return { tier: input.declaredTier, reason: "declared", estTokens };
  if (input.tierHint) return { tier: input.tierHint, reason: "hint", estTokens };
  if (input.hasToolMessages) return { tier: "powerful", reason: "tool-messages", estTokens };
  if ((input.historyMessageCount ?? 0) > AGENTIC_MIN_HISTORY_MESSAGES) {
    return { tier: "powerful", reason: "history-depth", estTokens };
  }
  if (
    Math.ceil(Math.max(0, input.systemChars ?? 0) / CHARS_PER_TOKEN) > AGENTIC_MIN_SYSTEM_TOKENS
  ) {
    return { tier: "powerful", reason: "system-size", estTokens };
  }
  if (input.hasComplexTools) return { tier: "powerful", reason: "complex-tools", estTokens };
  if (estTokens >= POWERFUL_MIN_TOKENS) return { tier: "powerful", reason: "context-size", estTokens };
  if ((input.toolCount ?? 0) > 0) return { tier: "balanced", reason: "tool-count", estTokens };
  if (estTokens <= FAST_MAX_TOKENS) return { tier: "fast", reason: "short-turn", estTokens };
  return { tier: "balanced", reason: "midsize-turn", estTokens };
}

/** Every input axis, with values chosen to straddle each threshold and each
 *  optional-field default. The cartesian product is ~83k cases. */
const AXES = {
  promptChars: [0, 100, 2_000, 40_000],
  historyChars: [undefined, 0, 5_000, 100_000],
  // 8 is AT the agentic history bound (must NOT fire), 9 is over it.
  historyMessageCount: [undefined, 0, AGENTIC_MIN_HISTORY_MESSAGES, AGENTIC_MIN_HISTORY_MESSAGES + 1],
  hasToolMessages: [undefined, false, true],
  // 8000 chars = exactly AGENTIC_MIN_SYSTEM_TOKENS tokens (must NOT fire).
  systemChars: [undefined, 0, AGENTIC_MIN_SYSTEM_TOKENS * CHARS_PER_TOKEN, AGENTIC_MIN_SYSTEM_TOKENS * CHARS_PER_TOKEN + 4],
  attachmentCount: [undefined, 0, 3],
  toolCount: [undefined, 0, 2],
  hasComplexTools: [undefined, false, true],
  tierHint: [undefined, "balanced" as RoutingTier],
  declaredTier: [undefined, "powerful" as RoutingTier],
} as const;

function* everyInput(): Generator<TierClassifierInput> {
  for (const promptChars of AXES.promptChars)
    for (const historyChars of AXES.historyChars)
      for (const historyMessageCount of AXES.historyMessageCount)
        for (const hasToolMessages of AXES.hasToolMessages)
          for (const systemChars of AXES.systemChars)
            for (const attachmentCount of AXES.attachmentCount)
              for (const toolCount of AXES.toolCount)
                for (const hasComplexTools of AXES.hasComplexTools)
                  for (const tierHint of AXES.tierHint)
                    for (const declaredTier of AXES.declaredTier)
                      yield {
                        promptChars,
                        historyChars,
                        historyMessageCount,
                        hasToolMessages,
                        systemChars,
                        attachmentCount,
                        toolCount,
                        hasComplexTools,
                        tierHint,
                        declaredTier,
                      };
}

describe("no scorer ⇒ byte-identical to the pre-seam classifier", () => {
  test("every generated input serializes to the same verdict", () => {
    let cases = 0;
    const mismatches: string[] = [];
    for (const input of everyInput()) {
      cases += 1;
      const actual = JSON.stringify(classifyTierVerdict(input));
      const expected = JSON.stringify(preSeamVerdict(input));
      if (actual !== expected) {
        mismatches.push(`${JSON.stringify(input)}\n  got ${actual}\n  want ${expected}`);
        if (mismatches.length > 3) break;
      }
    }
    expect(mismatches).toEqual([]);
    // Guard the guard: a generator that silently produced nothing would make the
    // assertion above vacuously true.
    expect(cases).toBeGreaterThan(80_000);
  });

  test("the tier-only wrapper agrees too", () => {
    for (const input of everyInput()) {
      if (input.promptChars !== 2_000) continue; // one slice, ~20k cases
      expect(classifyTier(input)).toBe(preSeamVerdict(input).tier);
    }
  });

  test("a heuristic verdict carries NO confidence key at all", () => {
    // Not merely `undefined`: an extra key would change the jsonb written to
    // `usage.routingSignals` on every routed turn.
    expect(Object.keys(classifyTierVerdict({ promptChars: 10 }))).toEqual([
      "tier",
      "reason",
      "estTokens",
    ]);
  });
});

// ── The seam ───────────────────────────────────────────────────────────

/** A stub scorer that always says `fast` — deliberately the opposite of what
 *  the heuristic says for the inputs below, so "who won" is unambiguous. */
const fastScorer: TierScorer = () => ({ tier: "fast", confidence: 0.87 });

/** A scorer that abstains on everything. */
const abstainingScorer: TierScorer = () => undefined;

/** A big, tool-driven turn: the heuristic routes it `powerful`. */
const bigTurn: TierClassifierInput = { promptChars: 100_000, hasToolMessages: true };

describe("scorer precedence", () => {
  test("a declared tier still wins over the scorer", () => {
    const v = classifyTierVerdict({ ...bigTurn, declaredTier: "balanced" }, fastScorer);
    expect(v.tier).toBe("balanced");
    expect(v.reason).toBe("declared");
    expect(v.confidence).toBeUndefined();
  });

  test("an explicit hint still wins over the scorer", () => {
    const v = classifyTierVerdict({ ...bigTurn, tierHint: "balanced" }, fastScorer);
    expect(v.tier).toBe("balanced");
    expect(v.reason).toBe("hint");
  });

  test("the scorer beats the heuristic", () => {
    expect(classifyTierVerdict(bigTurn).tier).toBe("powerful");
    const v = classifyTierVerdict(bigTurn, fastScorer);
    expect(v.tier).toBe("fast");
    expect(v.reason).toBe("scorer");
    expect(v.confidence).toBe(0.87);
  });

  test("an ABSTAINING scorer falls through to the heuristic verbatim", () => {
    expect(JSON.stringify(classifyTierVerdict(bigTurn, abstainingScorer))).toBe(
      JSON.stringify(preSeamVerdict(bigTurn)),
    );
  });

  test("the scorer receives the classifier's own input", () => {
    const seen: TierClassifierInput[] = [];
    const spy: TierScorer = (input) => {
      seen.push(input);
      return { tier: "balanced", confidence: 0.5 };
    };
    classifyTier({ promptChars: 42, toolCount: 3 }, spy);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.promptChars).toBe(42);
    expect(seen[0]?.toolCount).toBe(3);
  });
});

describe("chooseTurnVerdict — scorer version provenance", () => {
  const noManifests = () => undefined;
  const turn = {
    userMessage: "x".repeat(100_000),
    options: {},
    convExtensionTools: null,
    history: [{ role: "toolResult", content: "out" }],
  };

  test("a deciding scorer's version is reported and its confidence stamped", () => {
    const versioned: TierScorer = Object.assign(
      () => ({ tier: "fast" as RoutingTier, confidence: 0.4 }),
      { version: "router-v3" },
    );
    const v = chooseTurnVerdict(turn, noManifests, versioned);
    expect(v.tier).toBe("fast");
    expect(v.scorerVersion).toBe("router-v3");
    expect(v.signals.reason).toBe("scorer");
    expect(v.signals.confidence).toBe(0.4);
  });

  test("an ABSTAINING scorer's version is NOT reported — it shaped nothing", () => {
    const versioned: TierScorer = Object.assign(abstainingScorer, { version: "router-v3" });
    const v = chooseTurnVerdict(turn, noManifests, versioned);
    expect(v.scorerVersion).toBeUndefined();
    expect(v.signals.reason).toBe("tool-messages");
  });

  test("a deciding scorer with NO version reports none", () => {
    const v = chooseTurnVerdict(turn, noManifests, fastScorer);
    expect(v.tier).toBe("fast");
    expect(v.scorerVersion).toBeUndefined();
  });

  test("with no scorer, signals carry no confidence key and no version", () => {
    const v = chooseTurnVerdict(turn, noManifests);
    expect(v.scorerVersion).toBeUndefined();
    expect("confidence" in v.signals).toBe(false);
    expect(v.signals.reason).toBe("tool-messages");
  });
});

describe("withScorerVersion", () => {
  const config: RoutingConfig = { defaultTier: "balanced", preferenceOrderHash: "abcd1234" };

  test("no version ⇒ the SAME object, untouched (today's shipped path)", () => {
    expect(withScorerVersion(config, undefined)).toBe(config);
  });

  test("no config ⇒ undefined, whatever the version", () => {
    expect(withScorerVersion(undefined, "router-v3")).toBeUndefined();
  });

  test("a version is folded in without mutating the input", () => {
    expect(withScorerVersion(config, "router-v3")).toEqual({
      defaultTier: "balanced",
      preferenceOrderHash: "abcd1234",
      scorerVersion: "router-v3",
    });
    expect(config).toEqual({ defaultTier: "balanced", preferenceOrderHash: "abcd1234" });
  });
});

describe("thresholds override (what the sweep replays with)", () => {
  test("the default bundle IS the shipped constants", () => {
    expect(DEFAULT_TIER_THRESHOLDS).toEqual({
      fastMaxTokens: FAST_MAX_TOKENS,
      powerfulMinTokens: POWERFUL_MIN_TOKENS,
    });
  });

  test("passing the defaults explicitly changes nothing", () => {
    for (const input of everyInput()) {
      if (input.promptChars !== 100) continue;
      expect(JSON.stringify(classifyTierVerdict({ ...input, thresholds: DEFAULT_TIER_THRESHOLDS }))).toBe(
        JSON.stringify(preSeamVerdict(input)),
      );
    }
  });

  test("a lower powerful floor routes a mid-size turn up", () => {
    const turn: TierClassifierInput = { promptChars: 8_000 }; // 2000 est tokens
    expect(classifyTierVerdict(turn).tier).toBe("balanced");
    expect(
      classifyTierVerdict({ ...turn, thresholds: { fastMaxTokens: 500, powerfulMinTokens: 1_000 } }).tier,
    ).toBe("powerful");
  });

  test("a higher fast ceiling routes a mid-size turn down", () => {
    const turn: TierClassifierInput = { promptChars: 8_000 };
    expect(
      classifyTierVerdict({ ...turn, thresholds: { fastMaxTokens: 5_000, powerfulMinTokens: 8_000 } }).tier,
    ).toBe("fast");
  });

  test("the override does not touch the STRUCTURAL predicates", () => {
    // A tool-result turn is powerful on shape alone; no threshold can undo it.
    expect(
      classifyTierVerdict({
        promptChars: 1,
        hasToolMessages: true,
        thresholds: { fastMaxTokens: 1_000_000, powerfulMinTokens: 2_000_000 },
      }).reason,
    ).toBe("tool-messages");
  });
});
