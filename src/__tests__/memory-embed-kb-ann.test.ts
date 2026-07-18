/**
 * DB-audit fix for src/db/queries/knowledge-base.ts (memory-embed group).
 *
 * searchKBChunks / hasKBChunks were restructured from a correlated
 * `JOIN knowledge_base_files ... WHERE f.project_id = …` (which the
 * pgvector-0.8 planner refuses to serve from the HNSW index) to a single-table
 * ANN scan over knowledge_base_chunks whose tenant scope is an `file_id =
 * ANY(ARRAY(...))` InitPlan (mirrors message-search.ts). These tests assert the
 * restructure preserves the EXACT scoping semantics: only 'ready' files of the
 * requested project contribute, other projects / non-ready files are excluded,
 * and the display fields (filename, similarity) still come back.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";

mockDbConnection();
mockEmbeddingsModule();

const { insertKBFile, updateKBFile, insertKBChunk, searchKBChunks, hasKBChunks } =
  await import("../db/queries/knowledge-base");
const { createProject } = await import("../db/queries/projects");

let projectA: string;
let projectB: string;

beforeAll(async () => {
  await setupTestDb();
  projectA = (await createProject({ name: "kb-ann-a", path: "/tmp/kb-ann-a" })).id;
  projectB = (await createProject({ name: "kb-ann-b", path: "/tmp/kb-ann-b" })).id;
});

afterAll(async () => {
  await closeTestDb();
});

async function readyFileWithChunk(projectId: string, filename: string, content: string): Promise<string> {
  const file = await insertKBFile({ projectId, filename, mimeType: "text/markdown", fileSize: 10 });
  await updateKBFile(file.id, { status: "ready", chunkCount: 1 });
  await insertKBChunk({ fileId: file.id, content, chunkIndex: 0, embedding: mockEmbedding() });
  return file.id;
}

describe("searchKBChunks — single-table ANN scoped by file_id ARRAY InitPlan", () => {
  test("returns ready-file chunks of the project with filename + numeric similarity", async () => {
    await readyFileWithChunk(projectA, "guide.md", "TypeScript best practices");
    const results = await searchKBChunks(mockEmbedding(), projectA, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const hit = results.find((r) => r.content === "TypeScript best practices");
    expect(hit).toBeDefined();
    expect(hit!.filename).toBe("guide.md");
    expect(typeof hit!.similarity).toBe("number");
  });

  test("excludes chunks from a NON-ready (processing) file", async () => {
    const file = await insertKBFile({ projectId: projectA, filename: "pending.md", mimeType: "text/markdown", fileSize: 10 });
    // status stays 'processing' (default) — NOT ready.
    await insertKBChunk({ fileId: file.id, content: "not-ready-content", chunkIndex: 0, embedding: mockEmbedding() });
    const results = await searchKBChunks(mockEmbedding(), projectA, 50);
    expect(results.find((r) => r.content === "not-ready-content")).toBeUndefined();
  });

  test("does NOT leak another project's chunks", async () => {
    await readyFileWithChunk(projectB, "b-only.md", "project-B-secret-chunk");
    const results = await searchKBChunks(mockEmbedding(), projectA, 50);
    expect(results.find((r) => r.content === "project-B-secret-chunk")).toBeUndefined();
    // But project B's own search DOES see it.
    const bResults = await searchKBChunks(mockEmbedding(), projectB, 50);
    expect(bResults.find((r) => r.content === "project-B-secret-chunk")).toBeDefined();
  });
});

describe("hasKBChunks — existence via the same file_id ARRAY scope", () => {
  test("true when the project has a ready chunk, false for an empty project", async () => {
    const emptyProject = (await createProject({ name: "kb-ann-empty", path: "/tmp/kb-ann-empty" })).id;
    expect(await hasKBChunks(emptyProject)).toBe(false);
    await readyFileWithChunk(emptyProject, "now.md", "now-has-a-chunk");
    expect(await hasKBChunks(emptyProject)).toBe(true);
  });

  test("false when the only chunks belong to a non-ready file", async () => {
    const p = (await createProject({ name: "kb-ann-processing", path: "/tmp/kb-ann-proc" })).id;
    const file = await insertKBFile({ projectId: p, filename: "p.md", mimeType: "text/markdown", fileSize: 10 });
    await insertKBChunk({ fileId: file.id, content: "processing-chunk", chunkIndex: 0, embedding: mockEmbedding() });
    expect(await hasKBChunks(p)).toBe(false);
  });
});
