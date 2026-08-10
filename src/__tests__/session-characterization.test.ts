/**
 * CHARACTERIZATION suite for the session / chat-history surface.
 *
 * These tests pin what the code does TODAY — not what it ought to do. They
 * exist so a refactor of `src/db/session-storage.ts` / `session-sync.ts` /
 * `session-backfill.ts` (e.g. dropping the `implements SessionStorage`
 * conformance promise, or swapping pi's session TYPES for repo-owned ones)
 * can be proven to change nothing observable: same rows, same tree, same
 * parent links, same ordering, same errors, same API payloads.
 *
 * Every assertion here is an EXACT one (`toEqual` on whole structures, not
 * `toContain`), against real PGlite with deterministic, fixed timestamps.
 * Nothing is timed — the only clock-dependent values are normalised away.
 *
 * RUN:  bun test src/__tests__/session-characterization.test.ts --timeout 30000
 *
 * Companion: `session-golden-baseline.test.ts` records the same surface as a
 * committed JSON snapshot for a whole-structure diff.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { agentSessionEntries, agentSessions, conversations, messages, projects } from "../db/schema";

mockDbConnection();

const { DbSessionStorage, entryToRow, rowToEntry: storageRowToEntry } = await import("../db/session-storage");
const { backfillSessionForConversation, isLlmTurn, rowToEntry } = await import("../db/session-backfill");
const {
  appendSavedMessageEntry,
  computeSessionBranch,
  computeSessionTree,
  rewindSession,
  syncSessionForConversation,
  resolveConversationalLeaf,
} = await import("../db/session-sync");
const { reparentMessage } = await import("../db/queries/conversations");

const PROJECT_ID = "char-project";
const BASE_MS = Date.UTC(2026, 2, 1, 12, 0, 0);
const at = (sec: number): Date => new Date(BASE_MS + sec * 1000);

let convSeq = 0;

async function newConversation(): Promise<string> {
  const db = getTestDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: "C", path: "/tmp/c" }).onConflictDoNothing();
  const id = `char-conv-${++convSeq}`;
  await db.insert(conversations).values({ id, projectId: PROJECT_ID, title: "C" });
  return id;
}

interface SeedRow {
  id: string;
  role: string;
  content: string;
  parentId?: string | null;
  excluded?: boolean;
  sec: number;
}

async function seed(convId: string, rows: SeedRow[]): Promise<void> {
  for (const r of rows) {
    await getTestDb().insert(messages).values({
      id: r.id,
      conversationId: convId,
      role: r.role,
      content: r.content,
      parentMessageId: r.parentId ?? null,
      excluded: r.excluded ?? false,
      createdAt: at(r.sec),
    });
  }
}

/** Raw `agent_session_entries` for a session, in `seq` order — the storage
 *  layer's own read path is deliberately NOT used here. */
async function rawEntries(sessionId: string) {
  return getTestDb()
    .select()
    .from(agentSessionEntries)
    .where(eq(agentSessionEntries.sessionId, sessionId))
    .orderBy(asc(agentSessionEntries.seq));
}

async function sessionIdFor(convId: string): Promise<string> {
  const [row] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, convId));
  return row!.id;
}

/** `(entryId, type, parentId)` triples in seq order — the shape every
 *  structural assertion below compares. */
async function topology(convId: string): Promise<Array<[string, string, string | null]>> {
  const rows = await rawEntries(await sessionIdFor(convId));
  return rows.map((r) => [r.entryId, r.type, r.parentId] as [string, string, string | null]);
}

beforeEach(async () => { await setupTestDb(); }, 30_000);
afterAll(async () => { await closeTestDb(); });

// ────────────────────────────────────────────────────────────────────
describe("entry tree shape — a turn, then a child turn", () => {
  test("live-append writes exact parent links, types and ez_message_id cross-links", async () => {
    const c = await newConversation();
    await seed(c, [{ id: "u1", role: "user", content: "hi", sec: 0 }]);
    // A session must already exist for the O(1) live append to fire.
    await backfillSessionForConversation(c);
    const sid = await sessionIdFor(c);

    await seed(c, [{ id: "a1", role: "assistant", content: "yo", parentId: "u1", sec: 1 }]);
    await appendSavedMessageEntry(c, { id: "a1", role: "assistant", content: "yo", createdAt: at(1) }, "u1");
    await seed(c, [{ id: "u2", role: "user", content: "more", parentId: "a1", sec: 2 }]);
    await appendSavedMessageEntry(c, { id: "u2", role: "user", content: "more", createdAt: at(2) }, "a1");

    const rows = await rawEntries(sid);
    // The backfill's explicit `setLeafId(u1)` sits between them — a `leaf`
    // POINTER entry chained onto the then-current leaf, NOT a tree node.
    expect(rows.map((r) => [r.entryId, r.type, r.parentId, r.ezMessageId, r.timestamp])).toEqual([
      ["u1", "message", null, "u1", at(0).toISOString()],
      [expect.any(String) as unknown as string, "leaf", "u1", null, expect.any(String) as unknown as string],
      ["a1", "message", "u1", "a1", at(1).toISOString()],
      ["u2", "message", "a1", "u2", at(2).toISOString()],
    ]);
    // The leaf cache column follows the last live append, verbatim.
    const [srow] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.id, sid));
    expect(srow!.leafEntryId).toBe("u2");
  });

  test("entry rows are returned in seq order and seq is strictly increasing", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "a", sec: 0 },
      { id: "a1", role: "assistant", content: "b", parentId: "u1", sec: 1 },
      { id: "u2", role: "user", content: "c", parentId: "a1", sec: 2 },
    ]);
    const storage = await backfillSessionForConversation(c);
    const rows = await rawEntries(await sessionIdFor(c));
    for (let i = 1; i < rows.length; i++) {
      expect(BigInt(rows[i]!.seq) > BigInt(rows[i - 1]!.seq)).toBe(true);
    }
    // getEntries() is that same axis, in memory.
    expect((await storage.getEntries()).map((e) => e.id)).toEqual(rows.map((r) => r.entryId));
  });

  test("live-append is idempotent and never rewrites an existing entry's parent", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "a", sec: 0 },
      { id: "a1", role: "assistant", content: "b", parentId: "u1", sec: 1 },
    ]);
    await backfillSessionForConversation(c);
    // Re-append the SAME id with a DIFFERENT parent: onConflictDoNothing keeps
    // the original row. Append-only, enforced by the (session_id, entry_id) PK.
    await appendSavedMessageEntry(c, { id: "a1", role: "assistant", content: "b", createdAt: at(1) }, null);
    expect(await topology(c)).toEqual([
      ["u1", "message", null],
      ["a1", "message", "u1"],
      [expect.any(String) as unknown as string, "leaf", "a1"],
    ]);
  });

  test("live-append no-ops when no session exists yet, and fails open on a bad row", async () => {
    const c = await newConversation();
    await seed(c, [{ id: "u1", role: "user", content: "a", sec: 0 }]);
    // No session row → nothing written, no throw.
    await appendSavedMessageEntry(c, { id: "u1", role: "user", content: "a", createdAt: at(0) }, null);
    expect(await getTestDb().select().from(agentSessionEntries)).toEqual([]);

    // With a session, an FK-violating cross-link is swallowed (fail-open).
    await backfillSessionForConversation(c);
    const before = (await rawEntries(await sessionIdFor(c))).length;
    await appendSavedMessageEntry(c, { id: "ghost", role: "user", content: "x", createdAt: at(1) }, null);
    expect((await rawEntries(await sessionIdFor(c))).length).toBe(before);
  });
});

// ────────────────────────────────────────────────────────────────────
describe("backfill ordering — insertion order is not tree order", () => {
  test("a child seeded BEFORE its parent still links to it in the final tree", async () => {
    const c = await newConversation();
    // createdAt order is c2, c1, u1, a1 — so the backfill appends BOTH
    // children before their parents.
    await seed(c, [
      { id: "u1", role: "user", content: "u1", sec: 0 },
      { id: "a1", role: "assistant", content: "a1", parentId: "u1", sec: 1 },
      { id: "c1", role: "user", content: "c1", parentId: "a1", sec: -10 },
      { id: "c2", role: "assistant", content: "c2", parentId: "c1", sec: -20 },
    ]);
    const storage = await backfillSessionForConversation(c);

    expect(await topology(c)).toEqual([
      ["c2", "message", "c1"],
      ["c1", "message", "a1"],
      ["u1", "message", null],
      ["a1", "message", "u1"],
      [expect.any(String) as unknown as string, "leaf", "a1"],
    ]);
    // The tree resolves from the in-memory map, so the walk is complete.
    expect((await storage.getPathToRootOrCompaction("c2")).map((e) => e.id)).toEqual(["u1", "a1", "c1", "c2"]);
  });

  test("excluded rows and synthetic roles become non-emitting `custom` entries that keep the chain whole", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "u1", sec: 0 },
      { id: "cap", role: "capability-event", content: "{}", parentId: "u1", sec: 1 },
      { id: "ez", role: "ez-action-result", content: "{}", parentId: "cap", sec: 2 },
      { id: "pre", role: "preprocess-result", content: "{}", parentId: "ez", sec: 3 },
      { id: "x1", role: "assistant", content: "x", parentId: "pre", excluded: true, sec: 4 },
      { id: "u2", role: "user", content: "u2", parentId: "x1", sec: 5 },
    ]);
    await backfillSessionForConversation(c);
    const rows = await rawEntries(await sessionIdFor(c));
    expect(rows.filter((r) => r.type !== "leaf").map((r) => [r.entryId, r.type, r.parentId, r.ezMessageId])).toEqual([
      ["u1", "message", null, "u1"],
      ["cap", "custom", "u1", null],
      ["ez", "custom", "cap", null],
      ["pre", "custom", "ez", null],
      ["x1", "custom", "pre", null],
      ["u2", "message", "x1", "u2"],
    ]);
    // The `custom` payload shape prod carries.
    expect(rows.find((r) => r.entryId === "x1")!.payload).toEqual({
      customType: "ezcorp:filtered-row",
      data: { role: "assistant", excluded: true },
    });
    // Classification helper agrees with what got written.
    expect(isLlmTurn({ role: "assistant", excluded: true })).toBe(false);
    expect(isLlmTurn({ role: "capability-event", excluded: false })).toBe(false);
    expect(isLlmTurn({ role: "user", excluded: false })).toBe(true);
  });

  test("a cross-conversation parent pointer is re-rooted to null, never followed", async () => {
    const other = await newConversation();
    await seed(other, [{ id: "foreign", role: "user", content: "f", sec: 0 }]);
    const c = await newConversation();
    await seed(c, [{ id: "n1", role: "user", content: "n1", parentId: "foreign", sec: 1 }]);

    await backfillSessionForConversation(c);
    expect(await topology(c)).toEqual([
      ["n1", "message", null],
      [expect.any(String) as unknown as string, "leaf", "n1"],
    ]);
    // rowToEntry's re-root guard, in isolation.
    const entry = rowToEntry(
      { id: "n1", role: "user", content: "n1", parentMessageId: "foreign", excluded: false, createdAt: at(1) } as never,
      new Set(["n1"]),
    );
    expect(entry.parentId).toBe(null);
  });

  test("backfill is idempotent and concurrency-safe — a second call opens, never re-inserts", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "u1", sec: 0 },
      { id: "a1", role: "assistant", content: "a1", parentId: "u1", sec: 1 },
    ]);
    const first = await backfillSessionForConversation(c);
    const firstTopology = await topology(c);
    const [a, b] = await Promise.all([
      backfillSessionForConversation(c),
      backfillSessionForConversation(c),
    ]);
    expect(await topology(c)).toEqual(firstTopology);
    expect((await a.getMetadata()).id).toBe((await first.getMetadata()).id);
    expect((await b.getMetadata()).id).toBe((await first.getMetadata()).id);
  });
});

// ────────────────────────────────────────────────────────────────────
describe("the reparent sweep — the ONE sanctioned tree mutation", () => {
  test("a steer reparent in `messages` is mirrored onto the existing entry (no new row)", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "u1", sec: 0 },
      { id: "a1", role: "assistant", content: "a1", parentId: "u1", sec: 1 },
      { id: "s1", role: "user", content: "steer", parentId: "a1", sec: 2 },
    ]);
    await syncSessionForConversation(c);
    const before = await topology(c);
    expect(before.find((t) => t[0] === "s1")).toEqual(["s1", "message", "a1"]);

    // Delivery reparents the steer row onto the user turn.
    await reparentMessage(c, "s1", "u1");
    await syncSessionForConversation(c);

    const after = await topology(c);
    expect(after.length).toBe(before.length); // reparent, never re-append
    expect(after.find((t) => t[0] === "s1")).toEqual(["s1", "message", "u1"]);
    // And the walk follows the NEW parent.
    const storage = await DbSessionStorage.open(await sessionIdFor(c));
    expect((await storage.getPathToRootOrCompaction("s1")).map((e) => e.id)).toEqual(["u1", "s1"]);
  });

  test("the sweep is cursor-INDEPENDENT: it heals a row older than the append cursor", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "u1", sec: 0 },
      { id: "a1", role: "assistant", content: "a1", parentId: "u1", sec: 1 },
    ]);
    await syncSessionForConversation(c);
    // A later row advances the cursor past a1's createdAt.
    await seed(c, [{ id: "u2", role: "user", content: "u2", parentId: "a1", sec: 900 }]);
    await syncSessionForConversation(c);
    const [srow] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, c));
    expect(srow!.metadata).toEqual({ topologySyncedThroughMs: at(900).getTime() });

    // Reparent a row BELOW the cursor — createdAt is untouched by the update.
    await reparentMessage(c, "a1", null);
    await syncSessionForConversation(c);
    expect((await topology(c)).find((t) => t[0] === "a1")).toEqual(["a1", "message", null]);
  });

  test("a row ABSENT from the tree is appended even when it sits below the cursor", async () => {
    const c = await newConversation();
    await seed(c, [{ id: "u1", role: "user", content: "u1", sec: 100 }]);
    await syncSessionForConversation(c);
    // Late-committing insert with an OLD createdAt (transaction-start clock).
    await seed(c, [{ id: "late", role: "user", content: "late", parentId: "u1", sec: 1 }]);
    await syncSessionForConversation(c);
    expect((await topology(c)).map((t) => t[0])).toContain("late");
  });

  test("a re-sync with nothing changed leaves every parent link byte-identical", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "u1", sec: 0 },
      { id: "a1", role: "assistant", content: "a1", parentId: "u1", sec: 1 },
      { id: "a2", role: "assistant", content: "a2", parentId: "u1", sec: 2 },
    ]);
    await syncSessionForConversation(c);
    const before = await topology(c);
    await syncSessionForConversation(c);
    await syncSessionForConversation(c);
    expect(await topology(c)).toEqual(before);
  });

  test("reparentEntry: no-op when unchanged, throws not_found for an unknown id, mutates the shared entry object", async () => {
    const storage = await DbSessionStorage.create({});
    const sid = (await storage.getMetadata()).id;
    await storage.appendEntry({ type: "custom", id: "e1", parentId: null, timestamp: at(0).toISOString(), customType: "t" });
    await storage.appendEntry({ type: "custom", id: "e2", parentId: "e1", timestamp: at(1).toISOString(), customType: "t" });

    await storage.reparentEntry("e2", "e1"); // unchanged → no-op
    expect((await storage.getEntry("e2"))!.parentId).toBe("e1");
    await expect(storage.reparentEntry("nope", null)).rejects.toThrow("Entry nope not found");

    await storage.reparentEntry("e2", null);
    expect((await storage.getEntry("e2"))!.parentId).toBe(null);
    // Same object identity is reachable from getEntries().
    expect((await storage.getEntries()).find((e) => e.id === "e2")!.parentId).toBe(null);
    const [row] = await getTestDb()
      .select()
      .from(agentSessionEntries)
      .where(and(eq(agentSessionEntries.sessionId, sid), eq(agentSessionEntries.entryId, "e2")));
    expect(row!.parentId).toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────────
describe("path to root, and the compaction stop", () => {
  type Storage = Awaited<ReturnType<typeof DbSessionStorage.create>>;

  async function withEntries(): Promise<Storage> {
    const storage = await DbSessionStorage.create({});
    for (const [id, parent] of [["r", null], ["b", "r"], ["c", "b"], ["d", "c"]] as const) {
      await storage.appendEntry({ type: "custom", id, parentId: parent, timestamp: at(0).toISOString(), customType: "t" });
    }
    return storage;
  }

  test("null leaf → empty path; a full walk is ordered root → leaf", async () => {
    const storage = await withEntries();
    expect(await storage.getPathToRootOrCompaction(null)).toEqual([]);
    expect((await storage.getPathToRootOrCompaction("d")).map((e) => e.id)).toEqual(["r", "b", "c", "d"]);
  });

  test("a compaction with retainedTail stops the walk AT the compaction (inclusive)", async () => {
    const storage = await withEntries();
    await storage.appendEntry({
      type: "compaction", id: "k", parentId: "d", timestamp: at(1).toISOString(),
      summary: "s", tokensBefore: 10, retainedTail: [{ role: "user", content: "tail", timestamp: 0 }],
    });
    await storage.appendEntry({ type: "custom", id: "e", parentId: "k", timestamp: at(2).toISOString(), customType: "t" });
    expect((await storage.getPathToRootOrCompaction("e")).map((x: { id: string }) => x.id)).toEqual(["k", "e"]);
  });

  test("a compaction with firstKeptEntryId stops at that entry (inclusive)", async () => {
    const storage = await withEntries();
    await storage.appendEntry({
      type: "compaction", id: "k", parentId: "d", timestamp: at(1).toISOString(),
      summary: "s", tokensBefore: 10, firstKeptEntryId: "c",
    });
    expect((await storage.getPathToRootOrCompaction("k")).map((x: { id: string }) => x.id)).toEqual(["c", "d", "k"]);
  });

  test("a compaction with NEITHER retainedTail nor firstKeptEntryId does not stop the walk", async () => {
    const storage = await withEntries();
    await storage.appendEntry({
      type: "compaction", id: "k", parentId: "d", timestamp: at(1).toISOString(),
      summary: "s", tokensBefore: 10,
    });
    expect((await storage.getPathToRootOrCompaction("k")).map((x: { id: string }) => x.id)).toEqual(["r", "b", "c", "d", "k"]);
  });

  test("a MISSING parent throws invalid_session — this is what makes loadHistory fail open", async () => {
    const storage = await DbSessionStorage.create({});
    await storage.appendEntry({ type: "custom", id: "orphan", parentId: "gone", timestamp: at(0).toISOString(), customType: "t" });
    const err = await storage.getPathToRootOrCompaction("orphan").catch((e: unknown) => e as Error & { code?: string });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe("invalid_session");
    expect((err as Error).name).toBe("SessionError");
    expect((err as Error).message).toBe("Entry gone not found");
  });

  test("an unknown leaf id throws not_found", async () => {
    const storage = await DbSessionStorage.create({});
    const err = await storage.getPathToRootOrCompaction("nope").catch((e: unknown) => e as Error & { code?: string });
    expect((err as Error & { code?: string }).code).toBe("not_found");
    expect((err as Error).message).toBe("Entry nope not found");
  });
});

// ────────────────────────────────────────────────────────────────────
describe("leaf get / set", () => {
  test("setLeafId appends a `leaf` POINTER entry, moves the leaf and updates the cache column", async () => {
    const storage = await DbSessionStorage.create({});
    const sid = (await storage.getMetadata()).id;
    await storage.appendEntry({ type: "custom", id: "e1", parentId: null, timestamp: at(0).toISOString(), customType: "t" });
    await storage.appendEntry({ type: "custom", id: "e2", parentId: "e1", timestamp: at(1).toISOString(), customType: "t" });
    expect(await storage.getLeafId()).toBe("e2");

    await storage.setLeafId("e1");
    expect(await storage.getLeafId()).toBe("e1");
    const rows = await rawEntries(sid);
    expect(rows.map((r) => [r.type, r.parentId])).toEqual([
      ["custom", null],
      ["custom", "e1"],
      ["leaf", "e2"], // the pointer entry chains onto the PREVIOUS leaf
    ]);
    expect(rows[2]!.payload).toEqual({ targetId: "e1" });
    expect(rows[2]!.entryId.length).toBe(8); // generated 8-char uuidv7 tail
    const [srow] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.id, sid));
    expect(srow!.leafEntryId).toBe("e1");
  });

  test("setLeafId(null) is legal and survives a reopen; setLeafId(unknown) throws not_found", async () => {
    const storage = await DbSessionStorage.create({});
    const sid = (await storage.getMetadata()).id;
    await storage.appendEntry({ type: "custom", id: "e1", parentId: null, timestamp: at(0).toISOString(), customType: "t" });
    await storage.setLeafId(null);
    expect(await storage.getLeafId()).toBe(null);
    expect(await (await DbSessionStorage.open(sid)).getLeafId()).toBe(null);

    const err = await storage.setLeafId("nope").catch((e: unknown) => e as Error & { code?: string });
    expect((err as Error & { code?: string }).code).toBe("not_found");
  });

  test("open() re-derives the leaf by REPLAYING entries in seq order, not by id ordering", async () => {
    const storage = await DbSessionStorage.create({});
    const sid = (await storage.getMetadata()).id;
    // Ids deliberately anti-sorted vs insertion order.
    await storage.appendEntry({ type: "custom", id: "zzz", parentId: null, timestamp: at(0).toISOString(), customType: "t" });
    await storage.appendEntry({ type: "custom", id: "aaa", parentId: "zzz", timestamp: at(1).toISOString(), customType: "t" });
    expect(await (await DbSessionStorage.open(sid)).getLeafId()).toBe("aaa");
  });

  test("a duplicate entry id is rejected by the PK BEFORE any in-memory mutation", async () => {
    const storage = await DbSessionStorage.create({});
    await storage.appendEntry({ type: "custom", id: "dup", parentId: null, timestamp: at(0).toISOString(), customType: "t", data: { v: 1 } });
    await expect(
      storage.appendEntry({ type: "custom", id: "dup", parentId: "dup", timestamp: at(1).toISOString(), customType: "t", data: { v: 2 } }),
    ).rejects.toThrow();
    expect((await storage.getEntries()).length).toBe(1);
    expect(await storage.getEntry("dup")).toEqual({
      type: "custom", id: "dup", parentId: null, timestamp: at(0).toISOString(), customType: "t", data: { v: 1 },
    });
  });
});

// ────────────────────────────────────────────────────────────────────
describe("rewind", () => {
  async function seedRewindable(): Promise<string> {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "u1", sec: 0 },
      { id: "a1", role: "assistant", content: "a1", parentId: "u1", sec: 1 },
      { id: "u2", role: "user", content: "u2", parentId: "a1", sec: 2 },
      { id: "a2", role: "assistant", content: "a2", parentId: "u2", sec: 3 },
    ]);
    return c;
  }

  test("rewind moves the leaf via a pointer entry and reparents NOTHING", async () => {
    const c = await seedRewindable();
    await syncSessionForConversation(c);
    const before = await topology(c);

    const outcome = await rewindSession(c, "a1");
    expect(outcome.ok).toBe(true);

    const after = await topology(c);
    // Every pre-existing entry keeps its exact parent.
    expect(after.slice(0, before.length)).toEqual(before);
    // Exactly one new row: the leaf pointer.
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1]![1]).toBe("leaf");
    expect(await (await DbSessionStorage.open(await sessionIdFor(c))).getLeafId()).toBe("a1");
    // messages rows are untouched — the abandoned tail stays switchable.
    const rows = await getTestDb().select().from(messages).where(eq(messages.conversationId, c));
    expect(rows.map((r) => [r.id, r.parentMessageId]).sort()).toEqual([
      ["a1", "u1"], ["a2", "u2"], ["u1", null], ["u2", "a1"],
    ]);
  });

  test("a summary appends branch_summary FIRST so the leaf still ends at the target", async () => {
    const c = await seedRewindable();
    await syncSessionForConversation(c);
    const outcome = await rewindSession(c, "u2", "  abandoned  ");
    expect(outcome.ok).toBe(true);

    const rows = await rawEntries(await sessionIdFor(c));
    const tail = rows.slice(-3);
    expect(tail.map((r) => r.type)).toEqual(["leaf", "branch_summary", "leaf"]);
    expect(tail[1]!.payload).toEqual({ fromId: "a2", summary: "abandoned" }); // trimmed
    expect(tail[2]!.payload).toEqual({ targetId: "u2" });
    expect(await (await DbSessionStorage.open(await sessionIdFor(c))).getLeafId()).toBe("u2");
  });

  test("a whitespace-only summary writes no branch_summary", async () => {
    const c = await seedRewindable();
    await syncSessionForConversation(c);
    await rewindSession(c, "u1", "   ");
    const rows = await rawEntries(await sessionIdFor(c));
    expect(rows.filter((r) => r.type === "branch_summary")).toEqual([]);
  });

  test("a target outside the conversation is rejected and writes nothing", async () => {
    const c = await seedRewindable();
    await syncSessionForConversation(c);
    const before = await topology(c);
    expect(await rewindSession(c, "not-a-row")).toEqual({ ok: false, reason: "target_not_found" });
    expect(await topology(c)).toEqual(before);
  });

  test("the rewound leaf survives a reopen and is what /tree reports", async () => {
    const c = await seedRewindable();
    await syncSessionForConversation(c);
    await rewindSession(c, "a1");
    expect((await computeSessionTree(c)).currentLeaf).toBe("a1");
  });

  /** CHARACTERIZED, NOT ENDORSED. A plain READ moves the durable leaf: the
   *  catch-up append inside every sync goes through `appendEntry`, which
   *  refreshes the `leaf_entry_id` cache — so a `messages` row that arrives
   *  without a live append silently clobbers a rewind on the next
   *  `computeSessionTree` / `computeSessionBranch`. Pinned because a refactor
   *  that "tidies" the leaf-cache write would change user-visible reload
   *  behaviour (ChatThread re-seats on `currentLeaf`). */
  test("a catch-up append during a READ overwrites the rewound durable leaf", async () => {
    const c = await seedRewindable();
    await syncSessionForConversation(c);
    await rewindSession(c, "u1");
    expect((await computeSessionTree(c)).currentLeaf).toBe("u1");

    // A new turn's messages row lands; the live append never ran.
    await seed(c, [{ id: "a3", role: "assistant", content: "a3", parentId: "u1", sec: 4 }]);
    expect((await computeSessionTree(c)).currentLeaf).toBe("a3");
    const [srow] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, c));
    expect(srow!.leafEntryId).toBe("a3");
  });

  /** CHARACTERIZED, NOT ENDORSED. Rewinding ONTO a `capability-event` row
   *  persists that row as the durable leaf, but every reported leaf is
   *  `resolveConversationalLeaf`'d down to the nearest real turn — so the
   *  stored column and the API payload disagree. */
  test("rewind to a capability-event stores the cap but REPORTS its conversational ancestor", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "u1", sec: 0 },
      { id: "cap", role: "capability-event", content: "{}", parentId: "u1", sec: 1 },
    ]);
    await syncSessionForConversation(c);
    const outcome = await rewindSession(c, "cap");
    expect(outcome.ok && outcome.tree.currentLeaf).toBe("u1");
    expect((await computeSessionTree(c)).currentLeaf).toBe("u1");
    const [srow] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, c));
    expect(srow!.leafEntryId).toBe("cap");
    expect(await (await DbSessionStorage.open(await sessionIdFor(c))).getLeafId()).toBe("cap");
  });
});

// ────────────────────────────────────────────────────────────────────
describe("branch / sibling navigation (A/B retry)", () => {
  test("same-role siblings produce two distinct branches off one user turn", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "q", sec: 0 },
      { id: "a1", role: "assistant", content: "answer A", parentId: "u1", sec: 1 },
      { id: "a2", role: "assistant", content: "answer B", parentId: "u1", sec: 2 },
    ]);
    await syncSessionForConversation(c);

    expect(await computeSessionBranch(c, "a1")).toEqual([
      { id: "u1", role: "user", content: "q" },
      { id: "a1", role: "assistant", content: "answer A" },
    ]);
    expect(await computeSessionBranch(c, "a2")).toEqual([
      { id: "u1", role: "user", content: "q" },
      { id: "a2", role: "assistant", content: "answer B" },
    ]);
    // No parentMessageId → getLatestLeaf's `created_at DESC, id DESC`.
    expect((await computeSessionBranch(c, undefined)).map((r) => r.id)).toEqual(["u1", "a2"]);

    // Both siblings are nodes of the tree; the durable leaf is NOT the branch
    // selector — the client-carried parentMessageId is.
    const tree = await computeSessionTree(c);
    expect(tree.nodes.map((n) => [n.id, n.parentId, n.role, n.excluded])).toEqual([
      ["u1", null, "user", false],
      ["a1", "u1", "assistant", false],
      ["a2", "u1", "assistant", false],
    ]);
    expect(tree.currentLeaf).toBe("a2");
  });

  test("the branch reads role/content/excluded LIVE — a toggle changes the branch with no tree write", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "q", sec: 0 },
      { id: "a1", role: "assistant", content: "a", parentId: "u1", sec: 1 },
      { id: "u2", role: "user", content: "next", parentId: "a1", sec: 2 },
    ]);
    await syncSessionForConversation(c);
    const before = await topology(c);
    expect((await computeSessionBranch(c, "u2")).map((r) => r.id)).toEqual(["u1", "a1", "u2"]);

    await getTestDb().update(messages).set({ excluded: true }).where(eq(messages.id, "a1"));
    expect((await computeSessionBranch(c, "u2")).map((r) => r.id)).toEqual(["u1", "u2"]);
    // The entry stays a `message` entry — substance is never healed into the tree.
    expect(await topology(c)).toEqual(before);

    await getTestDb().update(messages).set({ content: "rewritten" }).where(eq(messages.id, "u1"));
    expect((await computeSessionBranch(c, "u2"))[0]).toEqual({ id: "u1", role: "user", content: "rewritten" });
  });

  test("an entry whose live row was deleted drops out of both the branch and the tree", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "u1", role: "user", content: "q", sec: 0 },
      { id: "a1", role: "assistant", content: "a", parentId: "u1", sec: 1 },
    ]);
    await syncSessionForConversation(c);
    await getTestDb().delete(messages).where(eq(messages.id, "a1"));

    expect((await computeSessionBranch(c, "u1")).map((r) => r.id)).toEqual(["u1"]);
    expect((await computeSessionTree(c)).nodes.map((n) => n.id)).toEqual(["u1"]);
    // The entry row survives; only its ez_message_id is nulled by the FK.
    const rows = await rawEntries(await sessionIdFor(c));
    expect(rows.filter((r) => r.entryId === "a1").map((r) => [r.type, r.ezMessageId])).toEqual([["message", null]]);
  });

  test("resolveConversationalLeaf walks a trailing capability-event pointer down to a real turn", async () => {
    const rows = new Map<string, { role: string; parentMessageId: string | null }>([
      ["u1", { role: "user", parentMessageId: null }],
      ["cap1", { role: "capability-event", parentMessageId: "u1" }],
      ["cap2", { role: "capability-event", parentMessageId: "cap1" }],
      ["loopA", { role: "capability-event", parentMessageId: "loopB" }],
      ["loopB", { role: "capability-event", parentMessageId: "loopA" }],
    ]) as unknown as Map<string, Parameters<typeof resolveConversationalLeaf>[1] extends Map<string, infer V> ? V : never>;
    expect(resolveConversationalLeaf("cap2", rows)).toBe("u1");
    expect(resolveConversationalLeaf("u1", rows)).toBe("u1");
    expect(resolveConversationalLeaf(null, rows)).toBe(null);
    expect(resolveConversationalLeaf("missing", rows)).toBe(null); // fail open
    expect(resolveConversationalLeaf("loopA", rows)).toBe(null); // cycle guard
  });
});

// ────────────────────────────────────────────────────────────────────
describe("storage primitives (row round-trip, labels, stats, cursor)", () => {
  test("entryToRow / rowToEntry round-trip: base fields are columns, everything else is the payload", async () => {
    const entry = {
      type: "message" as const,
      id: "x1",
      parentId: "x0",
      timestamp: at(0).toISOString(),
      message: { role: "user" as const, content: "hi", timestamp: BASE_MS },
    };
    const row = entryToRow("s1", entry, "x1");
    expect(row).toEqual({
      sessionId: "s1", entryId: "x1", type: "message", parentId: "x0",
      timestamp: at(0).toISOString(), payload: { message: entry.message }, ezMessageId: "x1",
    });
    expect(storageRowToEntry(row as never)).toEqual(entry);
    // Default cross-link is null (the JSONL-parity append path).
    expect(entryToRow("s1", entry).ezMessageId).toBe(null);
  });

  test("labels: latest non-empty per target wins; blank clears; findEntries keeps insertion order", async () => {
    const storage = await DbSessionStorage.create({});
    await storage.appendEntry({ type: "custom", id: "t1", parentId: null, timestamp: at(0).toISOString(), customType: "t" });
    await storage.appendEntry({ type: "label", id: "l1", parentId: "t1", timestamp: at(1).toISOString(), targetId: "t1", label: " first " });
    expect(await storage.getLabel("t1")).toBe("first");
    await storage.appendEntry({ type: "label", id: "l2", parentId: "l1", timestamp: at(2).toISOString(), targetId: "t1", label: "second" });
    expect(await storage.getLabel("t1")).toBe("second");
    await storage.appendEntry({ type: "label", id: "l3", parentId: "l2", timestamp: at(3).toISOString(), targetId: "t1", label: "   " });
    expect(await storage.getLabel("t1")).toBe(undefined);
    expect((await storage.findEntries("label")).map((e) => e.id)).toEqual(["l1", "l2", "l3"]);
    expect(await storage.getLabel("missing")).toBe(undefined);
  });

  test("getSessionName is the LAST session_info's trimmed name, else undefined", async () => {
    const storage = await DbSessionStorage.create({});
    expect(await storage.getSessionName()).toBe(undefined);
    await storage.appendEntry({ type: "session_info", id: "i1", parentId: null, timestamp: at(0).toISOString(), name: "one" });
    await storage.appendEntry({ type: "session_info", id: "i2", parentId: "i1", timestamp: at(1).toISOString(), name: "  two  " });
    expect(await storage.getSessionName()).toBe("two");
    await storage.appendEntry({ type: "session_info", id: "i3", parentId: "i2", timestamp: at(2).toISOString(), name: "  " });
    expect(await storage.getSessionName()).toBe(undefined);
  });

  test("getSessionStats sums the INSERTION axis (abandoned branches included) and rejects partial usage", async () => {
    const storage = await DbSessionStorage.create({});
    const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, totalTokens: 20, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } };
    await storage.appendEntry({
      type: "message", id: "a", parentId: null, timestamp: at(0).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "x" }], api: "unknown", provider: "unknown", model: "unknown", usage, stopReason: "stop", timestamp: BASE_MS },
    });
    // A SIBLING branch (never on the active path) still counts.
    await storage.appendEntry({
      type: "message", id: "b", parentId: null, timestamp: at(1).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "y" }], api: "unknown", provider: "unknown", model: "unknown", usage, stopReason: "stop", timestamp: BASE_MS },
    });
    // Partial usage (no cost.total) is DROPPED, not NaN-poisoned.
    await storage.appendEntry({
      type: "branch_summary", id: "c", parentId: "b", timestamp: at(2).toISOString(), fromId: "b", summary: "s",
      usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, totalTokens: 4 } as never,
    });
    // A user message contributes to messageCount only.
    await storage.appendEntry({
      type: "message", id: "d", parentId: "c", timestamp: at(3).toISOString(),
      message: { role: "user", content: "hi", timestamp: BASE_MS },
    });
    expect(await storage.getSessionStats()).toEqual({
      messageCount: 3, cachedTokens: 4, uncachedTokens: 26, totalTokens: 40, costTotal: 4,
    });
  });

  test("getEntries' afterEntrySeq is a POSITION in this session, not the seq column", async () => {
    const storage = await DbSessionStorage.create({});
    for (const id of ["p0", "p1", "p2", "p3"]) {
      await storage.appendEntry({ type: "custom", id, parentId: null, timestamp: at(0).toISOString(), customType: "t" });
    }
    // The bigserial is table-global, so it is NOT 0..3 here.
    const raw = await rawEntries((await storage.getMetadata()).id);
    expect((await storage.getEntries({ afterEntrySeq: 1, limit: 2 })).map((e) => e.id)).toEqual(["p1", "p2"]);
    expect((await storage.getEntries({ afterEntrySeq: Number(raw[0]!.seq) })).length).toBeLessThanOrEqual(4);
    // CHARACTERIZED, NOT ENDORSED — raw `Array.slice` semantics leak through:
    // `limit: 0` yields NOTHING (not "unlimited"), and a NEGATIVE cursor
    // silently counts from the END. A refactor that writes
    // `options.limit ? start + options.limit : undefined` flips the first one.
    expect((await storage.getEntries({ limit: 0 })).map((e) => e.id)).toEqual([]);
    expect((await storage.getEntries({ afterEntrySeq: -1 })).map((e) => e.id)).toEqual(["p3"]);
    expect((await storage.getEntries({ afterEntrySeq: -2, limit: 1 })).map((e) => e.id)).toEqual(["p2"]);
  });

  test("createEntryId mints unique 8-char ids and never collides with an existing entry", async () => {
    const storage = await DbSessionStorage.create({});
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = await storage.createEntryId();
      expect(id.length).toBe(8);
      await storage.appendEntry({ type: "custom", id, parentId: null, timestamp: at(0).toISOString(), customType: "t" });
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });

  test("metadata: only a plain object survives; a bare string/array/number becomes null", async () => {
    for (const [input, expected] of [
      [{ a: 1 }, { a: 1 }],
      ["", null],
      ["oops", null],
      [[1, 2], null],
      [7, null],
      [null, null],
      [undefined, null],
    ] as const) {
      const storage = await DbSessionStorage.create({ metadata: input as never });
      const [row] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.id, (await storage.getMetadata()).id));
      expect(row!.metadata).toEqual(expected as never);
    }
  });

  test("getMetadata surfaces the session row's lineage fields", async () => {
    const parent = await DbSessionStorage.create({});
    const parentId = (await parent.getMetadata()).id;
    const child = await DbSessionStorage.create({ cwd: "/tmp/x", parentSessionId: parentId, metadata: { k: "v" } });
    const meta = await child.getMetadata();
    expect({ cwd: meta.cwd, parentSessionId: meta.parentSessionId, conversationId: meta.conversationId, metadata: meta.metadata })
      .toEqual({ cwd: "/tmp/x", parentSessionId: parentId, conversationId: undefined, metadata: { k: "v" } });
    expect(typeof meta.createdAt).toBe("string");
    expect(meta.createdAt.endsWith("Z")).toBe(true);
  });

  test("open() on a missing session throws not_found", async () => {
    const err = await DbSessionStorage.open("no-such-session").catch((e: unknown) => e as Error & { code?: string });
    expect((err as Error & { code?: string }).code).toBe("not_found");
    expect((err as Error).message).toBe("Session no-such-session not found");
  });
});

// ────────────────────────────────────────────────────────────────────
describe("persisted column shape matches production", () => {
  test("types, id widths, ISO timestamp and payload key sets are exactly what live rows carry", async () => {
    const c = await newConversation();
    await seed(c, [
      { id: "11111111-1111-4111-8111-111111111111", role: "user", content: "u", sec: 0 },
      { id: "22222222-2222-4222-8222-222222222222", role: "capability-event", content: "{}", parentId: "11111111-1111-4111-8111-111111111111", sec: 1 },
    ]);
    await backfillSessionForConversation(c);
    const rows = await rawEntries(await sessionIdFor(c));

    // Live prod (3235 rows / 153 sessions) holds exactly these three types.
    expect([...new Set(rows.map((r) => r.type))].sort()).toEqual(["custom", "leaf", "message"]);
    for (const r of rows) {
      // `timestamp` is TEXT holding a 24-char ISO-8601 with milliseconds + Z.
      expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(r.timestamp.length).toBe(24);
      const keys = Object.keys(r.payload as Record<string, unknown>).sort();
      if (r.type === "message") expect(keys).toEqual(["message"]);
      if (r.type === "custom") expect(keys).toEqual(["customType", "data"]);
      if (r.type === "leaf") expect(keys).toEqual(["targetId"]);
      // message/custom entries reuse the 36-char messages row id; generated
      // ids (leaf/branch_summary) are 8-char uuidv7 tails.
      expect(r.entryId.length).toBe(r.type === "leaf" ? 8 : 36);
    }
    // ez_message_id is set for `message` entries only.
    expect(rows.filter((r) => r.ezMessageId !== null).map((r) => r.type)).toEqual(["message"]);
  });
});
