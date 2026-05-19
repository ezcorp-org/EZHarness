/**
 * DB-level tests for `cloneTurnsIntoNewConversation` — the helper behind the
 * chat-window "Select Mode → New Chat" feature. Uses an in-memory PGlite so
 * the full FK / cascade / jsonb behaviour is exercised.
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { eq, asc } from "drizzle-orm";
import {
  users,
  projects,
  extensions,
  conversations,
  messages,
  toolCalls,
} from "../db/schema";
import {
  cloneTurnsIntoNewConversation,
  updateMessageContent,
} from "../db/queries/conversations";

const USER_ID = "u-clone-1";
const OTHER_USER_ID = "u-clone-other";
const PROJECT_ID = "p-clone-1";
const EXT_ID = "ext-clone-1";
const SOURCE_CONV_ID = "conv-source-1";

async function seedFixtures() {
  const db = getTestDb();
  await db.insert(users).values([
    { id: USER_ID, email: "c@x.com", passwordHash: "x", name: "Clone", role: "member" } as any,
    { id: OTHER_USER_ID, email: "o@x.com", passwordHash: "x", name: "Other", role: "member" } as any,
  ]);
  await db.insert(projects).values({ id: PROJECT_ID, name: "p", path: "/tmp/p" } as any);
  await db.insert(extensions).values({
    id: EXT_ID,
    name: "test-ext",
    version: "0.0.1",
    description: "",
    manifest: { schemaVersion: 2, name: "test-ext", version: "0.0.1", description: "", author: { name: "t" }, permissions: {}, entrypoint: "./e.ts", tools: [] },
    source: "bundled",
  } as any);
  await db.insert(conversations).values({
    id: SOURCE_CONV_ID,
    projectId: PROJECT_ID,
    title: "Source chat",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    systemPrompt: "Be helpful.",
    userId: USER_ID,
  } as any);

  // Seed three turns — two user, one assistant — with an inline tool call
  // hanging off the assistant message. parentMessageId chain simulates a
  // branched history (msg-1 → msg-2a / msg-2b → msg-3).
  const created: Date[] = [
    new Date("2026-04-01T00:00:00Z"),
    new Date("2026-04-01T00:01:00Z"),
    new Date("2026-04-01T00:02:00Z"),
    new Date("2026-04-01T00:03:00Z"),
  ];
  await db.insert(messages).values([
    {
      id: "msg-1",
      conversationId: SOURCE_CONV_ID,
      role: "user",
      content: "Start: summarize this doc.",
      parentMessageId: null,
      runId: null,
      createdAt: created[0],
    },
    {
      id: "msg-2a",
      conversationId: SOURCE_CONV_ID,
      role: "assistant",
      content: "Sure! Here's a summary.",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      parentMessageId: "msg-1",
      runId: null,
      createdAt: created[1],
    },
    {
      id: "msg-2b",
      conversationId: SOURCE_CONV_ID,
      role: "assistant",
      content: "Alternative branch response.",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      parentMessageId: "msg-1",
      runId: null,
      createdAt: created[2],
    },
    {
      id: "msg-3",
      conversationId: SOURCE_CONV_ID,
      role: "user",
      content: "Thanks — now expand it.",
      parentMessageId: "msg-2a",
      runId: null,
      createdAt: created[3],
    },
  ] as any);

  // Inline tool call attached to msg-2a — must travel with the clone.
  await db.insert(toolCalls).values([
    {
      id: "tc-1",
      conversationId: SOURCE_CONV_ID,
      messageId: "msg-2a",
      extensionId: EXT_ID,
      toolName: "read_file",
      input: { path: "README.md" },
      output: { content: [{ type: "text", text: "# Hello" }] },
      success: true,
      durationMs: 42,
      userId: USER_ID,
      createdAt: created[1],
    },
    // Stray tool call against another message that is NOT in the selection —
    // must be excluded from the clone.
    {
      id: "tc-2",
      conversationId: SOURCE_CONV_ID,
      messageId: "msg-2b",
      extensionId: EXT_ID,
      toolName: "write_file",
      input: { path: "notes.md" },
      output: null,
      success: true,
      durationMs: 10,
      userId: USER_ID,
      createdAt: created[2],
    },
  ] as any);
}

// Module-level lifecycle: mockDbConnection() is only valid until
// restoreModuleMocks() fires. Running restoreModuleMocks() at the end of each
// describe would re-register the real `db/connection` for subsequent describes
// in THIS file (which still need the PGlite stub). Keep one afterAll at the
// very bottom of the file, and reset the DB in every beforeEach.
beforeEach(async () => {
  await setupTestDb();
  await seedFixtures();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("cloneTurnsIntoNewConversation", () => {

  test("clones selected messages in createdAt order with a fresh linear parent chain", async () => {
    const { conversation, messageIdMap } = await cloneTurnsIntoNewConversation(
      SOURCE_CONV_ID,
      ["msg-3", "msg-1", "msg-2a"], // client-supplied order should NOT matter
      { userId: USER_ID },
    );

    const db = getTestDb();
    const newRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(asc(messages.createdAt));

    // createdAt order from seed: msg-1, msg-2a, msg-3 (msg-2b not selected).
    expect(newRows).toHaveLength(3);
    expect(newRows.map((r) => r.content)).toEqual([
      "Start: summarize this doc.",
      "Sure! Here's a summary.",
      "Thanks — now expand it.",
    ]);

    // Fresh ids (not reused from source)
    const newIds = newRows.map((r) => r.id);
    expect(newIds).not.toContain("msg-1");
    expect(newIds).not.toContain("msg-2a");
    expect(newIds).not.toContain("msg-3");

    // Linear parent chain: first has no parent; subsequent point at previous.
    expect(newRows[0]!.parentMessageId).toBeNull();
    expect(newRows[1]!.parentMessageId).toBe(newRows[0]!.id);
    expect(newRows[2]!.parentMessageId).toBe(newRows[1]!.id);

    // runId is cleared (no live run linkage)
    expect(newRows.every((r) => r.runId === null)).toBe(true);

    // messageIdMap maps old → new for each selected id.
    expect(messageIdMap.get("msg-1")).toBe(newRows[0]!.id);
    expect(messageIdMap.get("msg-2a")).toBe(newRows[1]!.id);
    expect(messageIdMap.get("msg-3")).toBe(newRows[2]!.id);
    expect(messageIdMap.has("msg-2b")).toBe(false);
  });

  test("inherits projectId / model / provider / systemPrompt from source", async () => {
    const { conversation } = await cloneTurnsIntoNewConversation(
      SOURCE_CONV_ID,
      ["msg-1"],
      { userId: USER_ID },
    );

    expect(conversation.projectId).toBe(PROJECT_ID);
    expect(conversation.model).toBe("claude-sonnet-4-6");
    expect(conversation.provider).toBe("anthropic");
    expect(conversation.systemPrompt).toBe("Be helpful.");
    expect(conversation.userId).toBe(USER_ID);
    expect(conversation.title).toBe("Forked: Source chat");
  });

  test("links the fork back to its source via forkedFrom* fields", async () => {
    // Anchor must be the LAST selected message in createdAt order, regardless
    // of client-supplied ordering. Sidebar groups forks under the source via
    // forkedFromConversationId; forkedFromMessageId pinpoints the branch point.
    const { conversation } = await cloneTurnsIntoNewConversation(
      SOURCE_CONV_ID,
      ["msg-3", "msg-1", "msg-2a"], // mixed order
      { userId: USER_ID },
    );

    expect(conversation.forkedFromConversationId).toBe(SOURCE_CONV_ID);
    // msg-3 is the most recent of the three selected (per seed createdAt).
    expect(conversation.forkedFromMessageId).toBe("msg-3");
    // Forks are NOT sub-conversations — parentConversationId stays null so
    // they show up in the sidebar's listConversations query.
    expect(conversation.parentConversationId).toBeNull();
    expect(conversation.parentMessageId).toBeNull();
  });

  test("honours custom title", async () => {
    const { conversation } = await cloneTurnsIntoNewConversation(
      SOURCE_CONV_ID,
      ["msg-1"],
      { userId: USER_ID, title: "My custom title" },
    );
    expect(conversation.title).toBe("My custom title");
  });

  test("clones inline tool calls associated with selected messages, re-parented to new ids", async () => {
    const { conversation, messageIdMap } = await cloneTurnsIntoNewConversation(
      SOURCE_CONV_ID,
      ["msg-1", "msg-2a"],
      { userId: USER_ID },
    );

    const db = getTestDb();
    const newCalls = await db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.conversationId, conversation.id));

    // Only tc-1 (attached to msg-2a) should travel; tc-2 attached to
    // un-selected msg-2b must NOT appear.
    expect(newCalls).toHaveLength(1);
    expect(newCalls[0]!.toolName).toBe("read_file");
    expect(newCalls[0]!.id).not.toBe("tc-1");
    expect(newCalls[0]!.messageId).toBe(messageIdMap.get("msg-2a") ?? null);
    expect(newCalls[0]!.input).toEqual({ path: "README.md" });
    expect(newCalls[0]!.success).toBe(true);
    expect(newCalls[0]!.durationMs).toBe(42);
  });

  test("deduplicates repeated ids in selection payload", async () => {
    const { conversation } = await cloneTurnsIntoNewConversation(
      SOURCE_CONV_ID,
      ["msg-1", "msg-1", "msg-2a"],
      { userId: USER_ID },
    );

    const db = getTestDb();
    const newRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(newRows).toHaveLength(2);
  });

  test("throws when messageIds is empty", async () => {
    await expect(
      cloneTurnsIntoNewConversation(SOURCE_CONV_ID, [], { userId: USER_ID }),
    ).rejects.toThrow(/non-empty/);
  });

  test("throws when any messageId does not belong to source conversation", async () => {
    await expect(
      cloneTurnsIntoNewConversation(
        SOURCE_CONV_ID,
        ["msg-1", "does-not-exist"],
        { userId: USER_ID },
      ),
    ).rejects.toThrow(/do not belong/);
  });

  test("throws when source conversation does not exist", async () => {
    await expect(
      cloneTurnsIntoNewConversation("no-such-conv", ["msg-1"], { userId: USER_ID }),
    ).rejects.toThrow(/not found/);
  });

  test("unselected messages do not appear in cloned conversation", async () => {
    const { conversation } = await cloneTurnsIntoNewConversation(
      SOURCE_CONV_ID,
      ["msg-1"],
      { userId: USER_ID },
    );
    const db = getTestDb();
    const newRows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));
    expect(newRows).toHaveLength(1);
    expect(newRows[0]!.content).toBe("Start: summarize this doc.");
  });

  test("preserves per-message thinkingContent, model, provider, and usage on the clone", async () => {
    const db = getTestDb();
    // Augment msg-2a with reasoning-model fields so the assertion has something
    // to latch onto. (Seed fixture leaves these null by default.)
    await db
      .update(messages)
      .set({
        thinkingContent: "Let me reason about this…",
        usage: { inputTokens: 42, outputTokens: 18 },
      })
      .where(eq(messages.id, "msg-2a"));

    const { conversation } = await cloneTurnsIntoNewConversation(
      SOURCE_CONV_ID,
      ["msg-2a"],
      { userId: USER_ID },
    );

    const cloned = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id));

    expect(cloned).toHaveLength(1);
    expect(cloned[0]!.thinkingContent).toBe("Let me reason about this…");
    expect(cloned[0]!.model).toBe("claude-sonnet-4-6");
    expect(cloned[0]!.provider).toBe("anthropic");
    expect(cloned[0]!.usage).toEqual({ inputTokens: 42, outputTokens: 18 });
    // runId is deliberately cleared (fresh history, no back-link to source run).
    expect(cloned[0]!.runId).toBeNull();
  });
});

describe("updateMessageContent", () => {
  test("updates only the content field of the targeted message", async () => {
    const updated = await updateMessageContent(SOURCE_CONV_ID, "msg-2a", "Edited response.");
    expect(updated).not.toBeNull();
    expect(updated!.content).toBe("Edited response.");
    expect(updated!.role).toBe("assistant");
    expect(updated!.parentMessageId).toBe("msg-1");

    const db = getTestDb();
    const otherRows = await db
      .select()
      .from(messages)
      .where(eq(messages.id, "msg-1"));
    expect(otherRows[0]!.content).toBe("Start: summarize this doc.");
  });

  test("returns null when message does not belong to conversation", async () => {
    const result = await updateMessageContent(SOURCE_CONV_ID, "missing-id", "ignored");
    expect(result).toBeNull();
  });
});
