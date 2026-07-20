/**
 * query-core db-audit fixes for conversations.ts:
 *  - cloneTurnsIntoNewConversation enqueues an embed-outbox job for every
 *    cloned eligible message (IDX-04 invariant — a fork copy was invisible to
 *    semantic search forever), and runs the copy as one transaction.
 *  - deleteAllMessagesForConversation wipes extensions + tool_calls + messages
 *    as one all-or-nothing transaction.
 *  - searchConversations bounds output with LIMIT/OFFSET and still snippets.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "../../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb,
  getTestDb,
  closeTestDb,
  mockDbConnection,
} from "../../../__tests__/helpers/test-pglite";

mockDbConnection();

import { eq } from "drizzle-orm";
import {
  users,
  projects,
  extensions,
  conversations,
  messages,
  toolCalls,
  conversationExtensions,
  messageEmbedOutbox,
} from "../../schema";
import {
  cloneTurnsIntoNewConversation,
  deleteAllMessagesForConversation,
  searchConversations,
  createConversation,
  createMessage,
} from "../conversations";

const USER_ID = "u-qc-1";
const PROJECT_ID = "p-qc-1";
const EXT_ID = "ext-qc-1";
const SOURCE_CONV_ID = "conv-qc-source";

async function seedBase() {
  const db = getTestDb();
  await db.insert(users).values({
    id: USER_ID, email: "qc@x.com", passwordHash: "x", name: "QC", role: "member",
  } as any);
  await db.insert(projects).values({ id: PROJECT_ID, name: "p", path: "/tmp/p" } as any);
  await db.insert(extensions).values({
    id: EXT_ID,
    name: "test-ext",
    version: "0.0.1",
    description: "",
    manifest: { schemaVersion: 2, name: "test-ext", version: "0.0.1", description: "", author: { name: "t" }, permissions: {}, entrypoint: "./e.ts", tools: [] },
    source: "bundled",
  } as any);
}

async function seedCloneSource() {
  const db = getTestDb();
  await db.insert(conversations).values({
    id: SOURCE_CONV_ID, projectId: PROJECT_ID, title: "Source", userId: USER_ID,
  } as any);
  const created = [
    new Date("2026-04-01T00:00:00Z"),
    new Date("2026-04-01T00:01:00Z"),
  ];
  await db.insert(messages).values([
    { id: "m-1", conversationId: SOURCE_CONV_ID, role: "user", content: "Summarize this doc please.", parentMessageId: null, runId: null, createdAt: created[0] },
    { id: "m-2", conversationId: SOURCE_CONV_ID, role: "assistant", content: "Here is a summary.", parentMessageId: "m-1", runId: null, createdAt: created[1] },
  ] as any);
}

beforeEach(async () => {
  await setupTestDb();
  await seedBase();
});
afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("cloneTurnsIntoNewConversation embed enqueue (IDX-04)", () => {
  test("every cloned eligible message gets a pending embed-outbox row", async () => {
    await seedCloneSource();
    const { conversation, messageIdMap } = await cloneTurnsIntoNewConversation(
      SOURCE_CONV_ID,
      ["m-1", "m-2"],
      { userId: USER_ID },
    );

    const db = getTestDb();
    const outbox = await db
      .select()
      .from(messageEmbedOutbox)
      .where(eq(messageEmbedOutbox.conversationId, conversation.id));

    const enqueuedIds = new Set(outbox.map((r) => r.messageId));
    expect(enqueuedIds.has(messageIdMap.get("m-1")!)).toBe(true);
    expect(enqueuedIds.has(messageIdMap.get("m-2")!)).toBe(true);
    expect(outbox.every((r) => r.status === "pending")).toBe(true);
    expect(outbox).toHaveLength(2);
  });

  test("a whitespace-only (ineligible) cloned message is NOT enqueued", async () => {
    const db = getTestDb();
    await db.insert(conversations).values({
      id: "conv-ws", projectId: PROJECT_ID, title: "WS", userId: USER_ID,
    } as any);
    await db.insert(messages).values([
      { id: "ws-1", conversationId: "conv-ws", role: "user", content: "real content here", parentMessageId: null, runId: null, createdAt: new Date("2026-04-02T00:00:00Z") },
      { id: "ws-2", conversationId: "conv-ws", role: "assistant", content: "   ", parentMessageId: "ws-1", runId: null, createdAt: new Date("2026-04-02T00:01:00Z") },
    ] as any);

    const { conversation, messageIdMap } = await cloneTurnsIntoNewConversation(
      "conv-ws",
      ["ws-1", "ws-2"],
      { userId: USER_ID },
    );

    const outbox = await db
      .select()
      .from(messageEmbedOutbox)
      .where(eq(messageEmbedOutbox.conversationId, conversation.id));
    const ids = new Set(outbox.map((r) => r.messageId));
    expect(ids.has(messageIdMap.get("ws-1")!)).toBe(true);
    expect(ids.has(messageIdMap.get("ws-2")!)).toBe(false);
    expect(outbox).toHaveLength(1);
  });
});

describe("deleteAllMessagesForConversation transactional wipe", () => {
  test("removes conversation_extensions, tool_calls and messages together", async () => {
    const db = getTestDb();
    await db.insert(conversations).values({
      id: "conv-del", projectId: PROJECT_ID, title: "Del", userId: USER_ID,
    } as any);
    await db.insert(messages).values({
      id: "dm-1", conversationId: "conv-del", role: "user", content: "hi there", parentMessageId: null, runId: null, createdAt: new Date(),
    } as any);
    await db.insert(toolCalls).values({
      id: "dtc-1", conversationId: "conv-del", messageId: "dm-1", extensionId: EXT_ID, toolName: "t", input: {}, output: {}, success: true, durationMs: 1,
    } as any);
    await db.insert(conversationExtensions).values({
      id: "dce-1", conversationId: "conv-del", extensionId: EXT_ID,
    } as any);

    const removed = await deleteAllMessagesForConversation("conv-del");
    expect(removed).toBe(1);

    expect(await db.select().from(messages).where(eq(messages.conversationId, "conv-del"))).toHaveLength(0);
    expect(await db.select().from(toolCalls).where(eq(toolCalls.conversationId, "conv-del"))).toHaveLength(0);
    expect(await db.select().from(conversationExtensions).where(eq(conversationExtensions.conversationId, "conv-del"))).toHaveLength(0);
    // Conversation row itself survives.
    expect(await db.select().from(conversations).where(eq(conversations.id, "conv-del"))).toHaveLength(1);
  });

  test("throws on an invalid conversationId argument", async () => {
    await expect(deleteAllMessagesForConversation("" as string)).rejects.toThrow(/non-empty/);
  });
});

describe("searchConversations bounded LIMIT/OFFSET", () => {
  async function seedMatches(n: number) {
    for (let i = 0; i < n; i++) {
      const c = await createConversation(PROJECT_ID, { title: `Chat ${i}`, userId: USER_ID });
      await createMessage(c.id, { role: "user", content: `discussing chocolate cake number ${i}` });
    }
  }

  test("caps results at the requested limit", async () => {
    await seedMatches(5);
    const page = await searchConversations(PROJECT_ID, "chocolate cake", USER_ID, { limit: 2 });
    expect(page).toHaveLength(2);
    // Snippet still rendered for surviving rows (headline computed post-limit).
    expect(page[0]!.snippet).toContain("<mark>");
  });

  test("offset advances the page window (disjoint from page 1)", async () => {
    await seedMatches(5);
    const first = await searchConversations(PROJECT_ID, "chocolate cake", USER_ID, { limit: 2, offset: 0 });
    const second = await searchConversations(PROJECT_ID, "chocolate cake", USER_ID, { limit: 2, offset: 2 });
    const firstIds = new Set(first.map((r) => r.id));
    for (const r of second) expect(firstIds.has(r.id)).toBe(false);
    expect(second.length).toBeGreaterThanOrEqual(1);
  });

  test("short/empty query still short-circuits to []", async () => {
    expect(await searchConversations(PROJECT_ID, "a", USER_ID)).toEqual([]);
    expect(await searchConversations(PROJECT_ID, "", USER_ID)).toEqual([]);
  });
});
