import { eq, desc, asc, sql, and, or, isNull, inArray, notInArray } from "drizzle-orm";
import { getDb } from "../connection";
import { conversations, messages, toolCalls, runs } from "../schema";
import { listAttachmentsForMessages } from "./attachments";
import { getSetting } from "./settings";
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
  kind: "image" | "text" | "pdf" | "audio";
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
  opts?: { title?: string; model?: string; provider?: string; agentConfigId?: string; systemPrompt?: string; test?: boolean; userId?: string; parentConversationId?: string; parentMessageId?: string; forkedFromConversationId?: string; forkedFromMessageId?: string },
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
    })
    .returning();
  return rows[0]!;
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

export async function updateConversation(
  id: string,
  data: { title?: string; model?: string; provider?: string; systemPrompt?: string; agentConfigId?: string; modeId?: string | null },
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

export async function createMessage(
  conversationId: string,
  data: {
    role: string;
    content: string;
    thinkingContent?: string;
    model?: string;
    provider?: string;
    usage?: { inputTokens: number; outputTokens: number };
    runId?: string;
    parentMessageId?: string;
  },
): Promise<Message> {
  const db = getDb();
  const rows = await db
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

  // Touch conversation updatedAt
  await db
    .update(conversations)
    .set({ updatedAt: sql`NOW()` })
    .where(eq(conversations.id, conversationId));

  return rows[0]!;
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
 * subscription, ezContext, and locked mode continue working unchanged.
 *
 * Cascade behavior (see schema.ts FK definitions):
 *   - `attachments.message_id`  → ON DELETE CASCADE (rows wiped)
 *   - `tool_calls.message_id`   → ON DELETE CASCADE (inline calls wiped)
 *   - `tool_calls.conversation_id` rows with NULL messageId (conversation-
 *     level, not message-anchored) are NOT touched here — they belong to
 *     the conversation as a whole. None are expected on Ez conversations.
 *   - `runs` are referenced from messages via `messages.run_id` (set null
 *     on delete) — we don't garbage-collect runs rows, but they're harmless
 *     once unreferenced.
 *   - `active_runs.conversation_id` cascade only fires on conversation
 *     delete (not message delete) — any in-flight stream's active_run row
 *     stays. Caller is expected to stop streaming on the client side
 *     before clearing; the runtime treats a missing message history as a
 *     fresh start regardless.
 */
export async function deleteAllMessagesForConversation(conversationId: string): Promise<number> {
  if (!conversationId || typeof conversationId !== "string") {
    throw new Error("conversationId must be a non-empty string");
  }
  const rows = await getDb()
    .delete(messages)
    .where(eq(messages.conversationId, conversationId))
    .returning({ id: messages.id });
  return rows.length;
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

export async function getConversationPath(
  leafMessageId: string,
  conversationId: string,
): Promise<Message[]> {
  const db = getDb();
  // Track depth in the recursive CTE so we can order root → leaf via the
  // parent chain rather than created_at. Two messages inserted in the same
  // millisecond (common in tight-loop tests and fast branch creation) used
  // to come back in non-deterministic order, silently breaking downstream
  // code that expects strict user/assistant alternation in the history.
  const result = await db.execute(sql`
    WITH RECURSIVE path AS (
      SELECT *, 0 AS depth FROM messages
        WHERE id = ${leafMessageId} AND conversation_id = ${conversationId}
      UNION ALL
      SELECT m.*, p.depth + 1 FROM messages m
        JOIN path p ON m.id = p.parent_message_id
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

  try {
    const messageIdMap = new Map<string, string>();
    let prevNewId: string | null = null;

    for (const src of selected) {
      const inserted: MessageRow[] = await db
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
    }

    // Clone inline tool calls whose messageId is in our selection. We do NOT
    // clone conversation-level tool calls (messageId = null) — those belong
    // to the source conversation as a whole, not to the ported turns.
    const sourceCalls = await db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.conversationId, sourceConvId), inArray(toolCalls.messageId, uniqueIds)))
      .orderBy(asc(toolCalls.createdAt));

    for (const tc of sourceCalls) {
      const remappedMessageId = tc.messageId ? messageIdMap.get(tc.messageId) ?? null : null;
      if (!remappedMessageId) continue;
      await db.insert(toolCalls).values({
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
  } catch (err) {
    // Best-effort rollback: ON DELETE CASCADE wipes the child messages and
    // tool_calls rows we just inserted, so the database is left consistent.
    try {
      await db.delete(conversations).where(eq(conversations.id, newConv.id));
    } catch (rollbackErr) {
      log.error("Clone rollback failed - database may be inconsistent", {
        conversationId: newConv.id,
        originalError: String(err),
        rollbackError: String(rollbackErr),
      });
    }
    throw err;
  }
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
  const db = getDb();
  const rows = await db
    .update(messages)
    .set({ content })
    .where(and(eq(messages.conversationId, conversationId), eq(messages.id, messageId)))
    .returning();
  if (rows.length === 0) return null;
  await db
    .update(conversations)
    .set({ updatedAt: sql`NOW()` })
    .where(eq(conversations.id, conversationId));
  return rows[0]!;
}

/**
 * Flip a message's `excluded` flag. When true, load-history drops the row
 * from the array sent to pi-ai on subsequent turns (the transcript still
 * shows it, struck-through). Returns null when no row matches the
 * (conversationId, messageId) pair so the route can map to a 404.
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

export async function getLatestLeaf(conversationId: string): Promise<Message | null> {
  if (!conversationId || typeof conversationId !== "string") {
    throw new Error("conversationId must be a non-empty string");
  }
  const db = getDb();
  // Deterministic tiebreak on id DESC — when two leaves share the same
  // created_at timestamp (common in tight-loop test inserts or fast
  // branch creation), the previous ORDER BY created_at DESC alone
  // produced non-deterministic ordering. The id DESC secondary sort
  // gives a stable result even though it's arbitrary for ties.
  const result = await db.execute(sql`
    SELECT m.* FROM messages m
    WHERE m.conversation_id = ${conversationId}
      AND NOT EXISTS (
        SELECT 1 FROM messages child
        WHERE child.parent_message_id = m.id
          AND child.conversation_id = ${conversationId}
      )
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToMessage(row) : null;
}

// ── Search ───────────────────────────────────────────────────────────

export async function searchConversations(
  projectId: string,
  query: string,
  userId?: string,
): Promise<SearchResult[]> {
  if (!query || query.trim().length < 2) return [];

  const db = getDb();
  const userFilter = userId ? sql` AND c.user_id = ${userId}` : sql``;
  const results = await db.execute(sql`
    SELECT DISTINCT ON (c.id)
      c.id,
      c.title,
      c.updated_at,
      m.id as matching_message_id,
      ts_headline('english', m.content, plainto_tsquery('english', ${query}),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15') as snippet,
      ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', ${query})) as rank
    FROM conversations c
    JOIN messages m ON m.conversation_id = c.id
    WHERE c.project_id = ${projectId}
      AND (c.test IS NULL OR c.test = false)
      ${userFilter}
      AND (
        to_tsvector('english', m.content) @@ plainto_tsquery('english', ${query})
        OR to_tsvector('english', c.title) @@ plainto_tsquery('english', ${query})
      )
    ORDER BY c.id, rank DESC
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
