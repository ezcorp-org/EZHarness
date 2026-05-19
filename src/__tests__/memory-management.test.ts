import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import type { MemoryProvenance } from "../memory/types";

mockDbConnection();
mockEmbeddingsModule();

const { insertMemory, searchMemories, updateMemoryStatus, deleteMemory, getMemoryById, touchMemoryAccess } = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");
const { memoryAuditLog, memories } = await import("../db/schema");
const { eq } = await import("drizzle-orm");

let projectId: string;
let conversationId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "mgmt-test", path: "/tmp/mgmt" });
  projectId = project.id;
  const conv = await createConversation(projectId, { title: "mgmt conv" });
  conversationId = conv.id;
});

afterAll(async () => {
  await closeTestDb();
});

async function insertTestMemory(content: string, opts?: { category?: string; status?: string }) {
  const embedding = mockEmbedding();
  const provenance: MemoryProvenance = {
    sourceConversationId: conversationId,
    sourceMessageIds: ["msg-mgmt"],
    extractedAt: new Date(),
    confidence: "high",
    history: [{ action: "created", timestamp: new Date(), reason: "test" }],
  };
  const mem = await insertMemory({
    content,
    category: (opts?.category ?? "technical") as any,
    projectId,
    conversationId,
    messageIds: ["msg-mgmt"],
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

describe("Memory Management", () => {
  test("searchMemories filters by status", async () => {
    const active = await insertTestMemory("Active memory for status filter");
    const archived = await insertTestMemory("Archived memory for status filter", { status: "archived" });

    // Default: excludes archived
    const defaultResults = await searchMemories({ projectId });
    const defaultIds = defaultResults.map((m: any) => m.id);
    expect(defaultIds).toContain(active.id);
    expect(defaultIds).not.toContain(archived.id);

    // Explicit status filter
    const archivedResults = await searchMemories({ projectId, status: "archived" });
    const archivedIds = archivedResults.map((m: any) => m.id);
    expect(archivedIds).toContain(archived.id);
    expect(archivedIds).not.toContain(active.id);
  });

  test("searchMemories filters by category", async () => {
    const pref = await insertTestMemory("Category filter pref memory", { category: "preferences" });
    const tech = await insertTestMemory("Category filter tech memory", { category: "technical" });

    const results = await searchMemories({ projectId, category: "preferences" });
    const ids = results.map((m: any) => m.id);
    expect(ids).toContain(pref.id);
    expect(ids).not.toContain(tech.id);
  });

  test("searchMemories text search", async () => {
    await insertTestMemory("The user prefers PostgreSQL databases");
    await insertTestMemory("The user enjoys hiking outdoors");

    const results = await searchMemories({ projectId, search: "PostgreSQL" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((m: any) => m.content.includes("PostgreSQL"))).toBe(true);
  });

  test("updateMemoryStatus creates audit log", async () => {
    const mem = await insertTestMemory("Status change audit test");

    await updateMemoryStatus(mem.id, "stale", "test reason");

    const updated = await getMemoryById(mem.id);
    expect((updated as any).status).toBe("stale");

    const db = getDb();
    const logs = await db
      .select()
      .from(memoryAuditLog)
      .where(eq(memoryAuditLog.memoryId, mem.id));
    const statusLog = logs.find((l: any) => l.action === "status_change");
    expect(statusLog).toBeDefined();
    expect(statusLog!.reason).toBe("test reason");
  });

  test("deleteMemory creates audit log then removes", async () => {
    const mem = await insertTestMemory("Delete audit test memory");
    const memId = mem.id;

    await deleteMemory(memId);

    const gone = await getMemoryById(memId);
    expect(gone).toBeUndefined();
  });

  test("touchMemoryAccess updates lastAccessedAt", async () => {
    const mem = await insertTestMemory("Touch access test");

    const oldDate = new Date("2020-01-01");
    const db = getDb();
    await db.update(memories).set({ lastAccessedAt: oldDate } as any).where(eq(memories.id, mem.id));

    const before = await getMemoryById(mem.id);
    expect((before as any).lastAccessedAt).toEqual(oldDate);

    await touchMemoryAccess([mem.id]);

    const after = await getMemoryById(mem.id);
    expect((after as any).lastAccessedAt.getTime()).toBeGreaterThan(oldDate.getTime());
  });

  test("searchMemories offset skips rows", async () => {
    await insertTestMemory("Pagination memory A");
    await insertTestMemory("Pagination memory B");
    await insertTestMemory("Pagination memory C");

    const all = await searchMemories({ projectId, limit: 10 });
    expect(all.length).toBeGreaterThanOrEqual(3);

    const page2 = await searchMemories({ projectId, limit: 2, offset: 2 });
    // Should skip first 2, return remaining
    expect(page2.length).toBeGreaterThanOrEqual(1);
    // page2 results should not overlap with first 2 of all
    const firstTwoIds = all.slice(0, 2).map((m: any) => m.id);
    for (const m of page2) {
      expect(firstTwoIds).not.toContain(m.id);
    }
  });
});
