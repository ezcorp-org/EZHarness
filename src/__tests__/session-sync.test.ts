/**
 * P3 session-sync unit + behaviour coverage
 * (tasks/2026-07-11-postgres-session-storage-design.md §5/§6/§7-P3).
 *
 *  - Kill-switch default (OFF) + explicit ON/OFF.
 *  - Per-conversation write serialization: ordering, a rejected op never
 *    wedges the chain, map self-pruning under concurrency.
 *  - Catch-up sync from the messages table (the REPLAY AUTHORITY): first
 *    use backfills, later use appends only the delta, idempotently.
 *  - Crash recovery: a messages row that was never live-appended self-heals
 *    on the next sync.
 *  - O(1) live-append: appends when a session exists, no-ops otherwise,
 *    idempotent, and fail-open (an FK violation is swallowed, the tree
 *    stays intact, catch-up heals).
 *  - Branch extraction (message entries only; raw user/assistant content).
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { agentSessionEntries, agentSessions, conversations, messages, projects } from "../db/schema";

mockDbConnection();

const {
  SESSION_HISTORY_PRODUCER_SETTING,
  isSessionHistoryProducerEnabled,
  withConvSessionLock,
  syncSessionForConversation,
  computeSessionBranch,
  appendSavedMessageEntry,
  messageEntryToHistoryRow,
} = await import("../db/session-sync");
const { upsertSetting } = await import("../db/queries/settings");
const { backfillSessionForConversation } = await import("../db/session-backfill");

const PROJECT_ID = "p-sync";
let convSeq = 0;
const BASE = new Date("2026-07-11T00:00:00.000Z").getTime();
const at = (i: number): Date => new Date(BASE + i * 1000);

async function newConversation(): Promise<string> {
  const db = getTestDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: "P", path: "/tmp/p" }).onConflictDoNothing();
  const convId = `sync-conv-${++convSeq}`;
  await db.insert(conversations).values({ id: convId, projectId: PROJECT_ID, title: "C" });
  return convId;
}

async function seedMsg(convId: string, m: {
  id: string;
  role: string;
  content: string;
  parentId?: string | null;
  excluded?: boolean;
  createdAt: Date;
}): Promise<void> {
  await getTestDb().insert(messages).values({
    id: m.id,
    conversationId: convId,
    role: m.role,
    content: m.content,
    parentMessageId: m.parentId ?? null,
    excluded: m.excluded ?? false,
    createdAt: m.createdAt,
  });
}

describe("isSessionHistoryProducerEnabled — default OFF", () => {
  beforeEach(async () => { await setupTestDb(); }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  test("unset → false; true → true; false/garbage → false", async () => {
    expect(await isSessionHistoryProducerEnabled()).toBe(false);
    await upsertSetting(SESSION_HISTORY_PRODUCER_SETTING, true);
    expect(await isSessionHistoryProducerEnabled()).toBe(true);
    await upsertSetting(SESSION_HISTORY_PRODUCER_SETTING, false);
    expect(await isSessionHistoryProducerEnabled()).toBe(false);
    await upsertSetting(SESSION_HISTORY_PRODUCER_SETTING, "on");
    expect(await isSessionHistoryProducerEnabled()).toBe(false);
  });
});

describe("withConvSessionLock — per-conversation serialization", () => {
  test("serializes ops on the same conversation in call order", async () => {
    const order: number[] = [];
    const mk = (n: number, ms: number) => withConvSessionLock("lock-a", async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(n);
      return n;
    });
    // First op is slow; if they weren't serialized, 2 would land before 1.
    const [a, b] = await Promise.all([mk(1, 20), mk(2, 1)]);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(order).toEqual([1, 2]);
  });

  test("a rejected op does not wedge the chain (next op still runs)", async () => {
    const p1 = withConvSessionLock("lock-b", async () => { throw new Error("boom"); });
    const p2 = withConvSessionLock("lock-b", async () => "ok");
    await expect(p1).rejects.toThrow("boom");
    expect(await p2).toBe("ok");
  });

  test("map self-prunes: an op finishing while a newer op is queued does not delete the entry", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const p1 = withConvSessionLock("lock-c", async () => { await gate; return 1; });
    // p2 chains synchronously, overwriting the map entry before p1's finally.
    const p2 = withConvSessionLock("lock-c", async () => 2);
    release();
    expect(await p1).toBe(1); // p1.finally sees run2 (!== run1) → keeps the entry
    expect(await p2).toBe(2); // p2.finally sees run2 (=== run2) → prunes
  });
});

describe("syncSessionForConversation — catch-up from the messages table", () => {
  beforeEach(async () => { await setupTestDb(); }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  test("first use backfills; a later sync appends only the delta (idempotent)", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "a1", role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });

    const first = await syncSessionForConversation(c);
    const firstIds = (await first.getEntries()).map((e) => e.id).filter((id) => id === "u1" || id === "a1");
    expect(firstIds.sort()).toEqual(["a1", "u1"]);

    // A new turn arrives (route wrote the messages row; live-append never ran).
    await seedMsg(c, { id: "u2", role: "user", content: "u2", parentId: "a1", createdAt: at(2) });

    const second = await syncSessionForConversation(c);
    const ids = (await second.getEntries()).filter((e) => e.type === "message").map((e) => e.id);
    expect(ids.sort()).toEqual(["a1", "u1", "u2"]);

    // No duplicate entries for the already-synced rows.
    const rows = await getTestDb()
      .select()
      .from(agentSessionEntries)
      .where(and(eq(agentSessionEntries.sessionId, (await second.getMetadata()).id), eq(agentSessionEntries.entryId, "u1")));
    expect(rows.length).toBe(1);
  });

  test("crash recovery: a messages row that was never live-appended self-heals on next sync", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await backfillSessionForConversation(c); // session now holds only u1

    // Simulate a crash between the assistant messages-write and its session
    // append: the row exists, no entry does.
    await seedMsg(c, { id: "a1", role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });

    const healed = await syncSessionForConversation(c);
    const ids = (await healed.getEntries()).filter((e) => e.type === "message").map((e) => e.id);
    expect(ids.sort()).toEqual(["a1", "u1"]);
  });

  test("excluded/synthetic rows sync as non-emitting custom entries", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "x1", role: "assistant", content: "x", parentId: "u1", excluded: true, createdAt: at(1) });
    await seedMsg(c, { id: "pr", role: "preprocess-result", content: "{}", parentId: "x1", createdAt: at(2) });
    const s = await syncSessionForConversation(c);
    const custom = (await s.getEntries()).filter((e) => e.type === "custom").map((e) => e.id);
    expect(custom.sort()).toEqual(["pr", "x1"]);
  });
});

describe("messageEntryToHistoryRow — raw content extraction", () => {
  test("user entry → string content verbatim", () => {
    const row = messageEntryToHistoryRow({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "t",
      message: { role: "user", content: "hello" },
    } as never);
    expect(row).toEqual({ id: "u1", role: "user", content: "hello" });
  });

  test("assistant entry → concatenated text parts (thinking parts dropped)", () => {
    const row = messageEntryToHistoryRow({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "t",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "part1 " },
          { type: "text", text: "part2" },
        ],
      },
    } as never);
    expect(row).toEqual({ id: "a1", role: "assistant", content: "part1 part2" });
  });
});

describe("computeSessionBranch — session-backed branch", () => {
  beforeEach(async () => { await setupTestDb(); }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  test("explicit parentMessageId leaf → root→leaf message rows, custom entries dropped", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "x1", role: "assistant", content: "x", parentId: "u1", excluded: true, createdAt: at(1) });
    await seedMsg(c, { id: "u2", role: "user", content: "u2", parentId: "x1", createdAt: at(2) });

    const branch = await computeSessionBranch(c, "u2");
    expect(branch).toEqual([
      { id: "u1", role: "user", content: "u1" },
      { id: "u2", role: "user", content: "u2" },
    ]);
  });

  test("no parentMessageId → uses the latest leaf", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "a1", role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });
    const branch = await computeSessionBranch(c, undefined);
    expect(branch.map((r) => r.id)).toEqual(["u1", "a1"]);
  });

  test("empty conversation → empty branch (null leaf)", async () => {
    const c = await newConversation();
    expect(await computeSessionBranch(c, undefined)).toEqual([]);
  });
});

describe("appendSavedMessageEntry — O(1) idempotent live-append", () => {
  beforeEach(async () => { await setupTestDb(); }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  test("no-op when no session exists yet", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    // No session backfilled → append must silently do nothing.
    await appendSavedMessageEntry(c, { id: "u1", role: "user", content: "u1", createdAt: at(0) }, null);
    const sess = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, c));
    expect(sess.length).toBe(0);
  });

  test("appends onto an existing session and is idempotent; bumps the leaf cache", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await backfillSessionForConversation(c);
    await seedMsg(c, { id: "a1", role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });

    await appendSavedMessageEntry(c, { id: "a1", role: "assistant", content: "a1", createdAt: at(1) }, "u1");
    await appendSavedMessageEntry(c, { id: "a1", role: "assistant", content: "a1", createdAt: at(1) }, "u1"); // idempotent

    const [session] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, c));
    expect(session.leafEntryId).toBe("a1");
    const rows = await getTestDb()
      .select()
      .from(agentSessionEntries)
      .where(and(eq(agentSessionEntries.sessionId, session.id), eq(agentSessionEntries.entryId, "a1")));
    expect(rows.length).toBe(1);
    expect(rows[0]!.ezMessageId).toBe("a1");
    // The appended row reads back as a message entry on the branch.
    expect((await computeSessionBranch(c, "a1")).map((r) => r.id)).toEqual(["u1", "a1"]);
  });

  test("fail-open: an ez_message_id FK violation is swallowed, no entry written", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    const storage = await backfillSessionForConversation(c);

    // A message id that does not exist in `messages` → ez_message_id FK fails.
    await appendSavedMessageEntry(
      c,
      { id: "ghost-not-in-messages", role: "assistant", content: "x", createdAt: at(2) },
      "u1",
    );

    const rows = await getTestDb()
      .select()
      .from(agentSessionEntries)
      .where(and(eq(agentSessionEntries.sessionId, (await storage.getMetadata()).id), eq(agentSessionEntries.entryId, "ghost-not-in-messages")));
    expect(rows.length).toBe(0); // swallowed; nothing persisted
  });
});
