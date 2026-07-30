/**
 * WS3a — the user-definable tier ladder.
 *
 *   T1  the pure ladder module: validation (write-time, strict) + tolerant
 *       parse (read-time) + resolution truth table
 *   T2  the DRY guarantee: both hardcoded maps this feature deletes are now
 *       PROJECTIONS of DEFAULT_TIER_LADDER, asserted here so deleting a rung
 *       fails a test instead of handing a caller `undefined`
 *   T3  the degrade-gracefully guarantee: with NO ladder configured,
 *       `findModelForProviderInTier` answers byte-identically to the code this
 *       PR replaced — proved for EVERY pi-ai provider × EVERY tier against a
 *       verbatim reimplementation of the pre-change function
 *   T4  the ladder actually routing: honored in declared order, unavailable
 *       rungs skipped, malformed row ignored
 */

import { test, expect, describe, mock, afterAll } from "bun:test";

import { restoreModuleMocks } from "./helpers/mock-cleanup";
// registry.ts imports getSetting from ../db/queries/settings which needs
// drizzle-orm. Mock it before the registry import so this file is self-contained.
mock.module("../db/queries/settings", () => ({
  getSetting: mock(() => Promise.resolve(undefined)),
  getAllSettings: mock(() => Promise.resolve({})),
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(false)),
  isListingInstalled: mock(() => Promise.resolve(false)),
}));

afterAll(() => restoreModuleMocks());

import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import type { KnownProvider } from "@earendil-works/pi-ai";
import {
  BUILTIN_ROUTER_PROVIDERS,
  DEFAULT_TIER_LADDER,
  MAX_LADDER_ENTRIES_PER_TIER,
  TIER_LADDER_SETTING_KEY,
  emptyTierLadder,
  isBuiltinRouterProvider,
  ladderCandidates,
  ladderModelFor,
  parseTierLadder,
  resolveLadderEntry,
  validateTierLadder,
  type TierLadder,
} from "../runtime/routing/tier-ladder";
import { VALID_TIERS, type RoutingTier } from "../runtime/tier-classifier";
import { CHEAP_MODEL_BY_PROVIDER } from "../lib/cheap-models";
import {
  findModelForProviderInTier,
  findRunnableModelForProviderInTier,
  tierForModel,
} from "../providers/registry";

/** A ladder with only the rungs a test names; the rest empty. */
function ladder(partial: Partial<TierLadder>): TierLadder {
  return { ...emptyTierLadder(), ...partial };
}

// ── T1: validation ───────────────────────────────────────────────────

describe("T1 — validateTierLadder (the WRITE-time gate)", () => {
  test("a full three-tier ladder round-trips in declared order", () => {
    const value = {
      fast: [
        { provider: "anthropic", model: "claude-haiku-4-5" },
        { provider: "google", model: "gemini-2.0-flash" },
      ],
      balanced: [{ provider: "anthropic", model: "claude-sonnet-4-5" }],
      powerful: [{ provider: "anthropic", model: "claude-opus-4-1" }],
    };
    const result = validateTierLadder(value);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.ladder.fast.map((e) => e.model)).toEqual([
      "claude-haiku-4-5",
      "gemini-2.0-flash",
    ]);
    expect(result.ladder.balanced).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-5" },
    ]);
    expect(result.ladder.powerful).toHaveLength(1);
  });

  test("a partial ladder fills the omitted tiers with empty rungs", () => {
    const result = validateTierLadder({ powerful: [{ provider: "openai", model: "gpt-5.5" }] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.ladder.fast).toEqual([]);
    expect(result.ladder.balanced).toEqual([]);
    expect(result.ladder.powerful).toHaveLength(1);
  });

  test("an empty object is a valid (no-op) ladder", () => {
    const result = validateTierLadder({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.ladder).toEqual(emptyTierLadder());
  });

  test("provider/model strings are trimmed so the stored row is canonical", () => {
    const result = validateTierLadder({ fast: [{ provider: "  openai ", model: " gpt-4o-mini " }] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.ladder.fast[0]).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  test.each([
    ["a non-object", 42, "must be an object"],
    ["null", null, "must be an object"],
    ["an array", [{ provider: "openai", model: "gpt-4o" }], "must be an object"],
    ["an unknown tier key", { blazing: [] }, 'unknown tier "blazing"'],
    ["a non-array rung", { fast: { provider: "openai" } }, 'tier "fast" must be an array'],
    ["a non-object entry", { fast: ["openai/gpt-4o"] }, "fast[0] must be an object"],
    ["a missing provider", { fast: [{ model: "gpt-4o" }] }, 'fast[0] needs a non-empty "provider"'],
    ["a blank provider", { fast: [{ provider: "   ", model: "gpt-4o" }] }, 'needs a non-empty "provider"'],
    ["a missing model", { balanced: [{ provider: "openai" }] }, 'balanced[0] needs a non-empty "model"'],
    ["a non-string model", { balanced: [{ provider: "openai", model: 7 }] }, 'needs a non-empty "model"'],
    ["an unknown entry field", { fast: [{ provider: "openai", model: "gpt-4o", tier: "fast" }] }, 'unknown field "tier"'],
  ])("rejects %s", (_label, value, expectedError) => {
    const result = validateTierLadder(value);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toContain(expectedError);
  });

  test("rejects a rung longer than the per-tier cap", () => {
    const rungs = Array.from({ length: MAX_LADDER_ENTRIES_PER_TIER + 1 }, (_, i) => ({
      provider: "openai",
      model: `m-${i}`,
    }));
    const result = validateTierLadder({ fast: rungs });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toContain(`max ${MAX_LADDER_ENTRIES_PER_TIER}`);
    // Exactly at the cap is accepted.
    expect(validateTierLadder({ fast: rungs.slice(0, MAX_LADDER_ENTRIES_PER_TIER) }).ok).toBe(true);
  });
});

describe("T1 — parseTierLadder (the tolerant READ)", () => {
  test("an absent row parses to undefined, not a throw", () => {
    expect(parseTierLadder(undefined)).toBeUndefined();
    expect(parseTierLadder(null)).toBeUndefined();
  });

  test("a MALFORMED row is ignored, not thrown — routing must never break", () => {
    for (const bad of [42, "fast", [], { blazing: [] }, { fast: [{ provider: "" }] }]) {
      expect(parseTierLadder(bad)).toBeUndefined();
    }
  });

  test("a valid row parses to the normalized ladder", () => {
    expect(parseTierLadder({ fast: [{ provider: "openai", model: "gpt-4o-mini" }] })).toEqual(
      ladder({ fast: [{ provider: "openai", model: "gpt-4o-mini" }] }),
    );
  });

  test("the setting key is the documented one", () => {
    expect(TIER_LADDER_SETTING_KEY).toBe("provider:tierModels");
  });
});

// ── T1: resolution truth table ───────────────────────────────────────

describe("T1 — resolveLadderEntry truth table", () => {
  const available = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("honors the ladder in DECLARED order, not availability order", () => {
    const l = ladder({
      fast: [
        { provider: "p", model: "c" },
        { provider: "p", model: "a" },
      ],
    });
    expect(resolveLadderEntry(l, "fast", "p", available)).toEqual({ id: "c" });
  });

  test("skips entries naming an unavailable model, in order", () => {
    const l = ladder({
      fast: [
        { provider: "p", model: "retired" },
        { provider: "p", model: "also-gone" },
        { provider: "p", model: "b" },
      ],
    });
    expect(resolveLadderEntry(l, "fast", "p", available)).toEqual({ id: "b" });
  });

  test("skips entries for a DIFFERENT provider", () => {
    const l = ladder({
      fast: [
        { provider: "other", model: "a" },
        { provider: "p", model: "b" },
      ],
    });
    expect(resolveLadderEntry(l, "fast", "p", available)).toEqual({ id: "b" });
  });

  test("returns the AVAILABLE member itself, so the caller needs no second lookup", () => {
    const rich = [{ id: "b", extra: "kept" }];
    expect(resolveLadderEntry(ladder({ fast: [{ provider: "p", model: "b" }] }), "fast", "p", rich))
      .toBe(rich[0]);
  });

  test("is tier-scoped — a balanced rung never answers a fast lookup", () => {
    const l = ladder({ balanced: [{ provider: "p", model: "a" }] });
    expect(resolveLadderEntry(l, "fast", "p", available)).toBeUndefined();
    expect(resolveLadderEntry(l, "balanced", "p", available)).toEqual({ id: "a" });
  });

  test.each([
    ["an unset ladder", undefined],
    ["an empty ladder", emptyTierLadder()],
    ["a ladder naming only unavailable models", ladder({ fast: [{ provider: "p", model: "zzz" }] })],
    ["a ladder naming only other providers", ladder({ fast: [{ provider: "q", model: "a" }] })],
  ])("%s yields undefined (caller falls through)", (_label, l) => {
    expect(resolveLadderEntry(l, "fast", "p", available)).toBeUndefined();
  });

  test("no available models at all yields undefined", () => {
    expect(resolveLadderEntry(ladder({ fast: [{ provider: "p", model: "a" }] }), "fast", "p", []))
      .toBeUndefined();
  });
});

describe("T1 — ladderCandidates (the credential-walk chain)", () => {
  const l = ladder({
    fast: [
      { provider: "anthropic", model: "haiku" },
      { provider: "openai", model: "mini" },
      { provider: "google", model: "flash" },
    ],
  });

  test("with no preferred provider it is the declared order verbatim", () => {
    expect(ladderCandidates(l, "fast").map((e) => e.provider)).toEqual([
      "anthropic",
      "openai",
      "google",
    ]);
  });

  test("hoists the preferred provider, preserving the order of the rest", () => {
    expect(ladderCandidates(l, "fast", "google").map((e) => e.provider)).toEqual([
      "google",
      "anthropic",
      "openai",
    ]);
  });

  test("a preferred provider with no rung changes nothing", () => {
    expect(ladderCandidates(l, "fast", "xai-grok").map((e) => e.provider)).toEqual([
      "anthropic",
      "openai",
      "google",
    ]);
  });

  test("hoists EVERY rung of the preferred provider, in order", () => {
    const multi = ladder({
      fast: [
        { provider: "openai", model: "one" },
        { provider: "anthropic", model: "haiku" },
        { provider: "openai", model: "two" },
      ],
    });
    expect(ladderCandidates(multi, "fast", "openai").map((e) => e.model)).toEqual([
      "one",
      "two",
      "haiku",
    ]);
  });

  test("an unset ladder and an empty tier both yield no candidates", () => {
    expect(ladderCandidates(undefined, "fast")).toEqual([]);
    expect(ladderCandidates(undefined, "fast", "openai")).toEqual([]);
    expect(ladderCandidates(l, "powerful")).toEqual([]);
  });

  test("the returned array is a copy — mutating it cannot corrupt the ladder", () => {
    const got = ladderCandidates(l, "fast");
    got.push({ provider: "evil", model: "x" });
    expect(l.fast).toHaveLength(3);
  });
});

// ── T2: the DRY guarantee ────────────────────────────────────────────

describe("T2 — the two deleted maps are now projections of the ladder", () => {
  test("CHEAP_MODEL_BY_PROVIDER is DEFAULT_TIER_LADDER's fast rung", () => {
    for (const provider of ["anthropic", "openai", "google", "ollama"] as const) {
      const fromLadder = ladderModelFor(DEFAULT_TIER_LADDER, "fast", provider);
      // The `as` cast in src/lib/cheap-models.ts promises these are defined.
      expect(fromLadder).toBeTruthy();
      expect(CHEAP_MODEL_BY_PROVIDER[provider]).toBe(fromLadder!);
    }
  });

  test("the old PREFERRED_TIER_MODELS entry lives on every tier of the built-in ladder", () => {
    for (const tier of VALID_TIERS) {
      expect(ladderModelFor(DEFAULT_TIER_LADDER, tier, "openrouter")).toBe("openrouter/auto");
    }
  });

  test("the built-in ladder answers registry routing for openrouter ONLY", () => {
    expect(BUILTIN_ROUTER_PROVIDERS).toEqual(["openrouter"]);
    expect(isBuiltinRouterProvider("openrouter")).toBe(true);
    expect(isBuiltinRouterProvider("anthropic")).toBe(false);
  });

  test("ladderModelFor returns undefined for a provider with no rung", () => {
    expect(ladderModelFor(DEFAULT_TIER_LADDER, "balanced", "anthropic")).toBeUndefined();
  });

  test("emptyTierLadder has all three tiers and no rungs", () => {
    const empty = emptyTierLadder();
    expect(Object.keys(empty).sort()).toEqual([...VALID_TIERS].sort());
    expect(Object.values(empty).every((rungs) => rungs.length === 0)).toBe(true);
  });
});

// ── T3: the degrade-gracefully guarantee ─────────────────────────────

/**
 * The pre-change `findModelForProviderInTier`, reproduced verbatim from
 * `git show 5c46ccff:src/providers/registry.ts` using only exported
 * primitives (`tierForModel` IS the private `inferTier(...).tier` the old body
 * called through `piModelToEntry`). `PREFERRED_TIER_MODELS` had exactly one
 * entry — `openrouter → openrouter/auto` — inlined here.
 */
function legacyFindModelForProviderInTier(provider: string, tier: RoutingTier): string | null {
  const models = getModels(provider as KnownProvider);
  const preferredId = provider === "openrouter" ? "openrouter/auto" : undefined;
  if (preferredId) {
    const preferred = models.find((m) => m.id === preferredId);
    if (preferred) return preferred.id;
  }
  for (const model of models) {
    if (tierForModel(model) === tier) return model.id;
  }
  return null;
}

describe("T3 — with NO ladder configured, routing is byte-identical to before", () => {
  test("every pi-ai provider × every tier matches the pre-change function", () => {
    const providers = getProviders();
    // Guard against the comparison silently degenerating to a no-op.
    expect(providers.length).toBeGreaterThan(20);
    let compared = 0;
    for (const provider of providers) {
      for (const tier of VALID_TIERS) {
        const now = findModelForProviderInTier(provider, tier);
        expect(now?.id ?? null).toBe(legacyFindModelForProviderInTier(provider, tier));
        compared++;
      }
    }
    expect(compared).toBe(providers.length * 3);
  });

  test("an EMPTY ladder is indistinguishable from no ladder", () => {
    for (const provider of getProviders()) {
      for (const tier of VALID_TIERS) {
        expect(findModelForProviderInTier(provider, tier, emptyTierLadder())?.id ?? null).toBe(
          legacyFindModelForProviderInTier(provider, tier),
        );
      }
    }
  });

  test("a MALFORMED stored row is ignored, leaving the pre-change answer", () => {
    // This is the real read path: parseTierLadder(row) feeds the registry.
    const fromBadRow = parseTierLadder({ fast: [{ provider: 42 }] });
    expect(fromBadRow).toBeUndefined();
    expect(findModelForProviderInTier("anthropic", "fast", fromBadRow)?.id ?? null).toBe(
      legacyFindModelForProviderInTier("anthropic", "fast"),
    );
  });

  test("the openrouter built-in survives — the alphabetical scan is still overridden", () => {
    // Without the built-in rung this would be `ai21/jamba-large-1.7` etc.
    for (const tier of VALID_TIERS) {
      expect(findModelForProviderInTier("openrouter", tier)?.id).toBe("openrouter/auto");
    }
  });

  test("a provider with no model in the tier still returns null", () => {
    expect(findModelForProviderInTier("anthropic" as never, "nonexistent" as never)).toBeNull();
  });
});

// ── T4: the ladder routing ───────────────────────────────────────────

describe("T4 — a configured ladder decides which model a tier gets", () => {
  test("the configured rung beats the alphabetical scan", () => {
    const scanned = findModelForProviderInTier("openai", "fast")!.id;
    const configured = findModelForProviderInTier(
      "openai",
      "fast",
      ladder({ fast: [{ provider: "openai", model: "gpt-4o-mini" }] }),
    );
    expect(configured!.id).toBe("gpt-4o-mini");
    expect(configured!.id).not.toBe(scanned);
    expect(configured!.provider).toBe("openai");
  });

  test("a configured rung beats the BUILT-IN rung for the same provider", () => {
    const configured = findModelForProviderInTier(
      "openrouter",
      "balanced",
      ladder({ balanced: [{ provider: "openrouter", model: "openai/gpt-4o" }] }),
    );
    expect(configured!.id).toBe("openai/gpt-4o");
  });

  test("unavailable rungs are skipped in order, then the scan runs", () => {
    const l = ladder({
      fast: [
        { provider: "openai", model: "gpt-4o-mini-retired-snapshot" },
        { provider: "openai", model: "gpt-4o-mini" },
      ],
    });
    expect(findModelForProviderInTier("openai", "fast", l)!.id).toBe("gpt-4o-mini");

    const allGone = ladder({ fast: [{ provider: "openai", model: "no-such-model" }] });
    expect(findModelForProviderInTier("openai", "fast", allGone)?.id ?? null).toBe(
      legacyFindModelForProviderInTier("openai", "fast"),
    );
  });

  test("the ladder can name a model whose inferred tier differs — the operator decides", () => {
    // gpt-4o-mini infers as `fast`; naming it on the powerful rung routes it.
    const l = ladder({ powerful: [{ provider: "openai", model: "gpt-4o-mini" }] });
    expect(findModelForProviderInTier("openai", "powerful", l)!.id).toBe("gpt-4o-mini");
  });

  test("findRunnableModelForProviderInTier threads the ladder on the api-key path", () => {
    const l = ladder({ fast: [{ provider: "openai", model: "gpt-4o-mini" }] });
    expect(findRunnableModelForProviderInTier("openai", "fast", "apikey", l)!.id).toBe(
      "gpt-4o-mini",
    );
    // …and with no ladder is unchanged from the plain lookup.
    expect(findRunnableModelForProviderInTier("openai", "fast", "apikey")?.id ?? null).toBe(
      legacyFindModelForProviderInTier("openai", "fast"),
    );
  });

  test("on the OAuth path the ladder picks only from subscription-eligible models", () => {
    const baseline = findRunnableModelForProviderInTier("openai", "fast", "oauth")!.id;
    // gpt-5.5 is OAuth-only (LOCAL_OAUTH_OVERRIDES) — a legal rung here.
    const oauthOnly = ladder({ fast: [{ provider: "openai", model: "gpt-5.5" }] });
    expect(findRunnableModelForProviderInTier("openai", "fast", "oauth", oauthOnly)!.id).toBe(
      "gpt-5.5",
    );
    // A rung this credential cannot run is skipped, leaving the baseline pick.
    const unrunnable = ladder({ fast: [{ provider: "openai", model: "gpt-4o-mini" }] });
    expect(findRunnableModelForProviderInTier("openai", "fast", "oauth", unrunnable)!.id).toBe(
      baseline,
    );
  });
});
