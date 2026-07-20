/**
 * DB-audit fix for src/extensions/embed-worker.ts runBacklogRecovery
 * (memory-embed group).
 *
 * Boot recovery is now scoped to GENUINELY STALE in_progress rows (updated_at
 * older than the recovery window) instead of unconditionally re-pending ALL
 * in_progress rows. A live sibling instance (multi-host external Postgres)
 * refreshes its claims' updated_at, so its in-flight rows stay INSIDE the window
 * and must NOT be clobbered. start()'s retention sweep also purges aged terminal
 * failures.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mock.module("../memory/embeddings", () => ({
  isEmbeddingReady: () => false,
  generateEmbedding: async () => Array(384).fill(0.1),
  getTokenizer: async () => ({ encode: () => ({ length: 1 }), decode: () => "x" }),
  EMBEDDING_MODEL_ID: "Xenova/all-MiniLM-L6-v2@384",
  resetEmbeddingProvider: () => {},
  warmupEmbeddings: () => {},
}));
mock.module("../memory/message-chunker", () => ({
  isEmbedEligible: (role: string, content: string) =>
    ["user", "assistant"].includes(role) && content.trim().length > 0,
  chunkByTokens: (_t: unknown, text: string) => [text],
  CHUNK_TOKENS: 256,
  OVERLAP_TOKENS: 32,
  EMBED_ELIGIBLE_ROLES: new Set(["user", "assistant"]),
}));

mockDbConnection();

import { sql } from "drizzle-orm";
import { runBacklogRecovery, EmbedWorker, _embedWorkerInternals } from "../extensions/embed-worker";
import { purgeFailedRows } from "../db/queries/message-embed-outbox";

let seedCounter = 0;

async function seedOutbox(opts: {
  status: "pending" | "in_progress" | "failed";
  updatedAt: Date;
}): Promise<string> {
  seedCounter++;
  const db = getTestDb();
  const pid = `p-boot-${seedCounter}`;
  const cid = `c-boot-${seedCounter}`;
  const mid = `m-boot-${seedCounter}`;
  await db.execute(sql`INSERT INTO projects (id, name, path) VALUES (${pid}, 'p', ${`/tmp/${pid}`}) ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`INSERT INTO conversations (id, project_id, title) VALUES (${cid}, ${pid}, 'c') ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`INSERT INTO messages (id, conversation_id, role, content) VALUES (${mid}, ${cid}, 'user', 'x') ON CONFLICT (id) DO NOTHING`);
  await db.execute(sql`
    INSERT INTO message_embed_outbox (message_id, conversation_id, status, updated_at)
    VALUES (${mid}, ${cid}, ${opts.status}, ${opts.updatedAt.toISOString()})
    ON CONFLICT (message_id) DO NOTHING
  `);
  return mid;
}

async function statusOf(messageId: string): Promise<string | null> {
  const rows = await getTestDb().execute<{ status: string }>(sql`
    SELECT status FROM message_embed_outbox WHERE message_id = ${messageId}
  `);
  const r = (rows as any).rows ?? rows;
  return r[0]?.status ?? null;
}

const STALE = _embedWorkerInternals.DEFAULT_INPROGRESS_STALE_MS;

// Single file-level teardown: restoring module mocks inside a per-describe
// afterAll would tear down mockDbConnection before the NEXT describe runs, so
// start()'s internal getDb() would hit the real connection. Keep it once.
afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("runBacklogRecovery — stale-scoped in_progress reset", () => {
  beforeEach(async () => {
    await setupTestDb();
    seedCounter = 0;
  });

  test("re-pends a STALE in_progress row (crashed prior worker)", async () => {
    const stale = await seedOutbox({ status: "in_progress", updatedAt: new Date(Date.now() - STALE - 60_000) });
    const count = await runBacklogRecovery(getTestDb());
    expect(count).toBe(1);
    expect(await statusOf(stale)).toBe("pending");
  });

  test("does NOT re-pend a FRESH in_progress row (a live sibling's claim)", async () => {
    const fresh = await seedOutbox({ status: "in_progress", updatedAt: new Date() });
    const count = await runBacklogRecovery(getTestDb());
    expect(count).toBe(0);
    expect(await statusOf(fresh)).toBe("in_progress"); // untouched
  });

  test("resets stale but leaves fresh in the same sweep", async () => {
    const stale = await seedOutbox({ status: "in_progress", updatedAt: new Date(Date.now() - STALE - 60_000) });
    const fresh = await seedOutbox({ status: "in_progress", updatedAt: new Date() });
    const count = await runBacklogRecovery(getTestDb());
    expect(count).toBe(1);
    expect(await statusOf(stale)).toBe("pending");
    expect(await statusOf(fresh)).toBe("in_progress");
  });

  test("injected clock + custom window drive the cutoff", async () => {
    // A row 5 minutes old, window = 1 minute → stale under the injected now.
    const now = Date.now();
    const row = await seedOutbox({ status: "in_progress", updatedAt: new Date(now - 5 * 60_000) });
    const count = await runBacklogRecovery(getTestDb(), 60_000, () => now);
    expect(count).toBe(1);
    expect(await statusOf(row)).toBe("pending");
  });
});

describe("EmbedWorker.start — retention sweep purges aged terminal failures", () => {
  beforeEach(async () => {
    await setupTestDb();
    seedCounter = 0;
  });

  test("start() deletes 'failed' rows older than the retention window", async () => {
    const retention = _embedWorkerInternals.DEFAULT_FAILED_RETENTION_MS;
    const agedFailed = await seedOutbox({ status: "failed", updatedAt: new Date(Date.now() - retention - 24 * 60 * 60_000) });
    const freshFailed = await seedOutbox({ status: "failed", updatedAt: new Date() });

    const worker = new EmbedWorker({ skipLockfile: true, wakeIntervalMs: 60_000 });
    const ok = await worker.start();
    expect(ok).toBe(true);
    worker.stop();

    expect(await statusOf(agedFailed)).toBeNull(); // purged
    expect(await statusOf(freshFailed)).toBe("failed"); // kept
  });

  test("purgeFailedRows is a no-op when nothing is aged", async () => {
    await seedOutbox({ status: "failed", updatedAt: new Date() });
    const purged = await purgeFailedRows(getTestDb(), new Date(Date.now() - 7 * 24 * 60 * 60_000));
    expect(purged).toBe(0);
  });
});
