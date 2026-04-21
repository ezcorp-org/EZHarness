import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { MemoryProvenance } from "../memory/types";

mockDbConnection();
mockRealSettings();
mockEmbeddingsModule();

// Dynamic imports AFTER mocks
const { insertMemory, hasMemories } = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");

let projectAId: string;
let projectBId: string;
let emptyProjectId: string;
let conversationId: string;

async function insertTestMemory(content: string, opts?: { projectId?: string | null; projectIds?: string[]; category?: string; status?: string }) {
  const embedding = mockEmbedding();
  const provenance: MemoryProvenance = {
    sourceConversationId: conversationId,
    sourceMessageIds: ["msg-test"],
    extractedAt: new Date(),
    confidence: "high",
    history: [{ action: "created", timestamp: new Date(), reason: "test" }],
  };
  const mem = await insertMemory({
    content,
    category: (opts?.category ?? "technical") as any,
    projectId: opts?.projectId === null ? undefined : (opts?.projectId ?? undefined),
    conversationId,
    messageIds: ["msg-test"],
    confidence: "high",
    embedding,
    provenance,
    ...(opts?.projectIds ? { projectIds: opts.projectIds } : {}),
  });
  if (opts?.status && opts.status !== "active") {
    const db = getDb();
    const { memories } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(memories).set({ status: opts.status } as any).where(eq(memories.id, mem.id));
  }
  return mem;
}

describe("hasMemories fast-path check", () => {
  beforeAll(async () => {
    await setupTestDb();

    const projA = await createProject({ name: "Has Memories A", path: "/has-mem-a" });
    const projB = await createProject({ name: "Has Memories B", path: "/has-mem-b" });
    const emptyProj = await createProject({ name: "Empty Project", path: "/empty" });
    projectAId = projA.id;
    projectBId = projB.id;
    emptyProjectId = emptyProj.id;

    const conv = await createConversation(projectAId, { title: "has-mem-test" });
    conversationId = conv.id;
  });

  afterAll(async () => {
    await closeTestDb();
    restoreModuleMocks();
  });

  test("returns false for empty project with no global memories", async () => {
    // Run first — before any memories are inserted
    const result = await hasMemories(emptyProjectId);
    expect(result).toBe(false);
  });

  test("returns true when project has memories via junction table", async () => {
    await insertTestMemory("Project A technical decision", { projectId: projectAId });
    const result = await hasMemories(projectAId);
    expect(result).toBe(true);
  });

  test("returns true when global memories exist", async () => {
    await insertTestMemory("Global coding standard", { projectId: null });
    // hasMemories checks for project memories OR global memories (no junction rows)
    const result = await hasMemories(projectBId);
    expect(result).toBe(true);
  });

  test("returns false when all memories are archived", async () => {
    // Create a fresh project with only an archived memory
    const freshProj = await createProject({ name: "Archived Only", path: "/archived-only" });

    // We need to clean up global memories that would cause true — but we can't easily
    // isolate this since global memories from other tests exist.
    // Instead, test that a project with ONLY archived project-scoped memories
    // does not contribute to hasMemories via the junction path.
    // The global memories will make hasMemories return true regardless,
    // so we verify the archived memory itself doesn't count.
    const archivedMem = await insertTestMemory("Archived content for fresh project", {
      projectId: freshProj.id,
      status: "archived",
    });

    // Delete the global memory we inserted earlier so it doesn't interfere
    const db = getDb();
    const { sql } = await import("drizzle-orm");

    // Remove all global memories (no junction table entries) to isolate this test
    await db.execute(
      sql`DELETE FROM memories WHERE id NOT IN (SELECT memory_id FROM memory_projects) AND id != ${archivedMem.id}`,
    );

    // Now freshProj has only an archived memory — hasMemories should be false
    // (assuming no other active/stale memories assigned to freshProj and no global active memories)
    // But projectA memories still exist, so global check is clean.
    // We need to ensure no global (unassigned) active memories remain.
    const result = await hasMemories(freshProj.id);
    expect(result).toBe(false);
  });

  test("returns true for multi-project memory assigned to queried project", async () => {
    await insertTestMemory("Shared multi-project knowledge", {
      projectIds: [projectAId, projectBId],
    });

    const resultA = await hasMemories(projectAId);
    expect(resultA).toBe(true);

    const resultB = await hasMemories(projectBId);
    expect(resultB).toBe(true);
  });

  test("returns false when only other projects have memories", async () => {
    // Create a completely isolated project
    const isolatedProj = await createProject({ name: "Isolated", path: "/isolated" });

    // Ensure no global (unassigned) active memories exist
    const db = getDb();
    const { sql } = await import("drizzle-orm");
    await db.execute(
      sql`DELETE FROM memories WHERE id NOT IN (SELECT memory_id FROM memory_projects)`,
    );

    // Only projectA and projectB have memories — isolatedProj should return false
    const result = await hasMemories(isolatedProj.id);
    expect(result).toBe(false);
  });
});
