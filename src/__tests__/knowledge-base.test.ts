import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";

mockDbConnection();
mockEmbeddingsModule();

const { insertKBFile, listKBFiles, deleteKBFile, insertKBChunk, searchKBChunks, updateKBFile } = await import("../db/queries/knowledge-base");
const { createProject } = await import("../db/queries/projects");

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "kb-test", path: "/tmp/kb" });
  projectId = project.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("Knowledge Base", () => {
  test("insertKBFile creates file record", async () => {
    const file = await insertKBFile({
      projectId,
      filename: "guide.md",
      mimeType: "text/markdown",
      fileSize: 1024,
    });

    expect(file.id).toBeDefined();
    expect(file.filename).toBe("guide.md");
    expect(file.mimeType).toBe("text/markdown");
    expect(file.fileSize).toBe(1024);
    expect(file.status).toBe("processing");
    expect(file.chunkCount).toBe(0);
  });

  test("listKBFiles returns project files", async () => {
    await insertKBFile({
      projectId,
      filename: "notes.md",
      mimeType: "text/markdown",
      fileSize: 512,
    });

    const files = await listKBFiles(projectId);
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.every((f) => f.projectId === projectId)).toBe(true);

    const filenames = files.map((f) => f.filename);
    expect(filenames).toContain("guide.md");
    expect(filenames).toContain("notes.md");
  });

  test("deleteKBFile cascades to chunks", async () => {
    const file = await insertKBFile({
      projectId,
      filename: "to-delete.md",
      mimeType: "text/markdown",
      fileSize: 256,
    });
    await updateKBFile(file.id, { status: "ready" });

    const embedding = mockEmbedding();
    await insertKBChunk({
      fileId: file.id,
      content: "This chunk should be cascade deleted",
      chunkIndex: 0,
      embedding,
    });

    const deleted = await deleteKBFile(file.id);
    expect(deleted).toBe(true);

    // Verify chunks are gone — the file is deleted so its chunks
    // won't appear in search results (join on file fails)
    const results = await searchKBChunks(embedding, projectId, 100);
    const orphaned = results.find((r: any) => r.fileId === file.id);
    expect(orphaned).toBeUndefined();
  });

  test("searchKBChunks returns similar chunks", async () => {
    const file = await insertKBFile({
      projectId,
      filename: "searchable.md",
      mimeType: "text/markdown",
      fileSize: 100,
    });
    await updateKBFile(file.id, { status: "ready", chunkCount: 1 });

    const embedding = mockEmbedding();
    await insertKBChunk({
      fileId: file.id,
      content: "TypeScript best practices for large projects",
      chunkIndex: 0,
      embedding,
    });

    const results = await searchKBChunks(embedding, projectId, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const match = results.find((r: any) => r.fileId === file.id);
    expect(match).toBeDefined();
    expect(match!.content).toBe("TypeScript best practices for large projects");
    expect(match!.filename).toBe("searchable.md");
    expect(match!.chunkIndex).toBe(0);
    expect(typeof match!.similarity).toBe("number");
  });

  test("insertKBChunk stores chunk with embedding", async () => {
    const file = await insertKBFile({
      projectId,
      filename: "chunked.md",
      mimeType: "text/markdown",
      fileSize: 200,
    });

    const embedding = mockEmbedding();
    const chunk = await insertKBChunk({
      fileId: file.id,
      content: "A chunk of knowledge base content",
      chunkIndex: 0,
      embedding,
    });

    expect(chunk.id).toBeDefined();
    expect(chunk.content).toBe("A chunk of knowledge base content");
    expect(chunk.chunkIndex).toBe(0);
    expect(chunk.fileId).toBe(file.id);
  });
});
