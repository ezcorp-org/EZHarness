/**
 * WS3b — the mode → model/tier task binding
 * (`src/runtime/routing/mode-binding.ts`).
 *
 * `resolveTurnModelBinding` owns the WHOLE precedence chain above the
 * heuristic classifier, so the centrepiece here is a truth table: for every
 * combination of "caller pinned a model / a provider / nothing" ×
 * "mode names a model / a tier / neither" × "the named model still exists",
 * assert which level won AND that each level falls through correctly when
 * its input is absent.
 *
 * The module is pure — no DB, no registry — so every case is a direct call.
 * The wiring's fail-open envelope is tested separately in
 * setup-tools-mode-binding.test.ts.
 */
import { test, expect, describe } from "bun:test";
import {
  resolveTurnModelBinding,
  type AvailableModel,
  type ModeRoutingPreference,
} from "../runtime/routing/mode-binding";

/** A deployment that serves two Anthropic models and one OpenAI model. */
const CATALOG: AvailableModel[] = [
  { id: "claude-opus-4-6", provider: "anthropic" },
  { id: "claude-haiku-4-5", provider: "anthropic" },
  { id: "gpt-5.2", provider: "openai" },
];

function mode(overrides: Partial<ModeRoutingPreference> = {}): ModeRoutingPreference {
  return { preferredProvider: null, preferredModel: null, preferredTier: null, ...overrides };
}

describe("resolveTurnModelBinding — the precedence truth table", () => {
  // Each row is one rung of
  //   per-turn UI pin → conversation pin → mode model → mode tier → classifier
  // exercised with EVERY lower rung also populated, so a row passing proves
  // the level named actually WINS rather than merely being reachable.
  const richMode = mode({
    preferredProvider: "anthropic",
    preferredModel: "claude-opus-4-6",
    preferredTier: "fast",
  });

  test("level 1/2 — a turn pin (UI or conversation model) beats every mode preference", () => {
    const binding = resolveTurnModelBinding(
      { provider: "openai", model: "gpt-5.2" },
      richMode,
      CATALOG,
    );
    expect(binding).toEqual({ provider: "openai", model: "gpt-5.2", source: "turn-pin" });
    // Nothing to classify, so no tier hint is emitted.
    expect(binding.tier).toBeUndefined();
  });

  test("level 3 — with NO turn pin, the mode's preferred model wins over its tier", () => {
    const binding = resolveTurnModelBinding({}, richMode, CATALOG);
    expect(binding).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-6",
      source: "mode-model",
    });
    // A pinned turn is never classified, so the mode's tier is NOT emitted.
    expect(binding.tier).toBeUndefined();
  });

  test("level 4 — with the mode's model removed, its tier becomes the classifier hint", () => {
    const binding = resolveTurnModelBinding(
      {},
      mode({ preferredProvider: "anthropic", preferredTier: "fast" }),
      CATALOG,
    );
    expect(binding).toEqual({ provider: "anthropic", tier: "fast", source: "mode-tier" });
    expect(binding.model).toBeUndefined();
  });

  test("level 5 — with no mode preference at all, everything falls to the classifier", () => {
    const binding = resolveTurnModelBinding({}, mode(), CATALOG);
    expect(binding).toEqual({ provider: undefined, tier: undefined, source: "classifier" });
  });

  test("each level falls through cleanly when only IT is absent", () => {
    // model pin absent → mode model; mode model absent → mode tier; mode tier
    // absent → classifier. Same mode row, one field removed at a time.
    expect(resolveTurnModelBinding({}, richMode, CATALOG).source).toBe("mode-model");
    expect(resolveTurnModelBinding({}, mode({ preferredTier: "powerful" }), CATALOG).source).toBe(
      "mode-tier",
    );
    expect(resolveTurnModelBinding({}, mode(), CATALOG).source).toBe("classifier");
  });
});

describe("resolveTurnModelBinding — a caller-pinned PROVIDER", () => {
  test("beats the mode's provider/model pair (never a cross-provider mix)", () => {
    const binding = resolveTurnModelBinding(
      { provider: "openai" },
      mode({ preferredProvider: "anthropic", preferredModel: "claude-opus-4-6" }),
      CATALOG,
    );
    // The caller's provider survives; the mode's Anthropic model does NOT
    // get handed to it.
    expect(binding).toEqual({ provider: "openai", tier: undefined, source: "classifier" });
  });

  test("still lets the mode's TIER through as the classifier hint", () => {
    const binding = resolveTurnModelBinding(
      { provider: "openai" },
      mode({ preferredModel: "claude-opus-4-6", preferredTier: "powerful" }),
      CATALOG,
    );
    expect(binding).toEqual({ provider: "openai", tier: "powerful", source: "mode-tier" });
  });
});

describe("resolveTurnModelBinding — availability", () => {
  test("a mode naming a model the deployment no longer serves FALLS THROUGH (no error)", () => {
    // The retired-snapshot case: resolveModelObject would happily synthesize
    // a model object for this id, so availability has to be checked here.
    const binding = resolveTurnModelBinding(
      {},
      mode({ preferredProvider: "anthropic", preferredModel: "claude-3-5-sonnet-20241022" }),
      CATALOG,
    );
    expect(binding.model).toBeUndefined();
    expect(binding.source).toBe("classifier");
    // The provider is still served, so it survives the model's removal.
    expect(binding.provider).toBe("anthropic");
  });

  test("an unavailable model + a still-set tier degrades to the tier, not an error", () => {
    const binding = resolveTurnModelBinding(
      {},
      mode({ preferredModel: "gone-4", preferredTier: "balanced" }),
      CATALOG,
    );
    expect(binding).toEqual({ provider: undefined, tier: "balanced", source: "mode-tier" });
  });

  test("a mode naming a model on the WRONG provider falls through (pair is atomic)", () => {
    const binding = resolveTurnModelBinding(
      {},
      mode({ preferredProvider: "openai", preferredModel: "claude-opus-4-6" }),
      CATALOG,
    );
    expect(binding.model).toBeUndefined();
    // openai IS served, so the provider half of the preference still applies.
    expect(binding.provider).toBe("openai");
  });

  test("a model named with NO provider takes the provider from the matched catalog entry", () => {
    // resolveModel ignores a model id passed without a provider, so the pair
    // must always leave here complete.
    const binding = resolveTurnModelBinding({}, mode({ preferredModel: "gpt-5.2" }), CATALOG);
    expect(binding).toEqual({ provider: "openai", model: "gpt-5.2", source: "mode-model" });
  });

  test("an unrecognized provider is dropped like any other stale preference", () => {
    const binding = resolveTurnModelBinding(
      {},
      mode({ preferredProvider: "provider-that-left", preferredTier: "fast" }),
      CATALOG,
    );
    expect(binding).toEqual({ provider: undefined, tier: "fast", source: "mode-tier" });
  });

  test("an empty catalog can honor nothing the mode named, but still throws nothing", () => {
    const binding = resolveTurnModelBinding(
      {},
      mode({
        preferredProvider: "anthropic",
        preferredModel: "claude-opus-4-6",
        preferredTier: "powerful",
      }),
      [],
    );
    expect(binding).toEqual({ provider: undefined, tier: "powerful", source: "mode-tier" });
  });
});

describe("resolveTurnModelBinding — tolerating what the DB can actually hold", () => {
  test("an unrecognized preferred_tier is ignored (degrades, never routes on garbage)", () => {
    // Plain TEXT column, no CHECK — a hand-edited or older-build row can hold
    // anything, including the legacy wizard vocabulary.
    for (const raw of ["quality", "budget", "POWERFUL", "", "  ", "null"]) {
      const binding = resolveTurnModelBinding({}, mode({ preferredTier: raw }), CATALOG);
      expect(binding.tier).toBeUndefined();
      expect(binding.source).toBe("classifier");
    }
  });

  test("blank / whitespace-only model + provider preferences mean 'unset', not a pin on ''", () => {
    const binding = resolveTurnModelBinding(
      {},
      mode({ preferredProvider: "   ", preferredModel: "  " }),
      CATALOG,
    );
    expect(binding).toEqual({ provider: undefined, tier: undefined, source: "classifier" });
  });

  test("surrounding whitespace on a real preference is trimmed, not rejected", () => {
    const binding = resolveTurnModelBinding(
      {},
      mode({ preferredProvider: " anthropic ", preferredModel: " claude-haiku-4-5 " }),
      CATALOG,
    );
    expect(binding).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      source: "mode-model",
    });
  });

  test("no mode row at all (null / undefined) resolves to the classifier", () => {
    for (const missing of [null, undefined]) {
      expect(resolveTurnModelBinding({}, missing, CATALOG)).toEqual({
        provider: undefined,
        tier: undefined,
        source: "classifier",
      });
    }
  });

  test("a turn pin survives even when there is no mode row", () => {
    expect(resolveTurnModelBinding({ provider: "anthropic", model: "x" }, null, [])).toEqual({
      provider: "anthropic",
      model: "x",
      source: "turn-pin",
    });
  });
});
