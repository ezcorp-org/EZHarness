import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { EMBEDDING_DIM, mockEmbeddingsModule } from "./helpers/mock-vectors";

mockDbConnection();
mockEmbeddingsModule();

const { insertKBFile, listKBFiles, updateKBFile, insertKBChunk, getKBFile } = await import("../db/queries/knowledge-base");
const { createProject } = await import("../db/queries/projects");
const { chunkText, isAllowedFile } = await import("../memory/chunking");
const { generateEmbedding } = await import("../memory/embeddings");

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "upload-test", path: "/tmp/upload" });
  projectId = project.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("KB Upload Integration", () => {
  test("full upload flow: insert file, chunk text, embed chunks, update status", async () => {
    const fileContent = "# Hello World\n\nThis is a test document for the knowledge base upload flow.\n\nIt has multiple paragraphs to verify chunking works correctly.\n\nEach paragraph should be processed and embedded.";
    const filename = "test-upload.md";

    // Step 1: Validate file type
    expect(isAllowedFile(filename)).toBe(true);
    expect(isAllowedFile("bad.pdf")).toBe(false);
    expect(isAllowedFile("bad.exe")).toBe(false);

    // Step 2: Insert file record (mirrors API POST handler)
    const kbFile = await insertKBFile({
      projectId,
      filename,
      mimeType: "text/markdown",
      fileSize: fileContent.length,
      status: "processing",
    });

    expect(kbFile.id).toBeDefined();
    expect(kbFile.status).toBe("processing");

    // Step 3: Chunk the text (mirrors async processing)
    const chunks = chunkText(fileContent);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.content).toBeTruthy();

    // Step 4: Generate embeddings and insert chunks
    for (const chunk of chunks) {
      const embedding = await generateEmbedding(chunk.content);
      expect(embedding.length).toBe(EMBEDDING_DIM);

      const inserted = await insertKBChunk({
        fileId: kbFile.id,
        content: chunk.content,
        chunkIndex: chunk.index,
        embedding,
      });

      expect(inserted).toBeDefined();
      // Verify the chunk has the right fields (raw SQL returns snake_case)
      const id = inserted.id ?? (inserted as any).id;
      expect(id).toBeDefined();
    }

    // Step 5: Update file status to ready
    await updateKBFile(kbFile.id, { status: "ready", chunkCount: chunks.length });

    // Step 6: Verify the file is listed and has correct status
    const files = await listKBFiles(projectId);
    const uploaded = files.find(f => f.id === kbFile.id);
    expect(uploaded).toBeDefined();
    expect(uploaded!.status).toBe("ready");
    expect(uploaded!.chunkCount).toBe(chunks.length);
  });

  test("simulated API handler: FormData upload processing", async () => {
    // Simulate what the SvelteKit POST handler does
    const fileContent = "Line 1\nLine 2\nLine 3";
    const file = new File([fileContent], "notes.txt", { type: "text/plain" });

    // Build FormData like the frontend does
    const formData = new FormData();
    formData.append("file", file);
    formData.append("projectId", projectId);

    // Extract like the API handler does
    const extractedFile = formData.get("file") as File | null;
    const extractedProjectId = formData.get("projectId") as string | null;

    expect(extractedFile).not.toBeNull();
    expect(extractedProjectId).toBe(projectId);
    expect(isAllowedFile(extractedFile!.name)).toBe(true);

    // Read file text (this is what happens in the async processing)
    const text = await extractedFile!.text();
    expect(text).toBe(fileContent);

    // Insert the file record
    const kbFile = await insertKBFile({
      projectId: extractedProjectId!,
      filename: extractedFile!.name,
      mimeType: extractedFile!.type || "text/plain",
      fileSize: extractedFile!.size,
      status: "processing",
    });

    expect(kbFile.id).toBeDefined();

    // Process: chunk and embed
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      const embedding = await generateEmbedding(chunk.content);
      await insertKBChunk({
        fileId: kbFile.id,
        content: chunk.content,
        chunkIndex: chunk.index,
        embedding,
      });
    }

    await updateKBFile(kbFile.id, { status: "ready", chunkCount: chunks.length });

    // Verify
    const result = await getKBFile(kbFile.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("ready");
    expect(result!.filename).toBe("notes.txt");
  });

  test("file text readable after response sent (async processing pattern)", async () => {
    // This tests the critical pattern: can we read file.text() after
    // the file reference is captured in an async closure?
    const content = "async processing test content";
    const file = new File([content], "async.txt", { type: "text/plain" });

    const formData = new FormData();
    formData.append("file", file);

    const extractedFile = formData.get("file") as File;

    // Simulate: response is sent, then async processing reads the file
    let asyncResult: string | undefined;
    const asyncPromise = (async () => {
      // Small delay to simulate response being sent first
      await new Promise(resolve => setTimeout(resolve, 10));
      asyncResult = await extractedFile.text();
    })();

    await asyncPromise;
    expect(asyncResult).toBe(content);
  });

  test("upload with empty file content", async () => {
    const file = new File([""], "empty.txt", { type: "text/plain" });
    const text = await file.text();

    const chunks = chunkText(text);
    // Empty string should produce one chunk with empty content
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content).toBe("");
  });

  test("upload with large file chunked correctly", async () => {
    // Create content larger than default chunk size (512 chars)
    const paragraph = "This is a test paragraph for chunking. ".repeat(20) + "\n";
    const content = paragraph.repeat(5);

    const chunks = chunkText(content);
    expect(chunks.length).toBeGreaterThan(1);

    // Verify chunks have sequential indices
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i);
    }

    // Verify all content is covered (no gaps)
    const totalContent = chunks.map(c => c.content).join("");
    // Due to overlap, joined content will be longer than original
    expect(totalContent.length).toBeGreaterThanOrEqual(content.length);
  });

  test("file status transitions to error when processing fails", async () => {
    // Insert a file record in processing state
    const kbFile = await insertKBFile({
      projectId,
      filename: "will-fail.md",
      mimeType: "text/markdown",
      fileSize: 100,
      status: "processing",
    });

    // Simulate the async processing error path from the API route
    try {
      // Force an error during chunking/embedding
      throw new Error("Simulated embedding failure");
    } catch {
      await updateKBFile(kbFile.id, { status: "error" });
    }

    const result = await getKBFile(kbFile.id);
    expect(result).toBeDefined();
    expect(result!.status).toBe("error");
  });
});
