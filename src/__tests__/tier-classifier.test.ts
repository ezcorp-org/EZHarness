import { describe, test, expect } from "bun:test";
import {
  classifyTier,
  classifyTierVerdict,
  estimateTurnTokens,
  strongestTier,
  isRoutingTier,
  manifestRoutingTier,
  declaredTierForConversation,
  estimateToolSignals,
  contentChars,
  summarizeHistory,
  chooseTurnTier,
  chooseTurnVerdict,
  preferenceOrderHash,
  CHARS_PER_TOKEN,
  FAST_MAX_TOKENS,
  POWERFUL_MIN_TOKENS,
  AGENTIC_MIN_HISTORY_MESSAGES,
  AGENTIC_MIN_SYSTEM_TOKENS,
  ATTACHMENT_TOKEN_ESTIMATE,
  TOOL_RESULT_ROLE,
  type ExtensionRoutingManifest,
  type TierClassifierInput,
  type TierHistoryMessage,
  type TierReason,
} from "../runtime/tier-classifier";

// ── constants sanity ────────────────────────────────────────────────
describe("tier thresholds", () => {
  test("chars-per-token and token thresholds are the documented values", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(FAST_MAX_TOKENS).toBe(500);
    expect(POWERFUL_MIN_TOKENS).toBe(8000);
  });

  test("WS5 structural thresholds are exported as named consts (sweepable)", () => {
    // A later sweep script reads these by name to re-derive tiers from
    // stored `usage.routingSignals` — they must stay exported constants.
    expect(AGENTIC_MIN_HISTORY_MESSAGES).toBe(8);
    expect(AGENTIC_MIN_SYSTEM_TOKENS).toBe(2000);
    expect(ATTACHMENT_TOKEN_ESTIMATE).toBe(750);
    expect(TOOL_RESULT_ROLE).toBe("toolResult");
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

// ── WS5: estimateTurnTokens ──────────────────────────────────────────
describe("estimateTurnTokens", () => {
  test("sums prompt + history + system chars at the chars/4 rate", () => {
    // (40 + 80 + 40) / 4 = 40 tokens.
    expect(estimateTurnTokens({ promptChars: 40, historyChars: 80, systemChars: 40 })).toBe(40);
  });

  test("bills a flat surcharge per attachment on top of the char estimate", () => {
    expect(estimateTurnTokens({ promptChars: 8, attachmentCount: 2 })).toBe(
      2 + 2 * ATTACHMENT_TOKEN_ESTIMATE,
    );
  });

  test("every component is clamped at 0 — negatives can only under-count", () => {
    expect(
      estimateTurnTokens({
        promptChars: -100,
        historyChars: -100,
        systemChars: -100,
        attachmentCount: -5,
      }),
    ).toBe(0);
  });

  test("omitted components contribute nothing", () => {
    expect(estimateTurnTokens({ promptChars: 400 })).toBe(100);
  });
});

// ── WS5: the widened truth table ─────────────────────────────────────
describe("classifyTierVerdict — widened truth table", () => {
  const cases: Array<{
    name: string;
    input: TierClassifierInput;
    tier: "fast" | "balanced" | "powerful";
    reason: TierReason;
  }> = [
    // THE motivating case for this whole workstream. A four-word follow-up
    // is the CHEAPEST-looking and most context-heavy turn there is: before
    // WS5 it scored on `promptChars` alone and routed `fast`.
    {
      name: "short follow-up INSIDE A TOOL LOOP → powerful (was fast)",
      input: { promptChars: "now fix it".length, hasToolMessages: true },
      tier: "powerful",
      reason: "tool-messages",
    },
    {
      name: "a tool result in history beats even a zero-length prompt",
      input: { promptChars: 0, hasToolMessages: true },
      tier: "powerful",
      reason: "tool-messages",
    },
    // History depth: structural, fires regardless of prompt length.
    {
      name: "history deeper than the threshold → powerful",
      input: { promptChars: 4, historyMessageCount: AGENTIC_MIN_HISTORY_MESSAGES + 1 },
      tier: "powerful",
      reason: "history-depth",
    },
    {
      name: "history AT the threshold does not fire (strictly over)",
      input: { promptChars: 4, historyMessageCount: AGENTIC_MIN_HISTORY_MESSAGES },
      tier: "fast",
      reason: "short-turn",
    },
    // System size: also structural.
    {
      name: "system prompt over the token threshold → powerful",
      input: { promptChars: 4, systemChars: (AGENTIC_MIN_SYSTEM_TOKENS + 1) * CHARS_PER_TOKEN },
      tier: "powerful",
      reason: "system-size",
    },
    {
      name: "system prompt AT the threshold falls through to the size half",
      input: { promptChars: 4, systemChars: AGENTIC_MIN_SYSTEM_TOKENS * CHARS_PER_TOKEN },
      // ceil((4 + 8000)/4) = 2001 tokens: over FAST_MAX, under POWERFUL_MIN.
      tier: "balanced",
      reason: "midsize-turn",
    },
    // The size half now counts history + system + attachments too.
    {
      name: "long history alone pushes a short prompt to powerful on SIZE",
      input: { promptChars: 4, historyChars: POWERFUL_MIN_TOKENS * CHARS_PER_TOKEN },
      tier: "powerful",
      reason: "context-size",
    },
    {
      name: "attachments alone can carry a short prompt to powerful",
      input: {
        promptChars: 4,
        attachmentCount: Math.ceil(POWERFUL_MIN_TOKENS / ATTACHMENT_TOKEN_ESTIMATE),
      },
      tier: "powerful",
      reason: "context-size",
    },
    {
      name: "one attachment on a short prompt → balanced, not fast",
      input: { promptChars: 4, attachmentCount: 1 },
      tier: "balanced",
      reason: "midsize-turn",
    },
    // Pre-WS5 reasons still reachable, in their original order.
    {
      name: "complex tools still force powerful",
      input: { promptChars: 4, hasComplexTools: true },
      tier: "powerful",
      reason: "complex-tools",
    },
    {
      name: "read-class tool use still lands balanced",
      input: { promptChars: 4, toolCount: 1 },
      tier: "balanced",
      reason: "tool-count",
    },
    {
      name: "short tool-less turn is still fast",
      input: { promptChars: 4 },
      tier: "fast",
      reason: "short-turn",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const verdict = classifyTierVerdict(c.input);
      expect(verdict.tier).toBe(c.tier);
      expect(verdict.reason).toBe(c.reason);
      // The raw size is always reported, so a sweep can re-derive the
      // decision from the stored row.
      expect(verdict.estTokens).toBe(estimateTurnTokens(c.input));
    });
  }

  test("structural predicates are checked before the size half (reason attribution)", () => {
    // Both a tool result AND complex tools are present. Same tier either
    // way, but the reason must name the STRUCTURAL cause so a sweep can
    // tell the two populations apart.
    expect(
      classifyTierVerdict({ promptChars: 4, hasToolMessages: true, hasComplexTools: true }).reason,
    ).toBe("tool-messages");
    expect(
      classifyTierVerdict({
        promptChars: 4,
        historyMessageCount: AGENTIC_MIN_HISTORY_MESSAGES + 1,
        hasComplexTools: true,
      }).reason,
    ).toBe("history-depth");
    expect(
      classifyTierVerdict({
        promptChars: 4,
        systemChars: (AGENTIC_MIN_SYSTEM_TOKENS + 1) * CHARS_PER_TOKEN,
        hasComplexTools: true,
      }).reason,
    ).toBe("system-size");
  });

  test("classifyTier is exactly the verdict's tier", () => {
    const input: TierClassifierInput = { promptChars: 4, hasToolMessages: true };
    expect(classifyTier(input)).toBe(classifyTierVerdict(input).tier);
  });
});

// ── WS5: precedence is sacred ────────────────────────────────────────
describe("classifyTier — precedence over the NEW signals", () => {
  // Every new signal, all firing at once, at their most extreme.
  const allNewSignalsScreamingPowerful: TierClassifierInput = {
    promptChars: 4,
    historyChars: 10_000_000,
    historyMessageCount: 500,
    hasToolMessages: true,
    systemChars: 10_000_000,
    attachmentCount: 100,
  };

  test("declaredTier beats tierHint AND every new signal", () => {
    const verdict = classifyTierVerdict({
      ...allNewSignalsScreamingPowerful,
      tierHint: "balanced",
      declaredTier: "fast",
    });
    expect(verdict.tier).toBe("fast");
    expect(verdict.reason).toBe("declared");
  });

  test("tierHint beats every new signal when no tier is declared", () => {
    const verdict = classifyTierVerdict({
      ...allNewSignalsScreamingPowerful,
      tierHint: "fast",
    });
    expect(verdict.tier).toBe("fast");
    expect(verdict.reason).toBe("hint");
  });

  test("with neither, the new signals decide", () => {
    expect(classifyTier(allNewSignalsScreamingPowerful)).toBe("powerful");
  });
});

// ── WS5: regression guard — legacy callers are unchanged ─────────────
describe("classifyTier — legacy input produces the PRE-WS5 tier exactly", () => {
  // Every one of these is a promptChars-only input: the shape every caller
  // used before WS5. The expectations are the pre-WS5 outputs, transcribed
  // from the original truth table above. If a widening ever changes one of
  // these, it changed behaviour for existing callers.
  const legacy: Array<[TierClassifierInput, "fast" | "balanced" | "powerful"]> = [
    [{ promptChars: 0 }, "fast"],
    [{ promptChars: -50 }, "fast"],
    [{ promptChars: 4 }, "fast"],
    [{ promptChars: FAST_MAX_TOKENS * CHARS_PER_TOKEN }, "fast"],
    [{ promptChars: (FAST_MAX_TOKENS + 1) * CHARS_PER_TOKEN + 4 }, "balanced"],
    [{ promptChars: POWERFUL_MIN_TOKENS * CHARS_PER_TOKEN }, "powerful"],
    [{ promptChars: 10, toolCount: 1 }, "balanced"],
    [{ promptChars: 5, hasComplexTools: true }, "powerful"],
    [{ promptChars: 1_000_000, tierHint: "fast" }, "fast"],
    [{ promptChars: 10, declaredTier: "powerful", tierHint: "fast", hasComplexTools: false }, "powerful"],
  ];

  for (const [input, expected] of legacy) {
    test(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(classifyTier(input)).toBe(expected);
    });
  }

  test("an EMPTY history/system/attachment context is inert", () => {
    // Explicitly passing the zero values must equal omitting them.
    expect(
      classifyTier({
        promptChars: 4,
        historyChars: 0,
        historyMessageCount: 0,
        hasToolMessages: false,
        systemChars: 0,
        attachmentCount: 0,
      }),
    ).toBe(classifyTier({ promptChars: 4 }));
  });
});

// ── WS5: contentChars ────────────────────────────────────────────────
describe("contentChars", () => {
  test("plain string content counts its length", () => {
    expect(contentChars("hello")).toBe(5);
  });
  test("sums the text parts of a parts array", () => {
    expect(contentChars([{ type: "text", text: "abc" }, { type: "text", text: "de" }])).toBe(5);
  });
  test("non-text parts count 0 (their cost is billed via attachmentCount)", () => {
    expect(contentChars([{ type: "image", data: "AAAABBBBCCCC", mimeType: "image/png" }])).toBe(0);
  });
  test("mixed parts count only the text", () => {
    expect(
      contentChars([{ type: "image", data: "AAAA" }, { type: "text", text: "hi" }]),
    ).toBe(2);
  });
  test("tolerates null / non-array / non-string payloads", () => {
    expect(contentChars(null)).toBe(0);
    expect(contentChars(undefined)).toBe(0);
    expect(contentChars(42)).toBe(0);
    expect(contentChars({ text: "not an array" })).toBe(0);
    expect(contentChars([null, undefined, "bare string part"])).toBe(0);
  });
});

// ── WS5: summarizeHistory ────────────────────────────────────────────
describe("summarizeHistory", () => {
  test("null / undefined / empty → all-zero, tool-free", () => {
    const zero = { historyChars: 0, historyMessageCount: 0, hasToolMessages: false };
    expect(summarizeHistory(null)).toEqual(zero);
    expect(summarizeHistory(undefined)).toEqual(zero);
    expect(summarizeHistory([])).toEqual(zero);
  });

  test("counts messages and text chars in one pass", () => {
    const history: TierHistoryMessage[] = [
      { role: "user", content: "12345" },
      { role: "assistant", content: [{ type: "text", text: "678" }] },
    ];
    expect(summarizeHistory(history)).toEqual({
      historyChars: 8,
      historyMessageCount: 2,
      hasToolMessages: false,
    });
  });

  test("flags a tool-result role anywhere in the array", () => {
    const history: TierHistoryMessage[] = [
      { role: "user", content: "go" },
      { role: TOOL_RESULT_ROLE, content: "tool output" },
      { role: "assistant", content: "done" },
    ];
    expect(summarizeHistory(history).hasToolMessages).toBe(true);
  });

  test("a user/assistant-only history is NOT flagged as a tool loop", () => {
    const history: TierHistoryMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ];
    expect(summarizeHistory(history).hasToolMessages).toBe(false);
  });

  test("a message with no content contributes count but no chars", () => {
    expect(summarizeHistory([{ role: "user" }])).toEqual({
      historyChars: 0,
      historyMessageCount: 1,
      hasToolMessages: false,
    });
  });
});

// ── WS5: chooseTurnVerdict ───────────────────────────────────────────
describe("chooseTurnVerdict", () => {
  const resolveNone = (): ExtensionRoutingManifest | undefined => undefined;

  test("THE motivating turn: four words + a tool-loop history → powerful", () => {
    const verdict = chooseTurnVerdict(
      {
        userMessage: "now fix it",
        options: {},
        convExtensionTools: null,
        history: [
          { role: "user", content: "run the tests" },
          { role: "assistant", content: "calling the shell tool" },
          { role: TOOL_RESULT_ROLE, content: "3 failures" },
        ],
      },
      resolveNone,
    );
    expect(verdict.tier).toBe("powerful");
    expect(verdict.signals.reason).toBe("tool-messages");
    expect(verdict.signals.hasToolMessages).toBe(true);
    // The raw inputs are all reported for retroactive sweeping.
    expect(verdict.signals.promptChars).toBe("now fix it".length);
    expect(verdict.signals.historyMessageCount).toBe(3);
    expect(verdict.signals.historyChars).toBe(
      "run the tests".length + "calling the shell tool".length + "3 failures".length,
    );
  });

  test("the SAME four-word message with no history stays fast", () => {
    // Proves the tier change above comes from the history, not the prompt.
    const verdict = chooseTurnVerdict(
      { userMessage: "now fix it", options: {}, convExtensionTools: null },
      resolveNone,
    );
    expect(verdict.tier).toBe("fast");
    expect(verdict.signals.reason).toBe("short-turn");
  });

  test("reports the full raw signal record, including the chosen tier", () => {
    const verdict = chooseTurnVerdict(
      {
        userMessage: "hello",
        options: { projectId: "p", agentConfigId: "a" },
        convExtensionTools: null,
        history: [{ role: "user", content: "prior" }],
        systemChars: 400,
        attachmentCount: 2,
      },
      resolveNone,
    );
    expect(verdict.signals).toEqual({
      promptChars: 5,
      historyChars: 5,
      historyMessageCount: 1,
      hasToolMessages: false,
      systemChars: 400,
      attachmentCount: 2,
      toolCount: 2,
      hasComplexTools: true,
      estTokens: Math.ceil((5 + 5 + 400) / CHARS_PER_TOKEN) + 2 * ATTACHMENT_TOKEN_ESTIMATE,
      tier: "powerful",
      reason: "complex-tools",
    });
    expect(verdict.tier).toBe(verdict.signals.tier);
  });

  test("omitted context defaults to zero — same verdict as the pre-WS5 bridge", () => {
    const verdict = chooseTurnVerdict(
      { userMessage: "hi", options: {}, convExtensionTools: null },
      resolveNone,
    );
    expect(verdict.signals.historyChars).toBe(0);
    expect(verdict.signals.historyMessageCount).toBe(0);
    expect(verdict.signals.hasToolMessages).toBe(false);
    expect(verdict.signals.systemChars).toBe(0);
    expect(verdict.signals.attachmentCount).toBe(0);
    expect(verdict.tier).toBe("fast");
  });

  test("negative systemChars / attachmentCount are clamped to 0", () => {
    const verdict = chooseTurnVerdict(
      {
        userMessage: "hi",
        options: {},
        convExtensionTools: null,
        systemChars: -1000,
        attachmentCount: -3,
      },
      resolveNone,
    );
    expect(verdict.signals.systemChars).toBe(0);
    expect(verdict.signals.attachmentCount).toBe(0);
    expect(verdict.tier).toBe("fast");
  });

  test("a null history is accepted (same as absent)", () => {
    const verdict = chooseTurnVerdict(
      { userMessage: "hi", options: {}, convExtensionTools: null, history: null },
      resolveNone,
    );
    expect(verdict.signals.historyMessageCount).toBe(0);
  });

  test("an extension-declared tier still wins, and the signals say so", () => {
    const verdict = chooseTurnVerdict(
      {
        userMessage: "hi",
        options: {},
        convExtensionTools: { "ext-x": ["t"] },
        history: [{ role: TOOL_RESULT_ROLE, content: "out" }],
      },
      () => ({ routing: { tier: "fast" } }),
    );
    // Declared "fast" beats the tool-loop history — precedence intact.
    expect(verdict.tier).toBe("fast");
    expect(verdict.signals.reason).toBe("declared");
    // …and the raw signal that LOST is still logged, so a sweep can find it.
    expect(verdict.signals.hasToolMessages).toBe(true);
  });

  test("chooseTurnTier is exactly chooseTurnVerdict's tier", () => {
    const input = {
      userMessage: "now fix it",
      options: {},
      convExtensionTools: null,
      history: [{ role: TOOL_RESULT_ROLE, content: "out" }],
    };
    expect(chooseTurnTier(input, resolveNone)).toBe(chooseTurnVerdict(input, resolveNone).tier);
  });
});

// ── WS5: preferenceOrderHash ─────────────────────────────────────────
describe("preferenceOrderHash", () => {
  test("stable for the same order", () => {
    const a = preferenceOrderHash(["anthropic", "openai"]);
    expect(preferenceOrderHash(["anthropic", "openai"])).toBe(a);
  });

  test("ORDER-sensitive — a reorder is a different config", () => {
    expect(preferenceOrderHash(["anthropic", "openai"])).not.toBe(
      preferenceOrderHash(["openai", "anthropic"]),
    );
  });

  test("a different member set hashes differently", () => {
    expect(preferenceOrderHash(["anthropic"])).not.toBe(
      preferenceOrderHash(["anthropic", "google"]),
    );
  });

  test("null / undefined / empty all hash as the empty order", () => {
    const empty = preferenceOrderHash([]);
    expect(preferenceOrderHash(null)).toBe(empty);
    expect(preferenceOrderHash(undefined)).toBe(empty);
  });

  test("always 8 lowercase hex chars", () => {
    for (const order of [[], ["a"], ["anthropic", "openai", "google", "openrouter"]]) {
      expect(preferenceOrderHash(order)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});
