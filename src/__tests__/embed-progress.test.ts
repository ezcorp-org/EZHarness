/**
 * Phase 68 Plan 01 — Wave-0 RED contract for getEmbedProgress (OPS-04).
 *
 * INTENTIONALLY RED until Plan 02 lands: `getEmbedProgress` is imported from
 * `../db/queries/message-embed-outbox`, where Plan 02 ADDS it. The top-level
 * `await import(...)` resolves the module fine (it exists) but the named
 * export is `undefined`, so the first invocation throws — the Nyquist contract
 * this scaffold pins. Plan 02 turns it GREEN without editing the assertions.
 *
 * getEmbedProgress is the single source of truth for the CLI --status flag,
 * the backfill progress line, and the admin endpoint. It returns:
 *   {
 *     backlog:  { pending, inProgress, failed, total }   // message_embed_outbox by status
 *     coverage: { eligibleMessages, embeddedMessages }   // eligible vs has-≥1-chunk
 *   }
 *
 * Eligibility mirrors message-search.ts (NOT re-derived):
 *   role IN ('user','assistant')                (message-search.ts:195)
 *   (c.test IS NULL OR c.test = false)           (message-search.ts:139/194)
 *   content.trim().length > 0                    (message-chunker.isEmbedEligible)
 * embeddedMessages counts DISTINCT messages with ≥1 message_chunks row (a
 * message with 2 chunks counts ONCE).
 *
 * Harness: shared PGlite harness (helpers/test-pglite.ts). Seed via RAW inserts
 * (NOT createMessage) so we control outbox/chunk state independently. Do NOT
 * mock the DB — drive the real PGlite harness.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { getEmbedProgress } = await import("../db/queries/message-embed-outbox");
const { createProject } = await import("../db/queries/projects");
const { conversations, messages, messageChunks, messageEmbedOutbox } = await import("../db/schema");
const { EMBEDDING_MODEL_ID } = await import("../memory/embeddings");

async function seedConversation(opts: { test?: boolean | null } = {}) {
  const db = getTestDb();
  const project = await createProject({ name: "p", path: `/tmp/progress-${crypto.randomUUID()}` });
  const [conv] = await db
    .insert(conversations)
    .values({ projectId: project.id, title: "c", test: opts.test ?? false })
    .returning();
  return conv!;
}

async function seedMessage(conversationId: string, role: string, content: string) {
  const [msg] = await getTestDb().insert(messages).values({ conversationId, role, content }).returning();
  return msg!;
}

async function seedChunk(messageId: string, conversationId: string, chunkIndex: number) {
  await getTestDb().insert(messageChunks).values({
    messageId,
    conversationId,
    content: `chunk ${chunkIndex}`,
    chunkIndex,
    embeddingModelId: EMBEDDING_MODEL_ID,
  });
}

async function seedOutbox(
  messageId: string,
  conversationId: string,
  status: "pending" | "in_progress" | "failed",
) {
  await getTestDb().insert(messageEmbedOutbox).values({ messageId, conversationId, status, attempts: 0 });
}

describe("getEmbedProgress (OPS-04) — RED until Plan 02", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  test("empty DB → zeroed backlog and coverage", async () => {
    const progress = await getEmbedProgress(getTestDb());
    expect(progress).toEqual({
      backlog: { pending: 0, inProgress: 0, failed: 0, total: 0 },
      coverage: { eligibleMessages: 0, embeddedMessages: 0 },
    });
  });

  test("backlog reflects each status count and total", async () => {
    const conv = await seedConversation();
    const m1 = await seedMessage(conv.id, "user", "a");
    const m2 = await seedMessage(conv.id, "user", "b");
    const m3 = await seedMessage(conv.id, "user", "c");
    const m4 = await seedMessage(conv.id, "assistant", "d");
    const m5 = await seedMessage(conv.id, "assistant", "e");
    await seedOutbox(m1.id, conv.id, "pending");
    await seedOutbox(m2.id, conv.id, "pending");
    await seedOutbox(m3.id, conv.id, "pending");
    await seedOutbox(m4.id, conv.id, "in_progress");
    await seedOutbox(m5.id, conv.id, "failed");

    const { backlog } = await getEmbedProgress(getTestDb());
    expect(backlog.pending).toBe(3);
    expect(backlog.inProgress).toBe(1);
    expect(backlog.failed).toBe(1);
    expect(backlog.total).toBe(5);
  });

  test("coverage: eligibleMessages===N, embeddedMessages===M (DISTINCT per message)", async () => {
    const conv = await seedConversation();
    // N = 3 eligible messages.
    const a = await seedMessage(conv.id, "user", "alpha");
    const b = await seedMessage(conv.id, "assistant", "bravo");
    await seedMessage(conv.id, "user", "charlie"); // eligible, no chunks
    // M = 2 embedded: `a` has TWO chunks (must count ONCE), `b` has one.
    await seedChunk(a.id, conv.id, 0);
    await seedChunk(a.id, conv.id, 1);
    await seedChunk(b.id, conv.id, 0);

    const { coverage } = await getEmbedProgress(getTestDb());
    expect(coverage.eligibleMessages).toBe(3);
    expect(coverage.embeddedMessages).toBe(2); // COUNT DISTINCT message_id
  });

  test("test=true conversation excluded from eligibleMessages; NULL test counts as eligible", async () => {
    const liveConv = await seedConversation({ test: false });
    const nullConv = await seedConversation({ test: null });
    const testConv = await seedConversation({ test: true });

    await seedMessage(liveConv.id, "user", "live one");
    await seedMessage(nullConv.id, "user", "null-test one");
    await seedMessage(testConv.id, "user", "should be excluded");

    const { coverage } = await getEmbedProgress(getTestDb());
    expect(coverage.eligibleMessages).toBe(2); // live + null-test, NOT the test=true convo
  });

  test("system / tool messages excluded from eligibleMessages", async () => {
    const conv = await seedConversation();
    await seedMessage(conv.id, "user", "counts");
    await seedMessage(conv.id, "assistant", "counts too");
    await seedMessage(conv.id, "system", "excluded");
    await seedMessage(conv.id, "tool", "excluded");
    await seedMessage(conv.id, "user", "   "); // whitespace-only → ineligible

    const { coverage } = await getEmbedProgress(getTestDb());
    expect(coverage.eligibleMessages).toBe(2);
  });
});
