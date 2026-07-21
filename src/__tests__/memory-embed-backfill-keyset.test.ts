/**
 * DB-audit fixes for scripts/backfill-embeddings.ts (memory-embed group):
 *   - the gaps pass keyset is now a COMPOSITE `(created_at, id) > (cursor)`
 *     tuple, so an equal-timestamp group straddling a page boundary is no
 *     longer silently skipped (messages.created_at is transaction-stable, so
 *     bulk inserts share a timestamp).
 *   - the stale-model pass is PAGED + paced through the same batch loop instead
 *     of an unbounded single SELECT.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { eq, sql } from "drizzle-orm";

mockDbConnection();

const { runBackfill } = await import("../../scripts/backfill-embeddings");
const { createProject } = await import("../db/queries/projects");
const { conversations, messages, messageChunks, messageEmbedOutbox } = await import("../db/schema");
const { EMBEDDING_MODEL_ID } = await import("../memory/embeddings");

const FULL = { dryRun: false, refreshStale: false, projectId: null, batchSize: 50, sleepMs: 0 } as const;

async function seedConversation() {
  const project = await createProject({ name: "p", path: `/tmp/keyset-${crypto.randomUUID()}` });
  const [conv] = await getTestDb().insert(conversations).values({ projectId: project.id, title: "c", test: false }).returning();
  return conv!;
}

async function seedMessage(conversationId: string, content: string, createdAt?: Date) {
  const [msg] = await getTestDb().insert(messages)
    .values({ conversationId, role: "user", content, ...(createdAt ? { createdAt } : {}) })
    .returning();
  return msg!;
}

async function seedStaleChunk(messageId: string, conversationId: string) {
  await getTestDb().insert(messageChunks).values({
    messageId, conversationId, content: "stale", chunkIndex: 0,
    embeddingModelId: `${EMBEDDING_MODEL_ID}-OLD`,
  });
}

async function outboxCount() {
  return (await getTestDb().select().from(messageEmbedOutbox)).length;
}

describe("gaps pass — composite keyset survives equal-timestamp groups", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("all rows in an identical-created_at group are enqueued across a page boundary", async () => {
    const conv = await seedConversation();
    // THREE gaps sharing ONE created_at stamp (a bulk in-tx insert group). With
    // batchSize=2 the page boundary lands INSIDE the group — the bare
    // `created_at > cursor` predicate would skip the 3rd row; the composite
    // `(created_at, id) > (cursor_created_at, cursor_id)` keyset does not.
    const ts = new Date("2026-02-02T00:00:00.000Z");
    const m1 = await seedMessage(conv.id, "gap 1", ts);
    const m2 = await seedMessage(conv.id, "gap 2", ts);
    const m3 = await seedMessage(conv.id, "gap 3", ts);

    const result = await runBackfill(getTestDb(), { ...FULL, batchSize: 2 });

    expect(result.enqueued).toBe(3);
    expect(await outboxCount()).toBe(3);
    for (const m of [m1, m2, m3]) {
      const row = await getTestDb().select().from(messageEmbedOutbox).where(eq(messageEmbedOutbox.messageId, m.id));
      expect(row.length).toBe(1);
    }
  });

  test("a larger equal-timestamp group with a tiny batch still enqueues every row exactly once", async () => {
    const conv = await seedConversation();
    const ts = new Date("2026-03-03T00:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await seedMessage(conv.id, `g${i}`, ts)).id);

    const result = await runBackfill(getTestDb(), { ...FULL, batchSize: 2, sleepMs: 0 });
    expect(result.enqueued).toBe(7);
    expect(await outboxCount()).toBe(7);

    // Idempotent re-run adds nothing.
    const again = await runBackfill(getTestDb(), { ...FULL, batchSize: 2 });
    expect(again.enqueued).toBe(0);
    expect(await outboxCount()).toBe(7);
  });
});

describe("stale-model pass — paged + paced", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("re-enqueues every stale-model message across multiple pages", async () => {
    const conv = await seedConversation();
    const staleIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = await seedMessage(conv.id, `stale ${i}`, new Date(`2026-04-0${i + 1}T00:00:00.000Z`));
      await seedStaleChunk(m.id, conv.id);
      staleIds.push(m.id);
    }

    // batchSize=2 forces the stale pass to page (3 pages: 2,2,1).
    const result = await runBackfill(getTestDb(), { ...FULL, refreshStale: true, batchSize: 2, sleepMs: 0 });
    expect(result.enqueued).toBe(5);
    expect(await outboxCount()).toBe(5);
    for (const id of staleIds) {
      const row = await getTestDb().select().from(messageEmbedOutbox).where(eq(messageEmbedOutbox.messageId, id));
      expect(row.length).toBe(1);
      expect(row[0]!.status).toBe("pending");
    }
  });

  test("dry-run counts every stale page but writes nothing", async () => {
    const conv = await seedConversation();
    for (let i = 0; i < 4; i++) {
      const m = await seedMessage(conv.id, `s${i}`, new Date(`2026-05-0${i + 1}T00:00:00.000Z`));
      await seedStaleChunk(m.id, conv.id);
    }
    const result = await runBackfill(getTestDb(), { ...FULL, refreshStale: true, batchSize: 2, dryRun: true });
    expect(result.enqueued).toBe(4);
    expect(await outboxCount()).toBe(0);
  });
});
