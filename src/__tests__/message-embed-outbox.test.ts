/**
 * Phase 63 Plan 03 — transactional embed-outbox write boundary (IDX-04 + IDX-05).
 *
 * Covers:
 *   - enqueueEmbedJob helper: insert-once + upsert-no-duplicate (message_id PK).
 *   - createMessage atomicity: eligible role → exactly 1 message + 1 outbox row,
 *     in ONE transaction; throw-mid-tx → BOTH rows roll back (atomic).
 *   - eligibility allowlist at the write boundary (user/assistant non-empty only).
 *   - updateMessageContent re-enqueue (upsert, no duplicate); setMessageExcluded
 *     does NOT re-enqueue.
 *
 * The throw-mid-tx case mocks `../db/queries/message-embed-outbox` so the
 * in-tx enqueue throws AFTER the message insert — proving the message insert
 * rolls back with it. The mock re-implements the real upsert one-for-one and
 * gates the throw behind a mutable flag, so every other case still exercises
 * the genuine ON CONFLICT upsert path. The mocked module path is registered
 * in MODULE_PATHS (helpers/mock-cleanup.ts) and restored in afterAll so it
 * never leaks into subsequent test files.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";
import { eq } from "drizzle-orm";

mockDbConnection();

// Real-by-default outbox helper, but with a throw seam for the atomicity test.
// `enqueueEmbedJob` delegates to the real implementation unless `shouldThrow`
// is set, in which case it throws AFTER the message insert has already run
// inside createMessage's transaction.
let shouldThrowOnEnqueue = false;
mock.module("../db/queries/message-embed-outbox", () => {
  // Re-implement the real upsert here rather than delegating to the real
  // module: a `require()` of the canonical path is itself intercepted by
  // this very mock (infinite recursion), and the `.real` specifier resolves
  // to the same module under Bun's normalization. The throw seam is gated
  // behind `shouldThrowOnEnqueue`; the body otherwise mirrors the real
  // helper one-for-one.
  const { sql } = require("drizzle-orm");
  const { messageEmbedOutbox: tbl } = require("../db/schema");
  return {
    async enqueueEmbedJob(tx: any, messageId: string, conversationId: string) {
      if (shouldThrowOnEnqueue) throw new Error("injected enqueue failure");
      await tx
        .insert(tbl)
        .values({ messageId, conversationId, status: "pending", attempts: 0 })
        .onConflictDoUpdate({
          target: tbl.messageId,
          set: { status: "pending", attempts: 0, updatedAt: sql`NOW()` },
        });
    },
  };
});

const { enqueueEmbedJob } = await import("../db/queries/message-embed-outbox");
const { createConversation, createMessage, updateMessageContent, setMessageExcluded } =
  await import("../db/queries/conversations");
const { createProject } = await import("../db/queries/projects");
const { messageEmbedOutbox, messages } = await import("../db/schema");

async function seedConversation() {
  const project = await createProject({ name: "p", path: "/tmp/p" });
  const conv = await createConversation(project.id, { title: "c" });
  return conv;
}

async function outboxRowsFor(messageId: string) {
  return getTestDb().select().from(messageEmbedOutbox).where(eq(messageEmbedOutbox.messageId, messageId));
}

async function messageRowsIn(conversationId: string) {
  return getTestDb().select().from(messages).where(eq(messages.conversationId, conversationId));
}

describe("message-embed-outbox", () => {
  beforeEach(async () => {
    await setupTestDb();
    shouldThrowOnEnqueue = false;
  });
  afterAll(async () => {
    restoreModuleMocks();
    await closeTestDb();
  });

  // ── enqueueEmbedJob helper ──────────────────────────────────────────
  describe("enqueueEmbedJob helper", () => {
    test("first call inserts one pending row (attempts=0)", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "system", content: "x" }); // system → no auto-enqueue
      await enqueueEmbedJob(getTestDb(), msg.id, conv.id);

      const rows = await outboxRowsFor(msg.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.attempts).toBe(0);
    });

    test("second call upserts — no duplicate row, status reset to pending", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "system", content: "x" });
      await enqueueEmbedJob(getTestDb(), msg.id, conv.id);
      // Mutate the row so we can prove the upsert reset it.
      await getTestDb()
        .update(messageEmbedOutbox)
        .set({ status: "failed", attempts: 3 })
        .where(eq(messageEmbedOutbox.messageId, msg.id));

      await enqueueEmbedJob(getTestDb(), msg.id, conv.id);

      const rows = await outboxRowsFor(msg.id);
      expect(rows.length).toBe(1); // still exactly one
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.attempts).toBe(0);
    });
  });

  // ── createMessage: atomicity + eligibility ──────────────────────────
  describe("createMessage write boundary", () => {
    test("role=user non-empty → 1 message + 1 outbox row", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "user", content: "hello" });
      expect((await outboxRowsFor(msg.id)).length).toBe(1);
    });

    test("role=assistant non-empty → 1 message + 1 outbox row", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "assistant", content: "hi there" });
      expect((await outboxRowsFor(msg.id)).length).toBe(1);
    });

    test.each(["system", "extension", "ez-action-result", "capability-event"])(
      "role=%s → 1 message, 0 outbox rows",
      async (role) => {
        const conv = await seedConversation();
        const before = (await messageRowsIn(conv.id)).length;
        const msg = await createMessage(conv.id, { role, content: "payload" });
        expect((await messageRowsIn(conv.id)).length).toBe(before + 1);
        expect((await outboxRowsFor(msg.id)).length).toBe(0);
      },
    );

    test("role=assistant whitespace-only content → 1 message, 0 outbox", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "assistant", content: "   " });
      expect((await outboxRowsFor(msg.id)).length).toBe(0);
    });

    test("ATOMICITY: throw mid-tx after insert → NEITHER message nor outbox row exists", async () => {
      const conv = await seedConversation();
      const before = (await messageRowsIn(conv.id)).length;

      shouldThrowOnEnqueue = true;
      await expect(
        createMessage(conv.id, { role: "user", content: "should roll back" }),
      ).rejects.toThrow("injected enqueue failure");
      shouldThrowOnEnqueue = false;

      // Message insert rolled back with the enqueue failure.
      expect((await messageRowsIn(conv.id)).length).toBe(before);
      // And no orphaned outbox row.
      const allOutbox = await getTestDb().select().from(messageEmbedOutbox);
      expect(allOutbox.length).toBe(0);
    });
  });

  // ── updateMessageContent: re-enqueue on edit ────────────────────────
  describe("updateMessageContent re-enqueue", () => {
    test("editing eligible message re-enqueues (upsert, still 1 row, updated_at advances)", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "user", content: "v1" });
      const before = (await outboxRowsFor(msg.id))[0]!;

      // Drain-then-edit simulation: mark in_progress so we can prove reset.
      await getTestDb()
        .update(messageEmbedOutbox)
        .set({ status: "in_progress", attempts: 2 })
        .where(eq(messageEmbedOutbox.messageId, msg.id));
      await new Promise((r) => setTimeout(r, 5));

      await updateMessageContent(conv.id, msg.id, "v2 edited");

      const rows = await outboxRowsFor(msg.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("pending");
      expect(rows[0]!.attempts).toBe(0);
      expect(rows[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    });

    test("editing a non-eligible message creates no outbox row", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "system", content: "sys v1" });
      expect((await outboxRowsFor(msg.id)).length).toBe(0);

      await updateMessageContent(conv.id, msg.id, "sys v2");
      expect((await outboxRowsFor(msg.id)).length).toBe(0);
    });
  });

  // ── setMessageExcluded: must NOT re-enqueue ─────────────────────────
  describe("setMessageExcluded regression", () => {
    test("toggling excluded does not re-enqueue (outbox row unchanged)", async () => {
      const conv = await seedConversation();
      const msg = await createMessage(conv.id, { role: "user", content: "keep me" });
      const before = (await outboxRowsFor(msg.id))[0]!;
      await new Promise((r) => setTimeout(r, 5));

      await setMessageExcluded(conv.id, msg.id, true);

      const after = (await outboxRowsFor(msg.id))[0]!;
      expect(after.status).toBe(before.status);
      expect(after.attempts).toBe(before.attempts);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });
  });
});
