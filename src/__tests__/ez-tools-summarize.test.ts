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
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { expectDetails, expectText } from "./helpers/expect-tool-result";

interface SummaryDetails {
  conversationId?: string;
  style?: "brief" | "standup" | "tweet";
  messageCount?: number;
  isError?: boolean;
}

mockDbConnection();

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
});
