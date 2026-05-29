/**
 * Phase 64 Plan 01 — Task 2: outbox drain helpers.
 *
 * Covers:
 *   - claimBatch(db, N): returns up to N rows with status='pending' AND
 *     (next_attempt_after IS NULL OR next_attempt_after <= NOW()), marks
 *     them in_progress atomically. Uses subquery UPDATE (no UPDATE...LIMIT).
 *   - markDone(db, messageId): DELETEs the outbox row (no 'done' status).
 *   - markFailed(db, messageId, newAttempts, nextAttemptAfter):
 *     - if nextAttemptAfter is not null → status='pending' with backoff timestamp
 *     - if nextAttemptAfter is null (exhausted) → status='failed'
 *     - always sets attempts=newAttempts
 *   - resetAttemptsForPending(db): resets attempts=0 AND next_attempt_after=NULL
 *     WHERE status='pending' only (NOT 'in_progress'). Returns count of rows reset.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { claimBatch, markDone, markFailed, resetAttemptsForPending } = await import(
  "../db/queries/message-embed-outbox"
);

// ── Seed helpers ─────────────────────────────────────────────────────────────

let seedCounter = 0;

async function seedOutboxRow(opts?: {
  status?: "pending" | "in_progress" | "failed";
  attempts?: number;
  nextAttemptAfter?: Date | null;
}): Promise<{ messageId: string; conversationId: string }> {
  seedCounter++;
  const db = getTestDb();
  const pid = `p-drain-${seedCounter}`;
  const cid = `c-drain-${seedCounter}`;
  const mid = `m-drain-${seedCounter}`;

  await db.execute(sql`
    INSERT INTO projects (id, name, path) VALUES (${pid}, 'p', ${`/tmp/${pid}`})
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO conversations (id, project_id, title) VALUES (${cid}, ${pid}, 'c')
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO messages (id, conversation_id, role, content)
    VALUES (${mid}, ${cid}, 'system', 'x')
    ON CONFLICT (id) DO NOTHING
  `);

  const status = opts?.status ?? "pending";
  const attempts = opts?.attempts ?? 0;

  if (opts?.nextAttemptAfter !== undefined && opts.nextAttemptAfter !== null) {
    await db.execute(sql`
      INSERT INTO message_embed_outbox (message_id, conversation_id, status, attempts, next_attempt_after)
      VALUES (${mid}, ${cid}, ${status}, ${attempts}, ${opts.nextAttemptAfter.toISOString()})
      ON CONFLICT (message_id) DO NOTHING
    `);
  } else {
    await db.execute(sql`
      INSERT INTO message_embed_outbox (message_id, conversation_id, status, attempts)
      VALUES (${mid}, ${cid}, ${status}, ${attempts})
      ON CONFLICT (message_id) DO NOTHING
    `);
  }

  return { messageId: mid, conversationId: cid };
}

async function getOutboxRow(messageId: string) {
  const db = getTestDb();
  const rows = await db.execute<{
    message_id: string;
    status: string;
    attempts: number;
    next_attempt_after: string | null;
  }>(sql`
    SELECT message_id, status, attempts, next_attempt_after
    FROM message_embed_outbox
    WHERE message_id = ${messageId}
  `);
  const r = (rows as any).rows ?? rows;
  return r[0] ?? null;
}

async function countOutboxRows() {
  const db = getTestDb();
  const rows = await db.execute<{ count: string }>(sql`
    SELECT count(*) AS count FROM message_embed_outbox
  `);
  const r = (rows as any).rows ?? rows;
  return parseInt(r[0]!.count, 10);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("outbox drain helpers", () => {
  beforeEach(async () => {
    await setupTestDb();
    seedCounter = 0;
  });
  afterAll(async () => {
    await closeTestDb();
  });

  // ── claimBatch ─────────────────────────────────────────────────────────────

  describe("claimBatch", () => {
    test("claims pending rows with no next_attempt_after and marks them in_progress", async () => {
      const { messageId, conversationId } = await seedOutboxRow({ status: "pending" });
      const db = getTestDb();

      const claimed = await claimBatch(db, 10);

      expect(claimed.length).toBe(1);
      expect(claimed[0]!.messageId).toBe(messageId);
      expect(claimed[0]!.conversationId).toBe(conversationId);
      expect(claimed[0]!.attempts).toBe(0);

      // Row should now be in_progress
      const row = await getOutboxRow(messageId);
      expect(row!.status).toBe("in_progress");
    });

    test("respects batchSize limit — claims at most N rows", async () => {
      await seedOutboxRow({ status: "pending" });
      await seedOutboxRow({ status: "pending" });
      await seedOutboxRow({ status: "pending" });
      const db = getTestDb();

      const claimed = await claimBatch(db, 2);

      expect(claimed.length).toBe(2);
      // Exactly 1 row still pending
      const remaining = await db.execute<{ status: string }>(sql`
        SELECT status FROM message_embed_outbox WHERE status = 'pending'
      `);
      const r = (remaining as any).rows ?? remaining;
      expect(r.length).toBe(1);
    });

    test("does NOT claim rows with next_attempt_after in the future", async () => {
      const futureDate = new Date(Date.now() + 60_000); // 1 minute from now
      await seedOutboxRow({ status: "pending", nextAttemptAfter: futureDate });
      const db = getTestDb();

      const claimed = await claimBatch(db, 10);

      expect(claimed.length).toBe(0);
    });

    test("claims rows with next_attempt_after in the past", async () => {
      const pastDate = new Date(Date.now() - 60_000); // 1 minute ago
      const { messageId } = await seedOutboxRow({ status: "pending", nextAttemptAfter: pastDate });
      const db = getTestDb();

      const claimed = await claimBatch(db, 10);

      expect(claimed.length).toBe(1);
      expect(claimed[0]!.messageId).toBe(messageId);
    });

    test("does NOT claim rows with status='in_progress'", async () => {
      await seedOutboxRow({ status: "in_progress" });
      const db = getTestDb();

      const claimed = await claimBatch(db, 10);
      expect(claimed.length).toBe(0);
    });

    test("does NOT claim rows with status='failed'", async () => {
      await seedOutboxRow({ status: "failed" });
      const db = getTestDb();

      const claimed = await claimBatch(db, 10);
      expect(claimed.length).toBe(0);
    });

    test("returns empty array when no eligible rows exist", async () => {
      const db = getTestDb();
      const claimed = await claimBatch(db, 10);
      expect(claimed.length).toBe(0);
    });

    test("returned rows include attempts field", async () => {
      await seedOutboxRow({ status: "pending", attempts: 2 });
      const db = getTestDb();

      const claimed = await claimBatch(db, 10);
      expect(claimed.length).toBe(1);
      expect(claimed[0]!.attempts).toBe(2);
    });
  });

  // ── markDone ───────────────────────────────────────────────────────────────

  describe("markDone", () => {
    test("removes the outbox row entirely (no 'done' status)", async () => {
      const { messageId } = await seedOutboxRow({ status: "in_progress" });
      const db = getTestDb();

      await markDone(db, messageId);

      const row = await getOutboxRow(messageId);
      expect(row).toBeNull();
    });

    test("is idempotent — calling on an already-deleted row does not throw", async () => {
      const { messageId } = await seedOutboxRow({ status: "in_progress" });
      const db = getTestDb();

      await markDone(db, messageId);
      await expect(markDone(db, messageId)).resolves.toBeUndefined();
      expect(await countOutboxRows()).toBe(0);
    });
  });

  // ── markFailed ─────────────────────────────────────────────────────────────

  describe("markFailed", () => {
    test("with nextAttemptAfter = null → sets status='failed' and increments attempts", async () => {
      const { messageId } = await seedOutboxRow({ status: "in_progress", attempts: 2 });
      const db = getTestDb();

      await markFailed(db, messageId, 3, null);

      const row = await getOutboxRow(messageId);
      expect(row!.status).toBe("failed");
      expect(row!.attempts).toBe(3);
      expect(row!.next_attempt_after).toBeNull();
    });

    test("with nextAttemptAfter set → sets status='pending' with backoff timestamp", async () => {
      const { messageId } = await seedOutboxRow({ status: "in_progress", attempts: 1 });
      const db = getTestDb();
      const backoffDate = new Date(Date.now() + 30_000);

      await markFailed(db, messageId, 2, backoffDate);

      const row = await getOutboxRow(messageId);
      expect(row!.status).toBe("pending");
      expect(row!.attempts).toBe(2);
      // next_attempt_after should be set (not null), and close to backoffDate
      expect(row!.next_attempt_after).not.toBeNull();
    });

    test("backoff row is NOT claimed by claimBatch (next_attempt_after is future)", async () => {
      const { messageId } = await seedOutboxRow({ status: "in_progress", attempts: 0 });
      const db = getTestDb();
      const futureBackoff = new Date(Date.now() + 60_000);

      await markFailed(db, messageId, 1, futureBackoff);

      const claimed = await claimBatch(db, 10);
      expect(claimed.length).toBe(0);
    });
  });

  // ── resetAttemptsForPending ────────────────────────────────────────────────

  describe("resetAttemptsForPending", () => {
    test("resets attempts=0 and next_attempt_after=NULL for all pending rows", async () => {
      const { messageId: mid1 } = await seedOutboxRow({
        status: "pending",
        attempts: 3,
        nextAttemptAfter: new Date(Date.now() + 60_000),
      });
      const { messageId: mid2 } = await seedOutboxRow({
        status: "pending",
        attempts: 1,
        nextAttemptAfter: new Date(Date.now() + 30_000),
      });
      const db = getTestDb();

      const count = await resetAttemptsForPending(db);
      expect(count).toBe(2);

      const r1 = await getOutboxRow(mid1);
      const r2 = await getOutboxRow(mid2);
      expect(r1!.attempts).toBe(0);
      expect(r1!.next_attempt_after).toBeNull();
      expect(r2!.attempts).toBe(0);
      expect(r2!.next_attempt_after).toBeNull();
    });

    test("does NOT touch in_progress rows (no reset on live jobs)", async () => {
      await seedOutboxRow({ status: "pending", attempts: 2 });
      const { messageId: inProgressId } = await seedOutboxRow({
        status: "in_progress",
        attempts: 5,
      });
      const db = getTestDb();

      const count = await resetAttemptsForPending(db);
      expect(count).toBe(1); // only the pending row

      const row = await getOutboxRow(inProgressId);
      expect(row!.attempts).toBe(5); // unchanged
    });

    test("returns 0 when no pending rows exist", async () => {
      await seedOutboxRow({ status: "in_progress", attempts: 1 });
      const db = getTestDb();

      const count = await resetAttemptsForPending(db);
      expect(count).toBe(0);
    });

    test("returns 0 when outbox is empty", async () => {
      const db = getTestDb();
      const count = await resetAttemptsForPending(db);
      expect(count).toBe(0);
    });
  });
});
