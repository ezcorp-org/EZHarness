/**
 * Unit tests for `src/contexts/extract.ts` — stage-2 extraction.
 *
 * Pure builders + the orchestrator with injected deps (no DB / network / LLM).
 */
import { test, expect, describe } from "bun:test";
import {
  buildExtractTranscript,
  buildExtractSystemPrompt,
  buildExtractUserPrompt,
  stripThink,
  composeTitle,
  extractContext,
  type ExtractDeps,
} from "../contexts/extract";

const TYPES = [
  { id: "feature", label: "Feature", description: "A capability." },
  { id: "idea", label: "Idea", description: "A proposal." },
];

describe("buildExtractTranscript", () => {
  test("marks anchor messages, keeps others plain, full content (no per-msg truncation)", () => {
    const long = "y".repeat(1000);
    const { transcript, truncated } = buildExtractTranscript(
      [
        { id: "m1", role: "user", content: long },
        { id: "m2", role: "assistant", content: "answer" },
      ],
      new Set(["m2"]),
    );
    expect(truncated).toBe(false);
    expect(transcript).toContain(`user: ${long}`); // full content preserved
    expect(transcript).toContain(">>> [RELEVANT TO TOPIC]\nassistant: answer");
    expect(transcript).not.toContain(">>> [RELEVANT TO TOPIC]\nuser:"); // m1 not anchored
  });

  test("caps oldest-first with a truncation marker", () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({
      id: `m${i}`,
      role: "user",
      content: "z".repeat(20_000),
    }));
    const { transcript, truncated } = buildExtractTranscript(msgs, new Set());
    expect(truncated).toBe(true);
    expect(transcript.startsWith("…[older messages truncated]…")).toBe(true);
  });
});

describe("buildExtractSystemPrompt", () => {
  test("mandatory topic-tag block + structure sections naming the topic + type", () => {
    const p = buildExtractSystemPrompt("Auth flow", "Feature");
    expect(p).toContain('Topic: "Auth flow" (Feature)');
    expect(p).toContain("# Auth flow");
    // The topic-tag block that ALWAYS opens the document.
    expect(p).toContain("> **Topic:** Auth flow (Feature)");
    expect(p).toContain("> **Where it stands:**");
    expect(p).toContain("The heading and the tag block are ALWAYS required");
    // The remaining (optional) sections — Summary is gone, folded into the tag.
    expect(p).not.toContain("**Summary**");
    expect(p).toContain("**Details**");
    expect(p).toContain("**Code**");
    expect(p).toContain("**Open questions**");
    // Load-bearing rules.
    expect(p).toContain("Make every bullet self-contained");
    expect(p).toContain("record the FINAL state and note what it replaced");
    expect(p).toContain('prioritize the MOST RECENT messages');
    expect(p).toContain("VERBATIM");
    expect(p).toContain("RELEVANT TO TOPIC");
    expect(p).toContain("/no_think");
  });
});

describe("buildExtractUserPrompt", () => {
  test("appends the recency-anchor reminder naming the topic after the transcript", () => {
    const p = buildExtractUserPrompt("TRANSCRIPT-BODY", "Auth flow");
    expect(p.startsWith("TRANSCRIPT-BODY")).toBe(true);
    expect(p).toContain("\n\n---\n");
    expect(p).toContain('Now extract the context for topic "Auth flow"');
    expect(p).toContain("Markdown only.");
  });
});

describe("stripThink", () => {
  test("removes think blocks and trims", () => {
    expect(stripThink("<think>a\nb</think>  hello  ")).toBe("hello");
  });
  test("leaves plain content unchanged", () => {
    expect(stripThink("# Title\ntext")).toBe("# Title\ntext");
  });
});

describe("composeTitle", () => {
  test("uses the first markdown H1 when present", () => {
    expect(composeTitle("fallback", "# Real Heading\nbody")).toBe("Real Heading");
  });
  test("falls back to the topic label when no H1", () => {
    expect(composeTitle("Topic Label", "no heading here")).toBe("Topic Label");
  });
  test("caps overly long headings", () => {
    const long = `# ${"h".repeat(300)}`;
    expect(composeTitle("x", long)).toHaveLength(200);
  });
});

describe("extractContext orchestrator", () => {
  function baseDeps(overrides: Partial<ExtractDeps> = {}): Partial<ExtractDeps> {
    return {
      resolveTarget: async () => ({ kind: "pi", provider: "anthropic", modelId: "claude", piModel: {} }),
      runCompletion: async () => "<think>reasoning</think># Auth\nThe auth flow uses JWT.",
      getMessages: async () => [
        { id: "m1", role: "user", content: "how does auth work" },
        { id: "m2", role: "assistant", content: "it uses JWT" },
      ],
      listContextTypes: async () => TYPES,
      upsertSavedContext: async (input) => ({ id: "sc1", createdAt: new Date(), updatedAt: new Date(), ...input }) as any,
      ...overrides,
    };
  }

  const topic = { label: "Auth", typeId: "feature", messageIds: ["m2"] };

  test("copies typeId from the topic, strips thinking, records model provenance", async () => {
    let saved: any;
    const out = await extractContext(
      { conversationId: "conv-1", topic, userId: "u1", projectId: "p1" },
      baseDeps({
        upsertSavedContext: async (input) => {
          saved = input;
          return { id: "sc1", createdAt: new Date(), updatedAt: new Date(), ...input } as any;
        },
      }),
    );
    expect(saved.typeId).toBe("feature"); // copied from topic row, not re-classified
    expect(saved.topicLabel).toBe("Auth");
    expect(saved.content).toBe("# Auth\nThe auth flow uses JWT."); // <think> stripped
    expect(saved.title).toBe("Auth"); // H1 heading
    expect(saved.model).toBe("anthropic/claude");
    expect(saved.messageCount).toBe(2);
    expect(saved.userId).toBe("u1");
    expect(saved.projectId).toBe("p1");
    expect(saved.conversationId).toBe("conv-1");
    expect(out.id).toBe("sc1");
  });

  test("appends a truncation note when the transcript overflowed", async () => {
    let saved: any;
    await extractContext(
      { conversationId: "conv-1", topic, userId: "u1", projectId: null },
      baseDeps({
        getMessages: async () =>
          Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, role: "user", content: "z".repeat(20_000) })),
        runCompletion: async () => "extracted body",
        upsertSavedContext: async (input) => {
          saved = input;
          return { id: "sc1", createdAt: new Date(), updatedAt: new Date(), ...input } as any;
        },
      }),
    );
    expect(saved.content).toContain("extracted body");
    expect(saved.content).toContain("most recent portion of a long conversation");
  });

  test("empty model output → throws (never saves a blank)", async () => {
    await expect(
      extractContext(
        { conversationId: "conv-1", topic, userId: "u1", projectId: null },
        baseDeps({ runCompletion: async () => "<think>only thinking</think>   " }),
      ),
    ).rejects.toThrow(/no content/);
  });

  test("unknown typeId falls back to the id string in the prompt (label lookup miss)", async () => {
    let sysPrompt = "";
    await extractContext(
      { conversationId: "conv-1", topic: { ...topic, typeId: "mystery" }, userId: "u1", projectId: null },
      baseDeps({
        runCompletion: async (req) => {
          sysPrompt = req.systemPrompt;
          return "body";
        },
      }),
    );
    expect(sysPrompt).toContain('"Auth" (mystery)');
  });

  test("wires the user prompt as the transcript + recency-anchor reminder at low temperature", async () => {
    let req: { userPrompt: string; temperature?: number } | undefined;
    await extractContext(
      { conversationId: "conv-1", topic, userId: "u1", projectId: null },
      baseDeps({
        runCompletion: async (r) => {
          req = r;
          return "body";
        },
      }),
    );
    // The anchored assistant message rides in the transcript half…
    expect(req!.userPrompt).toContain(">>> [RELEVANT TO TOPIC]\nassistant: it uses JWT");
    // …followed by the trailing reminder naming the topic.
    expect(req!.userPrompt).toContain('Now extract the context for topic "Auth"');
    expect(req!.temperature).toBe(0.1);
  });
});
