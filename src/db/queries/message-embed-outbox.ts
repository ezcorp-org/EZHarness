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
        set: {
          status: "pending";
          attempts: number;
          nextAttemptAfter: null;
          updatedAt: ReturnType<typeof sql>;
        };
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
 *     status→`pending`, attempts→0, next_attempt_after→NULL, updated_at→NOW()
 *     WITHOUT creating a duplicate row. Clearing `next_attempt_after` is
 *     load-bearing: a row that previously failed/backed-off carries a future
 *     backoff stamp, and `claimBatch` gates on it — re-enqueueing must wipe it
 *     so the freshly-edited content is claimable immediately. This is what
 *     makes a content edit re-enqueue cleanly.
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
      set: { status: "pending", attempts: 0, nextAttemptAfter: null, updatedAt: sql`NOW()` },
    });
}

/**
 * Minimal structural handle accepted by {@link enqueueEmbedJobIfAbsent}. The
 * DO-NOTHING parallel of {@link EmbedJobTx}: its `.values(...)` chain exposes
 * `onConflictDoNothing` (NOT `onConflictDoUpdate`). Both the top-level drizzle
 * db AND a `db.transaction((tx) => …)` callback's `tx` satisfy this shape.
 *
 * PITFALL (Phase 63 research Pitfall 1): like {@link EmbedJobTx}, this module
 * must NEVER call `getDb()` itself — the caller MUST pass its own handle.
 */
export type EmbedJobInsertTx = {
  insert: (table: typeof messageEmbedOutbox) => {
    values: (v: {
      messageId: string;
      conversationId: string;
      status: "pending";
      attempts: number;
    }) => {
      onConflictDoNothing: (cfg: {
        target: typeof messageEmbedOutbox.messageId;
      }) => Promise<unknown>;
    };
  };
};

/**
 * Gaps-only enqueue: insert a fresh `pending` row for `messageId` ONLY if no
 * row already exists. This is the {@link enqueueEmbedJob} sibling for backfill
 * (OPS-01) — they differ in EXACTLY one clause:
 *   - `enqueueEmbedJob`  → `onConflictDoUpdate` (resets a colliding row to
 *     pending/attempts=0/no-backoff — the on-edit re-enqueue path).
 *   - `enqueueEmbedJobIfAbsent` → `onConflictDoNothing` (a colliding row is
 *     left BYTE-FOR-BYTE unchanged).
 *
 * WHY a sibling, not a flag on enqueueEmbedJob (RESEARCH Pattern 2): a
 * gaps-only backfill must NEVER disturb a row that is already
 * pending / in_progress / failed / backed-off. Resetting an in-flight or a
 * deliberately-failed (attempts=3) row would re-process work the worker has
 * already classified — the whole point of "fill only the true gaps". A
 * boolean flag would couple the two intents in one body and risk the wrong
 * conflict clause firing; two small functions keep each intent unambiguous.
 * `--refresh-stale` (Plan 04) deliberately reuses the DO-UPDATE
 * {@link enqueueEmbedJob} for the stale subset only — so `enqueueEmbedJob`
 * itself MUST stay untouched.
 *
 * `tx` is REQUIRED and must be the caller's handle (see {@link EmbedJobInsertTx}).
 * Never default it to `getDb()`.
 */
export async function enqueueEmbedJobIfAbsent(
  tx: EmbedJobInsertTx,
  messageId: string,
  conversationId: string,
): Promise<void> {
  await tx
    .insert(messageEmbedOutbox)
    .values({ messageId, conversationId, status: "pending", attempts: 0 })
    .onConflictDoNothing({ target: messageEmbedOutbox.messageId });
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

// ── Phase 68 Plan 02: getEmbedProgress (OPS-04) ─────────────────────────────

/**
 * Embed-index progress snapshot — the single source of truth shared by the
 * backfill CLI's `--status` flag, the in-run progress line, and the admin
 * endpoint.
 *
 * - `backlog`  — outbox rows by status (pending awaiting a worker tick,
 *   in_progress claimed-this-tick, failed terminal); `total` is their sum.
 * - `coverage` — `eligibleMessages` is the count of messages that SHOULD have
 *   an embedding (user/assistant, non-test-conversation, non-whitespace);
 *   `embeddedMessages` is how many of those actually have ≥1 chunk row. The
 *   gap (`eligible - embedded`) is roughly the backfill's remaining work.
 */
export interface EmbedProgress {
  backlog: { pending: number; inProgress: number; failed: number; total: number };
  coverage: { eligibleMessages: number; embeddedMessages: number };
}

/**
 * Compute the embed-index {@link EmbedProgress} snapshot.
 *
 * Eligibility predicates are MIRRORED VERBATIM from message-search.ts (DRY —
 * never re-derived):
 *   - `(c.test IS NULL OR c.test = false)`   (message-search.ts:139/194)
 *   - `m.role IN ('user','assistant')`       (message-search.ts:195)
 *   - `length(trim(m.content)) > 0`          (mirrors isEmbedEligible, message-chunker.ts:20)
 *
 * `embeddedMessages` is `COUNT(DISTINCT mc.message_id)` over chunked messages
 * that ALSO satisfy eligibility — a 2-chunk message counts ONCE, and a chunk
 * pointing at a now-ineligible message never inflates coverage.
 *
 * `db` is the {@link DrainDb} handle (PGlite test db, Bun.sql, and drizzle all
 * satisfy it). Three small aggregates rather than one giant join: the backlog
 * GROUP BY is folded into the typed shape (missing statuses default to 0).
 */
export async function getEmbedProgress(db: DrainDb): Promise<EmbedProgress> {
  const backlogRes = await db.execute(sql`
    SELECT status, COUNT(*)::int AS count
    FROM message_embed_outbox
    GROUP BY status
  `);
  const backlogRows = ((backlogRes as { rows?: { status: string; count: number }[] }).rows
    ?? (backlogRes as { status: string; count: number }[]));

  const backlog = { pending: 0, inProgress: 0, failed: 0, total: 0 };
  for (const r of backlogRows) {
    const count = Number(r.count);
    if (r.status === "pending") backlog.pending = count;
    else if (r.status === "in_progress") backlog.inProgress = count;
    else if (r.status === "failed") backlog.failed = count;
    backlog.total += count;
  }

  const eligibleRes = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE (c.test IS NULL OR c.test = false)
      AND m.role IN ('user', 'assistant')
      AND length(trim(m.content)) > 0
  `);
  const eligibleRows = ((eligibleRes as { rows?: { count: number }[] }).rows
    ?? (eligibleRes as { count: number }[]));
  const eligibleMessages = Number(eligibleRows[0]?.count ?? 0);

  const embeddedRes = await db.execute(sql`
    SELECT COUNT(DISTINCT mc.message_id)::int AS count
    FROM message_chunks mc
    JOIN messages m ON m.id = mc.message_id
    JOIN conversations c ON c.id = m.conversation_id
    WHERE (c.test IS NULL OR c.test = false)
      AND m.role IN ('user', 'assistant')
      AND length(trim(m.content)) > 0
  `);
  const embeddedRows = ((embeddedRes as { rows?: { count: number }[] }).rows
    ?? (embeddedRes as { count: number }[]));
  const embeddedMessages = Number(embeddedRows[0]?.count ?? 0);

  return { backlog, coverage: { eligibleMessages, embeddedMessages } };
}

// ── Phase 68 Plan 04: backfill throttle env knobs (OPS-02) ──────────────────

/** Default backfill page size (rows enqueued per paced batch). */
const DEFAULT_BACKFILL_BATCH_SIZE = 100;
/** Floor on backfill batch size. */
const MIN_BACKFILL_BATCH_SIZE = 1;
/** Default sleep (ms) between paced backfill batches — yields traffic. */
const DEFAULT_BACKFILL_SLEEP_MS = 200;
/** Floor on backfill sleep (ms); 0 means "no pause". */
const MIN_BACKFILL_SLEEP_MS = 0;

/**
 * Resolve `EZCORP_BACKFILL_BATCH_SIZE` into a sane page size. Mirrors the
 * embed-worker `getEmbedBatchSize` idiom (embed-worker.ts:97-104) VERBATIM:
 * undefined/empty → default; non-finite/≤0 → default; floor + clamp to MIN.
 *
 * Co-located here (rather than in the backfill script) because the Plan-01
 * RED contract imports it from this module alongside `enqueueEmbedJobIfAbsent`
 * — keeping the env-parse idiom next to the outbox primitives it paces.
 */
export function getBackfillBatchSize(): number {
  const raw = process.env.EZCORP_BACKFILL_BATCH_SIZE;
  if (raw === undefined || raw === "") return DEFAULT_BACKFILL_BATCH_SIZE;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BACKFILL_BATCH_SIZE;
  return Math.max(MIN_BACKFILL_BATCH_SIZE, n);
}

/**
 * Resolve `EZCORP_BACKFILL_SLEEP_MS` into a sane inter-batch pause. Same
 * defensive contract as {@link getBackfillBatchSize}: undefined/empty →
 * default; non-finite/negative → default; floor + clamp to MIN (0 allowed).
 */
export function getBackfillSleepMs(): number {
  const raw = process.env.EZCORP_BACKFILL_SLEEP_MS;
  if (raw === undefined || raw === "") return DEFAULT_BACKFILL_SLEEP_MS;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return DEFAULT_BACKFILL_SLEEP_MS;
  return Math.max(MIN_BACKFILL_SLEEP_MS, n);
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
  execute: (
    query: SQL<unknown>,
  ) => Promise<{ rows: Record<string, unknown>[] } | Record<string, unknown>[]>;
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
  const result = await db.execute(sql`
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
    // Exhausted — final failure state. Clear next_attempt_after too so a
    // later re-enqueue (or manual requeue) of this terminal row never
    // inherits a stale backoff stamp from an earlier retry.
    await db.execute(sql`
      UPDATE message_embed_outbox
      SET status = 'failed', attempts = ${newAttempts},
          next_attempt_after = NULL, updated_at = NOW()
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
  const result = await db.execute(sql`
    UPDATE message_embed_outbox
    SET attempts = 0, next_attempt_after = NULL, updated_at = NOW()
    WHERE status = 'pending'
    RETURNING message_id
  `);
  const rows = (result as { rows: { message_id: string }[] }).rows
    ?? (result as { message_id: string }[]);
  return rows.length;
}
