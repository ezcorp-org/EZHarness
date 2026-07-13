/**
 * DB-layer tests for `src/db/queries/contexts.ts` (topic contexts).
 *
 * Real PGlite via `setupTestDb`; `mockDbConnection()` swaps the
 * `db/connection` module before the query module is imported. Pattern
 * mirrors queries-lessons.test.ts.
 *
 * Covers:
 *   - migrate ×2 → context_types seed idempotent (10 rows, no dup/throw)
 *   - listContextTypes ordered by sort_order
 *   - getTopics / getTopic empty + found paths
 *   - replaceTopics: insert / keep-id-on-survive / delete-missing /
 *     lower-label dedupe / guard
 *   - getTopicState + upsertTopicState insert AND update
 *   - upsertSavedContext insert + conflict-update; guards
 *   - getSavedContext / deleteSavedContext found + not-found
 *   - searchContexts: each filter alone + combined + ILIKE-escape +
 *     limit clamp + offset + total
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { conversations, messages } from "../db/schema";
import { migrate } from "../db/migrate";

mockDbConnection();

const {
  listContextTypes,
  getTopics,
  getTopic,
  replaceTopics,
  getTopicState,
  upsertTopicState,
  getMessageWatermark,
  upsertSavedContext,
  getSavedContext,
  deleteSavedContext,
  searchContexts,
} = await import("../db/queries/contexts");
const { createProject } = await import("../db/queries/projects");
const { createUser } = await import("../db/queries/users");

async function makeConversation(projectId: string, userId: string): Promise<string> {
  const rows = await getTestDb()
    .insert(conversations)
    .values({ projectId, userId, title: "T" })
    .returning({ id: conversations.id });
  return rows[0]!.id as string;
}

async function makeMessage(convId: string, createdAt: Date): Promise<string> {
  const rows = await getTestDb()
    .insert(messages)
    .values({ conversationId: convId, role: "user", content: "hi", createdAt })
    .returning({ id: messages.id });
  return rows[0]!.id as string;
}

describe("contexts queries", () => {
  let projectId: string;
  let otherProjectId: string;
  let userId: string;
  let otherUserId: string;
  let conversationId: string;

  beforeEach(async () => {
    await setupTestDb();
    const p = await createProject({ name: "alpha", path: "/tmp/alpha" });
    projectId = p.id;
    const p2 = await createProject({ name: "beta", path: "/tmp/beta" });
    otherProjectId = p2.id;
    const u = await createUser({ email: "owner@test.com", passwordHash: "h", name: "Owner" });
    userId = u.id;
    const u2 = await createUser({ email: "other@test.com", passwordHash: "h", name: "Other" });
    otherUserId = u2.id;
    conversationId = await makeConversation(projectId, userId);
  });
  afterAll(async () => await closeTestDb());

  // ── context_types + migrate idempotency ──────────────────────────────
  describe("context_types seed", () => {
    test("listContextTypes returns 10 rows ordered by sort_order", async () => {
      const types = await listContextTypes();
      expect(types).toHaveLength(10);
      expect(types[0]!.id).toBe("feature");
      expect(types[0]!.sortOrder).toBe(1);
      expect(types[9]!.id).toBe("plan");
      expect(types[9]!.sortOrder).toBe(10);
      // strictly ascending sort_order
      const orders = types.map((t) => t.sortOrder);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
    });

    test("re-running migrate is idempotent (still 10 rows, no throw)", async () => {
      await migrate(getTestDb());
      await migrate(getTestDb());
      const types = await listContextTypes();
      expect(types).toHaveLength(10);
    });
  });

  // ── message watermark (lightweight staleness inputs for GET topics) ────
  describe("getMessageWatermark", () => {
    test("empty conversationId → zero count, null last id (guard)", async () => {
      expect(await getMessageWatermark("")).toEqual({ count: 0, lastMessageId: null });
    });

    test("conversation with no messages → zero count, null last id", async () => {
      expect(await getMessageWatermark(conversationId)).toEqual({
        count: 0,
        lastMessageId: null,
      });
    });

    test("counts messages and reports the newest message id", async () => {
      await makeMessage(conversationId, new Date("2026-01-01T00:00:00Z"));
      await makeMessage(conversationId, new Date("2026-01-01T00:01:00Z"));
      const newest = await makeMessage(conversationId, new Date("2026-01-01T00:02:00Z"));
      // A message in a DIFFERENT conversation must not leak into the count.
      const otherConv = await makeConversation(otherProjectId, otherUserId);
      await makeMessage(otherConv, new Date("2026-01-01T00:03:00Z"));

      expect(await getMessageWatermark(conversationId)).toEqual({
        count: 3,
        lastMessageId: newest,
      });
    });
  });

  // ── conversation_topics ──────────────────────────────────────────────
  describe("getTopics / getTopic", () => {
    test("getTopics returns [] for empty conversationId", async () => {
      expect(await getTopics("")).toEqual([]);
    });

    test("getTopics returns [] when none detected", async () => {
      expect(await getTopics(conversationId)).toEqual([]);
    });

    test("getTopic returns undefined for empty args", async () => {
      expect(await getTopic("", "x")).toBeUndefined();
      expect(await getTopic(conversationId, "")).toBeUndefined();
    });

    test("getTopic returns undefined for missing topic", async () => {
      expect(await getTopic(conversationId, "nope")).toBeUndefined();
    });

    test("getTopic scopes by conversation", async () => {
      const [topic] = await replaceTopics(conversationId, [
        { label: "Auth", typeId: "feature", messageIds: ["m1"] },
      ]);
      const other = await makeConversation(projectId, userId);
      // Same id, wrong conversation → not found.
      expect(await getTopic(other, topic!.id)).toBeUndefined();
      expect((await getTopic(conversationId, topic!.id))?.label).toBe("Auth");
    });
  });

  describe("replaceTopics", () => {
    test("throws without conversationId", async () => {
      await expect(replaceTopics("", [])).rejects.toThrow("conversationId is required");
    });

    test("inserts new topics", async () => {
      const rows = await replaceTopics(conversationId, [
        { label: "Auth", typeId: "feature", messageIds: ["m1", "m2"] },
        { label: "Caching", typeId: "idea", messageIds: ["m3"] },
      ]);
      expect(rows).toHaveLength(2);
      const auth = rows.find((r) => r.label === "Auth")!;
      expect(auth.typeId).toBe("feature");
      expect(auth.messageIds).toEqual(["m1", "m2"]);
    });

    test("keeps row id for a surviving label + deletes missing, transactionally", async () => {
      const first = await replaceTopics(conversationId, [
        { label: "Auth", typeId: "feature", messageIds: ["m1"] },
        { label: "Caching", typeId: "idea", messageIds: ["m2"] },
      ]);
      const authId = first.find((r) => r.label === "Auth")!.id;

      const second = await replaceTopics(conversationId, [
        // Auth survives (different casing + updated type/messageIds) — same id.
        { label: "auth", typeId: "decision", messageIds: ["m1", "m9"] },
        // Caching dropped; Logging is new.
        { label: "Logging", typeId: "how-to", messageIds: ["m5"] },
      ]);
      expect(second).toHaveLength(2);
      const survived = second.find((r) => r.label.toLowerCase() === "auth")!;
      expect(survived.id).toBe(authId); // stable pill id
      expect(survived.label).toBe("auth"); // casing refreshed
      expect(survived.typeId).toBe("decision");
      expect(survived.messageIds).toEqual(["m1", "m9"]);
      expect(second.some((r) => r.label === "Caching")).toBe(false); // deleted
      expect(second.some((r) => r.label === "Logging")).toBe(true); // inserted
    });

    test("dedupes incoming by lower(label), last wins", async () => {
      const rows = await replaceTopics(conversationId, [
        { label: "Auth", typeId: "feature", messageIds: ["a"] },
        { label: "auth", typeId: "bug-fix", messageIds: ["b"] },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.typeId).toBe("bug-fix");
      expect(rows[0]!.messageIds).toEqual(["b"]);
    });

    test("empty topic set clears all", async () => {
      await replaceTopics(conversationId, [
        { label: "Auth", typeId: "feature", messageIds: ["m1"] },
      ]);
      const cleared = await replaceTopics(conversationId, []);
      expect(cleared).toEqual([]);
      expect(await getTopics(conversationId)).toEqual([]);
    });
  });

  // ── conversation_topic_state ─────────────────────────────────────────
  describe("topic state", () => {
    test("getTopicState undefined for empty + missing", async () => {
      expect(await getTopicState("")).toBeUndefined();
      expect(await getTopicState(conversationId)).toBeUndefined();
    });

    test("upsertTopicState throws without conversationId", async () => {
      await expect(
        upsertTopicState("", { lastMessageId: null, messageCount: 0, model: null }),
      ).rejects.toThrow("conversationId is required");
    });

    test("upsertTopicState inserts then updates the same row", async () => {
      const inserted = await upsertTopicState(conversationId, {
        lastMessageId: "m1",
        messageCount: 3,
        model: "local/qwen3:1.7b",
      });
      expect(inserted.conversationId).toBe(conversationId);
      expect(inserted.messageCount).toBe(3);
      expect(inserted.lastMessageId).toBe("m1");
      expect(inserted.model).toBe("local/qwen3:1.7b");

      const updated = await upsertTopicState(conversationId, {
        lastMessageId: "m7",
        messageCount: 8,
        model: null,
      });
      expect(updated.messageCount).toBe(8);
      expect(updated.lastMessageId).toBe("m7");
      expect(updated.model).toBeNull();

      // Still exactly one row (PK on conversation_id).
      const fetched = await getTopicState(conversationId);
      expect(fetched?.messageCount).toBe(8);
    });
  });

  // ── saved_contexts ───────────────────────────────────────────────────
  const baseSaved = () => ({
    userId,
    projectId,
    conversationId,
    topicLabel: "Auth flow",
    typeId: "feature",
    title: "Auth flow",
    content: "# Auth\nDetails.",
    model: "local/qwen3:1.7b",
    messageCount: 4,
  });

  describe("upsertSavedContext", () => {
    test("guards required ids", async () => {
      await expect(
        upsertSavedContext({ ...baseSaved(), userId: "" }),
      ).rejects.toThrow("userId is required");
      await expect(
        upsertSavedContext({ ...baseSaved(), conversationId: "" }),
      ).rejects.toThrow("conversationId is required");
    });

    test("inserts a new snapshot", async () => {
      const row = await upsertSavedContext(baseSaved());
      expect(row.id).toBeDefined();
      expect(row.userId).toBe(userId);
      expect(row.topicLabel).toBe("Auth flow");
      expect(row.content).toBe("# Auth\nDetails.");
      expect(row.messageCount).toBe(4);
    });

    test("re-extract upserts (same id, latest content wins, no dup)", async () => {
      const first = await upsertSavedContext(baseSaved());
      const second = await upsertSavedContext({
        ...baseSaved(),
        typeId: "decision",
        title: "Auth flow v2",
        content: "# Auth v2",
        model: "anthropic/claude",
        messageCount: 9,
      });
      expect(second.id).toBe(first.id); // upsert, not a new row
      expect(second.typeId).toBe("decision");
      expect(second.title).toBe("Auth flow v2");
      expect(second.content).toBe("# Auth v2");
      expect(second.messageCount).toBe(9);
      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime()); // preserved

      const { total } = await searchContexts({ userId });
      expect(total).toBe(1);
    });
  });

  describe("getSavedContext / deleteSavedContext", () => {
    test("getSavedContext undefined for empty + missing", async () => {
      expect(await getSavedContext("")).toBeUndefined();
      expect(await getSavedContext("nope")).toBeUndefined();
    });

    test("delete found → true, then gone", async () => {
      const row = await upsertSavedContext(baseSaved());
      expect((await getSavedContext(row.id))?.id).toBe(row.id);
      expect(await deleteSavedContext(row.id)).toBe(true);
      expect(await getSavedContext(row.id)).toBeUndefined();
    });

    test("delete not-found → false; empty id → false", async () => {
      expect(await deleteSavedContext("nope")).toBe(false);
      expect(await deleteSavedContext("")).toBe(false);
    });
  });

  describe("searchContexts", () => {
    beforeEach(async () => {
      // Seed a spread of rows across user/project/type/content.
      await upsertSavedContext({
        userId, projectId, conversationId,
        topicLabel: "Auth flow", typeId: "feature",
        title: "Auth flow", content: "JWT refresh rotation", model: null, messageCount: 1,
      });
      const conv2 = await makeConversation(otherProjectId, userId);
      await upsertSavedContext({
        userId, projectId: otherProjectId, conversationId: conv2,
        topicLabel: "Caching layer", typeId: "idea",
        title: "Caching layer", content: "Redis TTL policy", model: null, messageCount: 2,
      });
      const conv3 = await makeConversation(projectId, otherUserId);
      await upsertSavedContext({
        userId: otherUserId, projectId, conversationId: conv3,
        topicLabel: "Other user topic", typeId: "feature",
        title: "Other user topic", content: "Unrelated", model: null, messageCount: 3,
      });
    });

    test("userId filter returns only that user's rows", async () => {
      const { contexts, total } = await searchContexts({ userId });
      expect(total).toBe(2);
      expect(contexts.every((c) => c.userId === userId)).toBe(true);
    });

    test("no filters returns all rows (admin view)", async () => {
      const { total } = await searchContexts({});
      expect(total).toBe(3);
    });

    test("projectId filter", async () => {
      const { contexts, total } = await searchContexts({ userId, projectId: otherProjectId });
      expect(total).toBe(1);
      expect(contexts[0]!.topicLabel).toBe("Caching layer");
    });

    test("typeId filter", async () => {
      const { total } = await searchContexts({ userId, typeId: "idea" });
      expect(total).toBe(1);
    });

    test("search ILIKE over title + content", async () => {
      const byContent = await searchContexts({ userId, search: "redis" });
      expect(byContent.total).toBe(1);
      expect(byContent.contexts[0]!.topicLabel).toBe("Caching layer");
      const byTitle = await searchContexts({ userId, search: "auth" });
      expect(byTitle.total).toBe(1);
    });

    test("combined filters", async () => {
      const { total } = await searchContexts({
        userId, projectId, typeId: "feature", search: "jwt",
      });
      expect(total).toBe(1);
    });

    test("ILIKE-escapes % and _ (literal match, no wildcard)", async () => {
      const conv = await makeConversation(projectId, userId);
      await upsertSavedContext({
        userId, projectId, conversationId: conv,
        topicLabel: "Percent", typeId: "fact",
        title: "50% done_now", content: "literal", model: null, messageCount: 1,
      });
      // A literal "%_" must match only the row containing that exact text —
      // if unescaped it would be a wildcard matching every row.
      const { total } = await searchContexts({ userId, search: "%" });
      expect(total).toBe(1);
      const underscore = await searchContexts({ userId, search: "done_now" });
      expect(underscore.total).toBe(1);
    });

    test("limit clamps to [1,100] and offset paginates", async () => {
      const page1 = await searchContexts({ userId: undefined, limit: 1, offset: 0 });
      expect(page1.contexts).toHaveLength(1);
      expect(page1.total).toBe(3);
      const page2 = await searchContexts({ limit: 1, offset: 1 });
      expect(page2.contexts).toHaveLength(1);
      expect(page2.contexts[0]!.id).not.toBe(page1.contexts[0]!.id);

      // Over-max clamps to 100 (all 3 fit); under-min clamps to 1.
      const big = await searchContexts({ limit: 999 });
      expect(big.contexts).toHaveLength(3);
      const tiny = await searchContexts({ limit: 0 });
      expect(tiny.contexts).toHaveLength(1);
      // Negative offset floored to 0.
      const negOffset = await searchContexts({ offset: -5 });
      expect(negOffset.contexts).toHaveLength(3);
    });
  });
});
