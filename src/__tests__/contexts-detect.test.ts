/**
 * Unit tests for `src/contexts/detect.ts` — stage-1 detection.
 *
 * Pure builders + the orchestrator with injected deps (no DB / network / LLM).
 */
import { test, expect, describe } from "bun:test";
import {
  buildDetectTranscript,
  buildDetectSchema,
  buildDetectSystemPrompt,
  parseDetectResponse,
  validateTopics,
  normalizeTypeSlug,
  matchExistingType,
  titleCaseSlug,
  resolveAnchors,
  isConversationalMessage,
  detectTopics,
  MAX_PER_MESSAGE_CHARS,
  MAX_TOPICS,
  MAX_LABEL_WORDS,
  type DetectDeps,
} from "../contexts/detect";

const TYPES = [
  { id: "feature", label: "Feature", description: "A capability." },
  { id: "idea", label: "Idea", description: "A proposal." },
];

describe("buildDetectTranscript", () => {
  test("tags each message with a 1-based [mN] ordinal + returns ordinalToId", () => {
    const { transcript, truncated, ordinalToId } = buildDetectTranscript([
      { id: "uuid-a", role: "user", content: "hello" },
      { id: "uuid-b", role: "assistant", content: "hi" },
    ]);
    expect(transcript).toBe("[m1] user: hello\n[m2] assistant: hi");
    expect(truncated).toBe(false);
    expect(ordinalToId.get(1)).toBe("uuid-a");
    expect(ordinalToId.get(2)).toBe("uuid-b");
  });

  test("truncates each message to MAX_PER_MESSAGE_CHARS with an ellipsis", () => {
    const long = "x".repeat(MAX_PER_MESSAGE_CHARS + 50);
    const { transcript } = buildDetectTranscript([{ id: "uuid-a", role: "user", content: long }]);
    expect(transcript).toBe(`[m1] user: ${"x".repeat(MAX_PER_MESSAGE_CHARS)}…`);
  });

  test("caps total oldest-first; the kept suffix keeps its original ordinals + full map", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `id${i}`,
      role: "user",
      content: "x".repeat(MAX_PER_MESSAGE_CHARS),
    }));
    const { transcript, truncated, ordinalToId } = buildDetectTranscript(many);
    expect(truncated).toBe(true);
    expect(transcript.startsWith("…[older messages truncated]…")).toBe(true);
    expect(transcript).not.toContain("[m1] "); // oldest dropped
    expect(transcript).toContain("[m200]"); // newest kept, ORIGINAL ordinal
    // Map covers all messages regardless of truncation.
    expect(ordinalToId.get(1)).toBe("id0");
    expect(ordinalToId.get(200)).toBe("id199");
  });
});

describe("buildDetectSchema", () => {
  test("type is an OPEN string, anchors is an integer array, typeDescription optional", () => {
    const schema = buildDetectSchema() as any;
    const props = schema.properties.topics.items.properties;
    expect(props.type).toEqual({ type: "string" });
    expect(props.typeDescription).toEqual({ type: "string" });
    // Anchors are message NUMBERS, not UUID strings.
    expect(props.anchors).toEqual({ type: "array", items: { type: "integer", minimum: 1 } });
    expect(props.messageIds).toBeUndefined();
    expect(schema.properties.topics.items.required).toEqual(["label", "type", "anchors"]);
    expect(schema.properties.topics.items.additionalProperties).toBe(false);
  });
});

describe("buildDetectSystemPrompt", () => {
  test("evidence floor + descriptive labels + create-is-expected + live types/labels", () => {
    const prompt = buildDetectSystemPrompt(TYPES, ["Auth flow", "Caching"]);
    expect(prompt).toContain("feature (Feature): A capability.");
    expect(prompt).toContain("idea (Idea): A proposal.");
    // FIX 2 — evidence floor.
    expect(prompt).toContain("Only report topics with SUBSTANTIVE discussion");
    expect(prompt).toContain("Fewer, well-evidenced topics beat many thin ones");
    // FIX 3 — descriptive labels.
    expect(prompt).toContain("short DESCRIPTIVE phrase");
    expect(prompt).toContain("NEVER the type name itself");
    // FIX 4 — creating a new type is expected, no near-duplicates.
    expect(prompt).toContain("CREATE a new one — that is expected and");
    expect(prompt).toContain("Never create a near-duplicate");
    expect(prompt).toContain("kebab-case");
    // FIX A — cite message NUMBERS ([mN] ordinals), not UUIDs.
    expect(prompt).toContain("cite the message numbers (the [mN] tags)");
    expect(prompt).toContain('"anchors": number[]');
    // The existing-label reuse block is unchanged.
    expect(prompt).toContain("REUSE a label");
    expect(prompt).toContain("- Auth flow");
    expect(prompt).toContain("- Caching");
    expect(prompt).toContain("/no_think");
  });

  test("omits the reuse section when no labels exist", () => {
    const prompt = buildDetectSystemPrompt(TYPES, []);
    expect(prompt).not.toContain("REUSE a label");
  });
});

describe("isConversationalMessage", () => {
  test("keeps real user/assistant/system turns with content", () => {
    expect(isConversationalMessage({ role: "user", content: "hi" })).toBe(true);
    expect(isConversationalMessage({ role: "assistant", content: "answer" })).toBe(true);
    expect(isConversationalMessage({ role: "system", content: "note" })).toBe(true);
  });
  test("drops UI-only synthetic rows (mirrors load-history kinds)", () => {
    expect(isConversationalMessage({ role: "capability-event", content: '{"x":1}' })).toBe(false);
    expect(isConversationalMessage({ role: "ez-action-result", content: "{}" })).toBe(false);
    expect(isConversationalMessage({ role: "preprocess-result", content: "{}" })).toBe(false);
  });
  test("drops empty / whitespace-only content", () => {
    expect(isConversationalMessage({ role: "assistant", content: "" })).toBe(false);
    expect(isConversationalMessage({ role: "user", content: "   \n " })).toBe(false);
  });
});

describe("normalizeTypeSlug", () => {
  test("lowercases, hyphenates spaces/underscores, strips junk, collapses, caps 30", () => {
    expect(normalizeTypeSlug("  Design_Review!! ")).toBe("design-review");
    expect(normalizeTypeSlug("Bug   Fix")).toBe("bug-fix");
    expect(normalizeTypeSlug("--weird__slug--")).toBe("weird-slug");
    expect(normalizeTypeSlug("a".repeat(50))).toHaveLength(30);
    // A slug that would end on a hyphen after the 30-char slice is trimmed.
    expect(normalizeTypeSlug(`${"ab-".repeat(11)}`).endsWith("-")).toBe(false);
  });
  test("empty / junk-only → empty string", () => {
    expect(normalizeTypeSlug("   ")).toBe("");
    expect(normalizeTypeSlug("!!!")).toBe("");
  });
});

describe("matchExistingType", () => {
  const ids = ["feature", "idea", "bug-fix", "design-review"];
  test("exact match", () => {
    expect(matchExistingType("feature", ids)).toBe("feature");
  });
  test("plural / es variant reuses the singular", () => {
    expect(matchExistingType("ideas", ids)).toBe("idea");
    expect(matchExistingType("bug-fixes", ids)).toBe("bug-fix");
  });
  test("hyphen-collapsed variant reuses the hyphenated id", () => {
    expect(matchExistingType("bugfix", ids)).toBe("bug-fix");
    expect(matchExistingType("designreview", ids)).toBe("design-review");
  });
  test("genuinely new → undefined; empty → undefined", () => {
    expect(matchExistingType("incident", ids)).toBeUndefined();
    expect(matchExistingType("", ids)).toBeUndefined();
  });
});

describe("titleCaseSlug", () => {
  test("Title-Cases the kebab slug", () => {
    expect(titleCaseSlug("design-review")).toBe("Design Review");
    expect(titleCaseSlug("incident")).toBe("Incident");
  });
});

describe("resolveAnchors", () => {
  const map = new Map<number, string>([
    [1, "uuid-a"],
    [2, "uuid-b"],
    [3, "uuid-c"],
  ]);
  test("maps 1-based ordinals to real ids in citation order", () => {
    expect(resolveAnchors([2, 1], map)).toEqual(["uuid-b", "uuid-a"]);
  });
  test("drops out-of-range ordinals and non-integers, dedupes ids", () => {
    expect(resolveAnchors([1, 9, 0, 2.5, "3" as unknown as number, 1], map)).toEqual(["uuid-a"]);
  });
  test("non-array or empty → empty", () => {
    expect(resolveAnchors("nope", map)).toEqual([]);
    expect(resolveAnchors([], map)).toEqual([]);
  });
});

describe("parseDetectResponse", () => {
  test("clean JSON", () => {
    expect(parseDetectResponse('{"topics":[{"label":"A","type":"feature","anchors":[1]}]}')).toEqual([
      { label: "A", type: "feature", anchors: [1] },
    ]);
  });
  test("fenced / prose-wrapped JSON (brace slice)", () => {
    const raw = 'Here you go:\n```json\n{"topics":[{"label":"A","type":"idea","anchors":[]}]}\n```';
    expect(parseDetectResponse(raw)).toEqual([{ label: "A", type: "idea", anchors: [] }]);
  });
  test("strips <think> blocks", () => {
    const raw = '<think>reasoning…</think>{"topics":[]}';
    expect(parseDetectResponse(raw)).toEqual([]);
  });
  test("no object → throws", () => {
    expect(() => parseDetectResponse("no json here")).toThrow(/no JSON object/);
  });
  test("invalid JSON → throws", () => {
    expect(() => parseDetectResponse("{not valid}")).toThrow(/not valid JSON/);
  });
  test("missing topics array → throws", () => {
    expect(() => parseDetectResponse('{"foo":1}')).toThrow(/missing a `topics` array/);
  });
});

describe("validateTopics — open taxonomy + evidence floor", () => {
  function fakeEnsure() {
    const calls: Array<{ id: string; label: string; description: string }> = [];
    const fn = async (t: { id: string; label: string; description: string }) => {
      calls.push(t);
      return { id: t.id };
    };
    return { fn, calls };
  }
  const EXISTING_TYPES = [
    { id: "feature", label: "Feature" },
    { id: "idea", label: "Idea" },
    { id: "bug-fix", label: "Bug Fix" },
  ];
  // 1-based [mN] ordinals → real ids: [m1]→"m1", [m2]→"m2".
  function vOpts(
    ensureContextType: (t: { id: string; label: string; description: string }) => Promise<{ id: string }> = async (t) => ({ id: t.id }),
  ) {
    return {
      existingTypes: EXISTING_TYPES,
      ordinalToId: new Map<number, string>([
        [1, "m1"],
        [2, "m2"],
      ]),
      ensureContextType,
    };
  }

  test("reuses an existing type on exact match (no new type created)", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics([{ label: "auth token flow", type: "feature", anchors: [1] }], vOpts(fn));
    expect(out[0]!.typeId).toBe("feature");
    expect(calls).toHaveLength(0);
  });

  test("reuses on trivial variants (Bug Fixes → bug-fix, IDEAS → idea) — never creates", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics(
      [
        { label: "login token bug", type: "Bug Fixes", anchors: [1] },
        { label: "caching strategy", type: "IDEAS", anchors: [2] },
      ],
      vOpts(fn),
    );
    expect(out.map((t) => t.typeId)).toEqual(["bug-fix", "idea"]);
    expect(calls).toHaveLength(0);
  });

  test("creates a new auto type with the model's typeDescription", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics(
      [{ label: "picker swap", type: "Design Review", typeDescription: "  A review of a design.  ", anchors: [1] }],
      vOpts(fn),
    );
    expect(out[0]!.typeId).toBe("design-review");
    expect(calls).toEqual([
      { id: "design-review", label: "Design Review", description: "A review of a design." },
    ]);
  });

  test("creates a new auto type with a default description when none is given", async () => {
    const { fn, calls } = fakeEnsure();
    await validateTopics([{ label: "prod outage", type: "incident", anchors: [1] }], vOpts(fn));
    expect(calls[0]!.description).toBe("Auto-detected: Incident");
  });

  test("reuses a just-created type for a later variant (one create, not two)", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics(
      [
        { label: "prod outage", type: "incident", anchors: [1] },
        { label: "second outage", type: "incidents", anchors: [2] },
      ],
      vOpts(fn),
    );
    expect(out.map((t) => t.typeId)).toEqual(["incident", "incident"]);
    expect(calls).toHaveLength(1);
  });

  test("caps NEW types at 3 per pass → the 4th falls back to the seeded idea type", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics(
      [
        { label: "first subject", type: "alpha", anchors: [1] },
        { label: "second subject", type: "bravo", anchors: [1] },
        { label: "third subject", type: "charlie", anchors: [1] },
        { label: "fourth subject", type: "delta", anchors: [1] },
      ],
      vOpts(fn),
    );
    expect(out.map((t) => t.typeId)).toEqual(["alpha", "bravo", "charlie", "idea"]);
    expect(calls).toHaveLength(3);
  });

  test("an empty / invalid slug falls back to idea (no create)", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics([{ label: "some subject", type: "!!!", anchors: [1] }], vOpts(fn));
    expect(out[0]!.typeId).toBe("idea");
    expect(calls).toHaveLength(0);
  });

  test("maps [mN] ordinal anchors to real message ids (drops out-of-range, dedupes)", async () => {
    const out = await validateTopics(
      [{ label: "auth work", type: "feature", anchors: [1, 9, 2, 1] }],
      vOpts(),
    );
    expect(out[0]!.messageIds).toEqual(["m1", "m2"]);
  });

  // FIX 2b — per-topic evidence floor applies WHEN other topics have anchors.
  test("drops zero-anchor topics when at least one topic has real anchors", async () => {
    const out = await validateTopics(
      [
        { label: "real subject", type: "feature", anchors: [1] },
        { label: "ghost topic", type: "bug-fix", anchors: [99] }, // out of range → []
        { label: "no anchors", type: "idea", anchors: [] },
        { label: "bad shape", type: "idea", anchors: "nope" },
      ],
      vOpts(),
    );
    expect(out.map((t) => t.label)).toEqual(["real subject"]);
  });

  // FIX B — wholesale citation failure: keep every label-valid topic anchor-less.
  test("keeps ALL label-valid topics (anchor-less) when EVERY one has zero anchors", async () => {
    const out = await validateTopics(
      [
        { label: "sub-agent chat panel fix", type: "bug-fix", anchors: [] },
        { label: "watermark refresh", type: "feature", anchors: [99] }, // out of range → []
        { label: "picker swap", type: "idea", anchors: "nope" },
      ],
      vOpts(),
    );
    expect(out.map((t) => t.label)).toEqual(["sub-agent chat panel fix", "watermark refresh", "picker swap"]);
    expect(out.every((t) => t.messageIds.length === 0)).toBe(true);
  });

  // FIX 3b — label discipline: a label that's just the type name is dropped
  // (in phase 1, BEFORE the anchor floor / wholesale fallback).
  test("drops topics whose label is just the type id or type label", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics(
      [
        { label: "bug-fix", type: "bug-fix", anchors: [1] }, // label == id
        { label: "Bug Fix", type: "bug-fix", anchors: [1] }, // label == type label (normalizes to id)
        { label: "Idea", type: "idea", anchors: [1] }, // label == seed label
        { label: "stale watermark refresh bug", type: "bug-fix", anchors: [1] }, // descriptive → kept
      ],
      vOpts(fn),
    );
    expect(out.map((t) => t.label)).toEqual(["stale watermark refresh bug"]);
    expect(calls).toHaveLength(0); // all reuse, never create
  });

  test("returns [] when every topic is dropped for label==type (no wholesale keep)", async () => {
    const out = await validateTopics(
      [
        { label: "bug-fix", type: "bug-fix", anchors: [1] },
        { label: "Idea", type: "idea", anchors: [1] },
      ],
      vOpts(),
    );
    expect(out).toEqual([]);
  });

  test("word-caps labels + drops empty / non-string labels", async () => {
    const out = await validateTopics(
      [
        { label: "  one two three four five six seven ", type: "idea", anchors: [1] },
        { label: "   ", type: "feature", anchors: [1] },
        { label: 42, type: "feature", anchors: [1] },
      ],
      vOpts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("one two three four five six".split(" ").slice(0, MAX_LABEL_WORDS).join(" "));
  });

  test("caps at MAX_TOPICS", async () => {
    const raw = Array.from({ length: MAX_TOPICS + 5 }, (_, i) => ({
      label: `topic number ${i}`,
      type: "feature",
      anchors: [1],
    }));
    expect(await validateTopics(raw, vOpts())).toHaveLength(MAX_TOPICS);
  });
});

describe("detectTopics orchestrator", () => {
  function baseDeps(overrides: Partial<DetectDeps> = {}): Partial<DetectDeps> {
    return {
      resolveTarget: async () => ({ kind: "sidecar", baseUrl: "http://x", model: "qwen3:1.7b" }),
      // conversational ordinals: 1 = m1, 2 = m2. The model cites [2] + a
      // bogus [9] (out of range → dropped by resolveAnchors).
      runCompletion: async () => '{"topics":[{"label":"Auth","type":"feature","anchors":[2,9]}]}',
      getMessages: async () => [
        { id: "m1", role: "user", content: "a" },
        { id: "m2", role: "assistant", content: "b" },
      ],
      listContextTypes: async () => TYPES,
      getExistingTopics: async () => [{ label: "Old" }],
      ensureContextType: async (t) => ({ id: t.id }),
      replaceTopics: async (_c, topics) => topics.map((t, i) => ({ id: `t${i}`, ...t }) as any),
      upsertTopicState: async (_c, input) => ({ ...input, conversationId: _c, analyzedAt: new Date("2026-07-13T00:00:00Z") }) as any,
      ...overrides,
    };
  }

  test("validates, replaces, and writes the watermark", async () => {
    let replaceArgs: any;
    let stateArgs: any;
    const res = await detectTopics("conv-1", baseDeps({
      replaceTopics: async (_c, topics) => {
        replaceArgs = topics;
        return topics.map((t, i) => ({ id: `t${i}`, ...t }) as any);
      },
      upsertTopicState: async (_c, input) => {
        stateArgs = input;
        return { ...input, conversationId: _c, analyzedAt: new Date("2026-07-13T00:00:00Z") } as any;
      },
    }));

    // messageIds filtered to real ids; label + type preserved.
    expect(replaceArgs).toEqual([{ label: "Auth", typeId: "feature", messageIds: ["m2"] }]);
    // watermark reflects the newest message + count + model provenance.
    expect(stateArgs).toEqual({ lastMessageId: "m2", messageCount: 2, model: "local/qwen3:1.7b" });
    expect(res.model).toBe("local/qwen3:1.7b");
    expect(res.analyzedAt).toBe("2026-07-13T00:00:00.000Z");
    expect(res.topics[0]!.label).toBe("Auth");
  });

  test("ensures a proposed NEW type BEFORE replaceTopics (FK RESTRICT ordering)", async () => {
    const order: string[] = [];
    let replaceArgs: any;
    await detectTopics("conv-1", baseDeps({
      runCompletion: async () =>
        '{"topics":[{"label":"Deploy","type":"design-review","typeDescription":"A review","anchors":[2]}]}',
      ensureContextType: async (t) => {
        order.push(`ensure:${t.id}`);
        return { id: t.id };
      },
      replaceTopics: async (_c, topics) => {
        order.push("replaceTopics");
        replaceArgs = topics;
        return topics.map((t, i) => ({ id: `t${i}`, ...t }) as any);
      },
    }));
    // The auto type is created first, so the topic → type FK resolves.
    expect(order).toEqual(["ensure:design-review", "replaceTopics"]);
    expect(replaceArgs).toEqual([{ label: "Deploy", typeId: "design-review", messageIds: ["m2"] }]);
  });

  test("empty conversation short-circuits (no LLM call, zero-count watermark)", async () => {
    let ran = false;
    let stateArgs: any;
    const res = await detectTopics("conv-1", baseDeps({
      getMessages: async () => [],
      runCompletion: async () => {
        ran = true;
        return "{}";
      },
      replaceTopics: async () => [],
      upsertTopicState: async (_c, input) => {
        stateArgs = input;
        return { ...input, conversationId: _c, analyzedAt: new Date() } as any;
      },
    }));
    expect(ran).toBe(false);
    expect(stateArgs).toEqual({ lastMessageId: null, messageCount: 0, model: "local/qwen3:1.7b" });
    expect(res.topics).toEqual([]);
  });

  test("telemetry-only conversation short-circuits but keeps the RAW watermark", async () => {
    let ran = false;
    let stateArgs: any;
    const res = await detectTopics("conv-1", baseDeps({
      getMessages: async () => [
        { id: "m1", role: "capability-event", content: '{"telemetry":1}' },
        { id: "m2", role: "assistant", content: "   " },
      ],
      runCompletion: async () => {
        ran = true;
        return "{}";
      },
      replaceTopics: async () => [],
      upsertTopicState: async (_c, input) => {
        stateArgs = input;
        return { ...input, conversationId: _c, analyzedAt: new Date() } as any;
      },
    }));
    expect(ran).toBe(false); // no conversational content → no LLM call
    // Watermark still tracks the RAW newest id + count (staleness stays consistent).
    expect(stateArgs).toEqual({ lastMessageId: "m2", messageCount: 2, model: "local/qwen3:1.7b" });
    expect(res.topics).toEqual([]);
  });

  test("strips telemetry from the transcript; ordinals map to the REAL uuids", async () => {
    let userPrompt = "";
    let replaceArgs: any;
    await detectTopics("conv-1", baseDeps({
      getMessages: async () => [
        { id: "uuid-m1", role: "user", content: "how do we fix the login bug" },
        { id: "uuid-cap", role: "capability-event", content: '{"secret":"TELEMETRY-NOISE"}' },
        { id: "uuid-m2", role: "assistant", content: "rotate the token" },
      ],
      // Ordinals are over the CONVERSATIONAL set only: 1 = uuid-m1, 2 = uuid-m2.
      runCompletion: async (req) => {
        userPrompt = req.userPrompt as string;
        return '{"topics":[{"label":"login token bug","type":"bug-fix","anchors":[1,2]}]}';
      },
      replaceTopics: async (_c, topics) => {
        replaceArgs = topics;
        return topics.map((t, i) => ({ id: `t${i}`, ...t }) as any);
      },
    }));
    // The capability-event content never reaches the model; real content does.
    expect(userPrompt).not.toContain("TELEMETRY-NOISE");
    expect(userPrompt).toContain("rotate the token");
    // Stored messageIds are the REAL uuids (mapped from ordinals), as today.
    expect(replaceArgs).toEqual([
      { label: "login token bug", typeId: "bug-fix", messageIds: ["uuid-m1", "uuid-m2"] },
    ]);
  });

  test("wholesale citation failure keeps the topic (stored with empty ids)", async () => {
    let replaceArgs: any;
    await detectTopics("conv-1", baseDeps({
      runCompletion: async () =>
        '{"topics":[{"label":"sub-agent chat panel fix","type":"bug-fix","anchors":[]}]}',
      replaceTopics: async (_c, topics) => {
        replaceArgs = topics;
        return topics.map((t, i) => ({ id: `t${i}`, ...t }) as any);
      },
    }));
    // No usable anchors, but the topic is good → kept anchor-less.
    expect(replaceArgs).toEqual([{ label: "sub-agent chat panel fix", typeId: "bug-fix", messageIds: [] }]);
  });
});
