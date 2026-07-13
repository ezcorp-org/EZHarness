/**
 * Topic-contexts DB layer.
 *
 * Four tables (see src/db/schema.ts + src/db/migrations/add-topic-contexts.ts):
 *   - context_types           — the DB-resident classification enum (read-only v1)
 *   - conversation_topics     — detected topics per conversation (stable pill ids)
 *   - conversation_topic_state — per-conversation staleness watermark
 *   - saved_contexts          — library snapshots (re-extract upserts)
 *
 * Two invariants worth calling out:
 *   1. The type enum is read live per classification call — this module
 *      exposes `listContextTypes` and the API constrains the model to it.
 *   2. Re-detection (`replaceTopics`) is a transactional replace-set keyed
 *      by `lower(label)`: surviving labels keep their row id, missing ones
 *      are deleted, new ones inserted. Stable ids matter for the UI pills.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../connection";
import {
  contextTypes,
  conversationTopics,
  conversationTopicState,
  messages,
  savedContexts,
  type ContextType,
  type ConversationTopic,
  type ConversationTopicState,
  type SavedContext,
} from "../schema";

// ── context_types (the DB enum) ────────────────────────────────────────

/** All classification types, ordered by `sort_order`. Fed live to the
 *  detection prompt + exposed by GET /api/context-types. */
export async function listContextTypes(): Promise<ContextType[]> {
  return (await getDb()
    .select()
    .from(contextTypes)
    .orderBy(contextTypes.sortOrder)) as ContextType[];
}

// ── conversation_topics ────────────────────────────────────────────────

/** Cached topics for a conversation, oldest-first (stable pill order). */
export async function getTopics(conversationId: string): Promise<ConversationTopic[]> {
  if (!conversationId) return [];
  return (await getDb()
    .select()
    .from(conversationTopics)
    .where(eq(conversationTopics.conversationId, conversationId))
    .orderBy(conversationTopics.createdAt)) as ConversationTopic[];
}

/** Fetch a single topic scoped to its conversation (extract-route lookup —
 *  the `conversationId` guard prevents cross-conversation id reuse). */
export async function getTopic(
  conversationId: string,
  topicId: string,
): Promise<ConversationTopic | undefined> {
  if (!conversationId || !topicId) return undefined;
  const rows = (await getDb()
    .select()
    .from(conversationTopics)
    .where(
      and(
        eq(conversationTopics.conversationId, conversationId),
        eq(conversationTopics.id, topicId),
      ),
    )
    .limit(1)) as ConversationTopic[];
  return rows[0];
}

export interface TopicInput {
  label: string;
  typeId: string;
  messageIds: string[];
}

/**
 * Transactional replace-set for a conversation's topics, keyed by
 * `lower(label)`:
 *   - a surviving label KEEPS its existing row id (stable pill id) and has
 *     its type/messageIds/label refreshed;
 *   - a label absent from `topics` is deleted;
 *   - a new label is inserted.
 *
 * Everything runs on the transaction handle `tx` — referencing the outer
 * `getDb()` inside would escape the transaction and break atomicity. The
 * `(conversation_id, lower(label))` unique index is the safety net; the
 * in-TS dedupe below (last-wins per lower-label) keeps a single detect pass
 * from tripping it.
 */
export async function replaceTopics(
  conversationId: string,
  topics: TopicInput[],
): Promise<ConversationTopic[]> {
  if (!conversationId) throw new Error("conversationId is required");

  // Dedupe incoming by lower(label) — last occurrence wins. Guards the
  // unique index against a detect pass that emitted the same label twice.
  const byLower = new Map<string, TopicInput>();
  for (const t of topics) {
    byLower.set(t.label.toLowerCase(), t);
  }

  return getDb().transaction(async (tx: any) => {
    const existing = (await tx
      .select()
      .from(conversationTopics)
      .where(eq(conversationTopics.conversationId, conversationId))) as ConversationTopic[];
    const existingByLower = new Map<string, ConversationTopic>();
    for (const row of existing) existingByLower.set(row.label.toLowerCase(), row);

    // Upsert each surviving/new label.
    for (const [lower, t] of byLower) {
      const prior = existingByLower.get(lower);
      if (prior) {
        await tx
          .update(conversationTopics)
          .set({
            label: t.label,
            typeId: t.typeId,
            messageIds: t.messageIds,
            updatedAt: new Date(),
          })
          .where(eq(conversationTopics.id, prior.id));
      } else {
        await tx.insert(conversationTopics).values({
          conversationId,
          label: t.label,
          typeId: t.typeId,
          messageIds: t.messageIds,
        });
      }
    }

    // Delete labels that are no longer present.
    for (const [lower, row] of existingByLower) {
      if (!byLower.has(lower)) {
        await tx.delete(conversationTopics).where(eq(conversationTopics.id, row.id));
      }
    }

    return (await tx
      .select()
      .from(conversationTopics)
      .where(eq(conversationTopics.conversationId, conversationId))
      .orderBy(conversationTopics.createdAt)) as ConversationTopic[];
  });
}

// ── conversation_topic_state (staleness watermark) ─────────────────────

export async function getTopicState(
  conversationId: string,
): Promise<ConversationTopicState | undefined> {
  if (!conversationId) return undefined;
  const rows = (await getDb()
    .select()
    .from(conversationTopicState)
    .where(eq(conversationTopicState.conversationId, conversationId))
    .limit(1)) as ConversationTopicState[];
  return rows[0];
}

export interface TopicStateInput {
  lastMessageId: string | null;
  messageCount: number;
  model: string | null;
}

/** Insert-or-update the watermark for a conversation (PK on
 *  conversation_id). `analyzedAt` is stamped NOW on every write. */
export async function upsertTopicState(
  conversationId: string,
  input: TopicStateInput,
): Promise<ConversationTopicState> {
  if (!conversationId) throw new Error("conversationId is required");
  const now = new Date();
  const rows = (await getDb()
    .insert(conversationTopicState)
    .values({
      conversationId,
      lastMessageId: input.lastMessageId,
      messageCount: input.messageCount,
      model: input.model,
      analyzedAt: now,
    })
    .onConflictDoUpdate({
      target: conversationTopicState.conversationId,
      set: {
        lastMessageId: input.lastMessageId,
        messageCount: input.messageCount,
        model: input.model,
        analyzedAt: now,
      },
    })
    .returning()) as ConversationTopicState[];
  return rows[0]!;
}

/**
 * Lightweight staleness inputs for a conversation: the total message count and
 * the id of the newest message (by `created_at`). The cache-only
 * `GET /api/conversations/[id]/topics` fires on every conversation switch and
 * only needs to compare a count + last-id against the watermark — it must NOT
 * pull every message row (with content + memories + attachments, as
 * `getMessages` does). This mirrors detect.ts's watermark math
 * (`messages.length` + the last message's id) with two indexed lookups.
 */
export async function getMessageWatermark(
  conversationId: string,
): Promise<{ count: number; lastMessageId: string | null }> {
  if (!conversationId) return { count: 0, lastMessageId: null };
  const db = getDb();
  const countRows = (await db
    .select({ count: sql<number>`count(*)` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))) as Array<{
    count: number | string;
  }>;
  const lastRows = (await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(1)) as Array<{ id: string }>;
  return {
    count: Number(countRows[0]?.count ?? 0),
    lastMessageId: lastRows[0]?.id ?? null,
  };
}

// ── saved_contexts (library) ───────────────────────────────────────────

export interface UpsertSavedContextInput {
  userId: string;
  projectId: string | null;
  conversationId: string;
  topicLabel: string;
  typeId: string;
  title: string;
  content: string;
  model: string | null;
  messageCount: number;
}

/**
 * Insert-or-update a library snapshot. Conflict target is the
 * `(user_id, conversation_id, topic_label)` unique index — a re-extract of
 * the same topic overwrites the prior snapshot (latest wins, no dup rows).
 * `createdAt` is preserved on update; `updatedAt` bumped to NOW.
 */
export async function upsertSavedContext(
  input: UpsertSavedContextInput,
): Promise<SavedContext> {
  if (!input.userId) throw new Error("userId is required");
  if (!input.conversationId) throw new Error("conversationId is required");
  const now = new Date();
  const rows = (await getDb()
    .insert(savedContexts)
    .values({
      userId: input.userId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      topicLabel: input.topicLabel,
      typeId: input.typeId,
      title: input.title,
      content: input.content,
      model: input.model,
      messageCount: input.messageCount,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [savedContexts.userId, savedContexts.conversationId, savedContexts.topicLabel],
      set: {
        typeId: input.typeId,
        projectId: input.projectId,
        title: input.title,
        content: input.content,
        model: input.model,
        messageCount: input.messageCount,
        updatedAt: now,
      },
    })
    .returning()) as SavedContext[];
  return rows[0]!;
}

/** Read a single saved context by id (owner check happens at the route,
 *  mirroring /api/memories/[id]). */
export async function getSavedContext(id: string): Promise<SavedContext | undefined> {
  if (!id) return undefined;
  const rows = (await getDb()
    .select()
    .from(savedContexts)
    .where(eq(savedContexts.id, id))
    .limit(1)) as SavedContext[];
  return rows[0];
}

/** Hard delete by id. Returns true when a row was removed. */
export async function deleteSavedContext(id: string): Promise<boolean> {
  if (!id) return false;
  const rows = await getDb()
    .delete(savedContexts)
    .where(eq(savedContexts.id, id))
    .returning({ id: savedContexts.id });
  return rows.length > 0;
}

export interface SearchContextsParams {
  /** Owner filter. Omit ONLY for an admin who wants the org-wide view. */
  userId?: string;
  projectId?: string;
  search?: string;
  typeId?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Library search: ILIKE over title + content, with optional user / project
 * / type filters. Returns the page plus the total matching count (for
 * pagination). `%` / `_` / `\` in the search term are escaped so they're
 * treated literally.
 */
export async function searchContexts(
  params: SearchContextsParams,
): Promise<{ contexts: SavedContext[]; total: number }> {
  const db = getDb();
  const conditions = [];
  if (params.userId) conditions.push(eq(savedContexts.userId, params.userId));
  if (params.projectId) conditions.push(eq(savedContexts.projectId, params.projectId));
  if (params.typeId) conditions.push(eq(savedContexts.typeId, params.typeId));

  const q = (params.search ?? "").trim();
  if (q.length > 0) {
    const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      sql`(${savedContexts.title} ILIKE ${pattern} OR ${savedContexts.content} ILIKE ${pattern})`,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const limit = Math.min(Math.max(1, params.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const offset = Math.max(0, params.offset ?? 0);

  const contexts = (await db
    .select()
    .from(savedContexts)
    .where(where)
    .orderBy(desc(savedContexts.createdAt))
    .limit(limit)
    .offset(offset)) as SavedContext[];

  const countRows = (await db
    .select({ count: sql<number>`count(*)` })
    .from(savedContexts)
    .where(where)) as Array<{ count: number | string }>;
  const total = Number(countRows[0]?.count ?? 0);

  return { contexts, total };
}
