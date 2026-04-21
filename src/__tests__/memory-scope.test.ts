import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import type { MemoryProvenance } from "../memory/types";

mockDbConnection();
mockRealSettings();
mockEmbeddingsModule();

const { insertMemory, searchMemories } = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");
const { memories } = await import("../db/schema");
const { eq } = await import("drizzle-orm");

let projectAId: string;
let projectBId: string;
let conversationId: string;

const globalMemoryIds: string[] = [];
const projectAMemoryIds: string[] = [];
const projectBMemoryIds: string[] = [];
let archivedGlobalMemoryId: string;

async function insertTestMemory(content: string, opts?: { projectId?: string | null; category?: string; status?: string }) {
  const embedding = mockEmbedding();
  const provenance: MemoryProvenance = {
    sourceConversationId: conversationId,
    sourceMessageIds: ["msg-scope-test"],
    extractedAt: new Date(),
    confidence: "high",
    history: [{ action: "created", timestamp: new Date(), reason: "test" }],
  };
  const mem = await insertMemory({
    content,
    category: (opts?.category ?? "technical") as any,
    projectId: opts?.projectId ?? undefined,
    conversationId,
    messageIds: ["msg-scope-test"],
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

beforeAll(async () => {
  await setupTestDb();
  const projectA = await createProject({ name: "scope-test-a", path: "/tmp/scope-a" });
  const projectB = await createProject({ name: "scope-test-b", path: "/tmp/scope-b" });
  projectAId = projectA.id;
  projectBId = projectB.id;
  const conv = await createConversation(projectAId, { title: "scope conv" });
  conversationId = conv.id;

  // 3 global memories (projectId: null)
  for (const label of ["global-1", "global-2", "global-3"]) {
    const mem = await insertTestMemory(`Global memory ${label}`, { projectId: null });
    globalMemoryIds.push(mem.id);
  }

  // 3 Project A memories
  for (const label of ["a-1", "a-2", "a-3"]) {
    const mem = await insertTestMemory(`Project A memory ${label}`, { projectId: projectAId });
    projectAMemoryIds.push(mem.id);
  }

  // 2 Project B memories
  for (const label of ["b-1", "b-2"]) {
    const mem = await insertTestMemory(`Project B memory ${label}`, { projectId: projectBId });
    projectBMemoryIds.push(mem.id);
  }

  // 1 archived global memory
  const archived = await insertTestMemory("Archived global memory", { projectId: null, status: "archived" });
  archivedGlobalMemoryId = archived.id;
});

afterAll(async () => {
  await closeTestDb();
  try { const { restoreModuleMocks } = require("./helpers/mock-cleanup"); restoreModuleMocks(); } catch {}
});

describe("searchMemories scope filtering", () => {
  test("scope=all + projectId=A returns Project A + global memories, not Project B", async () => {
    const results = await searchMemories({ scope: "all", projectId: projectAId });
    const ids = results.map((m) => m.id);

    for (const id of projectAMemoryIds) expect(ids).toContain(id);
    for (const id of globalMemoryIds) expect(ids).toContain(id);
    for (const id of projectBMemoryIds) expect(ids).not.toContain(id);
  });

  test("scope=project + projectId=A returns only Project A memories", async () => {
    const results = await searchMemories({ scope: "project", projectId: projectAId });
    const ids = results.map((m) => m.id);

    for (const id of projectAMemoryIds) expect(ids).toContain(id);
    for (const id of globalMemoryIds) expect(ids).not.toContain(id);
    for (const id of projectBMemoryIds) expect(ids).not.toContain(id);
  });

  test("scope=global returns only global (null projectId) memories", async () => {
    const results = await searchMemories({ scope: "global" });
    const ids = results.map((m) => m.id);

    for (const id of globalMemoryIds) expect(ids).toContain(id);
    for (const id of projectAMemoryIds) expect(ids).not.toContain(id);
    for (const id of projectBMemoryIds) expect(ids).not.toContain(id);
  });

  test("scope=all + projectId=B returns Project B + global memories, not Project A", async () => {
    const results = await searchMemories({ scope: "all", projectId: projectBId });
    const ids = results.map((m) => m.id);

    for (const id of projectBMemoryIds) expect(ids).toContain(id);
    for (const id of globalMemoryIds) expect(ids).toContain(id);
    for (const id of projectAMemoryIds) expect(ids).not.toContain(id);
  });

  test("no scope + projectId=A returns only Project A memories (backward compat)", async () => {
    const results = await searchMemories({ projectId: projectAId });
    const ids = results.map((m) => m.id);

    for (const id of projectAMemoryIds) expect(ids).toContain(id);
    for (const id of globalMemoryIds) expect(ids).not.toContain(id);
    for (const id of projectBMemoryIds) expect(ids).not.toContain(id);
  });

  test("no scope + no projectId returns all non-archived memories", async () => {
    const results = await searchMemories({});
    const ids = results.map((m) => m.id);

    for (const id of globalMemoryIds) expect(ids).toContain(id);
    for (const id of projectAMemoryIds) expect(ids).toContain(id);
    for (const id of projectBMemoryIds) expect(ids).toContain(id);
    expect(ids).not.toContain(archivedGlobalMemoryId);
  });

  test("scope=global excludes archived global memories (default status filter)", async () => {
    const results = await searchMemories({ scope: "global" });
    const ids = results.map((m) => m.id);

    for (const id of globalMemoryIds) expect(ids).toContain(id);
    expect(ids).not.toContain(archivedGlobalMemoryId);
  });

  test("scope=all + category filter works together", async () => {
    // Insert a preferences memory in Project A and a global one
    const prefA = await insertTestMemory("Pref in A for scope test", { projectId: projectAId, category: "preferences" });
    const prefGlobal = await insertTestMemory("Pref global for scope test", { projectId: null, category: "preferences" });

    const results = await searchMemories({ scope: "all", projectId: projectAId, category: "preferences" });
    const ids = results.map((m) => m.id);

    expect(ids).toContain(prefA.id);
    expect(ids).toContain(prefGlobal.id);
    // Technical memories from Project A should not appear
    for (const id of projectAMemoryIds) expect(ids).not.toContain(id);
  });

  test("scope=project + search filter works together", async () => {
    const searchable = await insertTestMemory("Kubernetes deployment orchestration strategy", { projectId: projectAId });

    const results = await searchMemories({ scope: "project", projectId: projectAId, search: "Kubernetes deployment" });
    const ids = results.map((m) => m.id);

    expect(ids).toContain(searchable.id);
    // Global memories should not appear with scope=project
    for (const id of globalMemoryIds) expect(ids).not.toContain(id);
  });

  test("scope=all with no projectId returns all non-archived memories", async () => {
    const results = await searchMemories({ scope: "all" });
    const ids = results.map((m) => m.id);

    for (const id of globalMemoryIds) expect(ids).toContain(id);
    for (const id of projectAMemoryIds) expect(ids).toContain(id);
    for (const id of projectBMemoryIds) expect(ids).toContain(id);
    expect(ids).not.toContain(archivedGlobalMemoryId);
  });
});
