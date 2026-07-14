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
  test("tags each message [m:id] with its role", () => {
    const { transcript, truncated } = buildDetectTranscript([
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "hi" },
    ]);
    expect(transcript).toBe("[m:m1] user: hello\n[m:m2] assistant: hi");
    expect(truncated).toBe(false);
  });

  test("truncates each message to MAX_PER_MESSAGE_CHARS with an ellipsis", () => {
    const long = "x".repeat(MAX_PER_MESSAGE_CHARS + 50);
    const { transcript } = buildDetectTranscript([{ id: "m1", role: "user", content: long }]);
    expect(transcript).toBe(`[m:m1] user: ${"x".repeat(MAX_PER_MESSAGE_CHARS)}…`);
  });

  test("caps total oldest-first, marking truncation and dropping the oldest whole", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      role: "user",
      content: "x".repeat(MAX_PER_MESSAGE_CHARS),
    }));
    const { transcript, truncated } = buildDetectTranscript(many);
    expect(truncated).toBe(true);
    expect(transcript.startsWith("…[older messages truncated]…")).toBe(true);
    expect(transcript).not.toContain("[m:m0]"); // oldest dropped
    expect(transcript).toContain("[m:m199]"); // newest kept
  });
});

describe("buildDetectSchema", () => {
  test("type is an OPEN string (no enum) with an optional typeDescription", () => {
    const schema = buildDetectSchema() as any;
    const props = schema.properties.topics.items.properties;
    expect(props.type).toEqual({ type: "string" });
    expect(props.type.enum).toBeUndefined();
    expect(props.typeDescription).toEqual({ type: "string" });
    // typeDescription is optional — a NEW type only.
    expect(schema.properties.topics.items.required).toEqual(["label", "type", "messageIds"]);
    expect(schema.properties.topics.items.additionalProperties).toBe(false);
  });
});

describe("buildDetectSystemPrompt", () => {
  test("lists live types + labels, prefers existing ids, allows a NEW kebab-case type", () => {
    const prompt = buildDetectSystemPrompt(TYPES, ["Auth flow", "Caching"]);
    expect(prompt).toContain("feature (Feature): A capability.");
    expect(prompt).toContain("idea (Idea): A proposal.");
    expect(prompt).toContain("Use an existing type id whenever one fits");
    expect(prompt).toContain("invent a NEW type id");
    expect(prompt).toContain("kebab-case");
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

describe("parseDetectResponse", () => {
  test("clean JSON", () => {
    expect(parseDetectResponse('{"topics":[{"label":"A","type":"feature","messageIds":["m1"]}]}')).toEqual([
      { label: "A", type: "feature", messageIds: ["m1"] },
    ]);
  });
  test("fenced / prose-wrapped JSON (brace slice)", () => {
    const raw = 'Here you go:\n```json\n{"topics":[{"label":"A","type":"idea","messageIds":[]}]}\n```';
    expect(parseDetectResponse(raw)).toEqual([{ label: "A", type: "idea", messageIds: [] }]);
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

describe("validateTopics — open taxonomy", () => {
  function fakeEnsure() {
    const calls: Array<{ id: string; label: string; description: string }> = [];
    const fn = async (t: { id: string; label: string; description: string }) => {
      calls.push(t);
      return { id: t.id };
    };
    return { fn, calls };
  }
  const REAL_IDS = ["feature", "idea", "bug-fix"];
  function vOpts(
    ensureContextType: (t: { id: string; label: string; description: string }) => Promise<{ id: string }> = async (t) => ({ id: t.id }),
  ) {
    return {
      existingTypeIds: REAL_IDS,
      realMessageIds: new Set(["m1", "m2"]),
      ensureContextType,
    };
  }

  test("reuses an existing type on exact match (no new type created)", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics([{ label: "Auth", type: "feature", messageIds: ["m1"] }], vOpts(fn));
    expect(out[0]!.typeId).toBe("feature");
    expect(calls).toHaveLength(0);
  });

  test("reuses on trivial variants (Bug Fixes → bug-fix, IDEAS → idea) — never creates", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics(
      [
        { label: "A", type: "Bug Fixes", messageIds: [] },
        { label: "B", type: "IDEAS", messageIds: [] },
      ],
      vOpts(fn),
    );
    expect(out.map((t) => t.typeId)).toEqual(["bug-fix", "idea"]);
    expect(calls).toHaveLength(0);
  });

  test("creates a new auto type with the model's typeDescription", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics(
      [{ label: "A", type: "Design Review", typeDescription: "  A review of a design.  ", messageIds: [] }],
      vOpts(fn),
    );
    expect(out[0]!.typeId).toBe("design-review");
    expect(calls).toEqual([
      { id: "design-review", label: "Design Review", description: "A review of a design." },
    ]);
  });

  test("creates a new auto type with a default description when none is given", async () => {
    const { fn, calls } = fakeEnsure();
    await validateTopics([{ label: "A", type: "incident", messageIds: [] }], vOpts(fn));
    expect(calls[0]!.description).toBe("Auto-detected: Incident");
  });

  test("reuses a just-created type for a later variant (one create, not two)", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics(
      [
        { label: "A", type: "incident", messageIds: [] },
        { label: "B", type: "incidents", messageIds: [] },
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
        { label: "A", type: "alpha", messageIds: [] },
        { label: "B", type: "bravo", messageIds: [] },
        { label: "C", type: "charlie", messageIds: [] },
        { label: "D", type: "delta", messageIds: [] },
      ],
      vOpts(fn),
    );
    expect(out.map((t) => t.typeId)).toEqual(["alpha", "bravo", "charlie", "idea"]);
    expect(calls).toHaveLength(3);
  });

  test("an empty / invalid slug falls back to idea (no create)", async () => {
    const { fn, calls } = fakeEnsure();
    const out = await validateTopics([{ label: "A", type: "!!!", messageIds: [] }], vOpts(fn));
    expect(out[0]!.typeId).toBe("idea");
    expect(calls).toHaveLength(0);
  });

  test("filters messageIds to real ids", async () => {
    const out = await validateTopics(
      [{ label: "A", type: "feature", messageIds: ["m1", "ghost", "m2"] }],
      vOpts(),
    );
    expect(out[0]!.messageIds).toEqual(["m1", "m2"]);
  });

  test("word-caps labels, drops empty/non-string labels, non-array messageIds → []", async () => {
    const out = await validateTopics(
      [
        { label: "  one two three four five six seven ", type: "idea", messageIds: "nope" },
        { label: "   ", type: "feature", messageIds: [] },
        { label: 42, type: "feature", messageIds: [] },
      ],
      vOpts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("one two three four five six".split(" ").slice(0, MAX_LABEL_WORDS).join(" "));
    expect(out[0]!.messageIds).toEqual([]);
  });

  test("caps at MAX_TOPICS", async () => {
    const raw = Array.from({ length: MAX_TOPICS + 5 }, (_, i) => ({
      label: `T${i}`,
      type: "feature",
      messageIds: [],
    }));
    expect(await validateTopics(raw, vOpts())).toHaveLength(MAX_TOPICS);
  });
});

describe("detectTopics orchestrator", () => {
  function baseDeps(overrides: Partial<DetectDeps> = {}): Partial<DetectDeps> {
    return {
      resolveTarget: async () => ({ kind: "sidecar", baseUrl: "http://x", model: "qwen3:1.7b" }),
      runCompletion: async () => '{"topics":[{"label":"Auth","type":"feature","messageIds":["m2","ghost"]}]}',
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
        '{"topics":[{"label":"Deploy","type":"design-review","typeDescription":"A review","messageIds":["m2"]}]}',
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
});
