/**
 * WS7 — the routing LABEL DEFINITION (`src/runtime/routing/labels.ts`).
 *
 * The exclusion tests here are the blocking ones. A capability-driven switch
 * ("I attached an image, so I moved to a vision model"; "the context outgrew the
 * window") labelled as a quality escalation would teach a future router to
 * escalate on every attachment, forever — and unlike a bad threshold, a poisoned
 * label survives every later fix. So each exclusion class has a test that pins
 * it to `excluded`, and specifically NOT to `negative`.
 *
 * The module is pure, so everything is driven through hand-built message trees
 * and an injected facts resolver — no DB, no registry.
 */
import { test, expect, describe } from "bun:test";
import {
  CONTEXT_PRESSURE_RATIO,
  countLabels,
  labelConversation,
  POSITIVE_MIN_FOLLOWING_TURNS,
  type LabelMessage,
  type LabelledSample,
  type ModelFacts,
  type ModelFactsResolver,
  type StoredRoutingSignals,
} from "../runtime/routing/labels";

const CONV = "conv-labels";
const BASE = Date.UTC(2026, 0, 1);
const at = (i: number) => new Date(BASE + i * 60_000).toISOString();

const TEXT = "text/plain";
const IMAGE = "image/png";

/**
 * Fixture catalog. `haiku`/`sonnet`/`opus` are a normal fast→balanced→powerful
 * ladder with EQUAL context windows, so a switch between them can never be
 * mistaken for a context-driven one. `small`/`big` exist only to exercise the
 * context-window check, and only `sonnet`/`opus` accept images.
 */
const CATALOG: Record<string, ModelFacts> = {
  "anthropic haiku": { tier: "fast", contextWindow: 200_000, acceptedMimeTypes: new Set([TEXT]) },
  "anthropic sonnet": {
    tier: "balanced",
    contextWindow: 200_000,
    acceptedMimeTypes: new Set([TEXT, IMAGE]),
  },
  "anthropic opus": {
    tier: "powerful",
    contextWindow: 200_000,
    acceptedMimeTypes: new Set([TEXT, IMAGE]),
  },
  "anthropic haiku-2": { tier: "fast", contextWindow: 200_000, acceptedMimeTypes: new Set([TEXT]) },
  "openai haiku": { tier: "fast", contextWindow: 200_000, acceptedMimeTypes: new Set([TEXT]) },
  "local small": { tier: "fast", contextWindow: 8_000, acceptedMimeTypes: new Set([TEXT]) },
  "local big": { tier: "powerful", contextWindow: 200_000, acceptedMimeTypes: new Set([TEXT]) },
  // A fast model with an UNKNOWN window — proves the context check disables
  // itself rather than inventing a limit.
  "local nowindow": { tier: "fast", contextWindow: 0, acceptedMimeTypes: new Set([TEXT]) },
};

const facts: ModelFactsResolver = (provider, model) => CATALOG[`${provider} ${model}`];

function sig(over: Partial<StoredRoutingSignals> = {}): StoredRoutingSignals {
  return {
    promptChars: 40,
    historyChars: 0,
    historyMessageCount: 0,
    hasToolMessages: false,
    systemChars: 0,
    attachmentCount: 0,
    toolCount: 0,
    hasComplexTools: false,
    estTokens: 100,
    tier: "fast",
    reason: "short-turn",
    ...over,
  };
}

function user(
  id: string,
  i: number,
  parent: string | null,
  mimes: readonly string[] = [],
): LabelMessage {
  return {
    id,
    role: "user",
    parentMessageId: parent,
    createdAt: at(i),
    attachmentMimeTypes: mimes,
  };
}

function asst(
  id: string,
  i: number,
  parent: string | null,
  provider: string,
  model: string,
  signals: StoredRoutingSignals | null = sig(),
): LabelMessage {
  return {
    id,
    role: "assistant",
    parentMessageId: parent,
    createdAt: at(i),
    provider,
    model,
    usage: signals ? { routingSignals: signals } : null,
  };
}

/** Sample for one message id. Every assistant turn always produces exactly
 *  one, so a missing id is a real failure rather than a soft undefined. */
function sampleFor(samples: LabelledSample[], id: string): LabelledSample {
  const found = samples.find((s) => s.messageId === id);
  if (!found) throw new Error(`no sample emitted for ${id}`);
  return found;
}

/**
 * A two-turn thread where the SECOND turn switched model: u1 → a1(from) →
 * u2(mimes) → a2(to). `a1` is the turn under test.
 */
function switchThread(args: {
  from: [string, string];
  to: [string, string];
  mimes?: readonly string[];
  estTokens?: number;
}): LabelMessage[] {
  const [fp, fm] = args.from;
  const [tp, tm] = args.to;
  return [
    user("u1", 0, null),
    asst("a1", 1, "u1", fp, fm, sig({ estTokens: args.estTokens ?? 100 })),
    user("u2", 2, "a1", args.mimes ?? []),
    asst("a2", 3, "u2", tp, tm, sig()),
  ];
}

describe("labelConversation — negatives (the cheaper model was insufficient)", () => {
  test("a mid-conversation switch to a strictly stronger tier is negative", () => {
    const samples = labelConversation(
      CONV,
      switchThread({ from: ["anthropic", "haiku"], to: ["anthropic", "opus"] }),
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.label).toBe("negative");
    expect(a1.reason).toBe("switch-escalated");
    expect(a1.servedTier).toBe("fast");
    expect(a1.comparedToTier).toBe("powerful");
    expect(a1.comparedToModel).toBe("opus");
    // Features travel WITH the label — the whole point of stamping signals.
    expect(a1.signals?.estTokens).toBe(100);
  });

  test("an A/B retry whose continued sibling is stronger makes the loser negative", () => {
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "anthropic", "haiku"),
        asst("a2", 2, "u1", "anthropic", "opus"),
        // The thread continued through a2 → a2 is the chosen answer.
        user("u2", 3, "a2"),
        asst("a3", 4, "u2", "anthropic", "opus"),
      ],
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.label).toBe("negative");
    expect(a1.reason).toBe("retry-escalated");
    expect(a1.comparedToTier).toBe("powerful");
    // The winner itself is NOT a sample about sufficiency.
    expect(sampleFor(samples, "a2").reason).toBe("retry-winner");
    expect(sampleFor(samples, "a2").label).toBe("excluded");
  });

  test("a regeneration (the prompt was re-asked) is negative", () => {
    const samples = labelConversation(
      CONV,
      [
        user("u0", 0, null),
        asst("a0", 1, "u0", "anthropic", "haiku"),
        user("u1", 2, "a0"),
        asst("a1", 3, "u1", "anthropic", "haiku"),
        // The user re-asked: a NEWER user sibling of u1 under the same parent.
        user("u1b", 4, "a0"),
        asst("a1b", 5, "u1b", "anthropic", "haiku"),
      ],
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.label).toBe("negative");
    expect(a1.reason).toBe("regenerated");
  });
});

describe("labelConversation — EXCLUSIONS (blocking: never negative)", () => {
  test("a LATERAL switch (same tier) is excluded, not negative", () => {
    const samples = labelConversation(
      CONV,
      switchThread({ from: ["anthropic", "haiku"], to: ["anthropic", "haiku-2"] }),
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.label).toBe("excluded");
    expect(a1.reason).toBe("switch-lateral");
  });

  test("a switch caused by an IMAGE ATTACHMENT is excluded, not negative", () => {
    // haiku (text only) → sonnet (accepts image/png), and the prompt the new
    // model answered carried an image. Tier DID go up; the cause was capability.
    const samples = labelConversation(
      CONV,
      switchThread({
        from: ["anthropic", "haiku"],
        to: ["anthropic", "sonnet"],
        mimes: [IMAGE],
      }),
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.label).toBe("excluded");
    expect(a1.reason).toBe("capability-attachment");
    // The comparison is still recorded, so the exclusion is auditable.
    expect(a1.comparedToTier).toBe("balanced");
  });

  test("a switch caused by the CONTEXT WINDOW is excluded, not negative", () => {
    const estTokens = Math.ceil(8_000 * CONTEXT_PRESSURE_RATIO);
    const samples = labelConversation(
      CONV,
      switchThread({ from: ["local", "small"], to: ["local", "big"], estTokens }),
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.label).toBe("excluded");
    expect(a1.reason).toBe("capability-context");
  });

  test("the same switch UNDER the pressure ratio stays a real escalation", () => {
    // One token below the pressure line: the old window was NOT the constraint,
    // so this must remain negative. Pins the check to the ratio, not to "the new
    // model is bigger", which would excuse every escalation.
    const estTokens = Math.ceil(8_000 * CONTEXT_PRESSURE_RATIO) - 1;
    const samples = labelConversation(
      CONV,
      switchThread({ from: ["local", "small"], to: ["local", "big"], estTokens }),
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("switch-escalated");
  });

  test("an attachment BOTH models accept does not excuse the escalation", () => {
    const samples = labelConversation(
      CONV,
      switchThread({ from: ["anthropic", "haiku"], to: ["anthropic", "opus"], mimes: [TEXT] }),
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("switch-escalated");
  });

  test("an attachment NEITHER model accepts does not excuse the escalation", () => {
    const samples = labelConversation(
      CONV,
      switchThread({
        from: ["anthropic", "haiku"],
        to: ["anthropic", "opus"],
        mimes: ["audio/ogg"],
      }),
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("switch-escalated");
  });

  test("an UNKNOWN context window disables the context check rather than guessing", () => {
    const samples = labelConversation(
      CONV,
      switchThread({ from: ["local", "nowindow"], to: ["local", "big"], estTokens: 999_999 }),
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("switch-escalated");
  });

  test("context pressure with NO window growth is not a capability switch", () => {
    // haiku → opus, both 200k. Even an enormous estimate can't be blamed on the
    // window when the new model's window is no larger.
    const samples = labelConversation(
      CONV,
      switchThread({
        from: ["anthropic", "haiku"],
        to: ["anthropic", "opus"],
        estTokens: 500_000,
      }),
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("switch-escalated");
  });

  test("the SWITCH TARGET's own estimate can establish context pressure", () => {
    // The from-turn's estimate is small; the (pinned) target turn stamped a
    // bigger one. `comparisonEstTokens` takes the larger of the two.
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "local", "small", sig({ estTokens: 10 })),
        user("u2", 2, "a1"),
        asst("a2", 3, "u2", "local", "big", sig({ estTokens: 7_500 })),
      ],
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("capability-context");
  });

  test("a DOWNGRADE switch is excluded (not negative, and not positive)", () => {
    const samples = labelConversation(
      CONV,
      switchThread({ from: ["anthropic", "opus"], to: ["anthropic", "haiku"] }),
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.label).toBe("excluded");
    expect(a1.reason).toBe("switch-downgrade");
  });

  test("a legacy row (no routingSignals) is excluded and carries no features", () => {
    const samples = labelConversation(
      CONV,
      [user("u1", 0, null), asst("a1", 1, "u1", "anthropic", "haiku", null)],
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.label).toBe("excluded");
    expect(a1.reason).toBe("no-routing-signals");
    expect(a1.signals).toBeUndefined();
    expect(a1.servedTier).toBeUndefined();
  });

  test("an unresolvable served model is excluded, never guessed at", () => {
    const samples = labelConversation(
      CONV,
      [user("u1", 0, null), asst("a1", 1, "u1", "anthropic", "who-is-this")],
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("model-facts-unknown");
  });

  test("a NULL served model is excluded", () => {
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        {
          id: "a1",
          role: "assistant",
          parentMessageId: "u1",
          createdAt: at(1),
          usage: { routingSignals: sig() },
        },
      ],
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("model-facts-unknown");
  });

  test("an unresolvable SWITCH TARGET excludes the comparison", () => {
    const samples = labelConversation(
      CONV,
      switchThread({ from: ["anthropic", "haiku"], to: ["anthropic", "mystery"] }),
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.reason).toBe("model-facts-unknown");
    // Facts for THIS turn resolved, so its own tier is still reported.
    expect(a1.servedTier).toBe("fast");
  });

  test("an A/B retry no sibling was continued through is excluded", () => {
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "anthropic", "haiku"),
        asst("a2", 2, "u1", "anthropic", "opus"),
      ],
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("retry-unresolved");
    expect(sampleFor(samples, "a2").reason).toBe("retry-unresolved");
  });

  test("an A/B retry continued through a SAME-tier sibling is excluded", () => {
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "anthropic", "haiku"),
        asst("a2", 2, "u1", "anthropic", "haiku-2"),
        user("u2", 3, "a2"),
      ],
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("retry-lateral");
  });

  test("an A/B retry continued through a WEAKER sibling is excluded", () => {
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "anthropic", "opus"),
        asst("a2", 2, "u1", "anthropic", "haiku"),
        user("u2", 3, "a2"),
      ],
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("retry-downgrade");
  });

  test("a retry whose continued sibling needed an attachment is excluded", () => {
    // The paired-comparison path runs the SAME capability checks as the switch
    // path — a vision retry must not read as a quality escalation either.
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null, [IMAGE]),
        asst("a1", 1, "u1", "anthropic", "haiku"),
        asst("a2", 2, "u1", "anthropic", "sonnet"),
        user("u2", 3, "a2"),
      ],
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("capability-attachment");
  });

  test("a single-turn thread is abandoned — unreadable, not positive", () => {
    const samples = labelConversation(
      CONV,
      [user("u1", 0, null), asst("a1", 1, "u1", "anthropic", "haiku")],
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.label).toBe("excluded");
    expect(a1.reason).toBe("abandoned");
  });

  test("a thread that changes model INSIDE the positive window is excluded", () => {
    // a1 → a2 same model (no switch at step 4), then a3 changes → the window is
    // not "continued without complaint", so a1 is neither positive nor negative.
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "anthropic", "haiku"),
        user("u2", 2, "a1"),
        asst("a2", 3, "u2", "anthropic", "haiku"),
        user("u3", 4, "a2"),
        asst("a3", 5, "u3", "anthropic", "opus"),
      ],
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("switched-downstream");
    // a2 itself DID switch on its successor → that is the escalation evidence.
    expect(sampleFor(samples, "a2").reason).toBe("switch-escalated");
  });

  test("a PROVIDER change on the same model id is a real switch", () => {
    const samples = labelConversation(
      CONV,
      switchThread({ from: ["anthropic", "haiku"], to: ["openai", "haiku"] }),
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("switch-lateral");
  });
});

describe("labelConversation — positives", () => {
  test("a thread that runs on, same model, no retry, is positive", () => {
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "anthropic", "haiku"),
        user("u2", 2, "a1"),
        asst("a2", 3, "u2", "anthropic", "haiku"),
        user("u3", 4, "a2"),
        asst("a3", 5, "u3", "anthropic", "haiku"),
      ],
      facts,
    );
    const a1 = sampleFor(samples, "a1");
    expect(a1.label).toBe("positive");
    expect(a1.reason).toBe("continued");
    expect(a1.servedTier).toBe("fast");
    // The tail turns can't see two more turns yet → abandoned, not positive.
    expect(sampleFor(samples, "a2").reason).toBe("abandoned");
    expect(sampleFor(samples, "a3").reason).toBe("abandoned");
  });

  test("the positive window is exactly POSITIVE_MIN_FOLLOWING_TURNS turns", () => {
    expect(POSITIVE_MIN_FOLLOWING_TURNS).toBe(2);
    // One following turn short → abandoned.
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "anthropic", "haiku"),
        user("u2", 2, "a1"),
        asst("a2", 3, "u2", "anthropic", "haiku"),
      ],
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("abandoned");
  });

  test("the stamped routingConfig rides along when present", () => {
    const withConfig: LabelMessage = {
      ...asst("a1", 1, "u1", "anthropic", "haiku"),
      usage: {
        routingSignals: sig(),
        routingConfig: { defaultTier: "balanced", preferenceOrderHash: "deadbeef" },
      },
    };
    const samples = labelConversation(CONV, [user("u1", 0, null), withConfig], facts);
    expect(sampleFor(samples, "a1").config).toEqual({
      defaultTier: "balanced",
      preferenceOrderHash: "deadbeef",
    });
  });
});

describe("labelConversation — structural robustness", () => {
  test("non-assistant rows produce no sample at all", () => {
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        { id: "s1", role: "system", parentMessageId: "u1", createdAt: at(1) },
        asst("a1", 2, "u1", "anthropic", "haiku"),
      ],
      facts,
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]?.messageId).toBe("a1");
  });

  test("a pre-tree FLAT thread (every parent null) invents no retries", () => {
    // The hazard this guards: with every row at the root, naive sibling logic
    // would read a normal 3-exchange thread as a pile of regenerations/retries.
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, null, "anthropic", "haiku"),
        user("u2", 2, null),
        asst("a2", 3, null, "anthropic", "haiku"),
        user("u3", 4, null),
        asst("a3", 5, null, "anthropic", "opus"),
      ],
      facts,
    );
    expect(samples.map((s) => s.reason)).toEqual(["abandoned", "abandoned", "abandoned"]);
    expect(samples.every((s) => s.label === "excluded")).toBe(true);
  });

  test("an empty conversation yields no samples", () => {
    expect(labelConversation(CONV, [], facts)).toEqual([]);
  });

  test("a self-referential parent link terminates instead of looping", () => {
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "anthropic", "haiku"),
        // u2 claims a1 as parent AND a1 as its own child target: a1 → u2 → u2.
        { ...user("u2", 2, "a1"), id: "u2" },
        { ...user("u2b", 3, "u2"), parentMessageId: "u2" },
        { ...user("u2c", 4, "u2b"), parentMessageId: "u2b" },
        // Point the last node back at u2 to close a cycle.
        { ...user("u2d", 5, "u2c"), parentMessageId: "u2c" },
      ].concat([{ id: "u2", role: "user", parentMessageId: "u2d", createdAt: at(6) }]),
      facts,
    );
    // The only assertion that matters: it returned.
    expect(samples).toHaveLength(1);
  });

  test("an assistant turn whose parent is not a user row reads no attachments", () => {
    // a2's parent is a1 (assistant), so there is no prompt to read MIMEs from —
    // the capability check simply sees none and the escalation stands.
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "anthropic", "haiku"),
        asst("a2", 2, "a1", "anthropic", "opus"),
      ],
      facts,
    );
    expect(sampleFor(samples, "a1").reason).toBe("switch-escalated");
  });

  test("siblings with identical timestamps order by id, so continuation is stable", () => {
    const sameTime = [
      user("u1", 0, null),
      { ...asst("a1", 1, "u1", "anthropic", "haiku"), createdAt: at(1) },
      { ...asst("a2", 1, "u1", "anthropic", "opus"), createdAt: at(1) },
      user("u2", 2, "a2"),
    ];
    const samples = labelConversation(CONV, sameTime, facts);
    // a2 sorts after a1 on id and is the one with children → the winner.
    expect(sampleFor(samples, "a2").reason).toBe("retry-winner");
    expect(sampleFor(samples, "a1").reason).toBe("retry-escalated");
  });

  test("a missing or unparseable createdAt does not throw", () => {
    const samples = labelConversation(
      CONV,
      [
        { id: "u1", role: "user", parentMessageId: null },
        { ...asst("a1", 1, "u1", "anthropic", "haiku"), createdAt: "not-a-date" },
        { ...user("u2", 2, "a1"), createdAt: null },
        { ...asst("a2", 3, "u2", "anthropic", "haiku"), createdAt: BASE + 4_000 },
        { ...user("u3", 4, "a2"), createdAt: new Date(BASE + 5_000) },
        { ...asst("a3", 5, "u3", "anthropic", "haiku"), createdAt: undefined },
      ],
      facts,
    );
    expect(sampleFor(samples, "a1").label).toBe("positive");
  });
});

describe("countLabels", () => {
  test("tallies every class and reason, so exclusions are never invisible", () => {
    const samples = labelConversation(
      CONV,
      [
        user("u1", 0, null),
        asst("a1", 1, "u1", "anthropic", "haiku"),
        user("u2", 2, "a1"),
        asst("a2", 3, "u2", "anthropic", "haiku"),
        user("u3", 4, "a2"),
        asst("a3", 5, "u3", "anthropic", "haiku"),
      ],
      facts,
    );
    const counts = countLabels(samples);
    expect(counts).toEqual({
      positive: 1,
      negative: 0,
      excluded: 2,
      byReason: { continued: 1, abandoned: 2 },
    });
    // The invariant that makes the tally trustworthy.
    expect(counts.positive + counts.negative + counts.excluded).toBe(samples.length);
  });

  test("an empty list tallies to zeros", () => {
    expect(countLabels([])).toEqual({ positive: 0, negative: 0, excluded: 0, byReason: {} });
  });
});
