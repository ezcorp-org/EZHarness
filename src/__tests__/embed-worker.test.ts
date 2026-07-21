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

import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { sql } from "drizzle-orm";
import {
  EmbedWorker,
  runBacklogRecovery,
  _embedWorkerInternals,
} from "../extensions/embed-worker";
import { readProcStartTime } from "../startup/process-lockfile";
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

// ── OPS-03: post-backlog-clear ANALYZE ─────────────────────────────────
//
// PGlite has no autovacuum, so after a big backfill drains, the HNSW/FTS
// planner stats on message_chunks go stale. tickOnce() runs
// `ANALYZE message_chunks` exactly once after a NON-EMPTY drain that clears
// the claimable-pending backlog to zero — never on an empty tick, a
// partial-drain tick that leaves claimable rows, or a degraded tick.
//
// Detection: wrap the live db.execute and serialize each call's drizzle
// queryChunks into a flat string, then look for the literal
// `ANALYZE message_chunks`. This matches the harness's "real db, observe
// the SQL it issues" style rather than introducing a new mocking layer.

/** Flatten a drizzle SQL object's static query chunks into a string. */
function sqlChunkText(arg: unknown): string {
  const chunks = (arg as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return typeof arg === "string" ? arg : "";
  let out = "";
  for (const chunk of chunks) {
    const value = (chunk as { value?: unknown })?.value;
    if (Array.isArray(value)) out += value.join(" ");
    else if (typeof value === "string") out += value;
  }
  return out;
}

/**
 * Install a spy on the live test db's `execute`, recording every issued
 * statement's flattened SQL text. Returns the recorder + an uninstaller.
 * The spy delegates to the real implementation so the drain still runs.
 */
function spyOnDbExecute() {
  const db = getDb() as unknown as { execute: (arg: unknown) => Promise<unknown> };
  const original = db.execute.bind(db);
  const statements: string[] = [];
  db.execute = (arg: unknown) => {
    statements.push(sqlChunkText(arg));
    return original(arg);
  };
  return {
    statements,
    analyzeCount: () =>
      statements.filter((s) => /ANALYZE\s+message_chunks/i.test(s)).length,
    restore: () => {
      db.execute = original as typeof db.execute;
    },
  };
}

describe("EmbedWorker — OPS-03: ANALYZE after backlog-clearing drain", () => {
  test("a tick that clears the last pending job runs ANALYZE message_chunks once", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = true;

    const spy = spyOnDbExecute();
    try {
      const worker = new EmbedWorker({ skipLockfile: true });
      const outcome = await worker.tickOnce();
      expect(outcome.embedded).toBe(1);
      // Backlog is now empty — ANALYZE fires exactly once.
      expect(spy.analyzeCount()).toBe(1);
    } finally {
      spy.restore();
    }
  });

  test("an empty tick (nothing claimed) does NOT run ANALYZE", async () => {
    // No outbox rows seeded — claimBatch returns 0.
    embeddingReady = true;

    const spy = spyOnDbExecute();
    try {
      const worker = new EmbedWorker({ skipLockfile: true });
      const outcome = await worker.tickOnce();
      expect(outcome.claimed).toBe(0);
      expect(spy.analyzeCount()).toBe(0);
    } finally {
      spy.restore();
    }
  });

  test("a partial drain that leaves claimable rows does NOT run ANALYZE; the later clearing tick does", async () => {
    const db = getDb();
    // Two pending jobs, batchSize 1 → first tick drains one, leaves one.
    const a = await seedConversationAndMessage();
    const b = await seedConversationAndMessage();
    await enqueueEmbedJob(db, a.messageId, a.conversationId);
    await enqueueEmbedJob(db, b.messageId, b.conversationId);
    embeddingReady = true;

    const worker = new EmbedWorker({ skipLockfile: true, batchSize: 1 });

    // Tick 1: drains one, one claimable row remains → NO ANALYZE.
    const spy1 = spyOnDbExecute();
    try {
      const out1 = await worker.tickOnce();
      expect(out1.embedded).toBe(1);
      expect(spy1.analyzeCount()).toBe(0);
    } finally {
      spy1.restore();
    }

    // Tick 2: drains the remainder, backlog now empty → ANALYZE fires once.
    const spy2 = spyOnDbExecute();
    try {
      const out2 = await worker.tickOnce();
      expect(out2.embedded).toBe(1);
      expect(spy2.analyzeCount()).toBe(1);
    } finally {
      spy2.restore();
    }
  });

  test("a degraded tick (embedder not ready) does NOT run ANALYZE", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = false;

    const spy = spyOnDbExecute();
    try {
      const worker = new EmbedWorker({ skipLockfile: true });
      const outcome = await worker.tickOnce();
      expect(outcome.skipped).toBeGreaterThan(0);
      expect(spy.analyzeCount()).toBe(0);
    } finally {
      spy.restore();
    }
  });

  test("ANALYZE failure is swallowed — the drain still succeeds", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = true;

    // Wrap execute so the ANALYZE statement throws, but everything else runs.
    const rawDb = getDb() as unknown as { execute: (arg: unknown) => Promise<unknown> };
    const original = rawDb.execute.bind(rawDb);
    let analyzeAttempted = false;
    rawDb.execute = (arg: unknown) => {
      if (/ANALYZE\s+message_chunks/i.test(sqlChunkText(arg))) {
        analyzeAttempted = true;
        throw new Error("ANALYZE boom");
      }
      return original(arg);
    };
    try {
      const worker = new EmbedWorker({ skipLockfile: true });
      const outcome = await worker.tickOnce();
      // The drain itself succeeded despite the ANALYZE throwing.
      expect(outcome.embedded).toBe(1);
      expect(analyzeAttempted).toBe(true);

      // outbox row was still drained (markDone ran before ANALYZE).
      const outboxRows = await db
        .select()
        .from(messageEmbedOutbox)
        .where(sql`message_id = ${messageId}`);
      expect(outboxRows).toHaveLength(0);
    } finally {
      rawDb.execute = original as typeof rawDb.execute;
    }
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

// ── Interval-driven tick (lines 250-254) ──────────────────────────────
//
// All the ING tests drive tickOnce() directly or use a 60s interval that
// never fires. This proves the setInterval callback body actually invokes
// tickOnce() and drains a row — the interval is the real production driver.
// Mirrors host-maintenance-daemon.test.ts's "interval-driven tick fires".

describe("EmbedWorker — interval-driven tick", () => {
  test("the armed interval fires tickOnce() and drains a pending message", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = true;

    // 1s floor is the smallest interval the worker allows.
    const worker = new EmbedWorker({ skipLockfile: true, wakeIntervalMs: 1000 });
    const ok = await worker.start();
    expect(ok).toBe(true);

    // Poll up to ~3s for the interval-driven drain (no manual tickOnce()).
    let drained = false;
    for (let i = 0; i < 30 && !drained; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const rows = await db
        .select()
        .from(messageEmbedOutbox)
        .where(sql`message_id = ${messageId}`);
      drained = rows.length === 0;
    }
    worker.stop();
    expect(drained).toBe(true);
  });

  test("runTickGuarded swallows + logs a rejected tick (defense-in-depth net)", async () => {
    // tickOnce()'s own try/catch/finally means it never rejects in practice,
    // so the interval's outer catch is otherwise unreachable. Force the
    // rejection path by stubbing tickOnce to throw, and assert the guard
    // swallows it (resolves, never rejects) so the daemon keeps ticking.
    const worker = new EmbedWorker({ skipLockfile: true, wakeIntervalMs: 60_000 });
    worker.tickOnce = async () => {
      throw new Error("boom tick");
    };
    await expect(worker.runTickGuarded()).resolves.toBeUndefined();
  });

  test("a thrown tick is swallowed by the interval's .catch — daemon keeps ticking", async () => {
    // First tick throws; subsequent ticks succeed. The interval's outer
    // .catch must keep the daemon alive so the row eventually drains.
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = true;

    let calls = 0;
    generateEmbeddingImpl = async (_text: string) => {
      calls++;
      if (calls === 1) throw new Error("transient embed fail");
      return Array(384).fill(0.1);
    };

    const worker = new EmbedWorker({ skipLockfile: true, wakeIntervalMs: 1000, maxAttempts: 5 });
    await worker.start();

    // Force re-claim eligibility each poll (backoff would otherwise gate it)
    // and wait for the eventual successful drain.
    let drained = false;
    for (let i = 0; i < 40 && !drained; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await db.execute(sql`
        UPDATE message_embed_outbox
        SET next_attempt_after = NOW() - INTERVAL '1 second'
        WHERE message_id = ${messageId} AND status = 'pending'
      `);
      const rows = await db
        .select()
        .from(messageEmbedOutbox)
        .where(sql`message_id = ${messageId}`);
      drained = rows.length === 0;
    }
    worker.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(drained).toBe(true);
  });
});

// ── Re-entrancy guard ─────────────────────────────────────────────────

describe("EmbedWorker — tickOnce re-entrancy guard", () => {
  test("an overlapping tickOnce() while one is in-flight returns the empty outcome", async () => {
    const db = getDb();
    const { conversationId, messageId } = await seedConversationAndMessage();
    await enqueueEmbedJob(db, messageId, conversationId);
    embeddingReady = true;

    // Block the first tick inside generateEmbedding until we release it.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    generateEmbeddingImpl = async (_text: string) => {
      await gate;
      return Array(384).fill(0.1);
    };

    const worker = new EmbedWorker({ skipLockfile: true });
    const first = worker.tickOnce();
    // Give the first tick a moment to claim the row and enter generateEmbedding.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second concurrent tick must early-return without claiming anything.
    const second = await worker.tickOnce();
    expect(second).toEqual({ claimed: 0, embedded: 0, failed: 0, skipped: 0 });

    release();
    const firstOutcome = await first;
    expect(firstOutcome.embedded).toBe(1);
  });
});

// ── Backoff math: computeNextAttemptAfter ──────────────────────────────

describe("EmbedWorker — computeNextAttemptAfter backoff math", () => {
  const { computeNextAttemptAfter, MAX_BACKOFF_EXPONENT } = _embedWorkerInternals;

  test("delay doubles per attempt and jitter stays within [delay, 1.3*delay]", () => {
    const now = () => 0;
    const BASE = 5_000;
    for (const attempts of [1, 2, 3]) {
      const delay = BASE * 2 ** attempts;
      const ms = computeNextAttemptAfter(attempts, now).getTime();
      // now()=0, so ms === delay + jitter, jitter in [0, 0.3*delay].
      expect(ms).toBeGreaterThanOrEqual(delay);
      expect(ms).toBeLessThanOrEqual(delay * 1.3);
    }
  });

  test("backoff grows monotonically across attempts (lower bound doubles)", () => {
    const now = () => 0;
    const a1 = computeNextAttemptAfter(1, now).getTime();
    const a2 = computeNextAttemptAfter(2, now).getTime();
    const a3 = computeNextAttemptAfter(3, now).getTime();
    // attempt n+1 lower bound (5000*2^(n+1)) exceeds attempt n upper bound
    // (5000*2^n*1.3), so growth is strictly monotonic regardless of jitter.
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThan(a2);
  });

  test("extreme attempts clamp the exponent — never produces an Invalid Date", () => {
    const now = () => 0;
    const d = computeNextAttemptAfter(1000, now);
    // Without the clamp, 5000*2^1000 overflows the Date range and
    // toISOString() throws. With the clamp it caps at 2^MAX_BACKOFF_EXPONENT.
    expect(Number.isNaN(d.getTime())).toBe(false);
    expect(() => d.toISOString()).not.toThrow();
    const capped = 5_000 * 2 ** MAX_BACKOFF_EXPONENT;
    expect(d.getTime()).toBeLessThanOrEqual(capped * 1.3);
  });
});

// ── PID lockfile subsystem ─────────────────────────────────────────────
//
// All ING tests pass skipLockfile:true, so the cross-process
// double-drain-prevention mechanism is otherwise unexercised. Mirrors
// host-maintenance-daemon.test.ts's "PID lockfile" describe block. Each
// test uses a unique tmp lockfilePath to avoid collisions.

describe("EmbedWorker — PID lockfile", () => {
  test("start() writes a lockfile containing this process's PID", async () => {
    const lockPath = join(tmpdir(), `ezcorp-embed-lock-first-${Date.now()}.pid`);
    const worker = new EmbedWorker({ wakeIntervalMs: 60_000, lockfilePath: lockPath });
    const ok = await worker.start();
    expect(ok).toBe(true);

    const file = Bun.file(lockPath);
    expect(await file.exists()).toBe(true);
    expect(parseInt((await file.text()).trim(), 10)).toBe(process.pid);

    worker.stop();
    await unlink(lockPath).catch(() => {});
  });

  test("a second worker refuses start() while a genuine live sibling holds the lock", async () => {
    const lockPath = join(tmpdir(), `ezcorp-embed-lock-sibling-${Date.now()}.pid`);
    // A genuine live sibling: a foreign live PID (1) whose stored identity
    // token still matches → refuse.
    await Bun.write(lockPath, `1 ${readProcStartTime(1)}`);

    const second = new EmbedWorker({ wakeIntervalMs: 60_000, lockfilePath: lockPath });
    expect(await second.start()).toBe(false);

    second.stop();
    await unlink(lockPath).catch(() => {});
  });

  test("a prior-boot lockfile holding our reused PID is reclaimed (restart fix)", async () => {
    const lockPath = join(tmpdir(), `ezcorp-embed-lock-reused-${Date.now()}.pid`);
    // The cross-restart self-deadlock case — must reclaim, not refuse.
    await Bun.write(lockPath, `${process.pid} prior-boot-token`);
    const worker = new EmbedWorker({ wakeIntervalMs: 60_000, lockfilePath: lockPath });
    expect(await worker.start()).toBe(true);
    expect(parseInt((await Bun.file(lockPath).text()).trim(), 10)).toBe(process.pid);
    worker.stop();
    await unlink(lockPath).catch(() => {});
  });

  test("a stale lockfile (dead PID) is overwritten and start() succeeds", async () => {
    const lockPath = join(tmpdir(), `ezcorp-embed-lock-stale-${Date.now()}.pid`);
    await Bun.write(lockPath, "999999999 dead-token"); // bogus, not alive

    const worker = new EmbedWorker({ wakeIntervalMs: 60_000, lockfilePath: lockPath });
    expect(await worker.start()).toBe(true);
    expect(parseInt((await Bun.file(lockPath).text()).trim(), 10)).toBe(process.pid);

    worker.stop();
    await unlink(lockPath).catch(() => {});
  });

  test("stop() releases the lockfile so a later worker can start", async () => {
    const lockPath = join(tmpdir(), `ezcorp-embed-lock-release-${Date.now()}.pid`);
    const first = new EmbedWorker({ wakeIntervalMs: 60_000, lockfilePath: lockPath });
    expect(await first.start()).toBe(true);
    first.stop();

    // stop()'s unlink is fire-and-forget — small wait for it to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = new EmbedWorker({ wakeIntervalMs: 60_000, lockfilePath: lockPath });
    expect(await second.start()).toBe(true);
    second.stop();
    await unlink(lockPath).catch(() => {});
  });

  test("isProcessAlive: own PID alive, bogus/zero/negative not alive", () => {
    const { isProcessAlive } = _embedWorkerInternals;
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999_999_999)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

// ── Env-var parsing helpers ────────────────────────────────────────────
//
// Mirrors host-maintenance-daemon.test.ts's "getSweepIntervalMs — env-var
// parsing" block. Drives the three EZCORP_EMBED_* parsers through
// unset/empty/invalid/below-floor/valid branches.

describe("EmbedWorker — env-var parsing", () => {
  const { getEmbedPollIntervalMs, getEmbedBatchSize, getEmbedMaxAttempts } =
    _embedWorkerInternals;

  afterEach(() => {
    delete process.env.EZCORP_EMBED_POLL_INTERVAL_MS;
    delete process.env.EZCORP_EMBED_BATCH_SIZE;
    delete process.env.EZCORP_EMBED_MAX_ATTEMPTS;
  });

  describe("getEmbedPollIntervalMs", () => {
    test("unset → default", () => {
      delete process.env.EZCORP_EMBED_POLL_INTERVAL_MS;
      expect(getEmbedPollIntervalMs()).toBe(_embedWorkerInternals.DEFAULT_POLL_MS);
    });
    test("empty string → default", () => {
      process.env.EZCORP_EMBED_POLL_INTERVAL_MS = "";
      expect(getEmbedPollIntervalMs()).toBe(_embedWorkerInternals.DEFAULT_POLL_MS);
    });
    test("non-numeric → default", () => {
      process.env.EZCORP_EMBED_POLL_INTERVAL_MS = "abc";
      expect(getEmbedPollIntervalMs()).toBe(_embedWorkerInternals.DEFAULT_POLL_MS);
    });
    test("zero / negative → default", () => {
      process.env.EZCORP_EMBED_POLL_INTERVAL_MS = "0";
      expect(getEmbedPollIntervalMs()).toBe(_embedWorkerInternals.DEFAULT_POLL_MS);
      process.env.EZCORP_EMBED_POLL_INTERVAL_MS = "-5";
      expect(getEmbedPollIntervalMs()).toBe(_embedWorkerInternals.DEFAULT_POLL_MS);
    });
    test("Infinity → default (non-finite)", () => {
      process.env.EZCORP_EMBED_POLL_INTERVAL_MS = "Infinity";
      expect(getEmbedPollIntervalMs()).toBe(_embedWorkerInternals.DEFAULT_POLL_MS);
    });
    test("below floor → clamped to MIN_POLL_MS", () => {
      process.env.EZCORP_EMBED_POLL_INTERVAL_MS = "100";
      expect(getEmbedPollIntervalMs()).toBe(_embedWorkerInternals.MIN_POLL_MS);
    });
    test("valid above floor → that integer", () => {
      process.env.EZCORP_EMBED_POLL_INTERVAL_MS = "12000";
      expect(getEmbedPollIntervalMs()).toBe(12000);
    });
  });

  describe("getEmbedBatchSize", () => {
    test("unset → default", () => {
      delete process.env.EZCORP_EMBED_BATCH_SIZE;
      expect(getEmbedBatchSize()).toBe(_embedWorkerInternals.DEFAULT_BATCH_SIZE);
    });
    test("invalid / zero → default", () => {
      process.env.EZCORP_EMBED_BATCH_SIZE = "abc";
      expect(getEmbedBatchSize()).toBe(_embedWorkerInternals.DEFAULT_BATCH_SIZE);
      process.env.EZCORP_EMBED_BATCH_SIZE = "0";
      expect(getEmbedBatchSize()).toBe(_embedWorkerInternals.DEFAULT_BATCH_SIZE);
    });
    test("valid → that integer (floored to MIN)", () => {
      process.env.EZCORP_EMBED_BATCH_SIZE = "20";
      expect(getEmbedBatchSize()).toBe(20);
    });
  });

  describe("getEmbedMaxAttempts", () => {
    test("unset → default", () => {
      delete process.env.EZCORP_EMBED_MAX_ATTEMPTS;
      expect(getEmbedMaxAttempts()).toBe(_embedWorkerInternals.DEFAULT_MAX_ATTEMPTS);
    });
    test("invalid / negative → default", () => {
      process.env.EZCORP_EMBED_MAX_ATTEMPTS = "nope";
      expect(getEmbedMaxAttempts()).toBe(_embedWorkerInternals.DEFAULT_MAX_ATTEMPTS);
      process.env.EZCORP_EMBED_MAX_ATTEMPTS = "-3";
      expect(getEmbedMaxAttempts()).toBe(_embedWorkerInternals.DEFAULT_MAX_ATTEMPTS);
    });
    test("valid → that integer (floored to MIN)", () => {
      process.env.EZCORP_EMBED_MAX_ATTEMPTS = "7";
      expect(getEmbedMaxAttempts()).toBe(7);
    });
  });
});
