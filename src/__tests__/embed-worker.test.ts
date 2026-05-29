/**
 * Phase 64 Plan 02 — EmbedWorker lifecycle + ING-01..05 coverage.
 *
 * Mirrors host-maintenance-daemon.test.ts structure. Uses:
 *   - mockDbConnection() at module level (PGlite-backed test DB)
 *   - setupTestDb() / closeTestDb() from ./helpers/test-pglite
 *   - skipLockfile: true on all daemon instances
 *   - tickOnce() driven directly (no interval waits)
 *
 * Mocks:
 *   - ../memory/embeddings — controls isEmbeddingReady() + generateEmbedding()
 *   - ../memory/message-chunker — returns predictable single-chunk output
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  closeTestDb,
  mockDbConnection,
  setupTestDb,
} from "./helpers/test-pglite";

// ── Module-level mocks — must precede any import that touches these paths ──

let embeddingReady = false;
let generateEmbeddingImpl: (text: string) => Promise<number[]> = async (_text: string) =>
  Array(384).fill(0.1);

mock.module("../memory/embeddings", () => ({
  isEmbeddingReady: () => embeddingReady,
  generateEmbedding: async (text: string) => generateEmbeddingImpl(text),
  getTokenizer: async () => ({
    encode: (_text: string, _opts: unknown) => ({ length: 10, slice: (s: number, e: number) => ({ length: Math.min(e, 10) - s }), [Symbol.iterator]: function*() {} }),
    decode: (_ids: unknown, _opts: unknown) => "chunk text",
  }),
  EMBEDDING_MODEL_ID: "Xenova/all-MiniLM-L6-v2@384",
  resetEmbeddingProvider: () => {},
  warmupEmbeddings: () => {},
}));

mock.module("../memory/message-chunker", () => ({
  isEmbedEligible: (role: string, content: string) =>
    ["user", "assistant"].includes(role) && content.trim().length > 0,
  chunkByTokens: (_tok: unknown, text: string) => [text],
  CHUNK_TOKENS: 256,
  OVERLAP_TOKENS: 32,
  EMBED_ELIGIBLE_ROLES: new Set(["user", "assistant"]),
}));

mockDbConnection();

// ── Imports after mock declarations ──

import { sql } from "drizzle-orm";
import { EmbedWorker, runBacklogRecovery } from "../extensions/embed-worker";
import {
  enqueueEmbedJob,
} from "../db/queries/message-embed-outbox";
import { getDb } from "../db/connection";
import { conversations, messages, messageChunks, messageEmbedOutbox } from "../db/schema";

// ── Test DB setup ──

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  embeddingReady = false;
  generateEmbeddingImpl = async (_text: string) => Array(384).fill(0.1);
  // Wipe test footprint between cases
  const db = getDb();
  await db.execute(sql`DELETE FROM message_chunks`);
  await db.execute(sql`DELETE FROM message_embed_outbox`);
  await db.execute(sql`DELETE FROM messages`);
  await db.execute(sql`DELETE FROM conversations`);
});

afterEach(() => {
  delete process.env.EZCORP_DISABLE_EMBED_WORKER;
});

// ── Helpers ──

async function seedConversationAndMessage(opts: {
  role?: string;
  content?: string;
} = {}) {
  const db = getDb();
  // Need a project row first
  const projectId = `test-proj-${Math.random().toString(36).slice(2, 8)}`;
  await db.execute(sql`
    INSERT INTO projects (id, name, path) VALUES (${projectId}, 'Test Project', '/tmp/test')
    ON CONFLICT DO NOTHING
  `);
  const conversationId = `test-conv-${Math.random().toString(36).slice(2, 8)}`;
  const messageId = `test-msg-${Math.random().toString(36).slice(2, 8)}`;
  const role = opts.role ?? "user";
  const content = opts.content ?? "Hello, how are you?";

  await db.insert(conversations).values({
    id: conversationId,
    projectId,
    title: "Test conversation",
  });
  await db.insert(messages).values({
    id: messageId,
    conversationId,
    role,
    content,
  });
  return { conversationId, messageId, role, content };
}

// ── ING-01: Drain works ───────────────────────────────────────────────

describe("EmbedWorker — ING-01: drain works", () => {
  test("tickOnce() embeds a pending message and removes it from the outbox", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();

    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = true;

    const worker = new EmbedWorker({ skipLockfile: true, wakeIntervalMs: 50 });
    const outcome = await worker.tickOnce();

    expect(outcome.claimed).toBe(1);
    expect(outcome.embedded).toBe(1);
    expect(outcome.failed).toBe(0);
    expect(outcome.skipped).toBe(0);

    // message_chunks should have 1 row for the message
    const chunks = await db
      .select()
      .from(messageChunks)
      .where(sql`message_id = ${messageId}`);
    expect(chunks).toHaveLength(1);

    // outbox row should be deleted (markDone)
    const outboxRows = await db
      .select()
      .from(messageEmbedOutbox)
      .where(sql`message_id = ${messageId}`);
    expect(outboxRows).toHaveLength(0);
  });

  test("tickOnce() skips ineligible messages (marks done, no chunk written)", async () => {
    const db = getDb();
    // system role is not embed-eligible
    const { conversationId, messageId } = await seedConversationAndMessage({ role: "system", content: "system prompt" });
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = true;

    const worker = new EmbedWorker({ skipLockfile: true });
    const outcome = await worker.tickOnce();

    expect(outcome.claimed).toBe(1);
    expect(outcome.embedded).toBe(0);
    // markDone removes the outbox row
    const outboxRows = await db
      .select()
      .from(messageEmbedOutbox)
      .where(sql`message_id = ${messageId}`);
    expect(outboxRows).toHaveLength(0);
  });
});

// ── ING-02: Degraded mode ─────────────────────────────────────────────

describe("EmbedWorker — ING-02: degraded mode", () => {
  test("when isEmbeddingReady()=false, tickOnce() returns skipped and leaves outbox intact", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = false;

    const worker = new EmbedWorker({ skipLockfile: true });
    const outcome = await worker.tickOnce();

    expect(outcome.claimed).toBe(0);
    expect(outcome.embedded).toBe(0);
    expect(outcome.failed).toBe(0);

    // outbox row still pending
    const outboxRows = await db
      .select()
      .from(messageEmbedOutbox)
      .where(sql`message_id = ${messageId}`);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.status).toBe("pending");
  });

  test("after degraded mode, first ready tick resumes and drains", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = false;

    const worker = new EmbedWorker({ skipLockfile: true });
    // First tick — degraded, nothing drained
    await worker.tickOnce();

    // Now ready — first ready tick should resume + drain
    embeddingReady = true;
    const outcome = await worker.tickOnce();

    expect(outcome.embedded).toBe(1);

    // outbox cleared
    const outboxRows = await db
      .select()
      .from(messageEmbedOutbox)
      .where(sql`message_id = ${messageId}`);
    expect(outboxRows).toHaveLength(0);
  });
});

// ── ING-03: Retry + exhaustion ────────────────────────────────────────

describe("EmbedWorker — ING-03: retry + exhaustion", () => {
  test("embed failure increments attempts and keeps row pending with backoff", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = true;

    generateEmbeddingImpl = async (_text: string) => {
      throw new Error("embed fail");
    };

    const worker = new EmbedWorker({ skipLockfile: true, maxAttempts: 3 });
    const outcome = await worker.tickOnce();

    expect(outcome.failed).toBe(1);
    expect(outcome.embedded).toBe(0);

    // Row stays in outbox with attempts=1, status=pending, next_attempt_after set
    const outboxRows = await db
      .select()
      .from(messageEmbedOutbox)
      .where(sql`message_id = ${messageId}`);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.attempts).toBe(1);
    expect(outboxRows[0]!.status).toBe("pending");
  });

  test("after maxAttempts failures, row is marked status=failed and left in outbox", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = true;

    generateEmbeddingImpl = async (_text: string) => {
      throw new Error("embed fail");
    };

    const worker = new EmbedWorker({ skipLockfile: true, maxAttempts: 3 });

    // Attempt 1: attempts=1, status=pending
    await worker.tickOnce();

    // For subsequent attempts we need to move time forward so next_attempt_after passes
    // Directly reset next_attempt_after to allow re-claim
    await db.execute(sql`
      UPDATE message_embed_outbox
      SET next_attempt_after = NOW() - INTERVAL '1 second'
      WHERE message_id = ${messageId} AND status = 'pending'
    `);

    // Attempt 2: attempts=2, status=pending
    await worker.tickOnce();

    await db.execute(sql`
      UPDATE message_embed_outbox
      SET next_attempt_after = NOW() - INTERVAL '1 second'
      WHERE message_id = ${messageId} AND status = 'pending'
    `);

    // Attempt 3: attempts=3, status=failed (exhausted)
    await worker.tickOnce();

    const outboxRows = await db
      .select()
      .from(messageEmbedOutbox)
      .where(sql`message_id = ${messageId}`);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]!.attempts).toBe(3);
    expect(outboxRows[0]!.status).toBe("failed");
  });
});

// ── ING-04: Boot recovery ─────────────────────────────────────────────

describe("EmbedWorker — ING-04: boot recovery", () => {
  test("runBacklogRecovery resets in_progress rows to pending", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);

    // Simulate crashed prior worker: set status to in_progress
    await db.execute(sql`
      UPDATE message_embed_outbox SET status = 'in_progress' WHERE message_id = ${messageId}
    `);

    // Verify it's in_progress before recovery
    const beforeRows = await db
      .select()
      .from(messageEmbedOutbox)
      .where(sql`message_id = ${messageId}`);
    expect(beforeRows[0]!.status).toBe("in_progress");

    // Call standalone runBacklogRecovery
    const count = await runBacklogRecovery(db);
    expect(count).toBe(1);

    // Now should be pending
    const afterRows = await db
      .select()
      .from(messageEmbedOutbox)
      .where(sql`message_id = ${messageId}`);
    expect(afterRows[0]!.status).toBe("pending");
  });

  test("start() calls runBacklogRecovery before arming interval", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);

    // Simulate crashed worker
    await db.execute(sql`
      UPDATE message_embed_outbox SET status = 'in_progress' WHERE message_id = ${messageId}
    `);

    embeddingReady = true;
    const worker = new EmbedWorker({ skipLockfile: true, wakeIntervalMs: 60_000 });
    const ok = await worker.start();
    expect(ok).toBe(true);

    // After start(), the in_progress row should be reset to pending
    const rows = await db
      .select()
      .from(messageEmbedOutbox)
      .where(sql`message_id = ${messageId}`);
    expect(rows[0]!.status).toBe("pending");

    worker.stop();
  });
});

// ── ING-05: Kill switch ───────────────────────────────────────────────

describe("EmbedWorker — ING-05: kill switch", () => {
  test("EZCORP_DISABLE_EMBED_WORKER=1 → start() returns false without lockfile", async () => {
    process.env.EZCORP_DISABLE_EMBED_WORKER = "1";
    const ok = await new EmbedWorker({ skipLockfile: true }).start();
    expect(ok).toBe(false);
  });

  test("start() is idempotent — second call returns true without rearming", async () => {
    const worker = new EmbedWorker({ skipLockfile: true, wakeIntervalMs: 60_000 });
    const first = await worker.start();
    const second = await worker.start();
    expect(first).toBe(true);
    expect(second).toBe(true);
    worker.stop();
  });

  test("stop() is idempotent — calling twice does not throw", async () => {
    const worker = new EmbedWorker({ skipLockfile: true, wakeIntervalMs: 60_000 });
    await worker.start();
    worker.stop();
    expect(() => worker.stop()).not.toThrow();
  });
});
