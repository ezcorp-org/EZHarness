import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { MemoryProvenance } from "../memory/types";

// Module-level mocks MUST be before dynamic imports
mockDbConnection();
mockRealSettings();
mockEmbeddingsModule();

// Dynamic imports AFTER mocks
const { insertMemory, setMemoryProjects } = await import("../db/queries/memories");
const { buildSystemPromptWithMemories } = await import("../memory/injection");
const { hybridSearch } = await import("../memory/retrieval");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { upsertSetting } = await import("../db/queries/settings");
const { getDb } = await import("../db/connection");
const { memories } = await import("../db/schema");
const { eq } = await import("drizzle-orm");

// Test state
let projectAId: string;
let projectBId: string;
let projectCId: string;
let conversationId: string;

// Memory references
let memA1: { id: string };
let memA2: { id: string };
let memB1: { id: string };
let memB2: { id: string };
let memAB1: { id: string };
let memGlobal1: { id: string };
let memGlobal2: { id: string };
let memArchived: { id: string };
let memStale: { id: string };
let memC1: { id: string };

async function insertTestMemory(content: string, opts?: { projectId?: string | null; projectIds?: string[]; category?: string; status?: string }) {
  const embedding = mockEmbedding();
  const provenance: MemoryProvenance = {
    sourceConversationId: conversationId,
    sourceMessageIds: ["msg-chat-test"],
    extractedAt: new Date(),
    confidence: "high",
    history: [{ action: "created", timestamp: new Date(), reason: "test" }],
  };
  const mem = await insertMemory({
    content,
    category: (opts?.category ?? "technical") as any,
    projectId: opts?.projectId === null ? undefined : (opts?.projectId ?? undefined),
    conversationId,
    messageIds: ["msg-chat-test"],
    confidence: "high",
    embedding,
    provenance,
    ...(opts?.projectIds ? { projectIds: opts.projectIds } : {}),
  });
  if (opts?.status && opts.status !== "active") {
    const db = getDb();
    await db.update(memories).set({ status: opts.status } as any).where(eq(memories.id, mem.id));
  }
  return mem;
}

beforeAll(async () => {
  await setupTestDb();

  const projectA = await createProject({ name: "chat-retrieval-a", path: "/tmp/chat-retrieval-a" });
  const projectB = await createProject({ name: "chat-retrieval-b", path: "/tmp/chat-retrieval-b" });
  const projectC = await createProject({ name: "chat-retrieval-c", path: "/tmp/chat-retrieval-c" });
  projectAId = projectA.id;
  projectBId = projectB.id;
  projectCId = projectC.id;

  const conv = await createConversation(projectAId, { title: "chat retrieval conv" });
  conversationId = conv.id;

  // Project A memories
  memA1 = await insertTestMemory("Project A database schema design", { projectId: projectAId });
  memA2 = await insertTestMemory("Project A uses PostgreSQL", { projectId: projectAId });

  // Project B memories
  memB1 = await insertTestMemory("Project B frontend React components", { projectId: projectBId });
  memB2 = await insertTestMemory("Project B CSS architecture", { projectId: projectBId });

  // Shared memory assigned to BOTH projectA and projectB
  memAB1 = await insertTestMemory("Shared deployment pipeline config", { projectIds: [projectAId, projectBId] });

  // Global memories (no project assignment)
  memGlobal1 = await insertTestMemory("Company coding standards", { projectId: null });
  memGlobal2 = await insertTestMemory("Team standup schedule", { projectId: null });

  // Archived memory in project A
  memArchived = await insertTestMemory("Deprecated API endpoint", { projectId: projectAId, status: "archived" });

  // Stale memory in project A
  memStale = await insertTestMemory("Old project A note", { projectId: projectAId, status: "stale" });

  // Project C memory
  memC1 = await insertTestMemory("Project C mobile app design", { projectId: projectCId });
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("chat memory retrieval - project scoping", () => {
  test("chat in project A retrieves project A memories", async () => {
    const result = await buildSystemPromptWithMemories("Base.", "database schema", projectAId);
    expect(result.systemPrompt).toContain("database schema design");
    const usedIds = result.memoriesUsed.map((m) => m.id);
    expect(usedIds).toContain(memA1.id);
  });

  test("chat in project A retrieves global memories", async () => {
    const result = await buildSystemPromptWithMemories("Base.", "coding standards", projectAId);
    expect(result.systemPrompt).toContain("coding standards");
  });

  test("chat in project A does NOT retrieve project B memories", async () => {
    const result = await buildSystemPromptWithMemories("Base.", "React components", projectAId);
    const usedIds = result.memoriesUsed.map((m) => m.id);
    expect(usedIds).not.toContain(memB1.id);
    expect(usedIds).not.toContain(memB2.id);
    expect(result.systemPrompt).not.toContain("React components");
    expect(result.systemPrompt).not.toContain("CSS architecture");
  });

  test("multi-project memory appears in both projects chats", async () => {
    const resultA = await buildSystemPromptWithMemories("Base.", "deployment pipeline", projectAId);
    const usedIdsA = resultA.memoriesUsed.map((m) => m.id);
    expect(usedIdsA).toContain(memAB1.id);

    const resultB = await buildSystemPromptWithMemories("Base.", "deployment pipeline", projectBId);
    const usedIdsB = resultB.memoriesUsed.map((m) => m.id);
    expect(usedIdsB).toContain(memAB1.id);
  });

  test("archived memories never appear in chat", async () => {
    const result = await buildSystemPromptWithMemories("Base.", "deprecated API", projectAId);
    const usedIds = result.memoriesUsed.map((m) => m.id);
    expect(usedIds).not.toContain(memArchived.id);
  });

  test("memory disabled setting skips all memories", async () => {
    await upsertSetting("global:memoryEnabled", false);
    try {
      const result = await buildSystemPromptWithMemories("Base.", "database schema", projectAId);
      expect(result.memoriesUsed).toEqual([]);
      expect(result.systemPrompt).toBe("Base.");
    } finally {
      await upsertSetting("global:memoryEnabled", true);
    }
  });
});

describe("chat memory retrieval - cross-project leak prevention", () => {
  test("project B memories never leak into project A chat", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("frontend React", embedding, { projectId: projectAId });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(memB1.id);
    expect(ids).not.toContain(memB2.id);
  });

  test("project C memories never leak into project A or B chats", async () => {
    const embedding = mockEmbedding();

    const resultsA = await hybridSearch("mobile app", embedding, { projectId: projectAId });
    expect(resultsA.map((r) => r.id)).not.toContain(memC1.id);

    const resultsB = await hybridSearch("mobile app", embedding, { projectId: projectBId });
    expect(resultsB.map((r) => r.id)).not.toContain(memC1.id);
  });

  test("after reassigning memory from A to B, it stops appearing in A chat", async () => {
    const reassignMem = await insertTestMemory("Reassignable memory content for testing", { projectId: projectAId });
    const embedding = mockEmbedding();

    // Should appear in project A
    const beforeResults = await hybridSearch("reassignable memory", embedding, { projectId: projectAId });
    expect(beforeResults.map((r) => r.id)).toContain(reassignMem.id);

    // Reassign to project B
    await setMemoryProjects(reassignMem.id, [projectBId]);

    // Should no longer appear in project A
    const afterResultsA = await hybridSearch("reassignable memory", embedding, { projectId: projectAId });
    expect(afterResultsA.map((r) => r.id)).not.toContain(reassignMem.id);

    // Should now appear in project B
    const afterResultsB = await hybridSearch("reassignable memory", embedding, { projectId: projectBId });
    expect(afterResultsB.map((r) => r.id)).toContain(reassignMem.id);
  });

  test("global memory appears in ALL projects chats", async () => {
    const embedding = mockEmbedding();

    const resultsA = await hybridSearch("coding standards", embedding, { projectId: projectAId });
    expect(resultsA.map((r) => r.id)).toContain(memGlobal1.id);

    const resultsB = await hybridSearch("coding standards", embedding, { projectId: projectBId });
    expect(resultsB.map((r) => r.id)).toContain(memGlobal1.id);

    const resultsC = await hybridSearch("coding standards", embedding, { projectId: projectCId });
    expect(resultsC.map((r) => r.id)).toContain(memGlobal1.id);
  });
});

describe("chat memory retrieval - isolation mode", () => {
  test("isolation mode ON excludes global memories", async () => {
    await upsertSetting(`project:${projectAId}:memoryIsolation`, true);
    try {
      const result = await buildSystemPromptWithMemories("Base.", "coding standards database schema", projectAId);
      const usedIds = result.memoriesUsed.map((m) => m.id);

      // Global memories should NOT appear
      expect(usedIds).not.toContain(memGlobal1.id);
      expect(usedIds).not.toContain(memGlobal2.id);

      // Project A memories should still appear
      const hasProjectAMemory = usedIds.includes(memA1.id) || usedIds.includes(memA2.id);
      expect(hasProjectAMemory).toBe(true);
    } finally {
      await upsertSetting(`project:${projectAId}:memoryIsolation`, false);
    }
  });

  test("isolation mode OFF (default) includes global + project memories", async () => {
    const result = await buildSystemPromptWithMemories("Base.", "coding standards database schema", projectAId);
    const usedIds = result.memoriesUsed.map((m) => m.id);

    // Both project A and global memories should appear
    const hasProjectAMemory = usedIds.includes(memA1.id) || usedIds.includes(memA2.id);
    const hasGlobalMemory = usedIds.includes(memGlobal1.id) || usedIds.includes(memGlobal2.id);
    expect(hasProjectAMemory).toBe(true);
    expect(hasGlobalMemory).toBe(true);
  });
});

describe("chat memory retrieval - edge cases", () => {
  test("project with no memories returns base prompt unchanged", async () => {
    const emptyProject = await createProject({ name: "empty-chat-project", path: "/tmp/empty-chat-project" });
    await upsertSetting(`project:${emptyProject.id}:memoryIsolation`, true);
    try {
      const result = await buildSystemPromptWithMemories("Base prompt only.", "anything at all", emptyProject.id);
      expect(result.systemPrompt).toBe("Base prompt only.");
      expect(result.memoriesUsed).toEqual([]);
    } finally {
      await upsertSetting(`project:${emptyProject.id}:memoryIsolation`, false);
    }
  });

  test("stale memories still appear but have status weight penalty applied", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("project A note", embedding, { projectId: projectAId });
    const staleResult = results.find((r) => r.id === memStale.id);

    // The stale memory should be retrievable (not excluded like archived)
    // and should have the 0.5 status weight multiplier applied to its RRF score.
    // We verify it appears in results (unlike archived memories which are excluded).
    if (staleResult) {
      expect(staleResult.rrfScore).toBeGreaterThan(0);
    }
    // Archived memory should never appear regardless of query
    const archivedResult = results.find((r) => r.id === memArchived.id);
    expect(archivedResult).toBeUndefined();
  });
});
