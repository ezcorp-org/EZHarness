import { test, expect, describe } from "bun:test";
import {
  composeReplyPrompt,
  draftReply,
  type VoiceProfile,
  type DraftLlm,
} from "../lib/voice";

// ── makeLlm — one-field fake matching the DraftLlm seam ─────────

function makeLlm(answer: string, opts?: { throwErr?: Error }) {
  const calls: Array<{
    systemPrompt?: string;
    userContent: string;
    maxTokens?: number;
    provider: string;
    model: string;
  }> = [];
  const llm: DraftLlm = {
    async complete(args) {
      if (opts?.throwErr) throw opts.throwErr;
      const userContent = args.messages.find((m) => m.role === "user")?.content ?? "";
      calls.push({
        ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
        userContent,
        ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
        provider: args.provider,
        model: args.model,
      });
      return { content: answer };
    },
  };
  return { calls, llm };
}

const FULL_PROFILE: VoiceProfile = {
  name: "Me",
  voiceDescription: "Warm and concise.",
  doRules: ["Ask a question back.", "Keep it short."],
  dontRules: ["No corporate filler."],
  sampleReplies: ["love this — what made you start?"],
};

describe("composeReplyPrompt", () => {
  test("includes framework guidance + voice rules + source text", () => {
    const out = composeReplyPrompt(FULL_PROFILE, "Great piece on burnout!", "reply");
    expect(out).toContain("Draft a reply to this comment");
    expect(out).toContain("Warm and concise.");
    expect(out).toContain("Ask a question back.");
    expect(out).toContain("No corporate filler.");
    expect(out).toContain("love this — what made you start?");
    expect(out).toContain("Great piece on burnout!");
    expect(out).toContain("Output ONLY the draft text");
  });

  test("welcome-dm and note-comment frameworks use distinct guidance", () => {
    const dm = composeReplyPrompt(null, "x", "welcome-dm");
    expect(dm).toContain("welcome direct message");
    const note = composeReplyPrompt(null, "x", "note-comment");
    expect(note).toContain("comment on this Note");
  });

  test("missing voice-profile omits do/don't/sample sections", () => {
    const out = composeReplyPrompt(null, "hello", "reply");
    expect(out).not.toContain("Do:");
    expect(out).not.toContain("Don't:");
    expect(out).not.toContain("Sample replies");
    expect(out).toContain("hello");
  });

  test("empty rule arrays are skipped", () => {
    const out = composeReplyPrompt(
      { name: "x", voiceDescription: "v", doRules: [], dontRules: [""], sampleReplies: [] },
      "src",
      "reply",
    );
    expect(out).not.toContain("Do:");
    expect(out).not.toContain("Don't:");
    expect(out).toContain("Voice: v");
  });

  test("profile with no voiceDescription still renders rules", () => {
    const out = composeReplyPrompt(
      { name: "x", doRules: ["only-do"], dontRules: [], sampleReplies: [] },
      "src",
      "reply",
    );
    expect(out).not.toContain("Voice:");
    expect(out).toContain("only-do");
  });
});

describe("draftReply", () => {
  const base = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    maxTokens: 1024,
    systemPrompt: "be human",
    voiceProfile: FULL_PROFILE,
    sourceText: "nice post",
    framework: "reply" as const,
  };

  test("returns trimmed body + threads provider/model/system to the LLM", async () => {
    const { calls, llm } = makeLlm("  Thanks — what hooked you?  ");
    const res = await draftReply({ ...base, llm });
    expect(res).toEqual({ ok: true, body: "Thanks — what hooked you?" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.provider).toBe("anthropic");
    expect(calls[0]?.model).toBe("claude-sonnet-4-6");
    expect(calls[0]?.systemPrompt).toBe("be human");
    expect(calls[0]?.maxTokens).toBe(1024);
    expect(calls[0]?.userContent).toContain("nice post");
  });

  test("surfaces LLM errors as { ok:false }", async () => {
    const { llm } = makeLlm("", { throwErr: new Error("quota burned") });
    const res = await draftReply({ ...base, llm });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("quota burned");
  });

  test("refuses empty / whitespace-only LLM output", async () => {
    const { llm } = makeLlm("   \n  ");
    const res = await draftReply({ ...base, llm });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("empty draft");
  });

  test("handles undefined content defensively as empty", async () => {
    const llm: DraftLlm = {
      // @ts-expect-error — exercise the `content ?? ""` defensive path.
      async complete() {
        return {};
      },
    };
    const res = await draftReply({ ...base, llm });
    expect(res.ok).toBe(false);
  });
});
