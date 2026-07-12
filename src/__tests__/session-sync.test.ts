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
  computeSessionTree,
  rewindSession,
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

    const { storage: first } = await syncSessionForConversation(c);
    const firstIds = (await first.getEntries()).map((e) => e.id).filter((id) => id === "u1" || id === "a1");
    expect(firstIds.sort()).toEqual(["a1", "u1"]);

    // A new turn arrives (route wrote the messages row; live-append never ran).
    await seedMsg(c, { id: "u2", role: "user", content: "u2", parentId: "a1", createdAt: at(2) });

    const { storage: second } = await syncSessionForConversation(c);
    const ids = (await second.getEntries()).filter((e) => e.type === "message").map((e) => e.id);
    expect(ids.sort()).toEqual(["a1", "u1", "u2"]);

    // No duplicate entries for the already-synced rows (existing-row no-op path).
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

    const { storage: healed } = await syncSessionForConversation(c);
    const ids = (await healed.getEntries()).filter((e) => e.type === "message").map((e) => e.id);
    expect(ids.sort()).toEqual(["a1", "u1"]);
  });

  test("excluded/synthetic rows sync as non-emitting custom entries", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "x1", role: "assistant", content: "x", parentId: "u1", excluded: true, createdAt: at(1) });
    await seedMsg(c, { id: "pr", role: "preprocess-result", content: "{}", parentId: "x1", createdAt: at(2) });
    const { storage: s } = await syncSessionForConversation(c);
    const custom = (await s.getEntries()).filter((e) => e.type === "custom").map((e) => e.id);
    expect(custom.sort()).toEqual(["pr", "x1"]);
  });

  test("topology reconcile: an existing entry's parentId follows a messages reparent", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "a1", role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });
    await seedMsg(c, { id: "s1", role: "user", content: "steer", parentId: "u1", createdAt: at(2) });
    await syncSessionForConversation(c); // s1 entry parent = u1

    // Delivery reparents s1 under a1 (a same-id parentMessageId UPDATE).
    await getTestDb().update(messages).set({ parentMessageId: "a1" }).where(eq(messages.id, "s1"));

    const { storage } = await syncSessionForConversation(c);
    const s1entry = (await storage.getEntries()).find((e) => e.id === "s1");
    expect(s1entry?.parentId).toBe("a1"); // reconciled
    // getPathToRoot now threads s1 under a1.
    const branch = await computeSessionBranch(c, "s1");
    expect(branch.map((r) => r.id)).toEqual(["u1", "a1", "s1"]);
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

  test("live excluded flag is honoured at read time (not the entry's stale classification)", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "a1", role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });
    await seedMsg(c, { id: "u2", role: "user", content: "u2", parentId: "a1", createdAt: at(2) });
    await syncSessionForConversation(c); // a1 backfilled as a NON-excluded message entry
    // Exclude a1 IN PLACE — the entry stays a `message` entry, but the producer
    // must drop it because the LIVE row is excluded.
    await getTestDb().update(messages).set({ excluded: true }).where(eq(messages.id, "a1"));
    expect((await computeSessionBranch(c, "u2")).map((r) => r.id)).toEqual(["u1", "u2"]);
  });

  test("a branch entry whose live messages row was deleted is skipped (graceful)", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "a1", role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });
    await syncSessionForConversation(c); // a1 entry created
    // Delete a1's messages row; its session entry remains (ez_message_id → null).
    await getTestDb().delete(messages).where(eq(messages.id, "a1"));
    // The producer walks the entry topology but skips a1 (no live row to join).
    expect((await computeSessionBranch(c, "a1")).map((r) => r.id)).toEqual(["u1"]);
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

describe("computeSessionTree — whole tree + durable leaf pointer (P4)", () => {
  beforeEach(async () => { await setupTestDb(); }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  test("nodes carry topology + live substance; currentLeaf = the session leaf", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "a1", role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });
    await seedMsg(c, { id: "u2", role: "user", content: "u2", parentId: "a1", createdAt: at(2) });

    const tree = await computeSessionTree(c);
    expect(tree.conversationId).toBe(c);
    expect(tree.currentLeaf).toBe("u2"); // backfill sets leaf = getLatestLeaf
    expect(tree.nodes.map((n) => n.id).sort()).toEqual(["a1", "u1", "u2"]);
    const byId = new Map(tree.nodes.map((n) => [n.id, n] as const));
    expect(byId.get("a1")!.parentId).toBe("u1"); // topology from the session tree
    expect(byId.get("u2")!.parentId).toBe("a1");
    expect(byId.get("u1")!.parentId).toBe(null);
    expect(byId.get("a1")!.role).toBe("assistant"); // substance from the live row
  });

  test("excluded rows are KEPT as nodes (excluded: true), unlike the producer branch", async () => {
    const c = await newConversation();
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "a1", role: "assistant", content: "a1", parentId: "u1", excluded: true, createdAt: at(1) });

    const tree = await computeSessionTree(c);
    const a1 = tree.nodes.find((n) => n.id === "a1");
    expect(a1?.excluded).toBe(true);
    // But the LLM-visible producer branch drops it (parity with legacy).
    expect((await computeSessionBranch(c, "a1")).map((r) => r.id)).toEqual(["u1"]);
  });
});

describe("rewindSession — moveTo the durable leaf + optional branch_summary (P4)", () => {
  beforeEach(async () => { await setupTestDb(); }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  // Build: u1 → a1 → u2 → a2 (the "abandoned tail" once we rewind to a1).
  async function seedLinearFour(c: string): Promise<void> {
    await seedMsg(c, { id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
    await seedMsg(c, { id: "a1", role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });
    await seedMsg(c, { id: "u2", role: "user", content: "u2", parentId: "a1", createdAt: at(2) });
    await seedMsg(c, { id: "a2", role: "assistant", content: "a2", parentId: "u2", createdAt: at(3) });
  }

  test("moves the leaf pointer to the target via a `leaf` entry; message-entry parents untouched", async () => {
    const c = await newConversation();
    await seedLinearFour(c);

    const outcome = await rewindSession(c, "a1");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.tree.currentLeaf).toBe("a1");

    // The durable leaf pointer now resolves to a1 (a `messages` row id).
    expect((await computeSessionTree(c)).currentLeaf).toBe("a1");

    // A `leaf` pointer entry was appended; the message entries kept their parents
    // (rewind never reparents a message entry — messages stays the authority).
    const [session] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, c));
    const entries = await getTestDb().select().from(agentSessionEntries).where(eq(agentSessionEntries.sessionId, session.id));
    expect(entries.some((e) => e.type === "leaf")).toBe(true);
    expect(session.leafEntryId).toBe("a1");
    const a2 = entries.find((e) => e.entryId === "a2");
    expect(a2?.parentId).toBe("u2"); // abandoned tail structurally intact
  });

  test("the NEXT producer read follows the rewound leaf; the abandoned tail is recoverable", async () => {
    const c = await newConversation();
    await seedLinearFour(c);
    await rewindSession(c, "a1");

    // The client carries parentMessageId = the rewound leaf → context ends at a1.
    expect((await computeSessionBranch(c, "a1")).map((r) => r.id)).toEqual(["u1", "a1"]);
    // Switching back to the abandoned tail recovers the full branch.
    expect((await computeSessionBranch(c, "a2")).map((r) => r.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  test("a real next-send off the rewound leaf forks a sibling of the abandoned tail", async () => {
    const c = await newConversation();
    await seedLinearFour(c);
    await rewindSession(c, "a1");

    // Simulate the next turn: a new user row parented to the rewound leaf a1
    // (the client passes parentMessageId=a1), then the live-append seam mirrors it.
    await seedMsg(c, { id: "u2b", role: "user", content: "u2b", parentId: "a1", createdAt: at(4) });
    await appendSavedMessageEntry(c, { id: "u2b", role: "user", content: "u2b", createdAt: at(4) }, "a1");

    // The new branch ends at u2b; a1 now has two children (u2 abandoned, u2b active).
    expect((await computeSessionBranch(c, "u2b")).map((r) => r.id)).toEqual(["u1", "a1", "u2b"]);
    const tree = await computeSessionTree(c);
    const childrenOfA1 = tree.nodes.filter((n) => n.parentId === "a1").map((n) => n.id).sort();
    expect(childrenOfA1).toEqual(["u2", "u2b"]);
    expect(tree.currentLeaf).toBe("u2b"); // live-append bumped the durable leaf
  });

  test("optional summary writes a branch_summary entry; leaf still ends at the target", async () => {
    const c = await newConversation();
    await seedLinearFour(c);

    const outcome = await rewindSession(c, "a1", "  abandoned a plan that went sideways  ");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.tree.currentLeaf).toBe("a1");

    const [session] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, c));
    const entries = await getTestDb().select().from(agentSessionEntries).where(eq(agentSessionEntries.sessionId, session.id));
    const summaryEntry = entries.find((e) => e.type === "branch_summary");
    expect(summaryEntry).toBeDefined();
    expect((summaryEntry!.payload as { summary?: string }).summary).toBe("abandoned a plan that went sideways"); // trimmed
    // The summary never joins a messages row → absent from the tree nodes.
    expect(outcome.tree.nodes.some((n) => n.id === summaryEntry!.entryId)).toBe(false);
    // Leaf still at the target despite the branch_summary append.
    expect((await computeSessionTree(c)).currentLeaf).toBe("a1");
  });

  test("a blank/whitespace summary appends no branch_summary entry", async () => {
    const c = await newConversation();
    await seedLinearFour(c);
    await rewindSession(c, "a1", "   ");
    const [session] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, c));
    const entries = await getTestDb().select().from(agentSessionEntries).where(eq(agentSessionEntries.sessionId, session.id));
    expect(entries.some((e) => e.type === "branch_summary")).toBe(false);
  });

  test("target not in the conversation → { ok: false, target_not_found }, no mutation", async () => {
    const c = await newConversation();
    await seedLinearFour(c);
    const before = await computeSessionTree(c);

    const outcome = await rewindSession(c, "nope-not-here");
    expect(outcome).toEqual({ ok: false, reason: "target_not_found" });
    // Leaf unchanged.
    expect((await computeSessionTree(c)).currentLeaf).toBe(before.currentLeaf);
  });
});
