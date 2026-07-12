import { eq } from "drizzle-orm";
import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { logger } from "../logger";
import type { HistoryUserRow } from "../chat/attachments/history-rehydrate";
import { getDb } from "./connection";
import { getMessages, getLatestLeaf } from "./queries/conversations";
import { getSetting } from "./queries/settings";
import { agentSessionEntries, agentSessions } from "./schema";
import { entryToRow, type DbSessionMetadata, type DbSessionStorage } from "./session-storage";
import { backfillSessionForConversation, isLlmTurn, rowToEntry, rowToPiMessage } from "./session-backfill";

/**
 * P3 of the Postgres SessionStorage design
 * (tasks/2026-07-11-postgres-session-storage-design.md §5/§7-P3): the pi
 * session tree becomes the conversation-history PRODUCER.
 *
 * Two responsibilities live here:
 *  1. READ — {@link computeSessionBranch}: the session tree is the
 *     TOPOLOGY authority (which rows are on the active branch, in what
 *     order); the `messages` table is the SUBSTANCE authority (role,
 *     content, and — crucially — the LIVE `excluded` flag). The branch is
 *     the ordered entry ids from `getPathToRoot`, JOINED back to live
 *     `messages` rows by id (the mirror invariant makes entry.id == row id).
 *     `load-history.ts` then runs its EXISTING filter/rehydration/mapping
 *     over those live rows, so the history is byte-identical to the legacy
 *     CTE path. Design §5's "swap the branch source, run the existing
 *     transform over it".
 *  2. WRITE — {@link appendSavedMessageEntry}: an O(1) idempotent
 *     live-append of a just-saved `messages` row onto the session tree,
 *     wired at the subscribe-bridge turn_end + steer seams.
 *
 * WHY topology-only (the load-bearing correctness decision): entry payloads
 * (role/content) and the message/custom CLASSIFICATION are snapshotted at
 * append time and are NOT reconciled on same-id UPDATEs — so if the producer
 * read them, an in-place mutation (the exclude-flag toggle, a role change)
 * would go stale and diverge from legacy. Reading substance from the live
 * `messages` row at branch time eliminates that class of drift BY
 * CONSTRUCTION. The entry payload remains for future phases (P4/P5 tree
 * display/replay) but is explicitly NOT load-bearing on this read path.
 *
 * What the catch-up in {@link syncSessionForConversation} DOES heal:
 *  - MISSING rows → appended (crash between messages-write and session-append,
 *    a kill-switch flip, an out-of-band insert).
 *  - TOPOLOGY of existing rows → `parentId` reconciled where a `messages`
 *    row's `parentMessageId` changed (a steer reparented at delivery).
 * What it delegates to the read-time messages JOIN (NOT healed in the tree):
 *  - content / role / excluded / synthetic-role classification — always LIVE.
 *
 * MIRROR INVARIANT: a `message` entry's `id` IS its `messages` row id
 * (backfill AND live-append key entries by row id), so entry.id == ezMessageId
 * == row id — that is what makes the read-time JOIN and row-keyed
 * attachment/image rehydration work.
 *
 * Live-append is an eager optimisation, not correctness-critical — a dropped
 * append is healed by the next read's catch-up — which is why every write here
 * is fail-open. All jsonb goes through column-mapped drizzle inserts (never
 * `${JSON.stringify}::jsonb`); the intra-session PK makes appends idempotent.
 *
 * PERF NOTE — high-water catch-up (Wave6 A3). The topology APPEND scan is now
 * incremental: a per-session cursor ({@link SYNC_CURSOR_META_KEY}, the max
 * `messages.createdAt` already reconciled, stashed in the existing
 * `agent_sessions.metadata` jsonb — no migration) lets the append pass skip
 * rows the previous sync already appended, so appends are O(delta-new-rows).
 *
 * The read as a WHOLE is still O(conversation), and that is deliberate, not a
 * missed optimisation — two costs cannot be cursor-gated without breaking a
 * Wave5-pinned invariant:
 *   1. SUBSTANCE join — `getMessages` reads the live rows every time because
 *      content/role/`excluded` are authoritative-live (the topology-only+live-
 *      JOIN design); a cached snapshot would re-introduce the exclude-toggle
 *      drift the producer exists to avoid.
 *   2. REPARENT reconcile — a reparent (steer delivery) UPDATEs
 *      `parent_message_id` WITHOUT touching `created_at`, so it can land on a
 *      row OLDER than the cursor. A createdAt cursor PROVABLY cannot detect it
 *      (session-sync.test.ts "topology reconcile" reparents an already-passed
 *      row), so the reparent sweep stays a full O(existing-entries) pass —
 *      write-free unless a live parent actually diverged. A fully-O(delta) read
 *      would need a `messages.updatedAt` watermark (none exists) + a branch-
 *      scoped substance fetch; both touch more surface (migrate.ts / the parity
 *      transform) than this hardening slice should, so they are left for a
 *      measured follow-up. HONESTY over cleverness (task A3).
 */

const log = logger.child("db.sessionSync");

// ── Kill-switch ─────────────────────────────────────────────────────

/** Setting key for the history-producer kill-switch. */
export const SESSION_HISTORY_PRODUCER_SETTING = "sessions:historyProducer";

/**
 * Whether the pi session tree produces the conversation branch. DEFAULT
 * OFF: unset/false runs the legacy CTE path byte-for-byte. This is the
 * riskiest flip in the campaign, so it ships dark — an operator enables it
 * after validation, and a single-container deploy always has an escape
 * hatch back to the proven path (design §7-P3). Any non-`true` value
 * (undefined, false, garbage) reads as OFF.
 */
export async function isSessionHistoryProducerEnabled(): Promise<boolean> {
  return (await getSetting(SESSION_HISTORY_PRODUCER_SETTING)) === true;
}

// ── Per-conversation write serialization (design §6) ────────────────
// DbSessionStorage is single-writer; concurrent runs on ONE conversation
// (overlapping browser tabs, a steer racing a turn) must not interleave
// appends into a corrupt tree. Serialize every session op for a
// conversation on a per-conversation promise chain + rely on the DB `seq`
// total order. Different conversations — including every sub-conversation
// (1:1 session per conversation row) — never contend, so sub-agent runs
// serialize against their OWN conversation only.

const convLocks = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `conversationId`'s session, serialized
 * behind any in-flight op for the same conversation. A prior op's rejection
 * never wedges the chain (the gate runs `fn` after the previous op settles
 * either way); the map self-prunes once `fn` is the chain tail.
 */
export async function withConvSessionLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const prev = convLocks.get(conversationId) ?? Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  convLocks.set(conversationId, run);
  try {
    return await run;
  } finally {
    if (convLocks.get(conversationId) === run) convLocks.delete(conversationId);
  }
}

// ── READ: session-backed branch ─────────────────────────────────────

/** A live `messages` row (the fields the producer join reads). */
type ConversationMessage = Awaited<ReturnType<typeof getMessages>>[number];

/** The result of one topology sync: the caught-up storage + the live rows
 *  indexed by id, so the producer JOINs substance without a second fetch. */
export interface SessionSyncResult {
  storage: DbSessionStorage;
  rowsById: Map<string, ConversationMessage>;
}

/**
 * Metadata key for the high-water APPEND cursor: the max `messages.createdAt`
 * (epoch ms) whose topology a prior sync already reconciled into the tree.
 * Every row at/older than this is guaranteed to already have an entry, so the
 * append scan can skip it. Stashed in the existing `agent_sessions.metadata`
 * jsonb — no schema migration. Gates APPENDS ONLY (see the reparent note in
 * {@link syncSessionForConversation}).
 */
export const SYNC_CURSOR_META_KEY = "topologySyncedThroughMs";

/** Read the append cursor from session metadata (0 when unset/invalid — a
 *  fresh or pre-cursor session, whose first sync then scans every row). */
function readSyncCursor(meta: DbSessionMetadata): number {
  const v = meta.metadata?.[SYNC_CURSOR_META_KEY];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Persist the advanced append cursor, preserving any other metadata keys.
 *  Serialized under {@link withConvSessionLock} with every other session op. */
async function writeSyncCursor(sessionId: string, meta: DbSessionMetadata, ms: number): Promise<void> {
  const nextMeta = { ...(meta.metadata ?? {}), [SYNC_CURSOR_META_KEY]: ms };
  await getDb().update(agentSessions).set({ metadata: nextMeta }).where(eq(agentSessions.id, sessionId));
}

/**
 * Bring the conversation's session tree TOPOLOGY up to date with the
 * `messages` table and return the storage + the live rows (indexed by id).
 * First use backfills the whole tree. Later uses reconcile topology:
 *  - MISSING rows → appended (mirroring backfill's classification).
 *  - EXISTING rows whose `messages` parentMessageId changed → entry parentId
 *    reparented (closes the steer-reparent drift).
 * Substance (content/role/excluded) is NOT touched here — the producer reads
 * it live from `rowsById`. Idempotent, so safe to run every read. NOT
 * self-locking: callers hold {@link withConvSessionLock}.
 *
 * The APPEND pass is INCREMENTAL (Wave6 A3): a per-session high-water cursor
 * ({@link SYNC_CURSOR_META_KEY}) lets it skip rows a prior sync already
 * appended, so appends are O(delta-new-rows). The gate is `createdAt < cursor`
 * (strict `<`, never `<=`) so same-millisecond rows straddling the boundary are
 * re-checked, not skipped — messages routinely share a createdAt ms (see the
 * getConversationPath ordering note). This assumes createdAt is monotonic
 * non-decreasing across inserts, which holds: `messages.createdAt` defaults to
 * now() and no writer backdates.
 *
 * The REPARENT pass is deliberately NOT cursor-gated: a reparent UPDATEs
 * parent_message_id without changing createdAt, so it can land on a row older
 * than the cursor — a full sweep is the only correct detection (see the header
 * PERF NOTE). It is write-free unless a live parent actually diverged.
 */
export async function syncSessionForConversation(conversationId: string): Promise<SessionSyncResult> {
  const storage = await backfillSessionForConversation(conversationId);
  const meta = await storage.getMetadata();
  const cursor = readSyncCursor(meta);
  const existing = new Map((await storage.getEntries()).map((e) => [e.id, e] as const));
  const rows = await getMessages(conversationId);
  const rowsById = new Map(rows.map((r) => [r.id, r] as const));
  const knownIds = new Set(rows.map((r) => r.id));

  // APPEND (O(delta)): rows strictly older than the cursor were appended by a
  // prior sync — skip their existence check. Track the newest createdAt so the
  // cursor advances past every row reconciled this pass.
  let maxCreatedMs = cursor;
  for (const row of rows) {
    const ms = row.createdAt.getTime();
    if (ms > maxCreatedMs) maxCreatedMs = ms;
    if (ms < cursor) continue;
    if (!existing.has(row.id)) {
      // Missing → append (mirrors backfill: real turns become `message`
      // entries cross-linked via ezMessageId = row id; excluded/synthetic
      // rows stay as non-emitting `custom` entries so the chain stays whole).
      await storage.appendEntry(rowToEntry(row, knownIds), isLlmTurn(row) ? row.id : null);
    }
  }

  // REPARENT (full sweep — cursor-INDEPENDENT). Reconcile every pre-existing
  // entry whose live row's parentMessageId diverged (a steer reparented at
  // delivery). Newly appended entries above are born with the right parent, so
  // only the pre-append `existing` set can drift. The desired parent mirrors
  // the live row with backfill's same-conversation re-root guard.
  for (const [id, entry] of existing) {
    const row = rowsById.get(id);
    if (!row) continue;
    const desiredParent = row.parentMessageId && knownIds.has(row.parentMessageId) ? row.parentMessageId : null;
    if (entry.parentId !== desiredParent) await storage.reparentEntry(id, desiredParent);
  }

  if (maxCreatedMs > cursor) await writeSyncCursor(meta.id, meta, maxCreatedMs);
  return { storage, rowsById };
}

/**
 * The conversation's active branch as `{id, role, content}` rows — the
 * session-backed equivalent of loadHistory's legacy getConversationPath
 * walk. TOPOLOGY (ordered ids + leaf) comes from the session tree; SUBSTANCE
 * (role/content) and the `excluded` filter come from the LIVE `messages`
 * rows (joined by id). Same leaf selection (`parentMessageId` ?? latest
 * leaf) and the same conversation-scoped truncation (the tree holds only
 * this conversation's rows; cross-conversation parents re-rooted to null).
 * Excluded rows are dropped exactly as loadHistory's legacy path drops them;
 * synthetic-role rows survive here and are mapped to null downstream, byte-
 * identically to legacy. Serialized per conversation.
 *
 * CAVEAT (load-bearing): the session LEAF POINTER (`storage.getLeafId()`, moved
 * by {@link rewindSession} and surfaced by {@link computeSessionTree}) is NOT
 * read here and is NOT authoritative for producer reads. The branch is chosen
 * by the CLIENT-CARRIED `parentMessageId` (the edit/retry/rewind branch
 * mechanism), falling back to the messages-table `getLatestLeaf` — never the
 * session leaf. Any future feature that wants context to end at a specific node
 * must carry it as `parentMessageId`; do not read the session leaf to decide
 * context.
 */
export async function computeSessionBranch(
  conversationId: string,
  parentMessageId: string | undefined,
): Promise<HistoryUserRow[]> {
  return withConvSessionLock(conversationId, async () => {
    const { storage, rowsById } = await syncSessionForConversation(conversationId);
    const leafId = parentMessageId ?? (await getLatestLeaf(conversationId))?.id ?? null;
    const branch = await storage.getPathToRoot(leafId);
    const rows: HistoryUserRow[] = [];
    for (const entry of branch) {
      const row = rowsById.get(entry.id);
      // Skip an entry whose live row is gone (deleted out of band) or that
      // the user has excluded — matching legacy `path.filter(!excluded)`.
      if (!row || row.excluded) continue;
      rows.push({ id: row.id, role: row.role, content: row.content });
    }
    return rows;
  });
}

// ── WRITE: O(1) live-append ─────────────────────────────────────────

/** The subset of a saved `messages` row {@link appendSavedMessageEntry}
 *  needs to mirror it into the session tree. */
export interface SavedMessageRow {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

/**
 * Live-append a just-saved `messages` row to the conversation's session
 * tree as a `message` entry (design §5 append seam). O(1): a session-id
 * lookup + an idempotent insert + a leaf-cache bump — no full-tree read.
 *
 * - Idempotent: the intra-session PK rejects a re-append (onConflictDoNothing).
 * - No-op when no session exists yet (the next loadHistory sync backfills
 *   the whole tree, this row included) — so it self-gates: nothing is
 *   written until the history producer has been enabled at least once.
 * - Fail-open: never throws into the caller's turn. A dropped append is
 *   healed by the replay-authority catch-up on the next open.
 *
 * Serialized per conversation with the read path so a run's appends can't
 * interleave with another run's sync.
 */
export async function appendSavedMessageEntry(
  conversationId: string,
  row: SavedMessageRow,
  parentId: string | null,
): Promise<void> {
  await withConvSessionLock(conversationId, async () => {
    const db = getDb();
    const [session] = await db
      .select({ id: agentSessions.id })
      .from(agentSessions)
      .where(eq(agentSessions.conversationId, conversationId));
    if (!session) return;
    const entry: SessionTreeEntry = {
      type: "message",
      id: row.id,
      parentId,
      timestamp: row.createdAt.toISOString(),
      // rowToPiMessage reads only role/content/createdAt — the fields
      // SavedMessageRow carries. Cast through its param type (a full
      // conversation row) rather than widening the proven backfill signature.
      message: rowToPiMessage(row as unknown as Parameters<typeof rowToPiMessage>[0]) as AgentMessage,
    };
    await db
      .insert(agentSessionEntries)
      .values(entryToRow(session.id, entry, row.id))
      .onConflictDoNothing();
    await db.update(agentSessions).set({ leafEntryId: row.id }).where(eq(agentSessions.id, session.id));
  }).catch((err) => log.warn("live session append failed (catch-up will heal)", {
    conversationId,
    id: row.id,
    error: String(err),
  }));
}

// ── TREE VIEW + REWIND (P4) ─────────────────────────────────────────
// The rewind/checkpoint surface (design §4). Both read the SAME
// topology+messages join the producer uses: TOPOLOGY (parentId + the
// durable leaf pointer) from the session tree, SUBSTANCE (role/excluded)
// from the LIVE `messages` rows. Rewind moves the leaf via a `leaf`
// POINTER entry (pi moveTo semantics), never by rewriting a message
// entry's parent — so `messages` stays the authority for message parents
// and the catch-up reconcile in {@link syncSessionForConversation} keeps
// healing them.

/** One node of the conversation's message tree for the rewind/branch UI +
 *  harness client. `parentId` is the SESSION tree's topology (== the live
 *  `messages` row's parentMessageId after catch-up); `role`/`excluded` are
 *  the LIVE row's. */
export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  role: string;
  /** Live exclude flag. Excluded rows ARE kept as tree nodes (the UI renders
   *  them struck-through and they're switchable branch points); the producer
   *  drops them only from the LLM-visible branch, never from the tree. */
  excluded: boolean;
  createdAt: string;
}

/** The conversation's whole message tree + the durable leaf pointer. */
export interface SessionTreeView {
  conversationId: string;
  /** The session leaf pointer — the persisted rewind/checkpoint position (pi
   *  `getLeafId`); in normal operation a `messages` row id. This is a
   *  tree-VIEW / harness field: it records where the last rewind moved the
   *  durable leaf, for display + external consumers. It is NOT authoritative
   *  for producer reads (the client-carried `parentMessageId` is the branch
   *  mechanism — see {@link computeSessionBranch}), and the chat client does
   *  NOT restore it into its active branch on reload. */
  currentLeaf: string | null;
  nodes: SessionTreeNode[];
}

/** Project a caught-up session + its live rows into a {@link SessionTreeView}.
 *  Only entries whose live `messages` row still exists become nodes — a row
 *  deleted out of band drops out, mirroring computeSessionBranch's skip. The
 *  session-internal `leaf`/`branch_summary` entries carry generated ids that
 *  never join a `messages` row, so they're naturally absent from `nodes`. */
function buildTreeView(
  conversationId: string,
  currentLeaf: string | null,
  entries: SessionTreeEntry[],
  rowsById: Map<string, ConversationMessage>,
): SessionTreeView {
  const nodes: SessionTreeNode[] = [];
  for (const entry of entries) {
    const row = rowsById.get(entry.id);
    if (!row) continue;
    nodes.push({ id: row.id, parentId: entry.parentId, role: row.role, excluded: row.excluded, createdAt: row.createdAt.toISOString() });
  }
  return { conversationId, currentLeaf, nodes };
}

/**
 * The conversation's whole message tree + durable leaf pointer for the
 * rewind/branch UI (design §4). Backfills on first use and serializes per
 * conversation exactly like {@link computeSessionBranch}.
 */
export async function computeSessionTree(conversationId: string): Promise<SessionTreeView> {
  return withConvSessionLock(conversationId, async () => {
    const { storage, rowsById } = await syncSessionForConversation(conversationId);
    return buildTreeView(conversationId, await storage.getLeafId(), await storage.getEntries(), rowsById);
  });
}

/** Outcome of a rewind: the refreshed tree, or a rejection when the target
 *  isn't a live row of THIS conversation (the route maps that to a 400). */
export type RewindOutcome =
  | { ok: true; tree: SessionTreeView }
  | { ok: false; reason: "target_not_found" };

/**
 * Rewind (checkpoint) the conversation to `targetMessageId`: move the session
 * leaf pointer there and optionally record a `branch_summary` for the branch
 * being abandoned. pi `moveTo` semantics — the leaf moves via a durable
 * `leaf` POINTER entry (never a message-entry reparent), so `messages`
 * remains the authority for message parents. The abandoned tail is untouched
 * in `messages`, so a later send re-parenting onto it recovers the branch.
 *
 * The leaf ends at the target (always a `messages` row id): a `branch_summary`
 * would otherwise advance the leaf to its own generated id, so it is appended
 * FIRST and setLeafId(target) runs LAST. Serialized per conversation with the
 * read path so it can't interleave with a concurrent run's append/sync.
 */
export async function rewindSession(
  conversationId: string,
  targetMessageId: string,
  summary?: string,
): Promise<RewindOutcome> {
  return withConvSessionLock(conversationId, async () => {
    const { storage, rowsById } = await syncSessionForConversation(conversationId);
    if (!rowsById.has(targetMessageId)) return { ok: false, reason: "target_not_found" };
    const priorLeaf = await storage.getLeafId();
    const trimmed = summary?.trim();
    if (trimmed) {
      const entry: SessionTreeEntry = {
        type: "branch_summary",
        id: await storage.createEntryId(),
        parentId: priorLeaf,
        timestamp: new Date().toISOString(),
        fromId: priorLeaf ?? "root",
        summary: trimmed,
      };
      await storage.appendEntry(entry);
    }
    await storage.setLeafId(targetMessageId);
    const tree = buildTreeView(conversationId, targetMessageId, await storage.getEntries(), rowsById);
    return { ok: true, tree };
  });
}
