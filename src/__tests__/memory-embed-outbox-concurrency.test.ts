/**
 * DB-audit fixes for src/db/queries/message-embed-outbox.ts (memory-embed group).
 *
 * Covers:
 *   - markDone / markFailed are CONDITIONAL on the claim still holding
 *     (status='in_progress'). If a content edit re-enqueued the row to 'pending'
 *     while the worker was embedding the OLD content, the terminal write must be
 *     a NO-OP so the freshly-pending job survives (lost-update / permanently-
 *     stale-index fix).
 *   - claimBatch (now FOR UPDATE SKIP LOCKED + an outer status recheck) still
 *     claims only genuinely-pending rows and never double-claims.
 *   - purgeFailedRows deletes only terminal 'failed' rows older than the cutoff.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { claimBatch, markDone, markFailed, purgeFailedRows } =
  await import("../db/queries/message-embed-outbox");

let seedCounter = 0;

async function seedOutboxRow(opts?: {
  status?: "pending" | "in_progress" | "failed";
  attempts?: number;
  updatedAt?: Date;
}): Promise<{ messageId: string; conversationId: string }> {
  seedCounter++;
  const db = getTestDb();
  const pid = `p-conc-${seedCounter}`;
  const cid = `c-conc-${seedCounter}`;
  const mid = `m-conc-${seedCounter}`;
  await db.execute(sql`INSERT INTO projects (id, name, path) VALUES (${pid}, 'p', ${`/tmp/${pid}`}) ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`INSERT INTO conversations (id, project_id, title) VALUES (${cid}, ${pid}, 'c') ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`INSERT INTO messages (id, conversation_id, role, content) VALUES (${mid}, ${cid}, 'user', 'x') ON CONFLICT (id) DO NOTHING`);
  const status = opts?.status ?? "pending";
  const attempts = opts?.attempts ?? 0;
  const updatedAt = opts?.updatedAt ? opts.updatedAt.toISOString() : new Date().toISOString();
  await db.execute(sql`
    INSERT INTO message_embed_outbox (message_id, conversation_id, status, attempts, updated_at)
    VALUES (${mid}, ${cid}, ${status}, ${attempts}, ${updatedAt})
    ON CONFLICT (message_id) DO NOTHING
  `);
  return { messageId: mid, conversationId: cid };
}

async function getRow(messageId: string) {
  const rows = await getTestDb().execute<{ status: string; attempts: number; next_attempt_after: string | null }>(sql`
    SELECT status, attempts, next_attempt_after FROM message_embed_outbox WHERE message_id = ${messageId}
  `);
  const r = (rows as any).rows ?? rows;
  return r[0] ?? null;
}

/** Simulate an on-edit re-enqueue landing while the worker holds the claim. */
async function reEnqueueToPending(messageId: string) {
  await getTestDb().execute(sql`
    UPDATE message_embed_outbox
    SET status = 'pending', attempts = 0, next_attempt_after = NULL, updated_at = NOW()
    WHERE message_id = ${messageId}
  `);
}

describe("markDone — lost-update guard (conditional on the claim)", () => {
  beforeEach(async () => {
    await setupTestDb();
    seedCounter = 0;
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("deletes a still-claimed (in_progress) row", async () => {
    const { messageId } = await seedOutboxRow({ status: "in_progress" });
    await markDone(getTestDb(), messageId);
    expect(await getRow(messageId)).toBeNull();
  });

  test("does NOT delete a row a concurrent edit re-pended — the fresh job survives", async () => {
    const { messageId } = await seedOutboxRow({ status: "in_progress" });
    // Edit re-enqueues to pending WHILE the worker was embedding old content.
    await reEnqueueToPending(messageId);
    // Worker finishes old content and calls markDone — must be a no-op now.
    await markDone(getTestDb(), messageId);
    const row = await getRow(messageId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("pending");
    // And it is still claimable on the next tick.
    const claimed = await claimBatch(getTestDb(), 10);
    expect(claimed.map((c) => c.messageId)).toContain(messageId);
  });
});

describe("markFailed — lost-update guard (conditional on the claim)", () => {
  beforeEach(async () => {
    await setupTestDb();
    seedCounter = 0;
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("stamps failure on a still-claimed row", async () => {
    const { messageId } = await seedOutboxRow({ status: "in_progress", attempts: 2 });
    await markFailed(getTestDb(), messageId, 3, null);
    expect((await getRow(messageId))!.status).toBe("failed");
  });

  test("does NOT stamp a stale failure onto a re-pended row", async () => {
    const { messageId } = await seedOutboxRow({ status: "in_progress", attempts: 2 });
    await reEnqueueToPending(messageId);
    // A stale terminal failure from the old attempt must NOT clobber the reset.
    await markFailed(getTestDb(), messageId, 3, null);
    const row = await getRow(messageId);
    expect(row!.status).toBe("pending"); // still pending, not 'failed'
    expect(row!.attempts).toBe(0); // reset preserved
  });

  test("does NOT stamp backoff onto a re-pended row", async () => {
    const { messageId } = await seedOutboxRow({ status: "in_progress", attempts: 0 });
    await reEnqueueToPending(messageId);
    await markFailed(getTestDb(), messageId, 1, new Date(Date.now() + 60_000));
    const row = await getRow(messageId);
    expect(row!.next_attempt_after).toBeNull(); // no stale backoff stamp
    expect(row!.attempts).toBe(0);
  });
});

describe("claimBatch — SKIP LOCKED restructure still claims correctly", () => {
  beforeEach(async () => {
    await setupTestDb();
    seedCounter = 0;
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("claims only pending rows, never double-claims across two passes", async () => {
    await seedOutboxRow({ status: "pending" });
    await seedOutboxRow({ status: "pending" });
    await seedOutboxRow({ status: "in_progress" }); // already claimed — ineligible

    const first = await claimBatch(getTestDb(), 10);
    expect(first.length).toBe(2); // only the two pending rows
    // A second pass finds nothing (all now in_progress) — no re-claim.
    const second = await claimBatch(getTestDb(), 10);
    expect(second.length).toBe(0);
    // No message id appears in both claims.
    const ids = new Set(first.map((r) => r.messageId));
    expect(second.every((r) => !ids.has(r.messageId))).toBe(true);
  });
});

describe("purgeFailedRows — bounded terminal-failure retention", () => {
  beforeEach(async () => {
    await setupTestDb();
    seedCounter = 0;
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("deletes aged 'failed' rows and keeps recent failures, pending, and in_progress", async () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60_000); // 10 days ago
    const { messageId: agedFailed } = await seedOutboxRow({ status: "failed", updatedAt: old });
    const { messageId: freshFailed } = await seedOutboxRow({ status: "failed" }); // updated now
    const { messageId: pending } = await seedOutboxRow({ status: "pending", updatedAt: old });
    const { messageId: inProgress } = await seedOutboxRow({ status: "in_progress", updatedAt: old });

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000); // 7-day retention
    const purged = await purgeFailedRows(getTestDb(), cutoff);
    expect(purged).toBe(1);

    expect(await getRow(agedFailed)).toBeNull(); // gone
    expect((await getRow(freshFailed))!.status).toBe("failed"); // kept (too recent)
    expect((await getRow(pending))!.status).toBe("pending"); // never touched
    expect((await getRow(inProgress))!.status).toBe("in_progress"); // never touched
  });
});
