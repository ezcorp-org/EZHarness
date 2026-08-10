/**
 * CHARACTERIZATION of the persisted session tree.
 *
 * This suite exists to pin the OBSERVABLE output of the session-tree stack
 * (`session-storage` → `session-backfill` → `session-sync`) so a pure
 * refactor of its TYPES cannot change its behaviour unnoticed. Every
 * expectation below was captured by running this file against `main`
 * BEFORE the pi-agent-core type-decoupling refactor and pasted in verbatim;
 * it is a golden master, not a restatement of the implementation.
 *
 * What is pinned, end to end on a real PGlite:
 *  - every `agent_session_entries` row the backfill + catch-up writes, in
 *    `seq` order, with its type / entry id / parentId / timestamp / jsonb
 *    payload / ezMessageId cross-link;
 *  - the reparent sweep (`session-sync.ts` → `storage.reparentEntry`) on an
 *    out-of-band `messages.parent_message_id` change;
 *  - `computeSessionBranch` (path-to-root/compaction + the live-rows join);
 *  - `computeSessionTree` (`getLeafId` + `getEntries` projection);
 *  - `rewindSession` (`createEntryId` + branch_summary append + `setLeafId`).
 *
 * NON-DETERMINISM is normalised, never asserted: session ids and the
 * generated 8-char ids of `leaf` / `branch_summary` entries become stable
 * `#genN` aliases in first-appearance order, and those entries' wall-clock
 * timestamps become `#now`. Message/custom entries keep their real ids and
 * their row-`createdAt` timestamps, which ARE deterministic and ARE asserted.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { agentSessionEntries, agentSessions, conversations, messages, projects } from "../db/schema";

mockDbConnection();

const {
  appendSavedMessageEntry,
  syncSessionForConversation,
  computeSessionBranch,
  computeSessionTree,
  rewindSession,
} = await import("../db/session-sync");

const PROJECT_ID = "p-char";
const CONV_ID = "char-conv";
const BASE = new Date("2026-07-11T00:00:00.000Z").getTime();
const at = (i: number): Date => new Date(BASE + i * 1000);

/** Ids the fixture seeds — everything else in the tree is generated. */
const SEEDED_IDS = ["u1", "a1", "x1", "pr1", "u2", "a2", "u2b", "a2b"] as const;

/** Stable alias for any id the implementation generated (session ids, the
 *  8-char `leaf` / `branch_summary` entry ids). First appearance wins, so the
 *  aliases are positional and reproducible. */
function makeIdNormalizer(): (id: string | null) => string | null {
  const known = new Set<string>(SEEDED_IDS);
  const aliases = new Map<string, string>();
  return (id) => {
    if (id === null) return null;
    if (known.has(id)) return id;
    const existing = aliases.get(id);
    if (existing) return existing;
    const alias = `#gen${aliases.size + 1}`;
    aliases.set(id, alias);
    return alias;
  };
}

interface EntrySnapshot {
  type: string;
  entryId: string | null;
  parentId: string | null;
  timestamp: string;
  payload: unknown;
  ezMessageId: string | null;
}

/** Every persisted entry row for the conversation's session, in `seq`
 *  (insertion) order, normalised. */
async function snapshotEntries(norm: (id: string | null) => string | null): Promise<EntrySnapshot[]> {
  const db = getTestDb();
  const [session] = await db.select().from(agentSessions).where(eq(agentSessions.conversationId, CONV_ID));
  const rows = await db
    .select()
    .from(agentSessionEntries)
    .where(eq(agentSessionEntries.sessionId, session.id))
    .orderBy(asc(agentSessionEntries.seq));
  return rows.map((row) => ({
    type: row.type,
    entryId: norm(row.entryId),
    // `leaf` / `branch_summary` stamp wall-clock time; the rest carry the
    // row's deterministic createdAt, which stays asserted.
    timestamp: row.type === "leaf" || row.type === "branch_summary" ? "#now" : row.timestamp,
    parentId: norm(row.parentId),
    payload: row.payload,
    ezMessageId: norm(row.ezMessageId),
  }));
}

/** The cached `agent_sessions.leaf_entry_id` column, normalised. */
async function snapshotLeafCache(norm: (id: string | null) => string | null): Promise<string | null> {
  const [session] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, CONV_ID));
  return norm(session.leafEntryId);
}

async function seedMsg(m: {
  id: string;
  role: string;
  content: string;
  parentId?: string | null;
  excluded?: boolean;
  createdAt: Date;
}): Promise<void> {
  await getTestDb().insert(messages).values({
    id: m.id,
    conversationId: CONV_ID,
    role: m.role,
    content: m.content,
    parentMessageId: m.parentId ?? null,
    excluded: m.excluded ?? false,
    createdAt: m.createdAt,
  });
}

/**
 * The fixture conversation. Deliberately exercises every classification the
 * backfill makes: real turns, an `excluded` row, a synthetic-role row, an
 * abandoned sibling branch, and a later active branch.
 *
 *   u1 → a1 → x1(excluded) → pr1(preprocess-result) → u2 → a2   (abandoned)
 *              \→ u2b → a2b                                     (active leaf)
 */
async function seedConversation(): Promise<void> {
  const db = getTestDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: "P", path: "/tmp/p" }).onConflictDoNothing();
  await db.insert(conversations).values({ id: CONV_ID, projectId: PROJECT_ID, title: "C" });
  await seedMsg({ id: "u1", role: "user", content: "u1", parentId: null, createdAt: at(0) });
  await seedMsg({ id: "a1", role: "assistant", content: "a1", parentId: "u1", createdAt: at(1) });
  await seedMsg({ id: "x1", role: "assistant", content: "x1-excluded", parentId: "a1", excluded: true, createdAt: at(2) });
  await seedMsg({ id: "pr1", role: "preprocess-result", content: "{}", parentId: "x1", createdAt: at(3) });
  await seedMsg({ id: "u2", role: "user", content: "u2-abandoned", parentId: "pr1", createdAt: at(4) });
  await seedMsg({ id: "a2", role: "assistant", content: "a2-abandoned", parentId: "u2", createdAt: at(5) });
  await seedMsg({ id: "u2b", role: "user", content: "u2-active", parentId: "pr1", createdAt: at(6) });
  await seedMsg({ id: "a2b", role: "assistant", content: "a2-active", parentId: "u2b", createdAt: at(7) });
}

// ── Golden masters, captured on `main` before the refactor ──────────

const ASSISTANT_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** An `assistant` row's persisted `message` payload, as `rowToPiMessage` builds it. */
function assistantPayload(text: string, createdAt: Date) {
  return {
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "unknown",
      provider: "unknown",
      model: "unknown",
      usage: ASSISTANT_USAGE,
      stopReason: "stop",
      timestamp: createdAt.getTime(),
    },
  };
}

/** A `user` row's persisted `message` payload. */
function userPayload(text: string, createdAt: Date) {
  return { message: { role: "user", content: text, timestamp: createdAt.getTime() } };
}

/** A filtered (excluded / synthetic-role) row's non-emitting `custom` payload. */
function filteredPayload(role: string, excluded: boolean) {
  return { customType: "ezcorp:filtered-row", data: { role, excluded } };
}

const BASELINE_AFTER_BACKFILL: EntrySnapshot[] = [
  { type: "message", entryId: "u1", parentId: null, timestamp: at(0).toISOString(), payload: userPayload("u1", at(0)), ezMessageId: "u1" },
  { type: "message", entryId: "a1", parentId: "u1", timestamp: at(1).toISOString(), payload: assistantPayload("a1", at(1)), ezMessageId: "a1" },
  { type: "custom", entryId: "x1", parentId: "a1", timestamp: at(2).toISOString(), payload: filteredPayload("assistant", true), ezMessageId: null },
  { type: "custom", entryId: "pr1", parentId: "x1", timestamp: at(3).toISOString(), payload: filteredPayload("preprocess-result", false), ezMessageId: null },
  { type: "message", entryId: "u2", parentId: "pr1", timestamp: at(4).toISOString(), payload: userPayload("u2-abandoned", at(4)), ezMessageId: "u2" },
  { type: "message", entryId: "a2", parentId: "u2", timestamp: at(5).toISOString(), payload: assistantPayload("a2-abandoned", at(5)), ezMessageId: "a2" },
  { type: "message", entryId: "u2b", parentId: "pr1", timestamp: at(6).toISOString(), payload: userPayload("u2-active", at(6)), ezMessageId: "u2b" },
  { type: "message", entryId: "a2b", parentId: "u2b", timestamp: at(7).toISOString(), payload: assistantPayload("a2-active", at(7)), ezMessageId: "a2b" },
  { type: "leaf", entryId: "#gen1", parentId: "a2b", timestamp: "#now", payload: { targetId: "a2b" }, ezMessageId: null },
];

describe("session tree — characterization (golden master from main)", () => {
  beforeEach(async () => {
    await setupTestDb();
    await seedConversation();
  }, 30_000);
  afterAll(async () => {
    await closeTestDb();
  });

  test("backfill writes exactly these rows, in this order", async () => {
    const norm = makeIdNormalizer();
    await syncSessionForConversation(CONV_ID);
    expect(await snapshotEntries(norm)).toEqual(BASELINE_AFTER_BACKFILL);
    expect(await snapshotLeafCache(norm)).toBe("a2b");
  });

  test("a second sync is a no-op: identical rows, identical order", async () => {
    await syncSessionForConversation(CONV_ID);
    await syncSessionForConversation(CONV_ID);
    expect(await snapshotEntries(makeIdNormalizer())).toEqual(BASELINE_AFTER_BACKFILL);
  });

  test("a row inserted after the first sync is appended, not re-ordered", async () => {
    const norm = makeIdNormalizer();
    await syncSessionForConversation(CONV_ID);
    await seedMsg({ id: "u3", role: "user", content: "u3-late", parentId: "a2b", createdAt: at(8) });
    await syncSessionForConversation(CONV_ID);
    const rows = await snapshotEntries(norm);
    expect(rows.slice(0, BASELINE_AFTER_BACKFILL.length)).toEqual(BASELINE_AFTER_BACKFILL);
    expect(rows.slice(BASELINE_AFTER_BACKFILL.length)).toEqual([
      {
        type: "message",
        entryId: "#gen2",
        parentId: "a2b",
        timestamp: at(8).toISOString(),
        payload: userPayload("u3-late", at(8)),
        ezMessageId: "#gen2",
      },
    ]);
  });

  test("the O(1) live append writes the same row the catch-up would", async () => {
    const norm = makeIdNormalizer();
    await syncSessionForConversation(CONV_ID);
    const late = { id: "u3", role: "user", content: "u3-late", createdAt: at(8) };
    await seedMsg({ ...late, parentId: "a2b" });
    await appendSavedMessageEntry(CONV_ID, late, "a2b");

    const afterLive = await snapshotEntries(norm);
    expect(afterLive.slice(BASELINE_AFTER_BACKFILL.length)).toEqual([
      {
        type: "message",
        entryId: "#gen2",
        parentId: "a2b",
        timestamp: at(8).toISOString(),
        payload: userPayload("u3-late", at(8)),
        ezMessageId: "#gen2",
      },
    ]);
    expect(await snapshotLeafCache(norm)).toBe("#gen2");

    // The catch-up now finds nothing to do — the two writers agree row for row.
    await syncSessionForConversation(CONV_ID);
    expect(await snapshotEntries(norm)).toEqual(afterLive);
  });

  test("a turn appended after a rewind continues the rewound branch", async () => {
    await rewindSession(CONV_ID, "a1");
    await seedMsg({ id: "u3", role: "user", content: "u3-after-rewind", parentId: "a1", createdAt: at(9) });
    await syncSessionForConversation(CONV_ID);

    expect((await computeSessionBranch(CONV_ID, "u3")).map((r) => r.id)).toEqual(["u1", "a1", "u3"]);
    // The abandoned tail is untouched and still reachable by its own id.
    expect((await computeSessionBranch(CONV_ID, "a2b")).map((r) => r.id)).toEqual([
      "u1", "a1", "pr1", "u2b", "a2b",
    ]);
    // Appending advanced the durable leaf onto the new turn.
    expect((await computeSessionTree(CONV_ID)).currentLeaf).toBe("u3");
  });

  test("the reparent sweep rewrites parentId in place, appending nothing", async () => {
    const norm = makeIdNormalizer();
    await syncSessionForConversation(CONV_ID);
    // Out-of-band steer-style reparent: u2b moves from pr1 onto a2.
    await getTestDb().update(messages).set({ parentMessageId: "a2" }).where(eq(messages.id, "u2b"));
    await syncSessionForConversation(CONV_ID);

    const expected = BASELINE_AFTER_BACKFILL.map((row) =>
      row.entryId === "u2b" ? { ...row, parentId: "a2" } : row,
    );
    expect(await snapshotEntries(norm)).toEqual(expected);
  });

  test("computeSessionBranch returns the live rows on the path to the leaf", async () => {
    expect(await computeSessionBranch(CONV_ID, undefined)).toEqual([
      { id: "u1", role: "user", content: "u1" },
      { id: "a1", role: "assistant", content: "a1" },
      { id: "pr1", role: "preprocess-result", content: "{}" },
      { id: "u2b", role: "user", content: "u2-active" },
      { id: "a2b", role: "assistant", content: "a2-active" },
    ]);
    // An explicit parentMessageId selects the abandoned branch instead.
    expect((await computeSessionBranch(CONV_ID, "a2")).map((r) => r.id)).toEqual(["u1", "a1", "pr1", "u2", "a2"]);
  });

  test("computeSessionTree projects every entry that still has a live row", async () => {
    const tree = await computeSessionTree(CONV_ID);
    expect(tree).toEqual({
      conversationId: CONV_ID,
      currentLeaf: "a2b",
      nodes: [
        { id: "u1", parentId: null, role: "user", excluded: false, createdAt: at(0).toISOString() },
        { id: "a1", parentId: "u1", role: "assistant", excluded: false, createdAt: at(1).toISOString() },
        { id: "x1", parentId: "a1", role: "assistant", excluded: true, createdAt: at(2).toISOString() },
        { id: "pr1", parentId: "x1", role: "preprocess-result", excluded: false, createdAt: at(3).toISOString() },
        { id: "u2", parentId: "pr1", role: "user", excluded: false, createdAt: at(4).toISOString() },
        { id: "a2", parentId: "u2", role: "assistant", excluded: false, createdAt: at(5).toISOString() },
        { id: "u2b", parentId: "pr1", role: "user", excluded: false, createdAt: at(6).toISOString() },
        { id: "a2b", parentId: "u2b", role: "assistant", excluded: false, createdAt: at(7).toISOString() },
      ],
    });
  });

  test("rewindSession appends a branch_summary then a leaf pointer, in that order", async () => {
    const norm = makeIdNormalizer();
    const outcome = await rewindSession(CONV_ID, "a1", "  abandoned that path  ");
    expect(outcome.ok).toBe(true);

    const rows = await snapshotEntries(norm);
    expect(rows.slice(0, BASELINE_AFTER_BACKFILL.length)).toEqual(BASELINE_AFTER_BACKFILL);
    expect(rows.slice(BASELINE_AFTER_BACKFILL.length)).toEqual([
      {
        type: "branch_summary",
        entryId: "#gen2",
        parentId: "a2b",
        timestamp: "#now",
        payload: { fromId: "a2b", summary: "abandoned that path" },
        ezMessageId: null,
      },
      { type: "leaf", entryId: "#gen3", parentId: "#gen2", timestamp: "#now", payload: { targetId: "a1" }, ezMessageId: null },
    ]);
    expect(await snapshotLeafCache(norm)).toBe("a1");
    // The rewound tree reports the new leaf; the abandoned tail stays in it.
    expect(outcome.ok && outcome.tree.currentLeaf).toBe("a1");
    expect(outcome.ok && outcome.tree.nodes.map((n) => n.id)).toEqual([
      "u1", "a1", "x1", "pr1", "u2", "a2", "u2b", "a2b",
    ]);
    // …and the rewind survives a reopen: the branch now ends at a1.
    expect((await computeSessionBranch(CONV_ID, "a1")).map((r) => r.id)).toEqual(["u1", "a1"]);
  });

  test("rewindSession without a summary appends only the leaf pointer", async () => {
    const norm = makeIdNormalizer();
    await rewindSession(CONV_ID, "u2", "   ");
    const rows = await snapshotEntries(norm);
    expect(rows.slice(BASELINE_AFTER_BACKFILL.length)).toEqual([
      { type: "leaf", entryId: "#gen2", parentId: "a2b", timestamp: "#now", payload: { targetId: "u2" }, ezMessageId: null },
    ]);
    expect(await snapshotLeafCache(norm)).toBe("u2");
  });

  test("rewindSession rejects a target that is not a live row of this conversation", async () => {
    expect(await rewindSession(CONV_ID, "not-a-row")).toEqual({ ok: false, reason: "target_not_found" });
  });
});
