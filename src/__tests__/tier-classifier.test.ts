import { describe, test, expect } from "bun:test";
import {
  classifyTier,
  strongestTier,
  isRoutingTier,
  manifestRoutingTier,
  declaredTierForConversation,
  estimateToolSignals,
  chooseTurnTier,
  CHARS_PER_TOKEN,
  FAST_MAX_TOKENS,
  POWERFUL_MIN_TOKENS,
  type ExtensionRoutingManifest,
} from "../runtime/tier-classifier";

// ── constants sanity ────────────────────────────────────────────────
describe("tier thresholds", () => {
  test("chars-per-token and token thresholds are the documented values", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(FAST_MAX_TOKENS).toBe(500);
    expect(POWERFUL_MIN_TOKENS).toBe(8000);
  });
});

// ── isRoutingTier ────────────────────────────────────────────────────
describe("isRoutingTier", () => {
  test("accepts the three tiers", () => {
    expect(isRoutingTier("fast")).toBe(true);
    expect(isRoutingTier("balanced")).toBe(true);
    expect(isRoutingTier("powerful")).toBe(true);
  });
  test("rejects everything else", () => {
    expect(isRoutingTier("reasoning")).toBe(false);
    expect(isRoutingTier("")).toBe(false);
    expect(isRoutingTier(undefined)).toBe(false);
    expect(isRoutingTier(null)).toBe(false);
    expect(isRoutingTier(2)).toBe(false);
    expect(isRoutingTier({ tier: "fast" })).toBe(false);
  });
});

// ── classifyTier ─────────────────────────────────────────────────────
describe("classifyTier", () => {
  test("declaredTier wins over hint and heuristic", () => {
    expect(
      classifyTier({
        promptChars: 10,
        declaredTier: "powerful",
        tierHint: "fast",
        hasComplexTools: false,
      }),
    ).toBe("powerful");
  });

  test("tierHint wins over heuristic when no declared tier", () => {
    expect(classifyTier({ promptChars: 1_000_000, tierHint: "fast" })).toBe("fast");
  });

  test("complex tools force powerful", () => {
    expect(classifyTier({ promptChars: 5, hasComplexTools: true })).toBe("powerful");
  });

  test("very large context routes to powerful (no tools)", () => {
    // POWERFUL_MIN_TOKENS tokens worth of characters.
    const chars = POWERFUL_MIN_TOKENS * CHARS_PER_TOKEN;
    expect(classifyTier({ promptChars: chars })).toBe("powerful");
  });

  test("any tool use routes to at least balanced", () => {
    // Short prompt that would otherwise be `fast`, but a tool is present.
    expect(classifyTier({ promptChars: 10, toolCount: 1 })).toBe("balanced");
  });

  test("short tool-less turn routes to fast", () => {
    expect(classifyTier({ promptChars: FAST_MAX_TOKENS * CHARS_PER_TOKEN })).toBe("fast");
  });

  test("mid-size tool-less turn routes to balanced", () => {
    // Between FAST_MAX and POWERFUL_MIN, no tools.
    const chars = (FAST_MAX_TOKENS + 1) * CHARS_PER_TOKEN + 4;
    expect(classifyTier({ promptChars: chars })).toBe("balanced");
  });

  test("toolCount defaults to 0 when omitted", () => {
    // No toolCount → falls through to the length-only fast/balanced split.
    expect(classifyTier({ promptChars: 4 })).toBe("fast");
  });

  test("negative promptChars is clamped to 0 (fast)", () => {
    expect(classifyTier({ promptChars: -50 })).toBe("fast");
  });
});

// ── strongestTier ────────────────────────────────────────────────────
describe("strongestTier", () => {
  test("empty list → undefined", () => {
    expect(strongestTier([])).toBeUndefined();
  });
  test("all null/undefined → undefined", () => {
    expect(strongestTier([undefined, null])).toBeUndefined();
  });
  test("single tier passes through", () => {
    expect(strongestTier(["balanced"])).toBe("balanced");
  });
  test("picks the highest rank (upgrade path)", () => {
    expect(strongestTier(["fast", "powerful", "balanced"])).toBe("powerful");
  });
  test("keeps the incumbent when a later tier is not stronger", () => {
    // Exercises the `TIER_RANK[t] > TIER_RANK[best]` false branch.
    expect(strongestTier(["powerful", "fast"])).toBe("powerful");
  });
});

// ── manifestRoutingTier ──────────────────────────────────────────────
describe("manifestRoutingTier", () => {
  test("null / undefined manifest → undefined", () => {
    expect(manifestRoutingTier(undefined)).toBeUndefined();
    expect(manifestRoutingTier(null)).toBeUndefined();
  });
  test("manifest without routing → undefined", () => {
    expect(manifestRoutingTier({})).toBeUndefined();
  });
  test("routing without tier → undefined", () => {
    expect(manifestRoutingTier({ routing: {} })).toBeUndefined();
  });
  test("invalid tier value → undefined", () => {
    expect(manifestRoutingTier({ routing: { tier: "reasoning" } })).toBeUndefined();
    expect(manifestRoutingTier({ routing: { tier: 3 } })).toBeUndefined();
  });
  test("valid tier passes through", () => {
    expect(manifestRoutingTier({ routing: { tier: "powerful" } })).toBe("powerful");
  });
});

// ── declaredTierForConversation ──────────────────────────────────────
describe("declaredTierForConversation", () => {
  const manifests: Record<string, ExtensionRoutingManifest> = {
    "ext-fast": { routing: { tier: "fast" } },
    "ext-powerful": { routing: { tier: "powerful" } },
    "ext-none": {},
  };
  const resolve = (id: string): ExtensionRoutingManifest | undefined => manifests[id];

  test("null map → undefined", () => {
    expect(declaredTierForConversation(null, resolve)).toBeUndefined();
    expect(declaredTierForConversation(undefined, resolve)).toBeUndefined();
  });

  test("empty map → undefined", () => {
    expect(declaredTierForConversation({}, resolve)).toBeUndefined();
  });

  test("combines declared tiers, strongest wins", () => {
    const map = { "ext-fast": ["a"], "ext-powerful": ["b"], "ext-none": ["c"] };
    expect(declaredTierForConversation(map, resolve)).toBe("powerful");
  });

  test("skips extensions toggled OFF (empty subset)", () => {
    // ext-powerful is toggled off → only ext-fast contributes.
    const map = { "ext-fast": ["a"], "ext-powerful": [] };
    expect(declaredTierForConversation(map, resolve)).toBe("fast");
  });

  test("extension with no routing declaration contributes nothing", () => {
    const map = { "ext-none": ["c"] };
    expect(declaredTierForConversation(map, resolve)).toBeUndefined();
  });

  test("unknown extension id (resolver returns undefined) → skipped", () => {
    const map = { "ext-unknown": ["a"] };
    expect(declaredTierForConversation(map, resolve)).toBeUndefined();
  });
});

// ── estimateToolSignals ──────────────────────────────────────────────
describe("estimateToolSignals", () => {
  test("toolRestriction 'none' → no tools", () => {
    expect(estimateToolSignals({ toolRestriction: "none", projectId: "p" })).toEqual({
      toolCount: 0,
      hasComplexTools: false,
    });
  });

  test("project → complex tools + one source", () => {
    expect(estimateToolSignals({ projectId: "p" })).toEqual({
      toolCount: 1,
      hasComplexTools: true,
    });
  });

  test("agent config only → one source, not complex", () => {
    expect(estimateToolSignals({ agentConfigId: "a" })).toEqual({
      toolCount: 1,
      hasComplexTools: false,
    });
  });

  test("project + agent config → two sources", () => {
    expect(estimateToolSignals({ projectId: "p", agentConfigId: "a" })).toEqual({
      toolCount: 2,
      hasComplexTools: true,
    });
  });

  test("orchestration depth alone marks complex", () => {
    expect(estimateToolSignals({ orchestrationDepth: 1 })).toEqual({
      toolCount: 0,
      hasComplexTools: true,
    });
  });

  test("read-only restriction keeps tools present but non-complex", () => {
    expect(estimateToolSignals({ toolRestriction: "read-only", projectId: "p" })).toEqual({
      toolCount: 1,
      hasComplexTools: false,
    });
  });

  test("no options → nothing", () => {
    expect(estimateToolSignals({})).toEqual({ toolCount: 0, hasComplexTools: false });
  });
});

// ── chooseTurnTier ───────────────────────────────────────────────────
describe("chooseTurnTier", () => {
  const resolveNone = (): ExtensionRoutingManifest | undefined => undefined;

  test("short tool-less turn on a fresh thread → fast", () => {
    expect(
      chooseTurnTier(
        { userMessage: "hi", options: {}, convExtensionTools: null },
        resolveNone,
      ),
    ).toBe("fast");
  });

  test("project turn → powerful via complex tools", () => {
    expect(
      chooseTurnTier(
        { userMessage: "do a refactor", options: { projectId: "p" }, convExtensionTools: null },
        resolveNone,
      ),
    ).toBe("powerful");
  });

  test("extension-declared tier overrides the heuristic", () => {
    const resolvePowerful = (): ExtensionRoutingManifest => ({ routing: { tier: "powerful" } });
    expect(
      chooseTurnTier(
        { userMessage: "hi", options: {}, convExtensionTools: { "ext-x": ["t"] } },
        resolvePowerful,
      ),
    ).toBe("powerful");
  });

  test("explicit options.tier hint is honored", () => {
    expect(
      chooseTurnTier(
        { userMessage: "hi", options: { tier: "balanced" }, convExtensionTools: null },
        resolveNone,
      ),
    ).toBe("balanced");
  });
});
