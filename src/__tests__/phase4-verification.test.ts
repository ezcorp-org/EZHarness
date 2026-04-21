/**
 * Phase 4: Memory Management & Knowledge Base — Verification Tests
 *
 * Covers all 6 requirements: MEM-05, MEM-06, KNOW-01, KNOW-02, KNOW-03, KNOW-04
 * Evidence file for v1.0 milestone audit closure.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  insertMemory,
  listMemories,
  searchMemories,
  updateMemory,
  deleteMemory,
  getMemoryById,
  updateMemoryStatus,
} from "../db/queries/memories";
import {
  insertKBFile,
  getKBFile,
  listKBFiles,
  deleteKBFile,
  insertKBChunk,
  searchKBChunks,
} from "../db/queries/knowledge-base";
import { computeStatus } from "../memory/lifecycle";
import { searchKBChunksForQuery } from "../memory/retrieval";
import { createProject } from "../db/queries/projects";

// ── Shared setup ──

let projectId: string;

const testEmbedding = Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.1);

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Phase4 Verification", path: "/tmp/p4-verify" });
  projectId = project.id;
});

afterAll(async () => {
  await closeTestDb();
});

// ── MEM-05: Memory CRUD ─────────────────────────────────────────────────

describe("MEM-05: Memory CRUD", () => {
  let memoryId: string;

  test("insertMemory creates and listMemories returns it", async () => {
    const memory = await insertMemory({
      content: "User prefers dark mode for all applications",
      category: "preferences",
      projectId,
      confidence: "high",
    });
    memoryId = memory.id;
    expect(memory.id).toBeDefined();
    expect(memory.content).toBe("User prefers dark mode for all applications");
    expect(memory.category).toBe("preferences");

    const list = await listMemories({ projectId });
    const found = list.find((m) => m.id === memoryId);
    expect(found).toBeDefined();
    expect(found!.content).toBe("User prefers dark mode for all applications");
  });

  test("searchMemories finds memory by content substring", async () => {
    const results = await searchMemories({ search: "dark mode", projectId });
    const found = results.find((m) => m.id === memoryId);
    expect(found).toBeDefined();
    expect(found!.content).toContain("dark mode");
  });

  test("updateMemory changes content", async () => {
    await updateMemory(memoryId, { content: "User prefers light mode instead" });
    const updated = await getMemoryById(memoryId);
    expect(updated).toBeDefined();
    expect(updated!.content).toBe("User prefers light mode instead");
  });

  test("deleteMemory removes it and getMemoryById returns undefined", async () => {
    await deleteMemory(memoryId);
    const deleted = await getMemoryById(memoryId);
    expect(deleted).toBeUndefined();
  });
});

// ── MEM-06: Lifecycle States ────────────────────────────────────────────

describe("MEM-06: Lifecycle States", () => {
  test("computeStatus returns correct status for different ages", () => {
    const now = new Date();
    expect(computeStatus(now)).toBe("active");

    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    expect(computeStatus(thirtyOneDaysAgo)).toBe("stale");

    const sixtyOneDaysAgo = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000);
    expect(computeStatus(sixtyOneDaysAgo)).toBe("archived");
  });

  test("updateMemoryStatus transitions status and persists", async () => {
    const memory = await insertMemory({
      content: "Lifecycle test memory",
      category: "technical",
      projectId,
      confidence: "medium",
    });
    expect(memory.status).toBe("active");

    await updateMemoryStatus(memory.id, "stale", "auto-decay test");
    const stale = await getMemoryById(memory.id);
    expect(stale).toBeDefined();
    expect(stale!.status).toBe("stale");

    await updateMemoryStatus(memory.id, "archived", "auto-decay test");
    const archived = await getMemoryById(memory.id);
    expect(archived).toBeDefined();
    expect(archived!.status).toBe("archived");

    // Cleanup
    await deleteMemory(memory.id);
  });
});

// ── KNOW-01: File Upload ────────────────────────────────────────────────

describe("KNOW-01: KB File Upload", () => {
  test("insertKBFile stores file and getKBFile retrieves it", async () => {
    const file = await insertKBFile({
      projectId,
      filename: "test-document.txt",
      mimeType: "text/plain",
      fileSize: 1024,
      status: "ready",
    });
    expect(file.id).toBeDefined();
    expect(file.filename).toBe("test-document.txt");
    expect(file.mimeType).toBe("text/plain");
    expect(file.fileSize).toBe(1024);

    const fetched = await getKBFile(file.id);
    expect(fetched).toBeDefined();
    expect(fetched!.filename).toBe("test-document.txt");
    expect(fetched!.projectId).toBe(projectId);
    expect(fetched!.status).toBe("ready");
  });
});

// ── KNOW-02: Chunking + Search ──────────────────────────────────────────

describe("KNOW-02: KB Chunking and Search", () => {
  test("insertKBChunk with embedding, then searchKBChunks finds it", async () => {
    // Need a file in 'ready' status for the JOIN in searchKBChunks
    const file = await insertKBFile({
      projectId,
      filename: "chunked-doc.txt",
      mimeType: "text/plain",
      fileSize: 2048,
      status: "ready",
      chunkCount: 1,
    });

    const chunk = await insertKBChunk({
      fileId: file.id,
      content: "The quick brown fox jumps over the lazy dog",
      chunkIndex: 0,
      embedding: testEmbedding,
    });
    expect(chunk.id).toBeDefined();
    expect(chunk.content).toBe("The quick brown fox jumps over the lazy dog");

    // Search with the same embedding should return a high-similarity match
    const results = await searchKBChunks(testEmbedding, projectId, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const found = results.find((r) => r.content === "The quick brown fox jumps over the lazy dog");
    expect(found).toBeDefined();
    expect(Number(found!.similarity)).toBeGreaterThan(0.9);
  });
});

// ── KNOW-03: KB in Conversations ────────────────────────────────────────

describe("KNOW-03: KB in Conversations (retrieval)", () => {
  test("searchKBChunksForQuery delegates to searchKBChunks and returns results", async () => {
    // We already have a chunk from KNOW-02 tests — search for it via retrieval wrapper
    const results = await searchKBChunksForQuery("fox jumping", testEmbedding, projectId, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const found = results.find((r) => r.content.includes("quick brown fox"));
    expect(found).toBeDefined();
  });
});

// ── KNOW-04: KB Management ──────────────────────────────────────────────

describe("KNOW-04: KB Management", () => {
  test("listKBFiles returns files, deleteKBFile removes one, list shrinks", async () => {
    const file1 = await insertKBFile({
      projectId,
      filename: "manage-1.txt",
      mimeType: "text/plain",
      fileSize: 100,
      status: "ready",
    });
    const file2 = await insertKBFile({
      projectId,
      filename: "manage-2.txt",
      mimeType: "text/plain",
      fileSize: 200,
      status: "ready",
    });

    const listBefore = await listKBFiles(projectId);
    const countBefore = listBefore.length;
    expect(listBefore.find((f) => f.id === file1.id)).toBeDefined();
    expect(listBefore.find((f) => f.id === file2.id)).toBeDefined();

    const deleted = await deleteKBFile(file1.id);
    expect(deleted).toBe(true);

    const listAfter = await listKBFiles(projectId);
    expect(listAfter.length).toBe(countBefore - 1);
    expect(listAfter.find((f) => f.id === file1.id)).toBeUndefined();
    expect(listAfter.find((f) => f.id === file2.id)).toBeDefined();
  });
});
