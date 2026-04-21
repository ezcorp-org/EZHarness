import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// Re-establish real settings implementation (prevents leaks from parallel tests)
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      if (!rows[0]) return false;
      await getDb().delete(tbl).where(eq(tbl.key, key));
      return true;
    },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

import {
  createConversation,
  createSubConversation,
  getSubConversations,
  getConversation,
  getMessagesWithToolCalls,
  createMessage,
} from "../db/queries/conversations";
import { createProject } from "../db/queries/projects";

let projectId: string;

// Guard helper: narrow array-index access (`arr[i]`) from
// `T | undefined` to `T` in a single place. Throws (rather than
// non-null asserting) so a shape/length regression surfaces as a
// descriptive failure.
function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Sub-Convo Test Project", path: "/tmp/sub-convo-test" });
  projectId = project.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

// ── createConversation with parent fields ─────────────────────────────

describe("createConversation with parent fields", () => {
  test("persists parentConversationId when provided", async () => {
    const parent = await createConversation(projectId, { title: "Parent" });
    const child = await createConversation(projectId, {
      title: "Child",
      parentConversationId: parent.id,
    });
    expect(child.parentConversationId).toBe(parent.id);
    expect(child.parentMessageId).toBeNull();
  });

  test("persists parentMessageId when provided", async () => {
    const parent = await createConversation(projectId, { title: "Parent" });
    const msg = await createMessage(parent.id, { role: "user", content: "Hello" });
    const child = await createConversation(projectId, {
      title: "Child",
      parentConversationId: parent.id,
      parentMessageId: msg.id,
    });
    expect(child.parentConversationId).toBe(parent.id);
    expect(child.parentMessageId).toBe(msg.id);
  });

  test("persists both parent fields together", async () => {
    const parent = await createConversation(projectId, { title: "Parent" });
    const msg = await createMessage(parent.id, { role: "user", content: "Test" });
    const child = await createConversation(projectId, {
      parentConversationId: parent.id,
      parentMessageId: msg.id,
    });
    const fetched = await getConversation(child.id);
    expect(fetched!.parentConversationId).toBe(parent.id);
    expect(fetched!.parentMessageId).toBe(msg.id);
  });

  test("defaults parent fields to null when omitted", async () => {
    const conv = await createConversation(projectId, { title: "No Parent" });
    expect(conv.parentConversationId).toBeNull();
    expect(conv.parentMessageId).toBeNull();
  });

  test("parent fields survive round-trip through getConversation", async () => {
    const parent = await createConversation(projectId, { title: "Parent RT" });
    const msg = await createMessage(parent.id, { role: "user", content: "RT msg" });
    const child = await createConversation(projectId, {
      title: "Child RT",
      parentConversationId: parent.id,
      parentMessageId: msg.id,
    });
    const fetched = await getConversation(child.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.parentConversationId).toBe(parent.id);
    expect(fetched!.parentMessageId).toBe(msg.id);
  });
});

// ── createSubConversation helper ──────────────────────────────────────

describe("createSubConversation", () => {
  test("creates sub-conversation linked to parent", async () => {
    const parent = await createConversation(projectId, { title: "Parent for sub" });
    const sub = await createSubConversation(projectId, {
      parentConversationId: parent.id,
    });
    expect(sub.parentConversationId).toBe(parent.id);
    expect(sub.title).toBe("Sub-conversation");
  });

  test("creates sub-conversation with parentMessageId", async () => {
    const parent = await createConversation(projectId, { title: "Parent" });
    const msg = await createMessage(parent.id, { role: "user", content: "trigger" });
    const sub = await createSubConversation(projectId, {
      parentConversationId: parent.id,
      parentMessageId: msg.id,
    });
    expect(sub.parentConversationId).toBe(parent.id);
    expect(sub.parentMessageId).toBe(msg.id);
  });

  test("creates sub-conversation with custom title", async () => {
    const parent = await createConversation(projectId, { title: "Parent" });
    const sub = await createSubConversation(projectId, {
      parentConversationId: parent.id,
      title: "Research Thread",
    });
    expect(sub.title).toBe("Research Thread");
  });

  test("throws when parentConversationId is missing", async () => {
    expect(() =>
      createSubConversation(projectId, { parentConversationId: "" })
    ).toThrow("parentConversationId is required");
  });
});

// ── getSubConversations ───────────────────────────────────────────────

describe("getSubConversations", () => {
  test("returns sub-conversations for a parent", async () => {
    const parent = await createConversation(projectId, { title: "Parent" });
    const sub1 = await createSubConversation(projectId, {
      parentConversationId: parent.id,
    });
    const sub2 = await createSubConversation(projectId, {
      parentConversationId: parent.id,
    });
    const subs = await getSubConversations(parent.id);
    expect(subs).toHaveLength(2);
    expect(subs.map((s) => s.id)).toContain(sub1.id);
    expect(subs.map((s) => s.id)).toContain(sub2.id);
  });

  test("returns empty array when no sub-conversations exist", async () => {
    const parent = await createConversation(projectId, { title: "Lonely Parent" });
    const subs = await getSubConversations(parent.id);
    expect(subs).toEqual([]);
  });

  test("does not return unrelated conversations", async () => {
    const parent1 = await createConversation(projectId, { title: "Parent 1" });
    const parent2 = await createConversation(projectId, { title: "Parent 2" });
    await createSubConversation(projectId, { parentConversationId: parent1.id });
    await createSubConversation(projectId, { parentConversationId: parent2.id });

    const subs1 = await getSubConversations(parent1.id);
    const subs2 = await getSubConversations(parent2.id);
    expect(subs1).toHaveLength(1);
    expect(subs2).toHaveLength(1);
    expect(at(subs1, 0, "subs1").id).not.toBe(at(subs2, 0, "subs2").id);
  });

  test("returns sub-conversations ordered by createdAt ascending", async () => {
    const parent = await createConversation(projectId, { title: "Ordered Parent" });
    const sub1 = await createSubConversation(projectId, {
      parentConversationId: parent.id,
      title: "First",
    });
    const sub2 = await createSubConversation(projectId, {
      parentConversationId: parent.id,
      title: "Second",
    });
    const subs = await getSubConversations(parent.id);
    expect(at(subs, 0, "subs").id).toBe(sub1.id);
    expect(at(subs, 1, "subs").id).toBe(sub2.id);
  });
});

// ── getMessagesWithToolCalls: SubConversationSummary.parentMessageId ──

describe("getMessagesWithToolCalls sub-conversation summaries", () => {
  test("returns parentMessageId in SubConversationSummary", async () => {
    const parent = await createConversation(projectId, { title: "Hydration Parent" });
    const msg = await createMessage(parent.id, { role: "user", content: "Trigger sub" });
    await createSubConversation(projectId, {
      parentConversationId: parent.id,
      parentMessageId: msg.id,
      title: "Sub with msg link",
    });

    const result = await getMessagesWithToolCalls(parent.id);
    expect(result.subConversations).toHaveLength(1);
    expect(at(result.subConversations, 0, "result.subConversations").parentMessageId).toBe(msg.id);
  });

  test("returns null parentMessageId when sub has no message link", async () => {
    const parent = await createConversation(projectId, { title: "No Msg Link Parent" });
    await createMessage(parent.id, { role: "user", content: "Hi" });
    await createSubConversation(projectId, {
      parentConversationId: parent.id,
    });

    const result = await getMessagesWithToolCalls(parent.id);
    expect(result.subConversations).toHaveLength(1);
    expect(at(result.subConversations, 0, "result.subConversations").parentMessageId).toBeNull();
  });

  test("returns multiple sub-conversation summaries with correct parentMessageIds", async () => {
    const parent = await createConversation(projectId, { title: "Multi Sub Parent" });
    const msg1 = await createMessage(parent.id, { role: "user", content: "First" });
    const msg2 = await createMessage(parent.id, { role: "user", content: "Second" });

    await createSubConversation(projectId, {
      parentConversationId: parent.id,
      parentMessageId: msg1.id,
      title: "Sub 1",
    });
    await createSubConversation(projectId, {
      parentConversationId: parent.id,
      parentMessageId: msg2.id,
      title: "Sub 2",
    });
    await createSubConversation(projectId, {
      parentConversationId: parent.id,
      title: "Sub no msg",
    });

    const result = await getMessagesWithToolCalls(parent.id);
    expect(result.subConversations).toHaveLength(3);

    const withMsg1 = result.subConversations.find((s) => s.parentMessageId === msg1.id);
    const withMsg2 = result.subConversations.find((s) => s.parentMessageId === msg2.id);
    const noMsg = result.subConversations.find((s) => s.parentMessageId === null);

    expect(withMsg1).toBeDefined();
    expect(withMsg2).toBeDefined();
    expect(noMsg).toBeDefined();
  });

  test("SubConversationSummary includes messageCount and lastMessagePreview", async () => {
    const parent = await createConversation(projectId, { title: "Summary Detail Parent" });
    await createMessage(parent.id, { role: "user", content: "Start" });

    const sub = await createSubConversation(projectId, {
      parentConversationId: parent.id,
    });
    await createMessage(sub.id, { role: "user", content: "Sub msg 1" });
    await createMessage(sub.id, { role: "assistant", content: "Sub reply" });

    const result = await getMessagesWithToolCalls(parent.id);
    expect(result.subConversations).toHaveLength(1);
    const summary = at(result.subConversations, 0, "result.subConversations");
    expect(summary.messageCount).toBe(2);
    expect(summary.lastMessagePreview).toBe("Sub reply");
  });

  test("SubConversationSummary has all expected fields", async () => {
    const parent = await createConversation(projectId, { title: "Shape Check Parent" });
    await createMessage(parent.id, { role: "user", content: "Go" });

    await createSubConversation(projectId, {
      parentConversationId: parent.id,
    });

    const result = await getMessagesWithToolCalls(parent.id);
    const summary = at(result.subConversations, 0, "result.subConversations");
    expect(summary).toHaveProperty("id");
    expect(summary).toHaveProperty("agentName");
    expect(summary).toHaveProperty("messageCount");
    expect(summary).toHaveProperty("lastMessagePreview");
    expect(summary).toHaveProperty("parentMessageId");
  });
});

// ── End-to-end flow ───────────────────────────────────────────────────

describe("sub-conversation end-to-end flow", () => {
  test("create parent → add messages → create sub linked to message → fetch subs → hydrate summaries", async () => {
    // 1. Create parent conversation
    const parent = await createConversation(projectId, { title: "E2E Parent" });

    // 2. Add messages to parent
    const userMsg = await createMessage(parent.id, { role: "user", content: "Research topic X" });
    await createMessage(parent.id, { role: "assistant", content: "Starting research..." });

    // 3. Create sub-conversation linked to user message
    const sub = await createSubConversation(projectId, {
      parentConversationId: parent.id,
      parentMessageId: userMsg.id,
      title: "Research: Topic X",
    });

    // 4. Add messages to sub
    await createMessage(sub.id, { role: "user", content: "Searching for topic X" });
    await new Promise(r => setTimeout(r, 10)); // ensure distinct timestamps for ordering
    await createMessage(sub.id, { role: "assistant", content: "Found 3 relevant papers" });

    // 5. Verify via getSubConversations
    const subs = await getSubConversations(parent.id);
    expect(subs).toHaveLength(1);
    const sub0 = at(subs, 0, "subs");
    expect(sub0.id).toBe(sub.id);
    expect(sub0.parentConversationId).toBe(parent.id);
    expect(sub0.parentMessageId).toBe(userMsg.id);
    expect(sub0.title).toBe("Research: Topic X");

    // 6. Verify via getMessagesWithToolCalls (hydration path)
    const hydrated = await getMessagesWithToolCalls(parent.id);
    expect(hydrated.messages).toHaveLength(2);
    expect(hydrated.subConversations).toHaveLength(1);
    const hydSub = at(hydrated.subConversations, 0, "hydrated.subConversations");
    expect(hydSub.id).toBe(sub.id);
    expect(hydSub.parentMessageId).toBe(userMsg.id);
    expect(hydSub.messageCount).toBe(2);
    expect(hydSub.lastMessagePreview).toBe("Found 3 relevant papers");
  });

  test("multiple subs on different messages are correctly mapped on hydration", async () => {
    const parent = await createConversation(projectId, { title: "Multi-Sub E2E" });
    const msg1 = await createMessage(parent.id, { role: "user", content: "Task A" });
    const msg2 = await createMessage(parent.id, { role: "user", content: "Task B" });

    const subA = await createSubConversation(projectId, {
      parentConversationId: parent.id,
      parentMessageId: msg1.id,
      title: "Sub A",
    });
    const subB = await createSubConversation(projectId, {
      parentConversationId: parent.id,
      parentMessageId: msg2.id,
      title: "Sub B",
    });

    await createMessage(subA.id, { role: "assistant", content: "Result A" });
    await createMessage(subB.id, { role: "assistant", content: "Result B" });

    const hydrated = await getMessagesWithToolCalls(parent.id);
    expect(hydrated.subConversations).toHaveLength(2);

    const summaryA = hydrated.subConversations.find((s) => s.parentMessageId === msg1.id);
    const summaryB = hydrated.subConversations.find((s) => s.parentMessageId === msg2.id);
    expect(summaryA).toBeDefined();
    expect(summaryB).toBeDefined();
    expect(summaryA!.id).toBe(subA.id);
    expect(summaryB!.id).toBe(subB.id);
  });
});
