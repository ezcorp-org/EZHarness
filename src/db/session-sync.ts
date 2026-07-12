import { eq } from "drizzle-orm";
import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import { logger } from "../logger";
import type { HistoryUserRow } from "../chat/attachments/history-rehydrate";
import { getDb } from "./connection";
import { getMessages, getLatestLeaf } from "./queries/conversations";
import { getSetting } from "./queries/settings";
import { agentSessionEntries, agentSessions } from "./schema";
import { entryToRow, type DbSessionStorage } from "./session-storage";
import { backfillSessionForConversation, isLlmTurn, rowToEntry, rowToPiMessage } from "./session-backfill";

/**
 * P3 of the Postgres SessionStorage design
 * (tasks/2026-07-11-postgres-session-storage-design.md §5/§7-P3): the pi
 * session tree becomes the conversation-history PRODUCER.
 *
 * Two responsibilities live here:
 *  1. READ — {@link computeSessionBranch}: bring the session tree up to
 *     date with the `messages` table (the REPLAY AUTHORITY) and return the
 *     active branch as `{id, role, content}` rows. `load-history.ts` then
 *     runs its EXISTING filter/rehydration/mapping over those rows, so the
 *     produced history is byte-identical to the legacy CTE path (see the
 *     LIVE parity suite). Realises design §5's "swap the branch source to
 *     the session, run the existing transform over it".
 *  2. WRITE — {@link appendSavedMessageEntry}: an O(1) idempotent
 *     live-append of a just-saved `messages` row onto the session tree,
 *     wired at the subscribe-bridge turn_end + steer seams.
 *
 * Correctness rests on ONE invariant + ONE backstop:
 *  - MIRROR INVARIANT: a `message` entry's `id` IS its `messages` row id
 *    (backfill AND live-append both key entries by row id), so
 *    `ezMessageId === entry.id` and downstream attachment/image
 *    rehydration keys correctly off the entry id.
 *  - REPLAY-AUTHORITY BACKSTOP: {@link syncSessionForConversation} re-syncs
 *    the tree from the `messages` table on every read, so a dropped
 *    live-append (a crash between the messages write and the session
 *    append, a kill-switch flip, an out-of-band edit/branch) SELF-HEALS on
 *    the next `loadHistory`. Live-append is therefore an eager optimisation,
 *    not a correctness-critical path — which is why every write here is
 *    fail-open.
 *
 * All jsonb goes through column-mapped drizzle inserts (never
 * `${JSON.stringify}::jsonb`); the intra-session PK makes appends idempotent.
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

/**
 * Bring the conversation's session tree up to date with the `messages`
 * table and return the storage. First use backfills the whole tree; later
 * uses append only the rows added since. Idempotent — a row already present
 * as an entry is skipped, so this is safe to run every read. NOT
 * self-locking: callers hold {@link withConvSessionLock}.
 */
export async function syncSessionForConversation(conversationId: string): Promise<DbSessionStorage> {
  const storage = await backfillSessionForConversation(conversationId);
  const existing = new Set((await storage.getEntries()).map((e) => e.id));
  const rows = await getMessages(conversationId);
  const knownIds = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    if (existing.has(row.id)) continue;
    // Mirror backfill: real turns become `message` entries (cross-linked via
    // ezMessageId = row id); excluded/synthetic rows stay in the tree as
    // non-emitting `custom` entries so the parentId chain stays connected.
    await storage.appendEntry(rowToEntry(row, knownIds), isLlmTurn(row) ? row.id : null);
  }
  return storage;
}

/** A session `message` entry → the `{id, role, content}` shape
 *  `load-history.ts` maps + rehydrates. `content` is the RAW text (the
 *  inverse of session-backfill's `rowToPiMessage`): the user string
 *  verbatim, or the assistant's concatenated text parts. `id` is the entry
 *  id, which IS the messages row id (mirror invariant), so per-message
 *  attachment/image rehydration keys off it. */
export function messageEntryToHistoryRow(entry: Extract<SessionTreeEntry, { type: "message" }>): HistoryUserRow {
  // A message entry only ever holds a user/assistant turn (backfill +
  // live-append store nothing else), so narrow past AgentMessage's wider
  // union to the role/content pair.
  const { role, content } = entry.message as {
    role: string;
    content: string | ReadonlyArray<{ type: string; text?: string }>;
  };
  return { id: entry.id, role, content: typeof content === "string" ? content : extractText(content) };
}

/** Concatenate the text parts of an assistant content array. */
function extractText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts.filter((p) => p.type === "text").map((p) => p.text).join("");
}

/**
 * The conversation's active branch as `{id, role, content}` rows — the
 * session-backed equivalent of loadHistory's legacy getConversationPath
 * walk. Same leaf selection (`parentMessageId` ?? latest leaf) and same
 * conversation-scoped truncation (the session tree only holds this
 * conversation's rows, cross-conversation parents re-rooted to null). Only
 * `message` entries surface; excluded/synthetic `custom` entries are
 * dropped exactly as loadHistory drops them. Serialized per conversation.
 */
export async function computeSessionBranch(
  conversationId: string,
  parentMessageId: string | undefined,
): Promise<HistoryUserRow[]> {
  return withConvSessionLock(conversationId, async () => {
    const storage = await syncSessionForConversation(conversationId);
    const leafId = parentMessageId ?? (await getLatestLeaf(conversationId))?.id ?? null;
    const branch = await storage.getPathToRoot(leafId);
    const rows: HistoryUserRow[] = [];
    for (const entry of branch) {
      if (entry.type === "message") rows.push(messageEntryToHistoryRow(entry));
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
