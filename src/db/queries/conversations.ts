import { eq, ne, desc, asc, sql, and, or, isNull, inArray, notInArray } from "drizzle-orm";
import { getDb } from "../connection";
import { conversations, messages, toolCalls, runs, conversationExtensions } from "../schema";
import { listAttachmentsForMessages } from "./attachments";
import { getSetting } from "./settings";
import { isEmbedEligible } from "../../memory/message-chunker";
import { enqueueEmbedJob, clearMessageEmbedState } from "./message-embed-outbox";
import { logger } from "../../logger";

const log = logger.child("db.queries.conversations");

// ── Types ────────────────────────────────────────────────────────────

type Conversation = typeof conversations.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type MemoryUsed = { id: string; content: string; category: string };
export type AttachmentSummary = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "text" | "pdf" | "audio" | "extension-handle";
};
type Message = MessageRow & { memoriesUsed?: MemoryUsed[]; attachments?: AttachmentSummary[] };

/**
 * Batch-attach sanitized attachment summaries to each message. `storagePath`
 * is intentionally dropped — it's a server-side FS path that must never reach
 * the client. The serving route at /api/attachments/[id] resolves the path
 * server-side, so the client only needs the id + display metadata.
 */
async function attachAttachments(msgs: Message[]): Promise<Message[]> {
  const ids = msgs.map((m) => m.id);
  const rows = await listAttachmentsForMessages(ids);
  if (rows.length === 0) return msgs;

  const byMessage = new Map<string, AttachmentSummary[]>();
  for (const row of rows) {
    const list = byMessage.get(row.messageId) ?? [];
    list.push({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      kind: row.kind,
    });
    byMessage.set(row.messageId, list);
  }

  return msgs.map((m) => {
    const attachments = byMessage.get(m.id);
    return attachments ? { ...m, attachments } : m;
  });
}

/**
 * Batch-attach `memoriesUsed` from the runs table. memoriesUsed is already
 * persisted per-turn inside `runs.result.output.memoriesUsed` by the executor;
 * this helper exposes it on each assistant message for the chat UI to render.
 */
async function attachMemoriesUsed(msgs: MessageRow[]): Promise<Message[]> {
  const runIds = Array.from(
    new Set(msgs.filter((m) => m.role === "assistant" && m.runId).map((m) => m.runId!)),
  );
  if (runIds.length === 0) return msgs;

  const rows = await getDb()
    .select({ id: runs.id, result: runs.result })
    .from(runs)
    .where(inArray(runs.id, runIds));

  const byRun = new Map<string, MemoryUsed[]>();
  for (const row of rows) {
    const output = (row.result?.output ?? null) as { memoriesUsed?: MemoryUsed[] } | null;
    if (output?.memoriesUsed && output.memoriesUsed.length > 0) {
      byRun.set(row.id, output.memoriesUsed);
    }
  }

  return msgs.map((m) => {
    // Only attach to assistant rows — a user row that happens to share a runId must
    // never leak memoriesUsed. Mirrors the role filter in `runIds` collection above.
    if (m.role !== "assistant" || !m.runId) return m;
    const mem = byRun.get(m.runId);
    return mem ? { ...m, memoriesUsed: mem } : m;
  });
}

export interface SearchResult {
  id: string;
  title: string;
  updatedAt: Date;
  matchingMessageId: string | null;
  snippet: string;
  rank: number;
}

// ── Conversations ────────────────────────────────────────────────────

export async function createConversation(
  projectId: string,
  opts?: { title?: string; model?: string; provider?: string; agentConfigId?: string; systemPrompt?: string; test?: boolean; userId?: string; parentConversationId?: string; parentMessageId?: string; forkedFromConversationId?: string; forkedFromMessageId?: string; extensionTools?: Record<string, string[]> | null },
): Promise<Conversation> {
  if (!projectId) throw new Error("projectId is required to create a conversation");
  const rows = await getDb()
    .insert(conversations)
    .values({
      projectId,
      ...(opts?.title ? { title: opts.title } : {}),
      model: opts?.model || null,
      provider: opts?.provider || null,
      systemPrompt: opts?.systemPrompt || null,
      agentConfigId: opts?.agentConfigId || null,
      parentConversationId: opts?.parentConversationId || null,
      parentMessageId: opts?.parentMessageId || null,
      forkedFromConversationId: opts?.forkedFromConversationId || null,
      forkedFromMessageId: opts?.forkedFromMessageId || null,
      test: opts?.test ?? false,
      userId: opts?.userId || null,
      extensionTools: opts?.extensionTools ?? null,
    })
    .returning();
  const created = rows[0]!;

  // Phase 53 Stage 2: auto-wire bundled extensions that need to fire
  // on every conversation (currently just the lessons-distiller).
  // Failure is logged + swallowed — conversation creation must not
  // depend on the wiring write succeeding. See
  // `src/extensions/auto-wire-bundled.ts` for the contract.
  try {
    const { autoWireBundledExtensions } = await import(
      "../../extensions/auto-wire-bundled"
    );
    await autoWireBundledExtensions(created.id);
  } catch (err) {
    // Defensive — autoWireBundledExtensions itself swallows; this is
    // belt-and-suspenders for the dynamic-import path.
    log.warn("auto-wire bundled extensions failed during createConversation", {
      conversationId: created.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return created;
}

export async function createSubConversation(
  projectId: string,
  opts: { parentConversationId: string; parentMessageId?: string; agentConfigId?: string; systemPrompt?: string; userId?: string; title?: string },
): Promise<Conversation> {
  if (!opts.parentConversationId) throw new Error("parentConversationId is required");
  return createConversation(projectId, {
    title: opts.title ?? "Sub-conversation",
    agentConfigId: opts.agentConfigId ?? undefined,
    systemPrompt: opts.systemPrompt ?? undefined,
    userId: opts.userId ?? undefined,
    parentConversationId: opts.parentConversationId,
    parentMessageId: opts.parentMessageId ?? undefined,
  });
}

export async function getSubConversations(parentConversationId: string): Promise<Conversation[]> {
  return getDb()
    .select()
    .from(conversations)
    .where(eq(conversations.parentConversationId, parentConversationId))
    .orderBy(asc(conversations.createdAt));
}

/**
 * Resolve the owning userId of a conversation, walking the
 * `parentConversationId` chain when the row itself has no owner.
 * Sub-conversations historically persisted with `userId: null`;
 * ownership is inherited from the (grand)parent. Depth-capped at 10 —
 * mirrors the executor's MAX_SPAWN_DEPTH, so a legitimate chain can
 * never exceed it. Returns null for an ownerless chain, a missing
 * conversation, or a cycle.
 */
export async function resolveConversationOwnerUserId(
  conversationId: string,
): Promise<string | null> {
  let currentId: string | null = conversationId;
  for (let depth = 0; depth <= 10 && currentId; depth++) {
    const conv: Conversation | null = await getConversation(currentId);
    if (!conv) return null;
    if (conv.userId) return conv.userId;
    currentId = conv.parentConversationId ?? null;
  }
  return null;
}

export async function listConversations(
  projectId: string,
  userId?: string,
  options?: { limit?: number; offset?: number },
): Promise<Conversation[]> {
  const conditions = [
    eq(conversations.projectId, projectId),
    or(eq(conversations.test, false), isNull(conversations.test)),
    isNull(conversations.parentConversationId),
  ];
  if (userId) conditions.push(eq(conversations.userId, userId));

  const query = getDb()
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt))
    .$dynamic();

  if (options?.limit !== undefined) query.limit(options.limit);
  if (options?.offset !== undefined) query.offset(options.offset);

  return query;
}

/**
 * Daily Briefing Phase 1 — the user's recent conversations across ALL
 * projects, for the briefing agent's `list_recent_conversations` tool.
 *
 * Sibling of `listConversations` (which is project-scoped — the
 * briefing mines the user's whole history, so it needs a user-scoped
 * variant). Shares the same hygiene filters (no test rows, no
 * sub-conversations) and adds the briefing-specific exclusions:
 *
 *   - `kind = 'regular'` only — the Ez concierge thread is noise.
 *   - `excludeAgentConfigId` — filters out PRIOR BRIEFINGS (locked
 *     decision §6.6: without this, day 3's "unfinished business"
 *     becomes recursive briefing soup).
 *   - `excludeConversationId` — the in-flight briefing conversation
 *     itself.
 *   - `onlyAgentConfigId` — the INVERSE filter: only conversations run
 *     by the given agent config. Used by `briefing_status` to list the
 *     user's recent briefing conversations.
 */
export async function listRecentConversationsForUser(
  userId: string,
  options?: {
    excludeAgentConfigId?: string | null;
    excludeConversationId?: string;
    onlyAgentConfigId?: string;
    limit?: number;
  },
): Promise<Conversation[]> {
  if (!userId) throw new Error("userId is required");
  const conditions = [
    eq(conversations.userId, userId),
    or(eq(conversations.test, false), isNull(conversations.test)),
    isNull(conversations.parentConversationId),
    eq(conversations.kind, "regular"),
  ];
  if (options?.onlyAgentConfigId) {
    conditions.push(eq(conversations.agentConfigId, options.onlyAgentConfigId));
  }
  if (options?.excludeAgentConfigId) {
    conditions.push(
      or(
        isNull(conversations.agentConfigId),
        ne(conversations.agentConfigId, options.excludeAgentConfigId),
      ),
    );
  }
  if (options?.excludeConversationId) {
    conditions.push(ne(conversations.id, options.excludeConversationId));
  }
  return getDb()
    .select()
    .from(conversations)
    .where(and(...conditions))
    .orderBy(desc(conversations.updatedAt))
    .limit(options?.limit ?? 10);
}

export async function getTestConversations(agentConfigId: string): Promise<Conversation[]> {
  return getDb()
    .select()
    .from(conversations)
    .where(and(
      eq(conversations.agentConfigId, agentConfigId),
      eq(conversations.test, true),
    ))
    .orderBy(desc(conversations.createdAt));
}

export async function deleteTestConversations(agentConfigId: string): Promise<number> {
  const rows = await getDb()
    .delete(conversations)
    .where(and(
      eq(conversations.agentConfigId, agentConfigId),
      eq(conversations.test, true),
    ))
    .returning({ id: conversations.id });
  return rows.length;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const rows = await getDb()
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  return rows[0] ?? null;
}

// ── Phase 2d: conversation metadata helpers ───────────────────────────
//
// `conversations.metadata` is a nullable JSONB bag for runtime-only flags
// that don't deserve their own column (yet). Currently holds `spawnDepth`
// for the `ezcorp/spawn-assignment` depth-limit gate — the number of
// extension-initiated spawns between this conversation and the root
// (0 for top-level conversations, +1 per spawn hop).

/** Read `spawnDepth` from the conversation's metadata bag; 0 when absent. */
export async function getConversationSpawnDepth(conversationId: string): Promise<number> {
  const conv = await getConversation(conversationId);
  if (!conv) return 0;
  const meta = (conv.metadata ?? {}) as { spawnDepth?: unknown };
  return typeof meta.spawnDepth === "number" ? meta.spawnDepth : 0;
}

/** Persist `spawnDepth` into the conversation's metadata bag, preserving
 *  any other keys already present. No-op on unknown conversation. */
export async function setConversationSpawnDepth(conversationId: string, depth: number): Promise<void> {
  const conv = await getConversation(conversationId);
  if (!conv) return;
  const meta = { ...((conv.metadata ?? {}) as Record<string, unknown>), spawnDepth: depth };
  await getDb()
    .update(conversations)
    .set({ metadata: meta })
    .where(eq(conversations.id, conversationId));
}

/**
 * Phase 4 §M2 — read the spawn-authorize audit id seeded on this
 * conversation when it was created via `ezcorp/spawn-assignment`. Used
 * by the PDP to set `parentAuditId` on every authorize() inside the
 * child, so the audit log forms a single chain rooted at the spawn's
 * authorize row. Returns `null` for top-level (non-spawned)
 * conversations or when the metadata key is absent.
 */
export async function getConversationSpawnParentAuditId(
  conversationId: string,
): Promise<string | null> {
  const conv = await getConversation(conversationId);
  if (!conv) return null;
  const meta = (conv.metadata ?? {}) as { spawnParentAuditId?: unknown };
  return typeof meta.spawnParentAuditId === "string" ? meta.spawnParentAuditId : null;
}

/**
 * Phase 4 §M2 — write the spawn-authorize audit id onto the child's
 * metadata bag at spawn-creation time. Preserves other metadata keys.
 */
export async function setConversationSpawnParentAuditId(
  conversationId: string,
  auditId: string,
): Promise<void> {
  const conv = await getConversation(conversationId);
  if (!conv) return;
  const meta = {
    ...((conv.metadata ?? {}) as Record<string, unknown>),
    spawnParentAuditId: auditId,
  };
  await getDb()
    .update(conversations)
    .set({ metadata: meta })
    .where(eq(conversations.id, conversationId));
}

export async function updateConversation(
  id: string,
  data: { title?: string; model?: string; provider?: string; systemPrompt?: string; agentConfigId?: string; modeId?: string | null; extensionTools?: Record<string, string[]> | null },
): Promise<Conversation | null> {
  const rows = await getDb()
    .update(conversations)
    .set({
      ...data,
      updatedAt: sql`NOW()`,
    })
    .where(eq(conversations.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteConversation(id: string): Promise<boolean> {
  const rows = await getDb()
    .delete(conversations)
    .where(eq(conversations.id, id))
    .returning({ id: conversations.id });
  return rows.length > 0;
}

// ── Phase 48: Ez concierge conversation (one per user, global scope) ──
//
// The Ez floating panel renders the user's single ez-kind conversation.
// Uniqueness is enforced at the DB level by the partial index
// `conversations_user_ez_unique` (declared in migrate.ts). This helper is
// the find-or-create path called on first panel open; calling it twice
// returns the same row.
//
// `projectId` is set to 'global' (the seeded global project from
// migrate.ts) because Ez conversations are not bound to any specific
// project — page context per turn carries the current projectId for the
// LLM's awareness, but the conversation itself spans the user's whole
// EZCorp setup.
//
// `modeId` is locked to the seeded 'builtin-ez' mode. The PUT handler at
// /api/conversations/[id]/+server.ts rejects modeId mutation when
// kind === 'ez' (sibling guard to the existing builtin-mode rejection).

export async function getOrCreateEzConversation(userId: string): Promise<Conversation> {
  if (!userId) throw new Error("userId is required");

  // Fast path: existing row.
  const existing = await getDb()
    .select()
    .from(conversations)
    .where(and(eq(conversations.userId, userId), eq(conversations.kind, "ez")));
  if (existing[0]) return existing[0];

  // Insert new row. The unique partial index will reject a concurrent second
  // creation; we don't bother with ON CONFLICT here because the lookup-then-
  // insert race is benign — losers retry the SELECT and find the winner.
  try {
    const rows = await getDb()
      .insert(conversations)
      .values({
        projectId: "global",
        title: "Ez",
        userId,
        modeId: "builtin-ez",
        kind: "ez",
      })
      .returning();
    return rows[0]!;
  } catch (err) {
    // Concurrent insert lost the race against the unique index — retry the
    // SELECT to surface the winner. Any other error propagates.
    const retry = await getDb()
      .select()
      .from(conversations)
      .where(and(eq(conversations.userId, userId), eq(conversations.kind, "ez")));
    if (retry[0]) return retry[0];
    throw err;
  }
}

// ── Messages ─────────────────────────────────────────────────────────

/**
 * Per-turn usage persisted on `messages.usage`. `cache*` are the WS0
 * prompt-cache meter (tokens served from / written to the provider cache this
 * turn + the derived hit-rate [0,1]). `requested*`/`routedTier`/`failover` are
 * routing provenance — requested vs served; the served values live on the
 * `model`/`provider` columns. Optional so pre-cache rows and non-caching
 * providers stay valid — jsonb, so no migration. Mirrors the canonical
 * `messages.usage` `$type` in schema.ts.
 */
export interface CreateMessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheHitRate?: number;
  /** Subset of cacheWriteTokens written with 1h retention (Anthropic-only; billed at 2× input). */
  cacheWrite1hTokens?: number;
  /** User-pinned provider at request time; null ⇒ Auto/routed. */
  requestedProvider?: string | null;
  /** User-pinned model at request time; null ⇒ Auto/routed. */
  requestedModel?: string | null;
  /** Tier the router selected — only present when routing fired. */
  routedTier?: "fast" | "balanced" | "powerful";
  /** True when the served provider ≠ the initially resolved provider. */
  failover?: boolean;
}

export async function createMessage(
  conversationId: string,
  data: {
    role: string;
    content: string;
    thinkingContent?: string;
    model?: string;
    provider?: string;
    usage?: CreateMessageUsage;
    runId?: string;
    parentMessageId?: string;
  },
): Promise<Message> {
  // Phase 63 IDX-04: the message insert, the conversation touch, AND the
  // embed-outbox enqueue MUST be one atomic unit — no message without its
  // embed job, no embed job without its message. EVERYTHING inside the
  // callback runs on `tx`; referencing the outer db/getDb() here would escape
  // the transaction and silently break atomicity (research Pitfall 1). The
  // enqueue is a single cheap upsert — fine in-tx. NEVER generate embeddings
  // here; that is the Phase 64 worker's job, off the SSE finalize hot path.
  // (`tx` is `any` by the deliberate repo-wide `Database = any` design in
  // connection.ts; enqueueEmbedJob's EmbedJobTx documents the handle shape.)
  return getDb().transaction(async (tx: any) => {
    const rows = await tx
      .insert(messages)
      .values({
        conversationId,
        role: data.role,
        content: data.content,
        thinkingContent: data.thinkingContent ?? null,
        model: data.model ?? null,
        provider: data.provider ?? null,
        usage: data.usage ?? null,
        runId: data.runId ?? null,
        parentMessageId: data.parentMessageId ?? null,
      })
      .returning();
    const msg = rows[0]!;

    // Touch conversation updatedAt (on tx).
    await tx
      .update(conversations)
      .set({ updatedAt: sql`NOW()` })
      .where(eq(conversations.id, conversationId));

    if (isEmbedEligible(data.role, data.content)) {
      await enqueueEmbedJob(tx, msg.id, conversationId);
    }

    return msg;
  });
}

export async function getMessages(conversationId: string): Promise<Message[]> {
  const rows = await getDb()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  const withMem = await attachMemoriesUsed(rows);
  return attachAttachments(withMem);
}

/**
 * Delete every message for a conversation, leaving the conversation row
 * itself in place. Returns the number of rows removed.
 *
 * Used by the Ez panel's "Clear conversation" action: the schema enforces
 * one Ez conversation per user (partial unique index on
 * `conversations(user_id) WHERE kind = 'ez'`), so "start a new chat" is
 * implemented as wiping the message list rather than deleting + recreating
 * the row. The conversation id stays stable — the caller's SSE
 * subscription and locked mode continue working unchanged.
 *
 * `tool_calls.message_id` and `conversation_extensions.added_by_message_id`
 * are `ON DELETE SET NULL`, NOT CASCADE — so wiping `messages` alone leaves
 * those rows behind and the next turn's `setup-tools` re-wires the
 * conversation-level extensions and the orphaned tool_calls rows pollute
 * the message-detail UI. Wipe both adjacent tables explicitly here. Order:
 * extensions/tool_calls first, messages last (so the message-cascade for
 * attachments still fires correctly).
 */
export async function deleteAllMessagesForConversation(conversationId: string): Promise<number> {
  if (!conversationId || typeof conversationId !== "string") {
    throw new Error("conversationId must be a non-empty string");
  }
  // All three deletes are ONE transaction so the wipe is all-or-nothing. A
  // crash/error after the extensions + tool_calls deletes but before the
  // messages delete used to leave the conversation with its full message
  // history intact but every historical tool-call row destroyed — a
  // non-self-healing partial state (the surviving messages lose their tool
  // calls permanently). Order preserved: extensions/tool_calls first, messages
  // last (so the message-cascade for attachments still fires correctly).
  return getDb().transaction(async (tx: any) => {
    await tx.delete(conversationExtensions).where(eq(conversationExtensions.conversationId, conversationId));
    await tx.delete(toolCalls).where(eq(toolCalls.conversationId, conversationId));
    const rows = await tx
      .delete(messages)
      .where(eq(messages.conversationId, conversationId))
      .returning({ id: messages.id });
    return rows.length;
  });
}

// ── Branching ────────────────────────────────────────────────────────

/** Map raw SQL row (snake_case) to Message type (camelCase) */
function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    role: row.role as string,
    content: row.content as string,
    thinkingContent: (row.thinking_content as string) ?? null,
    model: (row.model as string) ?? null,
    provider: (row.provider as string) ?? null,
    usage: row.usage as any,
    runId: (row.run_id as string) ?? null,
    parentMessageId: (row.parent_message_id as string) ?? null,
    excluded: row.excluded === true,
    createdAt: new Date(row.created_at as string),
  };
}

/**
 * Hard cap on the recursive parent-walk of {@link getConversationPath}
 * (defense-in-depth vs a `parent_message_id` CYCLE). `parent_message_id` is a
 * self-FK with no cycle constraint, so a buggy/malicious re-parent (e.g. an
 * unvalidated client `parentMessageId`, or A→B→A via {@link reparentMessage})
 * could form a loop the UNION-ALL recursive CTE would follow forever (Postgres
 * does not dedupe recursion), exhausting `work_mem`/temp — a self-DoS. Bounding
 * the walk turns that into a truncated (still bounded) read. The cap is ~100×
 * beyond any real chat branch length, so a legitimate conversation NEVER hits
 * it; only corrupt/adversarial data does.
 */
export const MAX_CONVERSATION_PATH_DEPTH = 100_000;

export async function getConversationPath(
  leafMessageId: string,
  conversationId: string,
  maxDepth: number = MAX_CONVERSATION_PATH_DEPTH,
): Promise<Message[]> {
  const db = getDb();
  // Track depth in the recursive CTE so we can order root → leaf via the
  // parent chain rather than created_at. Two messages inserted in the same
  // millisecond (common in tight-loop tests and fast branch creation) used
  // to come back in non-deterministic order, silently breaking downstream
  // code that expects strict user/assistant alternation in the history.
  //
  // `p.depth < maxDepth` bounds the recursion so a parent_message_id CYCLE
  // truncates the walk instead of looping forever (see
  // MAX_CONVERSATION_PATH_DEPTH). The default is unreachable for real data.
  //
  // The recursive step is CONVERSATION-SCOPED (`m.conversation_id =
  // ${conversationId}`): messages.parent_message_id is a self-FK to
  // messages(id) that is NOT conversation-scoped, so a FK-legal pointer could
  // in principle reference a row in ANOTHER conversation. No legitimate writer
  // ever creates such a pointer (every runtime save parents within the run's
  // own conversation; sub-conversation back-links live on conversations.
  // parent_message_id, a distinct column), but an unvalidated client-supplied
  // parentMessageId or corrupt data could. Scoping the follow here means a
  // stray cross-conversation pointer TRUNCATES the walk at the boundary rather
  // than pulling another conversation's rows into this history — matching the
  // per-conversation truncation session-backfill already performs (its
  // getMessages loads only this conversation, so the parent falls out of
  // knownIds and re-roots to null).
  const result = await db.execute(sql`
    WITH RECURSIVE path AS (
      SELECT *, 0 AS depth FROM messages
        WHERE id = ${leafMessageId} AND conversation_id = ${conversationId}
      UNION ALL
      SELECT m.*, p.depth + 1 FROM messages m
        JOIN path p ON m.id = p.parent_message_id AND m.conversation_id = ${conversationId}
        WHERE p.depth < ${maxDepth}
    )
    SELECT * FROM path ORDER BY depth DESC
  `);
  const rows = (result.rows as Record<string, unknown>[]).map(rowToMessage);
  const withMem = await attachMemoriesUsed(rows);
  return attachAttachments(withMem);
}

export async function getSiblings(parentMessageId: string): Promise<Message[]> {
  return getDb()
    .select()
    .from(messages)
    .where(eq(messages.parentMessageId, parentMessageId))
    .orderBy(asc(messages.createdAt));
}

/**
 * Clone a selection of turns from `sourceConvId` into a brand-new conversation.
 *
 * Builds a fresh linear parent chain across the selected messages (original
 * branching is discarded). Inline tool calls whose `messageId` is in the
 * selection travel along, re-parented to the cloned message ids. The new
 * conversation inherits `projectId / model / provider / systemPrompt /
 * agentConfigId / modeId` from the source and `userId` from the caller.
 *
 * Used by the "Select Mode → New Chat" feature in the chat window so users
 * can fork a subset of turns into a fresh conversation and continue from
 * there without losing role formatting or tool-call context.
 */
export async function cloneTurnsIntoNewConversation(
  sourceConvId: string,
  messageIds: string[],
  opts: { userId?: string | null; title?: string },
): Promise<{ conversation: Conversation; messageIdMap: Map<string, string> }> {
  if (!sourceConvId) throw new Error("sourceConvId is required");
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    throw new Error("messageIds must be a non-empty array");
  }

  const db = getDb();

  const source = await getConversation(sourceConvId);
  if (!source) throw new Error("Source conversation not found");

  // Deduplicate — clients occasionally pass duplicates when they wire up
  // checkbox toggles; dedupe here so the cloned chain doesn't have copies.
  const uniqueIds = Array.from(new Set(messageIds));

  const selected = await db
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, sourceConvId), inArray(messages.id, uniqueIds)))
    .orderBy(asc(messages.createdAt));

  if (selected.length !== uniqueIds.length) {
    throw new Error("One or more messageIds do not belong to the source conversation");
  }

  // Anchor = the last (most recent) selected source message in chronological
  // order. Used by the sidebar to group the fork under its source and (later)
  // power a "view in source" deep-link back to the branch point.
  const forkAnchorMessageId = selected[selected.length - 1]!.id;

  const newConv = await createConversation(source.projectId, {
    title: opts.title ?? `Forked: ${source.title}`,
    model: source.model ?? undefined,
    provider: source.provider ?? undefined,
    systemPrompt: source.systemPrompt ?? undefined,
    agentConfigId: source.agentConfigId ?? undefined,
    userId: opts.userId ?? undefined,
    forkedFromConversationId: sourceConvId,
    forkedFromMessageId: forkAnchorMessageId,
  });

  // The message-insert loop, the embed-outbox enqueues, and the tool-call copy
  // loop are ONE transaction so a crash/error mid-clone can never leave a
  // half-cloned conversation with a truncated message chain (the manual
  // FK-cascade "rollback" this replaces was best-effort — its own failure was
  // only logged, leaving the corrupt state permanently). If the tx aborts the
  // (already-committed) empty forked conversation row is the only remnant —
  // strictly better than a partial history — and the error propagates so the
  // route surfaces the failure. Everything runs on `tx` (research Pitfall 1);
  // the enqueue mirrors createMessage's IDX-04 guard so cloned eligible
  // messages are indexed for semantic search (an unenqueued fork copy would be
  // invisible to message search forever if the source were later deleted).
  return getDb().transaction(async (tx: any) => {
    const messageIdMap = new Map<string, string>();
    let prevNewId: string | null = null;

    for (const src of selected) {
      const inserted: MessageRow[] = await tx
        .insert(messages)
        .values({
          conversationId: newConv.id,
          role: src.role,
          content: src.content,
          thinkingContent: src.thinkingContent ?? null,
          model: src.model ?? null,
          provider: src.provider ?? null,
          usage: src.usage ?? null,
          // runId is intentionally cleared — the clone is a fresh history and
          // must not link back to the source's LLM run rows (memoriesUsed,
          // etc. are deliberately not inherited).
          runId: null,
          parentMessageId: prevNewId,
        })
        .returning();
      const newMsg = inserted[0]!;
      messageIdMap.set(src.id, newMsg.id);
      prevNewId = newMsg.id;

      // IDX-04: no message without its embed job (same guard as createMessage).
      if (isEmbedEligible(src.role, src.content)) {
        await enqueueEmbedJob(tx, newMsg.id, newConv.id);
      }
    }

    // Clone inline tool calls whose messageId is in our selection. We do NOT
    // clone conversation-level tool calls (messageId = null) — those belong
    // to the source conversation as a whole, not to the ported turns.
    const sourceCalls = await tx
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.conversationId, sourceConvId), inArray(toolCalls.messageId, uniqueIds)))
      .orderBy(asc(toolCalls.createdAt));

    for (const tc of sourceCalls) {
      const remappedMessageId = tc.messageId ? messageIdMap.get(tc.messageId) ?? null : null;
      if (!remappedMessageId) continue;
      await tx.insert(toolCalls).values({
        conversationId: newConv.id,
        messageId: remappedMessageId,
        extensionId: tc.extensionId,
        toolName: tc.toolName,
        input: tc.input,
        output: tc.output,
        success: tc.success,
        durationMs: tc.durationMs,
        cardType: tc.cardType ?? null,
        cardLayout: tc.cardLayout ?? null,
        userId: opts.userId ?? null,
        agentConfigId: tc.agentConfigId ?? null,
        model: tc.model ?? null,
        provider: tc.provider ?? null,
      });
    }

    return { conversation: newConv, messageIdMap };
  });
}

/**
 * Content-only update of a message (no branching, no regen). Used by the
 * assistant-turn "Edit text" affordance on seeded turns in cloned chats.
 * Callers are expected to have already verified conversation ownership and
 * that the message belongs to `conversationId`.
 */
export async function updateMessageContent(
  conversationId: string,
  messageId: string,
  content: string,
): Promise<Message | null> {
  // Phase 63 IDX-05: a content edit re-enqueues the message for embedding.
  // Wrapped in a transaction so the content update, conversation touch, and
  // outbox re-enqueue commit together. The outbox PK upsert means a re-edit
  // before the worker drains just refreshes the pending job (no duplicate
  // row). Everything runs on `tx` (research Pitfall 1).
  return getDb().transaction(async (tx: any) => {
    const rows = await tx
      .update(messages)
      .set({ content })
      .where(and(eq(messages.conversationId, conversationId), eq(messages.id, messageId)))
      .returning();
    if (rows.length === 0) return null;
    const msg = rows[0]!;

    await tx
      .update(conversations)
      .set({ updatedAt: sql`NOW()` })
      .where(eq(conversations.id, conversationId));

    if (isEmbedEligible(msg.role, content)) {
      await enqueueEmbedJob(tx, messageId, conversationId);
    } else {
      // The edit made this message embed-INELIGIBLE (e.g. cleared to
      // whitespace, or a role that never indexes). Drop any outbox job and
      // chunks left over from when it WAS eligible, so the Phase 64 worker
      // never embeds now-empty text and search never returns stale chunks.
      // Idempotent — a no-op when nothing was ever enqueued.
      await clearMessageEmbedState(tx, messageId);
    }

    return msg;
  });
}

/**
 * Flip a message's `excluded` flag. When true, load-history drops the row
 * from the array sent to pi-ai on subsequent turns (the transcript still
 * shows it, struck-through). Returns null when no row matches the
 * (conversationId, messageId) pair so the route can map to a 404.
 *
 * Embed-index policy (Phase 63 decision): context-exclusion and search-index
 * eligibility are INDEPENDENT. Excluding a message from the LLM context does
 * NOT cancel its embed outbox row or chunks — an excluded message stays
 * searchable. So this is intentionally NOT an embed write boundary (no
 * enqueue/clear here); it only toggles the context flag.
 */
export async function setMessageExcluded(
  conversationId: string,
  messageId: string,
  excluded: boolean,
): Promise<Message | null> {
  const db = getDb();
  const rows = await db
    .update(messages)
    .set({ excluded })
    .where(and(eq(messages.conversationId, conversationId), eq(messages.id, messageId)))
    .returning();
  if (rows.length === 0) return null;
  return rows[0]!;
}

/**
 * Re-parent a message onto a new parent within the SAME conversation (P4 §1.2 —
 * steered-row reconciliation). agent-chat persists a steer's user row at request
 * time with the leaf-at-request parent; when the steer is delivered mid-run the
 * LLM sees it at a LATER branch position, so subscribe-bridge re-parents the row
 * to the actual injection leaf here (serialized on ctx.dbQueue with the turn-save
 * chain) — making the next run's loadHistory rebuild the sequence the LLM saw.
 *
 * A single-column UPDATE from one valid existing message id to another: a crash
 * before/after it lands leaves the row with a valid, acyclic parent either way
 * (no partial state, no dangling/cross-conversation pointer), so the branch stays
 * coherent regardless. Conversation-scoped so a stray id can't touch another
 * conversation's row. Returns null when no row matches the pair (so a caller can
 * treat a since-deleted row as a no-op). NOT an embed write boundary — the parent
 * pointer doesn't change the indexed content.
 */
export async function reparentMessage(
  conversationId: string,
  messageId: string,
  newParentMessageId: string | null,
): Promise<Message | null> {
  const db = getDb();
  const rows = await db
    .update(messages)
    .set({ parentMessageId: newParentMessageId })
    .where(and(eq(messages.conversationId, conversationId), eq(messages.id, messageId)))
    .returning();
  if (rows.length === 0) return null;
  return rows[0]!;
}

export async function getLatestLeaf(
  conversationId: string,
  opts?: { excludeCapabilityEvents?: boolean },
): Promise<Message | null> {
  if (!conversationId || typeof conversationId !== "string") {
    throw new Error("conversationId must be a non-empty string");
  }
  const db = getDb();
  // `capability-event` rows are inline annotations (no conversational
  // children) — never tree nodes. When resolving a *parent* for a new
  // turn we must treat them as transparent: skip them as candidates AND
  // ignore them in the child-existence check, otherwise an assistant
  // turn that only has a trailing capability-event child (common right
  // after an auto-allowed tool run) is wrongly considered non-leaf and
  // the follow-up lands off the visible thread. This mirrors the
  // client's `computeLatestLeaf` (which excludes capability-event rows
  // and falls back to the last real message). Off by default so the
  // GET conversation-path caller keeps its existing behavior; the
  // message-create default opts in.
  const roleFilter = opts?.excludeCapabilityEvents
    ? sql` AND m.role <> 'capability-event'`
    : sql``;
  const childRoleFilter = opts?.excludeCapabilityEvents
    ? sql` AND child.role <> 'capability-event'`
    : sql``;
  // Deterministic tiebreak on id DESC — when two leaves share the same
  // created_at timestamp (common in tight-loop test inserts or fast
  // branch creation), the previous ORDER BY created_at DESC alone
  // produced non-deterministic ordering. The id DESC secondary sort
  // gives a stable result even though it's arbitrary for ties.
  const result = await db.execute(sql`
    SELECT m.* FROM messages m
    WHERE m.conversation_id = ${conversationId}
      ${roleFilter}
      AND NOT EXISTS (
        SELECT 1 FROM messages child
        WHERE child.parent_message_id = m.id
          AND child.conversation_id = ${conversationId}
          ${childRoleFilter}
      )
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

// ── Search ───────────────────────────────────────────────────────────

/** Default conversation-search page size. Bounds both the per-row `ts_headline`
 *  work AND the JSON payload — the old query computed the expensive
 *  `ts_headline`/`ts_rank` re-parse of `m.content` for EVERY matching message
 *  row before the DISTINCT collapse and returned an UNBOUNDED result. */
const DEFAULT_CONVERSATION_SEARCH_LIMIT = 50;

export async function searchConversations(
  projectId: string,
  query: string,
  userId?: string,
  opts?: { limit?: number; offset?: number },
): Promise<SearchResult[]> {
  if (!query || query.trim().length < 2) return [];

  const db = getDb();
  const limit = opts?.limit ?? DEFAULT_CONVERSATION_SEARCH_LIMIT;
  const offset = opts?.offset ?? 0;
  const userFilter = userId ? sql` AND c.user_id = ${userId}` : sql``;
  // Rank + LIMIT FIRST (best message per conversation via DISTINCT ON, then the
  // top-N conversations by rank), and compute the expensive `ts_headline`
  // snippet ONLY for the surviving page — mirrors the "rank first, headline the
  // survivors" shape searchMessages/message-search.ts already uses. The GIN
  // FTS index (idx_messages_fts) still drives the match predicate; what this
  // removes is the per-matching-row headline re-parse and the unbounded output.
  const results = await db.execute(sql`
    WITH matches AS (
      SELECT
        c.id AS conversation_id,
        c.title AS title,
        c.updated_at AS updated_at,
        m.id AS message_id,
        m.content AS content,
        ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', ${query})) AS rank
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      WHERE c.project_id = ${projectId}
        AND (c.test IS NULL OR c.test = false)
        ${userFilter}
        AND (
          to_tsvector('english', m.content) @@ plainto_tsquery('english', ${query})
          OR to_tsvector('english', c.title) @@ plainto_tsquery('english', ${query})
        )
    ),
    best AS (
      SELECT DISTINCT ON (conversation_id)
        conversation_id, title, updated_at, message_id, content, rank
      FROM matches
      ORDER BY conversation_id, rank DESC
    ),
    page AS (
      SELECT * FROM best
      ORDER BY rank DESC
      LIMIT ${limit} OFFSET ${offset}
    )
    SELECT
      conversation_id AS id,
      title,
      updated_at,
      message_id AS matching_message_id,
      ts_headline('english', content, plainto_tsquery('english', ${query}),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15') AS snippet,
      rank
    FROM page
    ORDER BY rank DESC
  `);

  return (results.rows as any[]).map((row) => ({
    id: row.id as string,
    title: row.title as string,
    updatedAt: new Date(row.updated_at as string),
    matchingMessageId: (row.matching_message_id as string) ?? null,
    snippet: row.snippet as string,
    rank: Number(row.rank),
  }));
}

// ── System Prompt Resolution ─────────────────────────────────────────

export async function resolveSystemPrompt(
  conversationId: string,
  projectId: string,
  modeId?: string | null,
): Promise<string | undefined> {
  const { getMode } = await import("./modes");

  // Fetch all sources in parallel
  const [conv, projectPrompt, globalPrompt, mode] = await Promise.all([
    getConversation(conversationId),
    getSetting(`project:${projectId}:systemPrompt`),
    getSetting("global:systemPrompt"),
    modeId ? getMode(modeId) : undefined,
  ]);

  const basePrompt = conv?.systemPrompt ?? (projectPrompt as string | undefined) ?? (globalPrompt as string | undefined);

  // Layer mode instruction on top of base prompt
  if (mode?.systemPromptInstruction) {
    const instruction = mode.systemPromptInstruction;
    if (mode.instructionPosition === "replace") return instruction;
    if (mode.instructionPosition === "append") return basePrompt ? `${basePrompt}\n\n${instruction}` : instruction;
    // Default: prepend
    return basePrompt ? `${instruction}\n\n${basePrompt}` : instruction;
  }

  return basePrompt;
}

// ── Tool Call Hydration ───────────────────────────────────────────────

/**
 * Coerce a tool output (string, ToolCallResult, or arbitrary object) to a text
 * representation. Pulled out of `truncateOutput` so callers can decide whether
 * to truncate or ship the full text (image-producing tools need the full body).
 */
export function extractOutputText(output: unknown): string | null {
  if (output == null) return null;
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    // Handle ToolCallResult shape: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(obj.content)) {
      const texts = (obj.content as any[])
        .filter((c: any) => c.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text);
      return texts.length > 0 ? texts.join("\n") : JSON.stringify(output);
    }
    const candidate = obj.text ?? obj.content ?? obj.result;
    return typeof candidate === "string" ? candidate : JSON.stringify(output);
  }
  return String(output);
}

// Match `![alt](url)` — the signal that a tool output carries a renderable image.
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^\)]+\)/;

/**
 * Extract text from output JSON, take first line, truncate to maxLen.
 */
export function truncateOutput(output: unknown, maxLen = 120): string | null {
  const text = extractOutputText(output);
  if (text == null) return null;
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > maxLen ? firstLine.slice(0, maxLen) + "..." : firstLine;
}

export interface ToolCallSummary {
  id: string;
  extensionId: string;
  toolName: string;
  input: Record<string, unknown> | null;
  outputSummary: string | null;
  fullOutput: string | null;
  success: boolean;
  durationMs: number;
  status: "success" | "error" | "interrupted";
  cardType: string | null;
  cardLayout: string | null;
  messageId: string | null;
  createdAt: Date;
}

export interface SubConversationSummary {
  id: string;
  agentName: string | null;
  agentConfigId: string | null;
  messageCount: number;
  lastMessagePreview: string | null;
  parentMessageId: string | null;
}

export interface MessageWithToolCalls extends Message {
  toolCalls: ToolCallSummary[];
}

/**
 * Convert a tool_calls row to the client-facing `ToolCallSummary` shape.
 * Shared between getMessagesWithToolCalls and getSubConversationToolCalls so
 * both return identical data for the same underlying row.
 */
function toolCallRowToSummary(tc: typeof toolCalls.$inferSelect): ToolCallSummary {
  const status: ToolCallSummary["status"] =
    tc.success === null && tc.output === null ? "interrupted"
      : tc.success === false ? "error"
      : "success";

  // Ship full output when either
  //   (a) the tool has a cardType — custom cards render structured data, or
  //   (b) the output contains markdown image syntax — the UI renders images
  //       inline, and we need the URL(s) that sit past the first-line truncation.
  // Image-gen tool outputs are small text+URL payloads, so bandwidth is negligible.
  let fullOutput: string | null = null;
  const extractedText = extractOutputText(tc.output);
  const hasImage = extractedText != null && MARKDOWN_IMAGE_RE.test(extractedText);
  if (tc.cardType || hasImage) {
    fullOutput = extractedText;
  }

  return {
    id: tc.id,
    extensionId: tc.extensionId,
    toolName: tc.toolName,
    input: tc.input,
    outputSummary: truncateOutput(tc.output),
    fullOutput,
    success: tc.success,
    cardType: tc.cardType ?? null,
    cardLayout: tc.cardLayout ?? null,
    messageId: tc.messageId ?? null,
    durationMs: tc.durationMs,
    status,
    createdAt: tc.createdAt,
  };
}

export async function getMessagesWithToolCalls(conversationId: string): Promise<{
  messages: MessageWithToolCalls[];
  subConversations: SubConversationSummary[];
  orphanedToolCalls: ToolCallSummary[];
}> {
  const db = getDb();

  // 1. Get messages
  const msgs = await getMessages(conversationId);
  if (msgs.length === 0) return { messages: [], subConversations: [], orphanedToolCalls: [] };

  const msgIds = msgs.map((m) => m.id);

  // 2. Batch fetch tool calls — both message-anchored and conversation-level (inline/card actions)
  const calls = await db
    .select()
    .from(toolCalls)
    .where(
      or(
        inArray(toolCalls.messageId, msgIds),
        and(eq(toolCalls.conversationId, conversationId), isNull(toolCalls.messageId)),
        and(eq(toolCalls.conversationId, conversationId), notInArray(toolCalls.messageId, msgIds)),
      )!,
    )
    .orderBy(asc(toolCalls.createdAt));

  // Group by messageId, separating orphaned (null messageId) calls
  const callsByMessage = new Map<string, ToolCallSummary[]>();
  const orphanedToolCalls: ToolCallSummary[] = [];
  const msgIdSet = new Set(msgIds);

  for (const tc of calls) {
    const summary = toolCallRowToSummary(tc);

    if (!tc.messageId || !msgIdSet.has(tc.messageId)) {
      orphanedToolCalls.push(summary);
    } else {
      const arr = callsByMessage.get(tc.messageId) ?? [];
      arr.push(summary);
      callsByMessage.set(tc.messageId, arr);
    }
  }

  // 3. Attach tool calls to messages

  const messagesWithCalls: MessageWithToolCalls[] = msgs.map((m) => ({
    ...m,
    toolCalls: callsByMessage.get(m.id) ?? [],
  }));

  // 4. Fetch sub-conversation summaries
  const subConvoRows = await db.execute(sql`
    SELECT
      c.id,
      ac.name AS agent_name,
      c.agent_config_id,
      (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
      (SELECT m.content FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_preview,
      c.parent_message_id
    FROM conversations c
    LEFT JOIN agent_configs ac ON ac.id = c.agent_config_id
    WHERE c.parent_conversation_id = ${conversationId}
    ORDER BY c.created_at ASC
  `);

  const subConversations: SubConversationSummary[] = (subConvoRows.rows as any[]).map((r) => ({
    id: r.id,
    agentName: r.agent_name ?? null,
    agentConfigId: r.agent_config_id ?? null,
    messageCount: Number(r.message_count),
    lastMessagePreview: r.last_message_preview ? truncateOutput(r.last_message_preview, 80) : null,
    parentMessageId: r.parent_message_id ?? null,
  }));

  return { messages: messagesWithCalls, subConversations, orphanedToolCalls };
}

/**
 * Fetch tool calls for every direct sub-conversation of a parent, grouped
 * by sub-conversation id. Used by the chat page to hydrate tool calls from
 * team members / invoked agents so their diffs appear in the parent's
 * Diff Summary panel.
 *
 * Only traverses one level — grandchildren (teams-of-teams) are not included.
 * The returned object is always defined (empty `{}` when there are no subs).
 */
export async function getSubConversationToolCalls(
  parentConversationId: string,
): Promise<Record<string, ToolCallSummary[]>> {
  const db = getDb();

  // 1. Collect sub-conversation ids.
  const subs = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.parentConversationId, parentConversationId));

  if (subs.length === 0) return {};
  const subIds = subs.map((r: { id: string }) => r.id);

  // 2. Batch-fetch all tool calls belonging to any of those sub-conversations.
  const calls = await db
    .select()
    .from(toolCalls)
    .where(inArray(toolCalls.conversationId, subIds))
    .orderBy(asc(toolCalls.createdAt));

  // 3. Group by sub-conversation id. Initialize empty arrays for every sub so
  //    callers can tell "no tool calls yet" apart from "not a sub-conversation"
  //    — the key set mirrors the known sub list.
  const grouped: Record<string, ToolCallSummary[]> = {};
  for (const id of subIds) grouped[id] = [];
  for (const tc of calls) {
    const summary = toolCallRowToSummary(tc);
    grouped[tc.conversationId] = grouped[tc.conversationId] ?? [];
    grouped[tc.conversationId]!.push(summary);
  }

  return grouped;
}
