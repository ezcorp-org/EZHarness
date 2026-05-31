/**
 * Phase 68 Plan 01 — Wave-0 RED contract for the embedding backfill CLI
 * (OPS-01 gaps-only + idempotent enqueue, OPS-02 throttle/env parse).
 *
 * THESE TESTS ARE INTENTIONALLY RED until Plans 02 + 04 land:
 *   - `parseArgs` / `runBackfill` are imported from `../../scripts/backfill-embeddings`,
 *     a module Plan 04 CREATES (mirroring scripts/sweep-perm-expiry.ts).
 *   - `enqueueEmbedJobIfAbsent`, `getBackfillBatchSize`, `getBackfillSleepMs`
 *     are imported from `../db/queries/message-embed-outbox`, which Plan 02 EXTENDS.
 * The top-level `await import(...)` therefore REJECTS with a module/export
 * resolution error — that is the Nyquist contract this scaffold pins. Plans
 * 02/04 turn it GREEN without editing the assertions.
 *
 * Contracts pinned (see 68-01-PLAN.md <interfaces>):
 *   OPS-01  gaps-only select  — enqueue ONLY eligible messages that have neither
 *           a message_chunks row NOR an existing outbox row; mirror the
 *           message-search.ts eligibility/test predicates (NOT re-derived):
 *             role IN ('user','assistant')                  (message-search.ts:195)
 *             (c.test IS NULL OR c.test = false)             (message-search.ts:139/194)
 *             content.trim().length > 0                      (message-chunker.isEmbedEligible)
 *   OPS-01  idempotency       — DO NOTHING (NOT DO UPDATE): a re-run enqueues 0
 *           and never resets a previously-failed row (contrast enqueueEmbedJob).
 *   OPS-01  dry-run           — writes nothing, return.enqueued reports the count
 *           it WOULD enqueue.
 *   OPS-02  env parse         — EZCORP_BACKFILL_BATCH_SIZE / _SLEEP_MS mirror the
 *           embed-worker idiom (undefined/empty→default, non-finite/≤0→default,
 *           floor + clamp), flags override env override default.
 *
 * Harness: the shared PGlite harness (helpers/test-pglite.ts), exactly like
 * message-embed-outbox-real.test.ts. We seed via RAW inserts (NOT createMessage)
 * because createMessage auto-enqueues eligible messages (conversations.ts:414),
 * which would pre-populate the outbox and defeat the gaps-only premise.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { eq } from "drizzle-orm";

mockDbConnection();

const { runBackfill, parseArgs } = await import("../../scripts/backfill-embeddings");
const { enqueueEmbedJobIfAbsent, getBackfillBatchSize, getBackfillSleepMs } = await import(
  "../db/queries/message-embed-outbox"
);
const { createProject } = await import("../db/queries/projects");
const { projects, conversations, messages, messageChunks, messageEmbedOutbox } = await import("../db/schema");
const { EMBEDDING_MODEL_ID } = await import("../memory/embeddings");

// ── Raw seeders (bypass createMessage's auto-enqueue) ──────────────────────

async function seedConversation(opts: { test?: boolean | null } = {}) {
  const db = getTestDb();
  const project = await createProject({ name: "p", path: `/tmp/backfill-${crypto.randomUUID()}` });
  const [conv] = await db
    .insert(conversations)
    .values({ projectId: project.id, title: "c", test: opts.test ?? false })
    .returning();
  return conv!;
}

async function seedMessage(conversationId: string, role: string, content: string) {
  const db = getTestDb();
  const [msg] = await db.insert(messages).values({ conversationId, role, content }).returning();
  return msg!;
}

async function seedChunk(messageId: string, conversationId: string) {
  await getTestDb().insert(messageChunks).values({
    messageId,
    conversationId,
    content: "already-embedded chunk",
    chunkIndex: 0,
    embeddingModelId: EMBEDDING_MODEL_ID,
  });
}

async function outboxRows() {
  return getTestDb().select().from(messageEmbedOutbox);
}

async function outboxFor(messageId: string) {
  return getTestDb().select().from(messageEmbedOutbox).where(eq(messageEmbedOutbox.messageId, messageId));
}

const FULL = { dryRun: false, refreshStale: false, projectId: null, batchSize: 50, sleepMs: 0 } as const;

describe("backfill-embeddings (OPS-01/OPS-02) — RED until Plans 02+04", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  describe("OPS-01 gaps-only select", () => {
    test("enqueues exactly the true gaps — skips chunked, already-queued, system, and test-conversation messages", async () => {
      const conv = await seedConversation();
      const testConv = await seedConversation({ test: true });

      // (a) eligible user msg, no chunks / no outbox → IS a gap (enqueue)
      const gap = await seedMessage(conv.id, "user", "find me");
      // (b) eligible assistant msg that ALREADY has a chunk → NOT a gap
      const chunked = await seedMessage(conv.id, "assistant", "already embedded");
      await seedChunk(chunked.id, conv.id);
      // (c) eligible user msg that already has an outbox row → NOT a gap
      const queued = await seedMessage(conv.id, "user", "already queued");
      await enqueueEmbedJobIfAbsent(getTestDb(), queued.id, conv.id);
      // (d) system-role msg → ineligible → NOT a gap
      await seedMessage(conv.id, "system", "system prompt");
      // (e) msg in a test=true conversation → excluded → NOT a gap
      await seedMessage(testConv.id, "user", "test convo message");
      // (f) whitespace-only eligible msg → ineligible (trim().length===0) → NOT a gap
      await seedMessage(conv.id, "user", "   ");

      const before = (await outboxRows()).length; // 1 (the pre-queued row)
      const result = await runBackfill(getTestDb(), { ...FULL });

      // Exactly one true gap was enqueued.
      expect(result.enqueued).toBe(1);
      expect((await outboxRows()).length).toBe(before + 1);
      expect((await outboxFor(gap.id)).length).toBe(1);
      // eligibleScanned counts true gaps the SUT considered enqueuing.
      expect(result.eligibleScanned).toBeGreaterThanOrEqual(1);
    });

    test("DO NOTHING leaves a pre-existing queued row's status/attempts untouched", async () => {
      const conv = await seedConversation();
      const queued = await seedMessage(conv.id, "user", "queued already");
      await enqueueEmbedJobIfAbsent(getTestDb(), queued.id, conv.id);
      // Mutate it to a terminal failed state.
      await getTestDb()
        .update(messageEmbedOutbox)
        .set({ status: "failed", attempts: 3 })
        .where(eq(messageEmbedOutbox.messageId, queued.id));

      await runBackfill(getTestDb(), { ...FULL });

      const row = (await outboxFor(queued.id))[0]!;
      expect(row.status).toBe("failed"); // DO NOTHING — never reset to pending
      expect(row.attempts).toBe(3);
    });
  });

  describe("OPS-01 idempotency", () => {
    test("a second run enqueues 0 and total outbox rows are unchanged; a failed row survives a third run", async () => {
      const conv = await seedConversation();
      await seedMessage(conv.id, "user", "gap one");
      await seedMessage(conv.id, "assistant", "gap two");

      const first = await runBackfill(getTestDb(), { ...FULL });
      expect(first.enqueued).toBe(2);
      const afterFirst = (await outboxRows()).length;

      const second = await runBackfill(getTestDb(), { ...FULL });
      expect(second.enqueued).toBe(0);
      expect((await outboxRows()).length).toBe(afterFirst);

      // Drive one queued row to failed/attempts=3 between runs.
      const all = await outboxRows();
      const target = all[0]!;
      await getTestDb()
        .update(messageEmbedOutbox)
        .set({ status: "failed", attempts: 3 })
        .where(eq(messageEmbedOutbox.messageId, target.messageId));

      const third = await runBackfill(getTestDb(), { ...FULL });
      expect(third.enqueued).toBe(0);
      const survivor = (await outboxFor(target.messageId))[0]!;
      expect(survivor.status).toBe("failed"); // DO NOTHING must not reset it
      expect(survivor.attempts).toBe(3);
    });
  });

  describe("OPS-01 enqueueEmbedJobIfAbsent (unit)", () => {
    test("calling twice for the same message inserts exactly one row", async () => {
      const conv = await seedConversation();
      const msg = await seedMessage(conv.id, "user", "x");

      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);
      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);

      const rows = await outboxFor(msg.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.attempts).toBe(0);
    });

    test("a pre-existing 'failed' row is left intact (DO NOTHING, not DO UPDATE)", async () => {
      const conv = await seedConversation();
      const msg = await seedMessage(conv.id, "user", "x");
      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);
      await getTestDb()
        .update(messageEmbedOutbox)
        .set({ status: "failed", attempts: 5 })
        .where(eq(messageEmbedOutbox.messageId, msg.id));

      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);

      const row = (await outboxFor(msg.id))[0]!;
      expect(row.status).toBe("failed");
      expect(row.attempts).toBe(5);
    });
  });

  describe("OPS-01 dry-run", () => {
    test("writes nothing but reports the count it would enqueue", async () => {
      const conv = await seedConversation();
      await seedMessage(conv.id, "user", "gap one");
      await seedMessage(conv.id, "assistant", "gap two");

      const before = (await outboxRows()).length;
      const result = await runBackfill(getTestDb(), { ...FULL, dryRun: true });

      expect(result.enqueued).toBe(2); // count it WOULD enqueue
      expect((await outboxRows()).length).toBe(before); // wrote nothing
    });
  });

  describe("OPS-02 env parse (mirror embed-worker idiom)", () => {
    let savedBatch: string | undefined;
    let savedSleep: string | undefined;
    beforeEach(() => {
      savedBatch = process.env.EZCORP_BACKFILL_BATCH_SIZE;
      savedSleep = process.env.EZCORP_BACKFILL_SLEEP_MS;
      delete process.env.EZCORP_BACKFILL_BATCH_SIZE;
      delete process.env.EZCORP_BACKFILL_SLEEP_MS;
    });
    afterAll(() => {
      if (savedBatch === undefined) delete process.env.EZCORP_BACKFILL_BATCH_SIZE;
      else process.env.EZCORP_BACKFILL_BATCH_SIZE = savedBatch;
      if (savedSleep === undefined) delete process.env.EZCORP_BACKFILL_SLEEP_MS;
      else process.env.EZCORP_BACKFILL_SLEEP_MS = savedSleep;
    });

    test("batch size: undefined/empty → default; non-finite/≤0 → default; floors + clamps", () => {
      const def = getBackfillBatchSize();
      expect(def).toBeGreaterThan(0);

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "";
      expect(getBackfillBatchSize()).toBe(def);

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "not-a-number";
      expect(getBackfillBatchSize()).toBe(def);

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "0";
      expect(getBackfillBatchSize()).toBe(def);

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "-7";
      expect(getBackfillBatchSize()).toBe(def);

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "12.9";
      expect(getBackfillBatchSize()).toBe(12); // Math.floor

      process.env.EZCORP_BACKFILL_BATCH_SIZE = "250";
      expect(getBackfillBatchSize()).toBeGreaterThanOrEqual(1);
    });

    test("sleep ms: undefined/empty → default; non-finite/negative → default; floors", () => {
      const def = getBackfillSleepMs();
      expect(def).toBeGreaterThanOrEqual(0);

      process.env.EZCORP_BACKFILL_SLEEP_MS = "";
      expect(getBackfillSleepMs()).toBe(def);

      process.env.EZCORP_BACKFILL_SLEEP_MS = "garbage";
      expect(getBackfillSleepMs()).toBe(def);

      process.env.EZCORP_BACKFILL_SLEEP_MS = "-5";
      expect(getBackfillSleepMs()).toBe(def);

      process.env.EZCORP_BACKFILL_SLEEP_MS = "40.7";
      expect(getBackfillSleepMs()).toBe(40); // Math.floor
    });
  });

  describe("parseArgs", () => {
    test("parses every supported flag (long + short forms)", () => {
      const parsed = parseArgs([
        "--dry-run",
        "--verbose",
        "--status",
        "--refresh-stale",
        "--project",
        "proj-123",
        "--batch-size",
        "25",
        "--sleep-ms",
        "100",
      ]);
      expect("error" in parsed).toBe(false);
      if ("error" in parsed) throw new Error("unreachable");
      expect(parsed.dryRun).toBe(true);
      expect(parsed.verbose).toBe(true);
      expect(parsed.status).toBe(true);
      expect(parsed.refreshStale).toBe(true);
      expect(parsed.projectId).toBe("proj-123");
      expect(parsed.batchSize).toBe(25);
      expect(parsed.sleepMs).toBe(100);
    });

    test("short flags -n / -v map to dry-run / verbose", () => {
      const parsed = parseArgs(["-n", "-v"]);
      if ("error" in parsed) throw new Error("unexpected error");
      expect(parsed.dryRun).toBe(true);
      expect(parsed.verbose).toBe(true);
    });

    test("empty argv yields all-defaults (no flags set)", () => {
      const parsed = parseArgs([]);
      if ("error" in parsed) throw new Error("unexpected error");
      expect(parsed.dryRun).toBe(false);
      expect(parsed.verbose).toBe(false);
      expect(parsed.status).toBe(false);
      expect(parsed.refreshStale).toBe(false);
      expect(parsed.projectId).toBe(null);
    });

    test("--help / -h → {error:'help'}", () => {
      expect(parseArgs(["--help"])).toEqual({ error: "help" });
      expect(parseArgs(["-h"])).toEqual({ error: "help" });
    });

    test("unknown flag → {error:'unknown flag: ...'}", () => {
      const parsed = parseArgs(["--bogus"]);
      expect("error" in parsed).toBe(true);
      if (!("error" in parsed)) throw new Error("unreachable");
      expect(parsed.error).toContain("unknown flag");
      expect(parsed.error).toContain("--bogus");
    });
  });
});
