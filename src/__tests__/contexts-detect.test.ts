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
  test("enum matches the live type ids", () => {
    const schema = buildDetectSchema(["feature", "idea"]) as any;
    expect(schema.properties.topics.items.properties.type.enum).toEqual(["feature", "idea"]);
    expect(schema.properties.topics.items.required).toEqual(["label", "type", "messageIds"]);
    expect(schema.properties.topics.items.additionalProperties).toBe(false);
  });
});

describe("buildDetectSystemPrompt", () => {
  test("lists live type ids + descriptions and existing labels", () => {
    const prompt = buildDetectSystemPrompt(TYPES, ["Auth flow", "Caching"]);
    expect(prompt).toContain("feature (Feature): A capability.");
    expect(prompt).toContain("idea (Idea): A proposal.");
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

describe("validateTopics", () => {
  const opts = { typeIds: new Set(["feature", "idea"]), realMessageIds: new Set(["m1", "m2"]) };

  test("drops unknown types", () => {
    const out = validateTopics(
      [
        { label: "Keep", type: "feature", messageIds: ["m1"] },
        { label: "Drop", type: "bogus", messageIds: ["m1"] },
      ],
      opts,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("Keep");
  });

  test("filters messageIds to real ids", () => {
    const out = validateTopics([{ label: "A", type: "feature", messageIds: ["m1", "ghost", "m2"] }], opts);
    expect(out[0]!.messageIds).toEqual(["m1", "m2"]);
  });

  test("word-caps labels + drops empty labels + non-array messageIds → []", () => {
    const out = validateTopics(
      [
        { label: "  one two three four five six seven ", type: "idea", messageIds: "nope" },
        { label: "   ", type: "feature", messageIds: [] },
        { label: 42, type: "feature", messageIds: [] },
      ],
      opts,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.label).toBe("one two three four five six".split(" ").slice(0, MAX_LABEL_WORDS).join(" "));
    expect(out[0]!.messageIds).toEqual([]);
  });

  test("caps at MAX_TOPICS", () => {
    const raw = Array.from({ length: MAX_TOPICS + 5 }, (_, i) => ({
      label: `T${i}`,
      type: "feature",
      messageIds: [],
    }));
    expect(validateTopics(raw, opts)).toHaveLength(MAX_TOPICS);
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
