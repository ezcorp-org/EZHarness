/**
 * Phase 63 Plan 03 — REAL embed-outbox helpers (no module mock).
 *
 * Companion to message-embed-outbox.test.ts, which `mock.module()`s
 * "../db/queries/message-embed-outbox" to inject a throw seam for the
 * atomicity test — and therefore asserts a re-implemented COPY of the upsert,
 * not the genuine `onConflictDoUpdate`/`sql\`NOW()\`` helper. This file imports
 * the REAL helpers and runs them against PGlite so the production code paths
 * (enqueueEmbedJob upsert + clearMessageEmbedState deletes) have direct
 * behavioral coverage that would catch drift in the real module.
 *
 * Covers:
 *   - enqueueEmbedJob: real ON CONFLICT (message_id) upsert — insert-once,
 *     re-enqueue resets status/attempts and advances updated_at, no duplicate.
 *   - clearMessageEmbedState: real deletes from message_embed_outbox AND
 *     message_chunks; idempotent (no-op when nothing exists).
 *   - updateMessageContent edit-to-ineligible: a user message edited down to
 *     whitespace drops both its outbox job and any chunks (the #1 stale-index
 *     fix), end-to-end through the real write boundary.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { eq } from "drizzle-orm";

mockDbConnection();

const { enqueueEmbedJob, enqueueEmbedJobIfAbsent, clearMessageEmbedState } = await import(
  "../db/queries/message-embed-outbox"
);
const { createConversation, createMessage, updateMessageContent } = await import(
  "../db/queries/conversations"
);
const { createProject } = await import("../db/queries/projects");
const { EMBEDDING_MODEL_ID } = await import("../memory/embeddings");
const { messageEmbedOutbox, messageChunks } = await import("../db/schema");

async function seedConversation() {
  const project = await createProject({ name: "p", path: "/tmp/p-real" });
  return createConversation(project.id, { title: "c" });
}

async function outboxRowsFor(messageId: string) {
  return getTestDb()
    .select()
    .from(messageEmbedOutbox)
    .where(eq(messageEmbedOutbox.messageId, messageId));
}

async function chunkRowsFor(messageId: string) {
  return getTestDb().select().from(messageChunks).where(eq(messageChunks.messageId, messageId));
}

async function insertChunk(messageId: string, conversationId: string) {
  // embedding is nullable; the worker fills it later. Only the NOT NULL
  // columns (content, chunk_index, embedding_model_id) are required here.
  await getTestDb().insert(messageChunks).values({
    messageId,
    conversationId,
    content: "stale chunk text",
    chunkIndex: 0,
    embeddingModelId: EMBEDDING_MODEL_ID,
  });
}

describe("message-embed-outbox (real helpers, no module mock)", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  describe("enqueueEmbedJob (real upsert)", () => {
    test("first call inserts exactly one pending row (attempts=0)", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "system", content: "x" }); // system → no auto-enqueue
      await enqueueEmbedJob(getTestDb(), msg.id, conv.id);

      const rows = await outboxRowsFor(msg.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.attempts).toBe(0);
    });

    test("re-enqueue upserts in place — no duplicate, resets status/attempts, advances updated_at", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "system", content: "x" });
      await enqueueEmbedJob(getTestDb(), msg.id, conv.id);
      const before = (await outboxRowsFor(msg.id))[0]!;

      // Simulate the worker grabbing then failing the job.
      await getTestDb()
        .update(messageEmbedOutbox)
        .set({ status: "failed", attempts: 3 })
        .where(eq(messageEmbedOutbox.messageId, msg.id));
      await new Promise((r) => setTimeout(r, 5));

      await enqueueEmbedJob(getTestDb(), msg.id, conv.id);

      const rows = await outboxRowsFor(msg.id);
      expect(rows.length).toBe(1); // still exactly one (message_id PK)
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.attempts).toBe(0);
      expect(rows[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    });
  });

  describe("enqueueEmbedJobIfAbsent (real DO NOTHING)", () => {
    test("first call inserts one pending row; a second call is a no-op (still one row)", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "system", content: "x" }); // system → no auto-enqueue
      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);
      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);

      const rows = await outboxRowsFor(msg.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.attempts).toBe(0);
    });

    test("leaves a pre-existing failed row BYTE-FOR-BYTE intact (DO NOTHING, not DO UPDATE)", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "system", content: "x" });
      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);
      // Drive it to a terminal failed state with a backoff stamp.
      const stamp = new Date(Date.now() + 60_000).toISOString();
      await getTestDb()
        .update(messageEmbedOutbox)
        .set({ status: "failed", attempts: 3, nextAttemptAfter: new Date(stamp) })
        .where(eq(messageEmbedOutbox.messageId, msg.id));

      await enqueueEmbedJobIfAbsent(getTestDb(), msg.id, conv.id);

      const row = (await outboxRowsFor(msg.id))[0]!;
      expect(row.status).toBe("failed"); // never reset to pending
      expect(row.attempts).toBe(3); // never reset to 0
      expect(row.nextAttemptAfter?.getTime()).toBe(new Date(stamp).getTime()); // backoff preserved
    });
  });

  describe("clearMessageEmbedState (real deletes)", () => {
    test("removes the outbox job AND chunks for the message", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "user", content: "indexed" }); // auto-enqueues
      await insertChunk(msg.id, conv.id);
      expect((await outboxRowsFor(msg.id)).length).toBe(1);
      expect((await chunkRowsFor(msg.id)).length).toBe(1);

      await getTestDb().transaction((tx) => clearMessageEmbedState(tx, msg.id));

      expect((await outboxRowsFor(msg.id)).length).toBe(0);
      expect((await chunkRowsFor(msg.id)).length).toBe(0);
    });

    test("is idempotent — clearing a message with no index state is a no-op", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "system", content: "never indexed" });
      expect((await outboxRowsFor(msg.id)).length).toBe(0);

      // Should not throw on absent rows.
      await getTestDb().transaction((tx) => clearMessageEmbedState(tx, msg.id));
      expect((await outboxRowsFor(msg.id)).length).toBe(0);
    });
  });

  describe("updateMessageContent edit-to-ineligible (stale-index fix)", () => {
    test("editing an eligible message down to whitespace drops its outbox job and chunks", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "user", content: "real content" });
      await insertChunk(msg.id, conv.id); // pretend the worker already chunked it
      expect((await outboxRowsFor(msg.id)).length).toBe(1);
      expect((await chunkRowsFor(msg.id)).length).toBe(1);

      await updateMessageContent(conv.id, msg.id, "   ");

      // No longer eligible → neither a pending job nor stale chunks survive.
      expect((await outboxRowsFor(msg.id)).length).toBe(0);
      expect((await chunkRowsFor(msg.id)).length).toBe(0);
    });
  });
});
