/**
 * Phase 48 Wave 2 — summarize_conversation Ez tool.
 *
 * Tests use an injected `summarize` stub so we don't spin up a real LLM.
 * The tool reads conversation messages from the DB, builds a transcript,
 * routes it through the stub with a style-keyed system prompt, and
 * returns the summary text.
 *
 * Asserts:
 *  - default style is "brief"
 *  - each style ("brief" | "standup" | "tweet") routes to a different
 *    system prompt (we capture & assert from the stub)
 *  - missing conversation → error result
 *  - empty conversation → "(empty conversation — nothing to summarize)"
 *  - large transcript is truncated from the start so recent content
 *    survives
 *  - conversationId is required
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { expectDetails, expectText } from "./helpers/expect-tool-result";

interface SummaryDetails {
  conversationId?: string;
  style?: "brief" | "standup" | "tweet";
  messageCount?: number;
  isError?: boolean;
}

mockDbConnection();

// Phase 48 fix: capture how `defaultSummarize` calls resolveModel so we
// can assert it threads the per-turn provider/model. The tool's default
// path uses dynamic `await import("../../../providers/router")` and
// `await import("../../../providers/llm")`, so module-level mocks
// installed here intercept those imports at call-time. The injected
// `summarize` stub used by the legacy tests above bypasses both — those
// tests never call resolveModel/completeLLM and remain unaffected.
const resolveModelCalls: Array<[unknown, unknown]> = [];
let resolveModelImpl: (provider?: unknown, model?: unknown) => Promise<unknown> = async (
  provider,
  model,
) => ({ provider: provider ?? "anthropic", model: model ?? "claude-default", piModel: { _stub: true } });

mock.module("../providers/router", () => ({
  resolveModel: async (provider?: unknown, model?: unknown) => {
    resolveModelCalls.push([provider, model]);
    return resolveModelImpl(provider, model);
  },
}));

mock.module("../providers/llm", () => ({
  completeLLM: async (_piModel: unknown, ctx: { systemPrompt: string }) => ({
    content: [{ type: "text", text: `STUBBED:${ctx.systemPrompt.slice(0, 12)}` }],
  }),
}));

const { createUser } = await import("../db/queries/users");
const { createConversation, createMessage } = await import("../db/queries/conversations");
const { createSummarizeConversationTool } = await import("../runtime/tools/ez/summarize-conversation");
const { getDb } = await import("../db/connection");
const { projects } = await import("../db/schema");

let userId: string;
let conversationId: string;
let emptyConvId: string;

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "ez-summ@test.com", passwordHash: "h", name: "S" });
  userId = u.id;
  // The conversations FK requires a project — use the migrated 'global' row.
  await getDb().insert(projects).values({ id: "summ-proj", name: "summ", path: "/tmp/summ", description: "", userId }).onConflictDoNothing();
  const conv = await createConversation("summ-proj", { title: "T", userId });
  conversationId = conv.id;
  await createMessage(conversationId, { role: "user", content: "What's the weather?" });
  await createMessage(conversationId, { role: "assistant", content: "Sunny and 75F." });
  await createMessage(conversationId, { role: "user", content: "Thanks!" });

  const empty = await createConversation("summ-proj", { title: "Empty", userId });
  emptyConvId = empty.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("summarize_conversation", () => {
  test("happy path: default style is 'brief' and the stub receives the brief prompt", async () => {
    const calls: Array<{ system: string; transcript: string }> = [];
    const tool = createSummarizeConversationTool({
      summarize: async (system, transcript) => {
        calls.push({ system, transcript });
        return "BRIEF SUMMARY";
      },
    });
    const result = await tool.execute("s-1", { conversationId });
    expect(expectText(result)).toBe("BRIEF SUMMARY");
    const details = expectDetails<SummaryDetails>(result);
    expect(details.style).toBe("brief");
    expect(details.messageCount).toBe(3);
    expect(calls.length).toBe(1);
    expect(calls[0]!.system).toContain("2-3 sentences");
    expect(calls[0]!.transcript).toContain("user: What's the weather?");
    expect(calls[0]!.transcript).toContain("assistant: Sunny and 75F.");
  });

  test("style='standup' routes to the bulleted-update prompt", async () => {
    const calls: Array<{ system: string }> = [];
    const tool = createSummarizeConversationTool({
      summarize: async (system) => {
        calls.push({ system });
        return "* discussed weather";
      },
    });
    const result = await tool.execute("s-2", { conversationId, style: "standup" });
    expect(expectDetails<SummaryDetails>(result).style).toBe("standup");
    expect(calls[0]!.system).toContain("daily-standup");
  });

  test("style='tweet' routes to the under-280-char prompt", async () => {
    const calls: Array<{ system: string }> = [];
    const tool = createSummarizeConversationTool({
      summarize: async (system) => {
        calls.push({ system });
        return "Asked about weather. Sunny.";
      },
    });
    const result = await tool.execute("s-3", { conversationId, style: "tweet" });
    expect(expectDetails<SummaryDetails>(result).style).toBe("tweet");
    expect(calls[0]!.system).toContain("280 characters");
  });

  test("missing conversation returns an error result, not a thrown exception", async () => {
    const tool = createSummarizeConversationTool({
      summarize: async () => "should-not-be-called",
    });
    const result = await tool.execute("s-4", { conversationId: "ghost-conv-id" });
    expect(expectDetails<SummaryDetails>(result).isError).toBe(true);
    expectText(result, "not found");
  });

  test("empty conversation reports the empty-state message and skips the LLM", async () => {
    let summarizerCalled = false;
    const tool = createSummarizeConversationTool({
      summarize: async () => {
        summarizerCalled = true;
        return "should-not-be-called";
      },
    });
    const result = await tool.execute("s-5", { conversationId: emptyConvId });
    expectText(result, "empty conversation");
    expect(expectDetails<SummaryDetails>(result).messageCount).toBe(0);
    expect(summarizerCalled).toBe(false);
  });

  test("conversationId is required (rejects empty string)", async () => {
    const tool = createSummarizeConversationTool({
      summarize: async () => "x",
    });
    const result = await tool.execute("s-6", { conversationId: "  " });
    expect(expectDetails<SummaryDetails>(result).isError).toBe(true);
    expectText(result, "conversationId");
  });

  // ── Phase 48 fix: provider/model threading into defaultSummarize ────
  // These tests exercise the DEFAULT (non-injected) summarizer path.
  // resolveModel + completeLLM are mocked at module load (top of file)
  // so we can assert exactly which arguments resolveModel receives.

  test("default summarizer threads ctx.provider + ctx.model into resolveModel (the bug-fix path)", async () => {
    resolveModelCalls.length = 0;
    resolveModelImpl = async (provider, model) => ({ provider, model, piModel: { _stub: true } });

    // No `summarize` injection — exercise the real defaultSummarize.
    const tool = createSummarizeConversationTool({ provider: "openai", model: "gpt-5.5" });
    const result = await tool.execute("s-7", { conversationId });

    // The summary came from the stubbed completeLLM, proving
    // defaultSummarize ran end-to-end without throwing.
    expectText(result, "STUBBED:");
    expect(expectDetails<SummaryDetails>(result).isError).toBeUndefined();

    // The user's picked model was the FIRST resolveModel call — not
    // `(undefined)`. Before the fix, only `(undefined, undefined)` was
    // ever passed, which routed to the Anthropic-first default tier
    // and threw "no Anthropic credentials configured" when the user
    // had only an OpenAI key.
    expect(resolveModelCalls.length).toBeGreaterThanOrEqual(1);
    expect(resolveModelCalls[0]).toEqual(["openai", "gpt-5.5"]);
  });

  test("default summarizer falls back to resolveModel(undefined) when provider+model are absent (legacy behavior preserved)", async () => {
    resolveModelCalls.length = 0;
    resolveModelImpl = async (provider, model) => ({
      provider: provider ?? "anthropic",
      model: model ?? "claude-default",
      piModel: { _stub: true },
    });

    // No provider/model in ctx — same construction as before the fix.
    const tool = createSummarizeConversationTool({});
    const result = await tool.execute("s-8", { conversationId });

    expectText(result, "STUBBED:");

    // Single resolveModel call, with `undefined` provider — the legacy
    // default-tier fallback path. The fix MUST NOT change this branch.
    expect(resolveModelCalls.length).toBe(1);
    expect(resolveModelCalls[0]![0]).toBeUndefined();
    expect(resolveModelCalls[0]![1]).toBeUndefined();
  });

  test("default summarizer falls back to resolveModel(undefined) when only provider is set (model missing)", async () => {
    resolveModelCalls.length = 0;
    resolveModelImpl = async (provider, model) => ({
      provider: provider ?? "anthropic",
      model: model ?? "claude-default",
      piModel: { _stub: true },
    });

    // Asymmetric input — should NOT be treated as "user picked
    // openai" because we can't pick a default model for them without
    // re-implementing tier resolution. Falls through to `(undefined)`.
    const tool = createSummarizeConversationTool({ provider: "openai" });
    const result = await tool.execute("s-9", { conversationId });

    expectText(result, "STUBBED:");
    expect(resolveModelCalls.length).toBe(1);
    expect(resolveModelCalls[0]![0]).toBeUndefined();
  });

  test("default summarizer falls back to resolveModel(undefined) if the picked provider+model fails to resolve", async () => {
    resolveModelCalls.length = 0;
    let callNum = 0;
    resolveModelImpl = async (provider, model) => {
      callNum++;
      if (callNum === 1) {
        // Simulate the picked model being unavailable (no credential,
        // unknown id, etc.) — defaultSummarize should swallow this and
        // try the legacy default-tier path.
        throw new Error("simulated picked-model failure");
      }
      return { provider: provider ?? "anthropic", model: model ?? "claude-default", piModel: { _stub: true } };
    };

    const tool = createSummarizeConversationTool({ provider: "openai", model: "gpt-5.5" });
    const result = await tool.execute("s-10", { conversationId });

    // First call used the picked pair; second call (the fallback) used `undefined`.
    expect(resolveModelCalls.length).toBe(2);
    expect(resolveModelCalls[0]).toEqual(["openai", "gpt-5.5"]);
    expect(resolveModelCalls[1]![0]).toBeUndefined();
    expect(resolveModelCalls[1]![1]).toBeUndefined();
    expectText(result, "STUBBED:");
  });

  // ── Phase 48 defense-in-depth: server-side conversationId default ─────
  // The LLM sometimes fails to extract `conversationId` from the
  // JSON-in-system-prompt page_context block. The runtime now wires a
  // `defaultConversationId` (pulled from `ezContext.route.conversationId`)
  // into the summarize tool factory; the tool prefers an explicit
  // params.conversationId when present, falls back to the default
  // otherwise, and only errors when BOTH are missing.

  test("defaults to ctx.defaultConversationId when params.conversationId is omitted", async () => {
    const calls: Array<{ system: string; transcript: string }> = [];
    const tool = createSummarizeConversationTool({
      defaultConversationId: conversationId,
      summarize: async (system, transcript) => {
        calls.push({ system, transcript });
        return "DEFAULTED";
      },
    });
    // No conversationId in params — the runtime default kicks in.
    const result = await tool.execute("s-d1", {});
    expectText(result, "DEFAULTED");
    const details = expectDetails<SummaryDetails>(result);
    expect(details.isError).toBeUndefined();
    expect(details.conversationId).toBe(conversationId);
    expect(details.messageCount).toBe(3);
    expect(calls.length).toBe(1);
  });

  test("defaults to ctx.defaultConversationId when params.conversationId is empty/whitespace", async () => {
    const tool = createSummarizeConversationTool({
      defaultConversationId: conversationId,
      summarize: async () => "DEFAULTED",
    });
    const result = await tool.execute("s-d2", { conversationId: "   " });
    expectText(result, "DEFAULTED");
    expect(expectDetails<SummaryDetails>(result).conversationId).toBe(conversationId);
  });

  test("explicit params.conversationId WINS over ctx.defaultConversationId", async () => {
    // Two convs exist (the suite's main convId and the empty one). The
    // user passes the empty conv explicitly — that must be summarized,
    // even though the default points to the populated one.
    const tool = createSummarizeConversationTool({
      defaultConversationId: conversationId, // populated conv (3 msgs)
      summarize: async () => "should-not-be-called",
    });
    const result = await tool.execute("s-d3", { conversationId: emptyConvId });
    // Empty-conv path returns the empty-state message and SKIPS the
    // summarizer — proves the explicit id was honored.
    expectText(result, "empty conversation");
    expect(expectDetails<SummaryDetails>(result).messageCount).toBe(0);
  });

  test("error when BOTH params.conversationId AND ctx.defaultConversationId are missing", async () => {
    const tool = createSummarizeConversationTool({
      // No defaultConversationId — simulates the user being on a
      // non-chat page (no current conversation to default to).
      summarize: async () => "should-not-be-called",
    });
    const result = await tool.execute("s-d4", {});
    expect(expectDetails<SummaryDetails>(result).isError).toBe(true);
    expectText(result, "conversationId");
  });

  test("error when params is empty AND ctx.defaultConversationId is empty string", async () => {
    const tool = createSummarizeConversationTool({
      defaultConversationId: "   ",
      summarize: async () => "should-not-be-called",
    });
    const result = await tool.execute("s-d5", { conversationId: "" });
    expect(expectDetails<SummaryDetails>(result).isError).toBe(true);
    expectText(result, "conversationId");
  });

  test("conversationId is no longer in the parameters' `required` array", () => {
    const tool = createSummarizeConversationTool({});
    const params = tool.parameters as { required?: string[] };
    expect(params.required ?? []).not.toContain("conversationId");
  });
});
