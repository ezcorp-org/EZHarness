import { eq, sql, type SQL } from "drizzle-orm";
import { messageChunks, messageEmbedOutbox } from "../schema";

/**
 * Minimal structural handle accepted by {@link enqueueEmbedJob}. Both the
 * top-level drizzle db AND a `db.transaction((tx) => …)` callback's `tx`
 * satisfy this shape, which is the whole point: the caller MUST pass its own
 * handle so the upsert runs INSIDE the enclosing transaction.
 *
 * PITFALL (Phase 63 research Pitfall 1): this module must NEVER call
 * `getDb()` itself. Fetching a fresh handle here would open a SECOND
 * connection/statement outside the caller's transaction, silently breaking
 * the IDX-04 atomicity guarantee (the message insert could roll back while
 * the outbox enqueue had already committed on its own connection).
 */
export type EmbedJobTx = {
  insert: (table: typeof messageEmbedOutbox) => {
    values: (v: {
      messageId: string;
      conversationId: string;
      status: "pending";
      attempts: number;
    }) => {
      onConflictDoUpdate: (cfg: {
        target: typeof messageEmbedOutbox.messageId;
        set: { status: "pending"; attempts: number; updatedAt: ReturnType<typeof sql> };
      }) => Promise<unknown>;
    };
  };
};

/**
 * Enqueue (or re-enqueue) an embed job for a message via an upsert on the
 * `message_embed_outbox` table.
 *
 * `message_id` is the PRIMARY KEY (one row per message), so:
 *   - first call for a message inserts a fresh `pending` row (attempts=0);
 *   - any subsequent call for the SAME message id upserts, resetting
 *     status→`pending`, attempts→0, updated_at→NOW() WITHOUT creating a
 *     duplicate row. This is what makes a content edit re-enqueue cleanly.
 *
 * `tx` is REQUIRED and must be the caller's transaction handle (see
 * {@link EmbedJobTx}). Never default it to `getDb()`.
 */
export async function enqueueEmbedJob(
  tx: EmbedJobTx,
  messageId: string,
  conversationId: string,
): Promise<void> {
  await tx
    .insert(messageEmbedOutbox)
    .values({ messageId, conversationId, status: "pending", attempts: 0 })
    .onConflictDoUpdate({
      target: messageEmbedOutbox.messageId,
      set: { status: "pending", attempts: 0, updatedAt: sql`NOW()` },
    });
}

/**
 * Minimal structural handle accepted by {@link clearMessageEmbedState} — a
 * `.delete(table).where(cond)` chain. Same contract as {@link EmbedJobTx}:
 * the caller passes its own transaction handle so the deletes run INSIDE the
 * enclosing transaction (this module never calls `getDb()` itself).
 */
export type ClearEmbedTx = {
  delete: (table: typeof messageEmbedOutbox | typeof messageChunks) => {
    where: (cond: SQL<unknown> | undefined) => Promise<unknown>;
  };
};

/**
 * Drop a message's entire embed-index state — its outbox job AND any chunks
 * already written for it. Called when an edit turns a previously-eligible
 * message embed-INELIGIBLE (e.g. cleared to whitespace), so neither a pending
 * outbox row nor stale chunks survive pointing at content that is no longer
 * indexable. Idempotent: deleting absent rows is a harmless no-op, so it is
 * safe to call on every ineligible edit regardless of prior state.
 *
 * `tx` is REQUIRED and must be the caller's transaction handle — never default
 * it to `getDb()` (see {@link EmbedJobTx} for why).
 */
export async function clearMessageEmbedState(tx: ClearEmbedTx, messageId: string): Promise<void> {
  await tx.delete(messageEmbedOutbox).where(eq(messageEmbedOutbox.messageId, messageId));
  await tx.delete(messageChunks).where(eq(messageChunks.messageId, messageId));
}

// ── Phase 64 Plan 01: EmbedWorker drain helpers ────────────────────────────

/**
 * Minimal structural handle accepted by the four EmbedWorker drain helpers
 * (claimBatch, markDone, markFailed, resetAttemptsForPending).
 *
 * Mirrors the {@link EmbedJobTx} / {@link ClearEmbedTx} structural-typing
 * approach — accepts the drizzle db directly (not inside a transaction, since
 * the worker runs these at arm's length, not inside the caller's tx).
 *
 * PITFALL: this module must NEVER call getDb() itself. All helpers accept `db`
 * as their first parameter so callers control the connection.
 */
export type DrainDb = {
  execute: <T = Record<string, unknown>>(
    query: SQL<unknown>,
  ) => Promise<{ rows: T[] } | T[]>;
  delete: (table: typeof messageEmbedOutbox) => {
    where: (cond: SQL<unknown> | undefined) => Promise<unknown>;
  };
};

/**
 * Claim up to `batchSize` pending outbox rows and mark them `in_progress`
 * atomically.
 *
 * Uses a subquery UPDATE to avoid UPDATE...LIMIT (unsupported in PGlite).
 * Only rows with status='pending' AND (next_attempt_after IS NULL OR
 * next_attempt_after <= NOW()) are eligible. Rows are claimed in
 * created_at ASC order (FIFO).
 */
export async function claimBatch(
  db: DrainDb,
  batchSize: number,
): Promise<Array<{ messageId: string; conversationId: string; attempts: number }>> {
  const result = await db.execute<{
    message_id: string;
    conversation_id: string;
    attempts: number;
  }>(sql`
    UPDATE message_embed_outbox
    SET status = 'in_progress', updated_at = NOW()
    WHERE message_id IN (
      SELECT message_id FROM message_embed_outbox
      WHERE status = 'pending'
        AND (next_attempt_after IS NULL OR next_attempt_after <= NOW())
      ORDER BY created_at ASC
      LIMIT ${batchSize}
    )
    RETURNING message_id, conversation_id, attempts
  `);
  const rows = (result as { rows: { message_id: string; conversation_id: string; attempts: number }[] }).rows
    ?? (result as { message_id: string; conversation_id: string; attempts: number }[]);
  return rows.map((r) => ({
    messageId: r.message_id,
    conversationId: r.conversation_id,
    attempts: r.attempts,
  }));
}

/**
 * Remove a successfully-processed outbox row. There is no 'done' status in
 * the schema — clean rows simply exit the table.
 * Idempotent: deleting an absent row is a no-op.
 */
export async function markDone(db: DrainDb, messageId: string): Promise<void> {
  await db.delete(messageEmbedOutbox).where(eq(messageEmbedOutbox.messageId, messageId));
}

/**
 * Record a failed embed attempt.
 *
 * - If `nextAttemptAfter` is a Date (retry): sets status='pending' with the
 *   provided backoff timestamp so claimBatch won't re-claim until that time.
 * - If `nextAttemptAfter` is null (exhausted): sets status='failed' (terminal).
 *
 * Always writes `attempts = newAttempts` to the row.
 */
export async function markFailed(
  db: DrainDb,
  messageId: string,
  newAttempts: number,
  nextAttemptAfter: Date | null,
): Promise<void> {
  if (nextAttemptAfter === null) {
    // Exhausted — final failure state
    await db.execute(sql`
      UPDATE message_embed_outbox
      SET status = 'failed', attempts = ${newAttempts}, updated_at = NOW()
      WHERE message_id = ${messageId}
    `);
  } else {
    // Retry with backoff — back to pending with a future next_attempt_after
    await db.execute(sql`
      UPDATE message_embed_outbox
      SET status = 'pending', attempts = ${newAttempts},
          next_attempt_after = ${nextAttemptAfter.toISOString()},
          updated_at = NOW()
      WHERE message_id = ${messageId}
    `);
  }
}

/**
 * Degraded-mode recovery: reset attempts=0 and next_attempt_after=NULL on
 * all 'pending' rows, making them immediately eligible for claimBatch.
 *
 * Scoped to status='pending' ONLY — never touches in_progress rows, which
 * would corrupt a live worker tick.
 *
 * Returns the count of rows reset.
 */
export async function resetAttemptsForPending(db: DrainDb): Promise<number> {
  const result = await db.execute<{ message_id: string }>(sql`
    UPDATE message_embed_outbox
    SET attempts = 0, next_attempt_after = NULL, updated_at = NOW()
    WHERE status = 'pending'
    RETURNING message_id
  `);
  const rows = (result as { rows: { message_id: string }[] }).rows
    ?? (result as { message_id: string }[]);
  return rows.length;
}
