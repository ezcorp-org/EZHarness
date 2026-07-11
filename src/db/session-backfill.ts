import { eq } from "drizzle-orm";
import type { AgentMessage, SessionTreeEntry } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "../types";
import { PREPROCESS_RESULT_ROLE } from "../runtime/stream-chat/preprocess-shared";
import { getDb } from "./connection";
import { getLatestLeaf, getMessages } from "./queries/conversations";
import { agentSessions } from "./schema";
import { DbSessionStorage } from "./session-storage";

/**
 * Lazy session backfill (P2 of the Postgres SessionStorage design,
 * tasks/2026-07-11-postgres-session-storage-design.md §7).
 *
 * Reconstructs a `DbSessionStorage` session tree for an EXISTING
 * conversation from its `messages` rows, so the pi Session read path can
 * reproduce today's `loadHistory` output. This slice is DARK — nothing in
 * the runtime request path calls it yet (P3 wires the lazy trigger); it is
 * exercised only by the read-parity suite
 * (src/__tests__/session-backfill-parity.test.ts).
 *
 * Fidelity contract (design §2, mirrors src/runtime/stream-chat/
 * load-history.ts — the parity suite FAILS if the two drift):
 *  - FULL-tree walk (§6): every `messages` row becomes an entry so branch
 *    reconstruction (getPathToRoot) matches getConversationPath — a
 *    getConversationPath-only walk would lose sibling branches.
 *  - Only REAL user/assistant turns become LLM-visible `message` entries.
 *    `excluded` rows and the UI-only synthetic roles (ez-action-result,
 *    preprocess-result, capability-event) are preserved in the tree as
 *    NON-emitting `custom` entries — they keep the parentId chain intact
 *    but yield no message from buildContext, exactly as loadHistory drops
 *    them (`.filter(!excluded)` + role→null).
 *  - `message` entries carry the row's pi AgentMessage AND an ezMessageId
 *    cross-link back to the source row (design §3).
 *  - The leaf is the conversation's active leaf (loadHistory's
 *    getLatestLeaf, default opts).
 */

/** Roles loadHistory maps to `null` — UI-only synthetic rows never sent to
 *  the LLM. Kept in lockstep with load-history.ts. */
const SYNTHETIC_ROLES = new Set<string>(["ez-action-result", PREPROCESS_RESULT_ROLE, "capability-event"]);

/** A conversation `messages` row (the subset backfill reads). */
type ConversationMessage = Awaited<ReturnType<typeof getMessages>>[number];

/** True when the row is an LLM-visible turn — i.e. becomes a `message`
 *  session entry. Mirrors loadHistory's drop rules: `excluded` rows and
 *  the synthetic UI-only roles are NOT turns. */
export function isLlmTurn(row: { role: string; excluded: boolean }): boolean {
  return !row.excluded && !SYNTHETIC_ROLES.has(row.role);
}

/**
 * Base-map a real turn row to the pi message `loadHistory` would emit
 * BEFORE attachment/image rehydration — byte-identical to load-history.ts's
 * per-row mapping except `timestamp`, which loadHistory sets to a
 * non-deterministic `Date.now()` (the parity suite normalises it away).
 * Here it is the row's createdAt, so a backfilled session is deterministic.
 */
export function rowToPiMessage(row: ConversationMessage): AssistantMessage | UserMessage {
  const timestamp = row.createdAt.getTime();
  if (row.role === "assistant") {
    return {
      role: "assistant",
      content: [{ type: "text", text: row.content }],
      api: "unknown",
      provider: "unknown",
      model: "unknown",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp,
    } satisfies AssistantMessage;
  }
  return { role: "user", content: row.content, timestamp } satisfies UserMessage;
}

/** The session-tree entry for a row: an LLM-visible `message` entry for a
 *  real turn, else a non-emitting `custom` placeholder that keeps the tree
 *  connected. `id`/`parentId` reuse the row ids so the entry chain mirrors
 *  parentMessageId exactly.
 *
 *  Re-root guard: if `parentMessageId` is absent from the loaded row set
 *  (`knownIds`), re-root the entry to `parentId = null`. This is defensive —
 *  a same-conversation dangling pointer is unreachable (the self-FK
 *  messages.parent_message_id → messages(id) is ON DELETE SET NULL) — but a
 *  cross-conversation pointer (the FK is not conversation-scoped) or
 *  inconsistent data would otherwise make getPathToRoot throw
 *  invalid_session on a missing byId entry. Degrade gracefully instead. */
export function rowToEntry(row: ConversationMessage, knownIds: ReadonlySet<string>): SessionTreeEntry {
  const parentId = row.parentMessageId && knownIds.has(row.parentMessageId) ? row.parentMessageId : null;
  const base = { id: row.id, parentId, timestamp: row.createdAt.toISOString() };
  if (isLlmTurn(row)) {
    return { type: "message", ...base, message: rowToPiMessage(row) as AgentMessage };
  }
  return { type: "custom", ...base, customType: "ezcorp:filtered-row", data: { role: row.role, excluded: row.excluded } };
}

/** Postgres unique_violation (SQLSTATE 23505). drizzle wraps driver errors
 *  in a DrizzleQueryError whose `.code` is undefined — the SQLSTATE lives on
 *  `.cause`; check both so a raw driver error (Bun.sql) also matches. */
function isUniqueViolation(err: unknown): boolean {
  const codeOf = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);
  return codeOf(err) === "23505" || codeOf((err as { cause?: unknown } | null)?.cause) === "23505";
}

/**
 * Backfill (or return the existing) session for a conversation.
 *
 * Idempotent AND concurrency-safe: the session-row INSERT is the single
 * serialization point. The partial unique index
 * `agent_sessions_conversation_unique` lets exactly one caller's row land;
 * a repeat call OR a concurrent loser hits a 23505 unique violation, which
 * we catch and resolve by OPENING the existing session (never a second
 * INSERT, never duplicate entries, never an unhandled 500). We deliberately
 * do NOT check-then-insert (a SELECT-then-CREATE races: two callers both
 * pass the SELECT, then the loser's INSERT throws). Note: a concurrent
 * loser may open a session the winner is still populating — a partial read
 * that per-session locking closes in P3 (out of scope here).
 */
export async function backfillSessionForConversation(conversationId: string): Promise<DbSessionStorage> {
  const db = getDb();
  const storage = await DbSessionStorage.create({ conversationId }).catch((err) => {
    if (!isUniqueViolation(err)) throw err;
    return null;
  });
  if (!storage) {
    const [existing] = await db.select().from(agentSessions).where(eq(agentSessions.conversationId, conversationId));
    return DbSessionStorage.open(existing.id);
  }

  // FULL-tree walk: getMessages returns EVERY row (all branches), ordered
  // by createdAt. parent_id has no FK, so appending a child before its
  // parent is fine — getPathToRoot resolves the chain from the in-memory
  // map, not insertion order.
  const rows = await getMessages(conversationId);
  const knownIds = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    // Cross-link the row on `message` entries only (design §3); synthetic /
    // excluded placeholders carry no ezMessageId.
    const ezMessageId = isLlmTurn(row) ? row.id : null;
    await storage.appendEntry(rowToEntry(row, knownIds), ezMessageId);
  }

  // Leaf = the conversation's active leaf (loadHistory uses getLatestLeaf
  // with default opts). Set explicitly — never rely on insertion order.
  const leaf = await getLatestLeaf(conversationId);
  if (leaf) await storage.setLeafId(leaf.id);

  return storage;
}
