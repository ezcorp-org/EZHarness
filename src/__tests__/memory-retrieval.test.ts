import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestPglite } from "./helpers/test-pglite";
import { EMBEDDING_DIMENSIONS } from "../memory/types";

// Mock db/connection before any imports that use it
mockDbConnection();

// Import after mocking
import { hybridSearch, searchKBChunksForQuery, type HybridSearchResult } from "../memory/retrieval";

// Helper: create a deterministic 384-dim vector that has known cosine similarity properties
function makeVector(seed: number): number[] {
  const vec = new Array(EMBEDDING_DIMENSIONS).fill(0);
  // Place the seed value at specific positions to create distinct directions
  vec[seed % EMBEDDING_DIMENSIONS] = 0.9;
  vec[(seed + 1) % EMBEDDING_DIMENSIONS] = 0.3;
  vec[(seed + 2) % EMBEDDING_DIMENSIONS] = 0.1;
  // Normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / norm);
}

describe("hybridSearch", () => {
  let pglite: ReturnType<typeof getTestPglite>;

  beforeAll(async () => {
    const setup = await setupTestDb();
    pglite = setup.pglite;

    // Create test projects
    await pglite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('proj-a', 'Project A', '/a') ON CONFLICT DO NOTHING;
      INSERT INTO projects (id, name, path) VALUES ('proj-b', 'Project B', '/b') ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    // Clear junction rows and memories between tests
    await pglite.exec("DELETE FROM memory_projects; DELETE FROM memories;");
  });

  test("returns empty array when no memories exist", async () => {
    const queryVec = makeVector(0);
    const results = await hybridSearch("test query", queryVec, {});
    expect(results).toEqual([]);
  });

  test("returns results ranked by RRF score combining vector and keyword ranks", async () => {
    const vec1 = makeVector(0); // Close to query vector
    const vec2 = makeVector(10); // Different direction

    const v1str = `[${vec1.join(",")}]`;
    const v2str = `[${vec2.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, confidence, embedding)
      VALUES ('m1', 'TypeScript programming preferences', 'technical', 'high', '${v1str}');
      INSERT INTO memories (id, content, category, confidence, embedding)
      VALUES ('m2', 'Likes coffee in the morning', 'preferences', 'medium', '${v2str}');
    `);

    const queryVec = makeVector(0); // Same direction as m1
    const results = await hybridSearch("TypeScript programming", queryVec, {});

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.id).toBe("m1"); // m1 should rank higher (both vector + keyword match)
    expect(results[0]!.rrfScore).toBeGreaterThan(0);
  });

  test("boosts current project memories by 1.5x over global memories", async () => {
    // Both memories identical content+embedding: one project-scoped, one global
    const vec = makeVector(5);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, project_id, confidence, embedding)
      VALUES ('m-proj-a', 'User likes dark mode editor', 'preferences', 'proj-a', 'high', '${vstr}');
      INSERT INTO memories (id, content, category, confidence, embedding)
      VALUES ('m-global', 'User likes dark mode editor', 'preferences', 'high', '${vstr}');
      INSERT INTO memory_projects (memory_id, project_id) VALUES ('m-proj-a', 'proj-a');
    `);

    const results = await hybridSearch("dark mode editor", vec, { projectId: "proj-a" });

    expect(results.length).toBe(2);
    // proj-a memory should have higher score due to 1.5x boost vs global
    const projA = results.find(r => r.id === "m-proj-a")!;
    const globalMem = results.find(r => r.id === "m-global")!;
    expect(projA.rrfScore).toBeGreaterThan(globalMem.rrfScore);
  });

  test("returns results even when keyword search finds no matches (vector-only fallback)", async () => {
    const vec = makeVector(3);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, confidence, embedding)
      VALUES ('m-vec', 'Enjoys reading science fiction novels', 'preferences', 'high', '${vstr}');
    `);

    // Query with keywords that do NOT match content, but vector is close
    const results = await hybridSearch("xyznonexistentkeyword", vec, {});

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.id).toBe("m-vec");
    expect(results[0]!.rrfScore).toBeGreaterThan(0);
  });

  test("with isolateToProject=true only returns memories with matching projectId", async () => {
    const vec = makeVector(7);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, project_id, confidence, embedding)
      VALUES ('m-iso-a', 'Project A specific memory', 'technical', 'proj-a', 'high', '${vstr}');
      INSERT INTO memories (id, content, category, project_id, confidence, embedding)
      VALUES ('m-iso-b', 'Project B specific memory', 'technical', 'proj-b', 'high', '${vstr}');
      INSERT INTO memories (id, content, category, confidence, embedding)
      VALUES ('m-iso-none', 'No project memory', 'technical', 'high', '${vstr}');
      INSERT INTO memory_projects (memory_id, project_id) VALUES ('m-iso-a', 'proj-a');
      INSERT INTO memory_projects (memory_id, project_id) VALUES ('m-iso-b', 'proj-b');
    `);

    const results = await hybridSearch("specific memory", vec, {
      projectId: "proj-a",
      isolateToProject: true,
    });

    // Only proj-a memory should be returned
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe("m-iso-a");
  });

  test("with isolateToProject=false (default) returns project + global memories, not other projects", async () => {
    const vec = makeVector(9);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, project_id, confidence, embedding)
      VALUES ('m-glob-a', 'Memory from project A', 'technical', 'proj-a', 'high', '${vstr}');
      INSERT INTO memories (id, content, category, project_id, confidence, embedding)
      VALUES ('m-glob-b', 'Memory from project B', 'technical', 'proj-b', 'high', '${vstr}');
      INSERT INTO memories (id, content, category, confidence, embedding)
      VALUES ('m-glob-global', 'Global memory for everyone', 'technical', 'high', '${vstr}');
      INSERT INTO memory_projects (memory_id, project_id) VALUES ('m-glob-a', 'proj-a');
      INSERT INTO memory_projects (memory_id, project_id) VALUES ('m-glob-b', 'proj-b');
    `);

    const results = await hybridSearch("memory from project", vec, { projectId: "proj-a" });

    const ids = results.map(r => r.id);
    // proj-a memory and global memory should be returned
    expect(ids).toContain("m-glob-a");
    expect(ids).toContain("m-glob-global");
    // proj-b memory should NOT leak through
    expect(ids).not.toContain("m-glob-b");
  });

  test("hybridSearch reduces stale memory RRF score by 0.5x", async () => {
    // Create two identical memories: one active, one stale
    const vec = makeVector(11);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, confidence, status, embedding)
      VALUES ('m-active', 'Prefers dark theme editor', 'preferences', 'high', 'active', '${vstr}');
      INSERT INTO memories (id, content, category, confidence, status, embedding)
      VALUES ('m-stale', 'Prefers dark theme editor', 'preferences', 'high', 'stale', '${vstr}');
    `);

    const results = await hybridSearch("dark theme editor", vec, {});

    expect(results.length).toBe(2);
    const activeResult = results.find(r => r.id === "m-active")!;
    const staleResult = results.find(r => r.id === "m-stale")!;
    // Stale RRF should be less than active (0.5x weight applied)
    expect(staleResult.rrfScore).toBeLessThan(activeResult.rrfScore);
    // The stale score should be roughly half (within margin due to different rank positions)
    expect(staleResult.rrfScore / activeResult.rrfScore).toBeCloseTo(0.5, 1);
  });

  test("hybridSearch excludes archived memories entirely", async () => {
    const vec = makeVector(12);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, confidence, status, embedding)
      VALUES ('m-archived', 'Old archived memory content', 'technical', 'high', 'archived', '${vstr}');
      INSERT INTO memories (id, content, category, confidence, status, embedding)
      VALUES ('m-keep', 'Active memory content', 'technical', 'high', 'active', '${vstr}');
    `);

    const results = await hybridSearch("memory content", vec, {});

    const ids = results.map(r => r.id);
    expect(ids).not.toContain("m-archived");
    expect(ids).toContain("m-keep");
  });

  test("hybridSearch calls touchMemoryAccess with result IDs", async () => {
    const vec = makeVector(13);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, confidence, embedding, last_accessed_at)
      VALUES ('m-touch', 'Some searchable content here', 'technical', 'high', '${vstr}', '2025-01-01');
    `);

    const results = await hybridSearch("searchable content", vec, {});

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.map(r => r.id)).toContain("m-touch");

    // Wait a tick for the fire-and-forget touchMemoryAccess to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify lastAccessedAt was updated
    const row = await pglite.query("SELECT last_accessed_at FROM memories WHERE id = 'm-touch'");
    const updatedAt = new Date((row.rows[0] as any).last_accessed_at as string);
    expect(updatedAt.getFullYear()).toBeGreaterThanOrEqual(2026);
  });
});

describe("searchKBChunksForQuery", () => {
  let pglite: ReturnType<typeof getTestPglite>;

  beforeAll(async () => {
    const setup = await setupTestDb();
    pglite = setup.pglite;

    await pglite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('proj-kb', 'KB Project', '/kb') ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await pglite.exec("DELETE FROM knowledge_base_chunks");
    await pglite.exec("DELETE FROM knowledge_base_files");
  });

  test("returns matching KB chunks with correct fields", async () => {
    const vec = makeVector(20);
    const vstr = `[${vec.join(",")}]`;

    // Insert a KB file with status=ready
    await pglite.exec(`
      INSERT INTO knowledge_base_files (id, project_id, filename, mime_type, file_size, status, chunk_count)
      VALUES ('kbf-1', 'proj-kb', 'guide.md', 'text/markdown', 1024, 'ready', 2);
    `);

    // Insert chunks with embeddings
    await pglite.exec(`
      INSERT INTO knowledge_base_chunks (id, file_id, content, chunk_index, embedding)
      VALUES ('kbc-1', 'kbf-1', 'Getting started with the API', 0, '${vstr}');
      INSERT INTO knowledge_base_chunks (id, file_id, content, chunk_index, embedding)
      VALUES ('kbc-2', 'kbf-1', 'Advanced configuration options', 1, '${vstr}');
    `);

    const results = await searchKBChunksForQuery("API guide", vec, "proj-kb");

    expect(results.length).toBeGreaterThanOrEqual(1);
    const first = results[0]!;
    expect(first.id).toBeDefined();
    expect(first.content).toBeDefined();
    expect(typeof first.chunkIndex).toBe("number");
    expect(first.filename).toBe("guide.md");
    expect(first.fileId).toBe("kbf-1");
    expect(typeof first.similarity).toBe("number");
  });

  test("excludes chunks from non-ready KB files", async () => {
    const vec = makeVector(21);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO knowledge_base_files (id, project_id, filename, mime_type, file_size, status)
      VALUES ('kbf-processing', 'proj-kb', 'pending.md', 'text/markdown', 512, 'processing');
    `);

    await pglite.exec(`
      INSERT INTO knowledge_base_chunks (id, file_id, content, chunk_index, embedding)
      VALUES ('kbc-p1', 'kbf-processing', 'This should not appear', 0, '${vstr}');
    `);

    const results = await searchKBChunksForQuery("should not appear", vec, "proj-kb");
    expect(results.length).toBe(0);
  });

  test("excludes chunks from other projects", async () => {
    const vec = makeVector(22);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('proj-other', 'Other', '/other') ON CONFLICT DO NOTHING;
      INSERT INTO knowledge_base_files (id, project_id, filename, mime_type, file_size, status, chunk_count)
      VALUES ('kbf-other', 'proj-other', 'other.md', 'text/markdown', 256, 'ready', 1);
      INSERT INTO knowledge_base_chunks (id, file_id, content, chunk_index, embedding)
      VALUES ('kbc-o1', 'kbf-other', 'Content from other project', 0, '${vstr}');
    `);

    const results = await searchKBChunksForQuery("other project", vec, "proj-kb");
    expect(results.length).toBe(0);
  });
});
