/**
 * Daily Briefing — read-tool tests (PGlite).
 *
 * Covers the three internal tools end-to-end against a real schema:
 *   - list_recent_conversations exclusion matrix (other users, ez-kind,
 *     sub-conversations, test rows, prior briefings, the in-flight
 *     briefing conversation itself), ordering + limit clamping.
 *   - get_conversation_summary ownership gate (no existence oracle),
 *     transcript shape, role filtering, truncation.
 *   - get_task_snapshots ownership skip, aggregation counts, and the
 *     task-tracking-unavailable degradation path.
 *   - wireBriefingToolsForTurn registration + dedup.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

// Controllable task-tracking host stub. `snapshotImpl` is re-pointed
// per-test; the default returns no snapshot.
let snapshotImpl: (conversationId: string) => Promise<unknown> = async () => undefined;
mock.module("../runtime/task-tracking-host", () => ({
  getTaskSnapshotForConversation: (conversationId: string) => snapshotImpl(conversationId),
}));

import {
  createListRecentConversationsTool,
  createGetConversationSummaryTool,
  createGetTaskSnapshotsTool,
  wireBriefingToolsForTurn,
  BRIEFING_TOOL_NAMES,
  type BriefingToolContext,
} from "../runtime/briefing/tools";
import { users, projects, conversations, messages, agentConfigs } from "../db/schema";
import type { AgentTool } from "@mariozechner/pi-agent-core";

let userId: string;
let otherUserId: string;
let projectId: string;
let briefingAgentId: string;

function ctx(overrides?: Partial<BriefingToolContext>): BriefingToolContext {
  return {
    userId,
    conversationId: "current-briefing-conv",
    briefingAgentConfigId: briefingAgentId,
    ...overrides,
  };
}

async function insertConversation(data: {
  title: string;
  owner?: string | null;
  kind?: "regular" | "ez";
  parentConversationId?: string;
  agentConfigId?: string;
  test?: boolean;
  updatedAt?: Date;
  id?: string;
}): Promise<string> {
  const db = getTestDb();
  const [row] = await db.insert(conversations).values({
    ...(data.id ? { id: data.id } : {}),
    projectId,
    title: data.title,
    userId: data.owner === undefined ? userId : data.owner,
    kind: data.kind ?? "regular",
    parentConversationId: data.parentConversationId ?? null,
    agentConfigId: data.agentConfigId ?? null,
    test: data.test ?? false,
    ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
  }).returning();
  return row!.id;
}

beforeAll(async () => {
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  snapshotImpl = async () => undefined;
  const db = getTestDb();
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(agentConfigs);
  await db.delete(projects);
  await db.delete(users);

  const [u1] = await db.insert(users).values({ email: "a@t.local", passwordHash: "x", name: "A" }).returning();
  const [u2] = await db.insert(users).values({ email: "b@t.local", passwordHash: "x", name: "B" }).returning();
  userId = u1!.id;
  otherUserId = u2!.id;
  const [p] = await db.insert(projects).values({ name: "P", path: "/tmp/p" }).returning();
  projectId = p!.id;
  const [agent] = await db.insert(agentConfigs).values({
    name: "Daily Briefing",
    description: "d",
    prompt: "p",
  }).returning();
  briefingAgentId = agent!.id;
});

// ── list_recent_conversations ─────────────────────────────────────

describe("list_recent_conversations", () => {
  test("returns the user's own regular conversations, newest first", async () => {
    const old = new Date("2026-06-01T00:00:00Z");
    const recent = new Date("2026-06-09T00:00:00Z");
    await insertConversation({ title: "Older", updatedAt: old });
    await insertConversation({ title: "Newer", updatedAt: recent });

    const tool = createListRecentConversationsTool(ctx());
    const res = await tool.execute("tc-1", {});
    const details = res.details as { count: number; conversations: Array<{ title: string }> };
    expect(details.count).toBe(2);
    expect(details.conversations[0]!.title).toBe("Newer");
    expect(details.conversations[1]!.title).toBe("Older");
  });

  test("excludes other users, ez-kind, sub-conversations, test rows, prior briefings, and the in-flight briefing", async () => {
    await insertConversation({ title: "Mine" });
    await insertConversation({ title: "Theirs", owner: otherUserId });
    await insertConversation({ title: "Ez thread", kind: "ez" });
    const parent = await insertConversation({ title: "Parent" });
    await insertConversation({ title: "Sub", parentConversationId: parent, owner: null });
    await insertConversation({ title: "Test conv", test: true });
    await insertConversation({ title: "Yesterday's briefing", agentConfigId: briefingAgentId });
    await insertConversation({ title: "Current briefing", id: "current-briefing-conv", agentConfigId: briefingAgentId });

    const tool = createListRecentConversationsTool(ctx());
    const res = await tool.execute("tc-1", {});
    const details = res.details as { count: number; conversations: Array<{ title: string }> };
    const titles = details.conversations.map((c) => c.title).sort();
    expect(titles).toEqual(["Mine", "Parent"]);
  });

  test("clamps the limit into [1, 25] and defaults to 10", async () => {
    for (let i = 0; i < 12; i++) {
      await insertConversation({ title: `c${i}`, updatedAt: new Date(Date.UTC(2026, 5, 1 + i)) });
    }
    const tool = createListRecentConversationsTool(ctx());
    const def = (await tool.execute("tc", {})).details as { count: number };
    expect(def.count).toBe(10);
    const one = (await tool.execute("tc", { limit: -5 })).details as { count: number };
    expect(one.count).toBe(1);
    const capped = (await tool.execute("tc", { limit: 9999 })).details as { count: number };
    expect(capped.count).toBe(12);
    const junk = (await tool.execute("tc", { limit: "lots" })).details as { count: number };
    expect(junk.count).toBe(10);
  });

  test("folds unexpected errors into a tool error result", async () => {
    const tool = createListRecentConversationsTool(ctx({ userId: "" })); // userId required → throws inside
    const res = await tool.execute("tc", {});
    expect((res.details as { isError?: boolean }).isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/^Error:/);
  });
});

// ── get_conversation_summary ──────────────────────────────────────

describe("get_conversation_summary", () => {
  async function addMessage(convId: string, role: string, content: string): Promise<void> {
    await getTestDb().insert(messages).values({ conversationId: convId, role, content });
  }

  test("returns title + transcript of user/assistant turns only", async () => {
    const convId = await insertConversation({ title: "SSL setup" });
    await addMessage(convId, "user", "set up SSL for the api host");
    await addMessage(convId, "assistant", "Working on it — generated the CSR.");
    await addMessage(convId, "ez-action-result", "{\"kind\":\"card\"}");
    await addMessage(convId, "capability-event", "{}");
    await addMessage(convId, "assistant", "   "); // empty — skipped

    const tool = createGetConversationSummaryTool(ctx());
    const res = await tool.execute("tc", { conversationId: convId });
    const details = res.details as { title: string; messageCount: number; transcript: string };
    expect(details.title).toBe("SSL setup");
    expect(details.messageCount).toBe(2);
    expect(details.transcript).toBe(
      "USER: set up SSL for the api host\n\nASSISTANT: Working on it — generated the CSR.",
    );
  });

  test("ownership gate: another user's conversation reads as 'not found' (no oracle)", async () => {
    const theirs = await insertConversation({ title: "Secret", owner: otherUserId });
    const tool = createGetConversationSummaryTool(ctx());
    const res = await tool.execute("tc", { conversationId: theirs });
    expect((res.details as { isError?: boolean }).isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("Error: conversation not found");
  });

  test("missing conversation reads identically to a non-owned one", async () => {
    const tool = createGetConversationSummaryTool(ctx());
    const res = await tool.execute("tc", { conversationId: "nope" });
    expect((res.content[0] as { text: string }).text).toBe("Error: conversation not found");
  });

  test("conversationId is required", async () => {
    const tool = createGetConversationSummaryTool(ctx());
    const res = await tool.execute("tc", {});
    expect((res.content[0] as { text: string }).text).toMatch(/conversationId is required/);
  });

  test("total transcript is capped at 24k chars, keeping the END", async () => {
    const convId = await insertConversation({ title: "Huge" });
    for (let i = 0; i < 14; i++) {
      await addMessage(convId, "user", `m${i}-${"y".repeat(1_990)}`);
    }
    const tool = createGetConversationSummaryTool(ctx());
    const res = await tool.execute("tc", { conversationId: convId, maxMessages: 14 });
    const details = res.details as { transcript: string };
    expect(details.transcript.length).toBeLessThanOrEqual(24_001); // cap + leading ellipsis
    expect(details.transcript.startsWith("…")).toBe(true);
    expect(details.transcript).toContain("m13-"); // the end survives
    expect(details.transcript).not.toContain("m0-"); // the start is dropped
  });

  test("maxMessages keeps the TRAILING turns; long messages are truncated", async () => {
    const convId = await insertConversation({ title: "Long" });
    await addMessage(convId, "user", "first");
    await addMessage(convId, "assistant", "x".repeat(3_000));
    await addMessage(convId, "user", "last");

    const tool = createGetConversationSummaryTool(ctx());
    const res = await tool.execute("tc", { conversationId: convId, maxMessages: 2 });
    const details = res.details as { transcript: string; messageCount: number };
    expect(details.messageCount).toBe(3);
    expect(details.transcript).not.toContain("first");
    expect(details.transcript).toContain("last");
    // 2000-char cap + ellipsis on the long assistant turn.
    expect(details.transcript).toContain(`${"x".repeat(2_000)}…`);
    expect(details.transcript).not.toContain("x".repeat(2_001));
  });
});

// ── get_task_snapshots ────────────────────────────────────────────

describe("get_task_snapshots", () => {
  test("aggregates open/active counts across owned conversations", async () => {
    const a = await insertConversation({ title: "Conv A" });
    const b = await insertConversation({ title: "Conv B" });
    snapshotImpl = async (id: string) => {
      if (id === a) {
        return {
          conversationId: id,
          tasks: [
            { id: "t1", title: "Fix login", status: "pending" },
            { id: "t2", title: "Ship briefing", status: "active" },
          ],
        };
      }
      return {
        conversationId: id,
        tasks: [{ id: "t3", title: "Write docs", status: "completed" }],
      };
    };

    const tool = createGetTaskSnapshotsTool(ctx());
    const res = await tool.execute("tc", { conversationIds: [a, b] });
    const details = res.details as {
      counts: { open: number; active: number };
      conversations: Array<{ conversationId: string; title: string; tasks: unknown[] }>;
    };
    expect(details.counts).toEqual({ open: 1, active: 1 });
    expect(details.conversations).toHaveLength(2);
    expect(details.conversations[0]!.title).toBe("Conv A");
  });

  test("silently skips non-owned + missing conversations", async () => {
    const theirs = await insertConversation({ title: "Theirs", owner: otherUserId });
    snapshotImpl = async () => ({ conversationId: "x", tasks: [{ id: "t", title: "T", status: "pending" }] });
    const tool = createGetTaskSnapshotsTool(ctx());
    const res = await tool.execute("tc", { conversationIds: [theirs, "missing"] });
    const details = res.details as { counts: { open: number }; conversations: unknown[] };
    expect(details.conversations).toHaveLength(0);
    expect(details.counts.open).toBe(0);
  });

  test("conversations without tasks are omitted", async () => {
    const a = await insertConversation({ title: "Empty" });
    snapshotImpl = async () => ({ conversationId: a, tasks: [] });
    const tool = createGetTaskSnapshotsTool(ctx());
    const res = await tool.execute("tc", { conversationIds: [a] });
    expect((res.details as { conversations: unknown[] }).conversations).toHaveLength(0);
  });

  test("degrades to an 'unavailable' note when the task-tracking host throws", async () => {
    const a = await insertConversation({ title: "Conv" });
    snapshotImpl = async () => {
      throw new Error("task-tracking extension not installed — did ensureBundledExtensions() run?");
    };
    const tool = createGetTaskSnapshotsTool(ctx());
    const res = await tool.execute("tc", { conversationIds: [a] });
    const details = res.details as { unavailable?: boolean; note?: string };
    expect(details.unavailable).toBe(true);
    expect(details.note).toMatch(/unavailable/);
  });

  test("conversationIds is required and must be non-empty / well-typed", async () => {
    const tool = createGetTaskSnapshotsTool(ctx());
    for (const params of [{}, { conversationIds: [] }, { conversationIds: [1, 2] }, { conversationIds: "x" }]) {
      const res = await tool.execute("tc", params);
      expect((res.content[0] as { text: string }).text).toMatch(/conversationIds is required/);
    }
  });
});

// ── wireBriefingToolsForTurn ──────────────────────────────────────

describe("wireBriefingToolsForTurn", () => {
  test("registers the three tools + their defs, dedups on re-wire", () => {
    const agentTools: AgentTool[] = [];
    const defsMap = new Map();
    const params = {
      agentTools,
      builtinToolDefsMap: defsMap,
      conversationId: "c1",
      userId,
      briefingAgentConfigId: briefingAgentId,
    };
    wireBriefingToolsForTurn(params);
    expect(agentTools.map((t) => t.name).sort()).toEqual([...BRIEFING_TOOL_NAMES].sort());
    expect([...defsMap.keys()].sort()).toEqual([...BRIEFING_TOOL_NAMES].sort());
    // Defensive double-invoke — no duplicates.
    wireBriefingToolsForTurn(params);
    expect(agentTools).toHaveLength(BRIEFING_TOOL_NAMES.length);
  });

  test("works without a builtinToolDefsMap", () => {
    const agentTools: AgentTool[] = [];
    wireBriefingToolsForTurn({
      agentTools,
      conversationId: "c1",
      userId,
      briefingAgentConfigId: null,
    });
    expect(agentTools).toHaveLength(3);
  });
});
