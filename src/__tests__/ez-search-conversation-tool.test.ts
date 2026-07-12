/**
 * search_conversation Ez tool.
 *
 * Two layers, mirroring the summarize_conversation test:
 *  - Injectable-seam tests: a deterministic `search` stub captures the
 *    params the tool forwards and returns canned `MessageSearchHit`s, so we
 *    assert formatting, <mark> stripping, conversationId narrowing,
 *    limit defaulting/capping, no-results messaging, and error handling
 *    without touching the DB.
 *  - Real-PGlite integration: the tool with NO injected seam runs the real
 *    `searchMessages` in keyword mode over seeded messages — proving the
 *    default wiring + tenant scoping (results only for the ctx userId).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { expectDetails, expectText } from "./helpers/expect-tool-result";

interface SearchDetails {
  query?: string;
  conversationId?: string;
  count?: number;
  isError?: boolean;
}

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createConversation, createMessage } = await import("../db/queries/conversations");
const { createSearchConversationTool } = await import("../runtime/tools/ez/search-conversation");
const { getDb } = await import("../db/connection");
const { projects } = await import("../db/schema");
type MessageSearchHit = import("../db/queries/message-search").MessageSearchHit;

/** Minimal MessageSearchHit fixture for the seam tests. */
function makeHit(over: Partial<MessageSearchHit> & { conversationId: string }): MessageSearchHit {
  return {
    conversationId: over.conversationId,
    conversationTitle: over.conversationTitle ?? "Some chat",
    messageId: over.messageId ?? "m-1",
    role: over.role ?? "user",
    createdAt: over.createdAt ?? new Date("2026-01-02T03:04:05.000Z"),
    snippet: over.snippet ?? "a plain snippet",
    matchType: over.matchType ?? "lexical",
    rankLexical: over.rankLexical ?? 1,
    rankSemantic: over.rankSemantic ?? null,
    score: over.score ?? 0.5,
    projectId: over.projectId ?? "p-1",
    projectName: over.projectName ?? "Proj",
  };
}

describe("search_conversation (injectable seam)", () => {
  test("formats hits as a numbered list with title, id, role, timestamp, and stripped snippet", async () => {
    const tool = createSearchConversationTool({
      userId: "u-1",
      search: async () => [
        makeHit({
          conversationId: "conv-a",
          conversationTitle: "Trip planning",
          role: "assistant",
          snippet: "we discussed <mark>pineapple</mark> imports",
        }),
        makeHit({ conversationId: "conv-b", conversationTitle: "Budget", role: "user", snippet: "second hit" }),
      ],
    });
    const result = await tool.execute("q-1", { query: "pineapple" });
    const text = expectText(result);
    expect(text).toContain("Found 2 messages matching \"pineapple\"");
    expect(text).toContain("[assistant] \"Trip planning\"");
    expect(text).toContain("conversationId: conv-a");
    expect(text).toContain("2026-01-02T03:04:05.000Z");
    // <mark> wrappers stripped to plain text.
    expect(text).toContain("we discussed pineapple imports");
    expect(text).not.toContain("<mark>");
    // Points the model at the escalation tool.
    expect(text).toContain("summarize_conversation");
    const details = expectDetails<SearchDetails>(result);
    expect(details.count).toBe(2);
    expect(details.query).toBe("pineapple");
    expect(details.conversationId).toBeUndefined();
  });

  test("threads ctx.userId + defaults limit to 10", async () => {
    const seen: Array<{ query: string; userId: string; limit: number }> = [];
    const tool = createSearchConversationTool({
      userId: "user-xyz",
      search: async (p) => {
        seen.push(p);
        return [];
      },
    });
    await tool.execute("q-2", { query: "hello" });
    expect(seen[0]).toEqual({ query: "hello", userId: "user-xyz", limit: 10 });
  });

  test("caps limit at 20 and floors it at 1", async () => {
    const seen: number[] = [];
    const tool = createSearchConversationTool({
      userId: "u-1",
      search: async (p) => {
        seen.push(p.limit);
        return [];
      },
    });
    await tool.execute("q-3a", { query: "x", limit: 50 }); // over the cap → 20
    await tool.execute("q-3b", { query: "x", limit: 0 }); // under the floor → 1
    await tool.execute("q-3c", { query: "x", limit: 4 }); // in range → 4
    expect(seen).toEqual([20, 1, 4]);
  });

  test("conversationId narrows the hits (over-fetching to the cap, then post-filtering)", async () => {
    let seenLimit = -1;
    const tool = createSearchConversationTool({
      userId: "u-1",
      search: async (p) => {
        seenLimit = p.limit;
        return [
          makeHit({ conversationId: "keep", conversationTitle: "Keep" }),
          makeHit({ conversationId: "drop", conversationTitle: "Drop" }),
          makeHit({ conversationId: "keep", conversationTitle: "Keep", messageId: "m-2", snippet: "second keep" }),
        ];
      },
    });
    const result = await tool.execute("q-4", { query: "x", conversationId: "keep" });
    const text = expectText(result);
    expect(text).toContain("Found 2 messages");
    expect(text).toContain("conversationId: keep");
    expect(text).not.toContain("conversationId: drop");
    // Narrowing over-fetches to the cap so the filter has room to fill `limit`.
    expect(seenLimit).toBe(20);
    expect(expectDetails<SearchDetails>(result).conversationId).toBe("keep");
  });

  test("no results (unscoped) returns a friendly message", async () => {
    const tool = createSearchConversationTool({ userId: "u-1", search: async () => [] });
    const result = await tool.execute("q-5", { query: "nothingmatches" });
    const text = expectText(result);
    expect(text).toContain("No messages matching \"nothingmatches\" were found.");
    const details = expectDetails<SearchDetails>(result);
    expect(details.count).toBe(0);
    expect(details.conversationId).toBeUndefined();
  });

  test("no results within a narrowed conversationId names the conversation", async () => {
    const tool = createSearchConversationTool({
      userId: "u-1",
      // Hits exist, but none in the narrowed conversation → filtered to empty.
      search: async () => [makeHit({ conversationId: "other" })],
    });
    const result = await tool.execute("q-6", { query: "x", conversationId: "target-conv" });
    expect(expectText(result)).toContain("in conversation target-conv");
    expect(expectDetails<SearchDetails>(result).conversationId).toBe("target-conv");
  });

  test("empty query returns an error result, not a throw", async () => {
    const tool = createSearchConversationTool({ userId: "u-1", search: async () => [makeHit({ conversationId: "x" })] });
    const result = await tool.execute("q-7", { query: "   " });
    expect(expectDetails<SearchDetails>(result).isError).toBe(true);
    expectText(result, "query is required");
  });

  test("a throwing search seam surfaces as a tool error", async () => {
    const tool = createSearchConversationTool({
      userId: "u-1",
      search: async () => {
        throw new Error("search backend exploded");
      },
    });
    const result = await tool.execute("q-8", { query: "x" });
    expect(expectDetails<SearchDetails>(result).isError).toBe(true);
    expectText(result, "search backend exploded");
  });
});

describe("search_conversation (real PGlite, keyword mode)", () => {
  let user1: string;
  let user2: string;
  let conv1Id: string;
  let conv2Id: string;

  beforeAll(async () => {
    await setupTestDb();
    const u1 = await createUser({ email: "ez-search-1@test.com", passwordHash: "h", name: "One" });
    const u2 = await createUser({ email: "ez-search-2@test.com", passwordHash: "h", name: "Two" });
    user1 = u1.id;
    user2 = u2.id;
    await getDb()
      .insert(projects)
      .values({ id: "search-proj", name: "search", path: "/tmp/search", description: "", userId: user1 })
      .onConflictDoNothing();

    const c1 = await createConversation("search-proj", { title: "User1 chat", userId: user1 });
    conv1Id = c1.id;
    await createMessage(conv1Id, { role: "user", content: "I want to talk about pineapple farming techniques." });
    await createMessage(conv1Id, { role: "assistant", content: "Sure — bananas grow differently than apples." });

    // A second user's conversation that ALSO mentions the search term — the
    // tenant scope must exclude it from user1's results.
    const c2 = await createConversation("search-proj", { title: "User2 chat", userId: user2 });
    conv2Id = c2.id;
    await createMessage(conv2Id, { role: "user", content: "My pineapple plantation is thriving." });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  test("default wiring runs real searchMessages and returns a matching hit", async () => {
    const tool = createSearchConversationTool({ userId: user1 });
    const result = await tool.execute("int-1", { query: "pineapple" });
    const text = expectText(result);
    // Singular noun proves exactly one hit for user1.
    expect(text).toContain("Found 1 message matching \"pineapple\"");
    expect(text).toContain(`conversationId: ${conv1Id}`);
    expect(text).toContain("pineapple");
    expect(text).not.toContain("<mark>");
    expect(expectDetails<SearchDetails>(result).count).toBe(1);
  });

  test("tenant scope: user1's search never returns user2's conversation", async () => {
    const tool = createSearchConversationTool({ userId: user1 });
    const result = await tool.execute("int-2", { query: "pineapple" });
    const text = expectText(result);
    expect(text).not.toContain(conv2Id);
    expect(text).toContain(conv1Id);
  });

  test("a user with no matching conversations gets the no-results message", async () => {
    const tool = createSearchConversationTool({ userId: user2 });
    // user2 mentions pineapple but not this term.
    const result = await tool.execute("int-3", { query: "quantum" });
    expect(expectText(result)).toContain("No messages matching \"quantum\" were found.");
    expect(expectDetails<SearchDetails>(result).count).toBe(0);
  });
});
