import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import type { MemoryProvenance } from "../memory/types";

// Mock pi-ai to simulate LLM unavailability — prevents leaked mocks from
// other test files (e.g. memory-integration) making complete() succeed.
mock.module("@earendil-works/pi-ai", () => ({
  complete: async () => { throw new Error("LLM not configured in test"); },
  stream: () => ({ [Symbol.asyncIterator]: async function* () {}, result: async () => { throw new Error("LLM not configured in test"); } }),
  getModel: () => { throw new Error("LLM not configured in test"); },
  getModels: () => [],
  getProviders: () => [],
  getEnvApiKey: () => undefined,
}));

// Re-establish real settings implementation — parallel tests mock this globally in Bun.
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      if (!rows[0]) return false;
      await getDb().delete(tbl).where(eq(tbl.key, key));
      return true;
    },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();
mockEmbeddingsModule();

const { insertMemory, searchMemories, getMemoryById } = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");
const { memoryAuditLog, memories, users } = await import("../db/schema");
const { eq } = await import("drizzle-orm");
const { upsertSetting } = await import("../db/queries/settings");
const { runCompaction, mergeContents } = await import("../memory/compaction");

const OWNER = "compaction-owner";
const OTHER_USER = "compaction-other";

let projectId: string;
let conversationId: string;
let otherConversationId: string;
let unownedConversationId: string;

// Controllable merge function for tests
let mergeShouldFail = false;
const testMergeFn = async (a: string, b: string) => {
  if (mergeShouldFail) return "";
  return `Merged: ${a} + ${b}`;
};

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values([
    { id: OWNER, email: "compaction-owner@test.local", name: "Compaction Owner", passwordHash: "fake-hash" },
    { id: OTHER_USER, email: "compaction-other@test.local", name: "Compaction Other", passwordHash: "fake-hash" },
  ]).onConflictDoNothing();
  const project = await createProject({ name: "compaction-test", path: "/tmp/compaction" });
  projectId = project.id;
  const conv = await createConversation(projectId, { title: "compaction conv", userId: OWNER });
  conversationId = conv.id;
  const otherConv = await createConversation(projectId, { title: "other user's conv", userId: OTHER_USER });
  otherConversationId = otherConv.id;
  const unowned = await createConversation(projectId, { title: "unowned conv" });
  unownedConversationId = unowned.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(async () => {
  const db = getDb();
  await db.delete(memoryAuditLog);
  await db.delete(memories);
  mergeShouldFail = false;
  // Clear the compaction lock so each test starts fresh
  const { deleteSetting } = await import("../db/queries/settings");
  await deleteSetting("compaction:lastRun");
});

async function insertTestMemory(content: string, opts?: { category?: string; status?: string; conversationId?: string | null }) {
  const embedding = mockEmbedding();
  const convId = opts?.conversationId === undefined ? conversationId : opts.conversationId;
  const provenance: MemoryProvenance = {
    sourceConversationId: convId ?? "",
    sourceMessageIds: ["msg-comp"],
    extractedAt: new Date(),
    confidence: "high",
    history: [{ action: "created", timestamp: new Date(), reason: "test" }],
  };
  const mem = await insertMemory({
    content,
    category: (opts?.category ?? "technical") as any,
    projectId,
    conversationId: convId,
    messageIds: ["msg-comp"],
    confidence: "high",
    embedding,
    provenance,
  });
  if (opts?.status && opts.status !== "active") {
    const db = getDb();
    await db.update(memories).set({ status: opts.status } as any).where(eq(memories.id, mem.id));
  }
  return mem;
}

describe("Memory Compaction", () => {
  test("runCompaction merges two similar active memories via LLM", async () => {
    const mem1 = await insertTestMemory("User prefers TypeScript for backend");
    const mem2 = await insertTestMemory("User likes TypeScript on the server");

    const mergedCount = await runCompaction(projectId, testMergeFn);
    expect(mergedCount).toBe(1);

    // Originals should be deleted
    const orig1 = await getMemoryById(mem1.id);
    const orig2 = await getMemoryById(mem2.id);
    expect(orig1).toBeUndefined();
    expect(orig2).toBeUndefined();

    // A new merged memory should exist
    const remaining = await searchMemories({ projectId, status: "active" });
    expect(remaining.length).toBe(1);

    const merged = remaining[0]!;
    expect(merged.content).toContain("Merged:");
    const prov = merged.provenance as MemoryProvenance;
    expect(prov.history).toBeDefined();
    expect(prov.history![0]!.action).toBe("merged");

    // The merged row is stamped with the resolved owner (ownership shape 1) —
    // without the stamp it has neither user_id nor conversation_id and the
    // user-scoped injection predicate in retrieval.ts can never return it.
    expect(merged.userId).toBe(OWNER);
  });

  test("runCompaction never merges across users — similar rows owned by different users both survive", async () => {
    const memOwner = await insertTestMemory("Cross-user similar fact");
    const memOther = await insertTestMemory("Cross-user similar fact too", { conversationId: otherConversationId });

    const mergedCount = await runCompaction(projectId, testMergeFn);
    expect(mergedCount).toBe(0);

    expect(await getMemoryById(memOwner.id)).toBeDefined();
    expect(await getMemoryById(memOther.id)).toBeDefined();
  });

  test("runCompaction skips memories with no resolvable owner (unowned conversation or no conversation)", async () => {
    const memUnownedConv = await insertTestMemory("Ownerless similar fact", { conversationId: unownedConversationId });
    const memNoConv = await insertTestMemory("Ownerless similar fact two", { conversationId: null });

    const mergedCount = await runCompaction(projectId, testMergeFn);
    expect(mergedCount).toBe(0);

    // Both rows survive untouched — merging them would create a row no
    // user-scoped read could ever see.
    expect(await getMemoryById(memUnownedConv.id)).toBeDefined();
    expect(await getMemoryById(memNoConv.id)).toBeDefined();
  });

  test("runCompaction skips memories without embeddings", async () => {
    const mem = await insertTestMemory("Memory without embedding");

    // Null out the embedding via raw SQL
    const db = getDb();
    await db.update(memories).set({ embedding: null } as any).where(eq(memories.id, mem.id));

    const mergedCount = await runCompaction(projectId, testMergeFn);
    expect(mergedCount).toBe(0);

    // Memory should still exist untouched
    const found = await getMemoryById(mem.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe("Memory without embedding");
  });

  test("runCompaction respects lock (skips if run < 60s ago)", async () => {
    await insertTestMemory("Lock test memory A");
    await insertTestMemory("Lock test memory B");

    // Set lock to now
    await upsertSetting("compaction:lastRun", new Date().toISOString());

    const mergedCount = await runCompaction(projectId, testMergeFn);
    expect(mergedCount).toBe(0);

    // Both memories should still exist
    const remaining = await searchMemories({ projectId, status: "active" });
    expect(remaining.length).toBe(2);
  });

  test("runCompaction skips if similar memory is not active", async () => {
    const active = await insertTestMemory("Active memory for stale test");
    await insertTestMemory("Stale memory for stale test", { status: "stale" });

    const mergedCount = await runCompaction(projectId, testMergeFn);
    expect(mergedCount).toBe(0);

    // Active memory should still exist
    const found = await getMemoryById(active.id);
    expect(found).toBeDefined();
  });

  test("runCompaction returns 0 when no similar memories found", async () => {
    await insertTestMemory("Only one memory exists");

    const mergedCount = await runCompaction(projectId, testMergeFn);
    expect(mergedCount).toBe(0);
  });

  test("merge failure causes compaction to skip the pair", async () => {
    mergeShouldFail = true;

    await insertTestMemory("LLM fail test A");
    await insertTestMemory("LLM fail test B");

    const mergedCount = await runCompaction(projectId, testMergeFn);
    expect(mergedCount).toBe(0);

    // Both originals should still exist since merge returned empty string
    const remaining = await searchMemories({ projectId, status: "active" });
    expect(remaining.length).toBe(2);
  });
});

describe("mergeContents", () => {
  test("returns empty string when LLM is unavailable", async () => {
    // mergeContents tries to import pi-ai complete() which won't be configured in test
    // It should catch the error and return ""
    const result = await mergeContents("fact A", "fact B");
    expect(result).toBe("");
  });
});
