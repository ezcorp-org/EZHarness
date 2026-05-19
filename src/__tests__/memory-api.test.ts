import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import type { MemoryProvenance } from "../memory/types";

mockDbConnection();
mockRealSettings();
mockEmbeddingsModule();

const { insertMemory, searchMemories, getMemoryById, updateMemory, updateMemoryStatus, deleteMemory } = await import("../db/queries/memories");
const { insertKBFile, listKBFiles, getKBFile, deleteKBFile } = await import("../db/queries/knowledge-base");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");
const { memories, memoryAuditLog } = await import("../db/schema");
const { eq } = await import("drizzle-orm");

let projectId: string;
let conversationId: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

async function insertTestMemory(content: string, opts?: { category?: string; status?: string }) {
  const embedding = mockEmbedding();
  const provenance: MemoryProvenance = {
    sourceConversationId: conversationId,
    sourceMessageIds: ["msg-api-test"],
    extractedAt: new Date(),
    confidence: "high",
    history: [{ action: "created", timestamp: new Date(), reason: "test" }],
  };
  const mem = await insertMemory({
    content,
    category: (opts?.category ?? "technical") as any,
    projectId,
    conversationId,
    messageIds: ["msg-api-test"],
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
  const project = await createProject({ name: "api-test", path: "/tmp/api-test" });
  projectId = project.id;
  const conv = await createConversation(projectId, { title: "api conv" });
  conversationId = conv.id;

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // GET /api/memories
      if (path === "/api/memories" && method === "GET") {
        const params: any = {};
        if (url.searchParams.get("projectId")) params.projectId = url.searchParams.get("projectId");
        if (url.searchParams.get("search")) params.search = url.searchParams.get("search");
        if (url.searchParams.get("status")) params.status = url.searchParams.get("status");
        if (url.searchParams.get("category")) params.category = url.searchParams.get("category");
        if (url.searchParams.get("limit")) params.limit = parseInt(url.searchParams.get("limit")!, 10);
        if (url.searchParams.get("offset")) params.offset = parseInt(url.searchParams.get("offset")!, 10);
        const results = await searchMemories(params);
        return Response.json(results);
      }

      // /api/memories/:id
      const memoryMatch = path.match(/^\/api\/memories\/([^/]+)$/);
      if (memoryMatch) {
        const id = memoryMatch[1]!;
        if (method === "GET") {
          const mem = await getMemoryById(id);
          if (!mem) return Response.json({ error: "Not found" }, { status: 404 });
          return Response.json(mem);
        }
        if (method === "PUT") {
          const mem = await getMemoryById(id);
          if (!mem) return Response.json({ error: "Not found" }, { status: 404 });
          const body = await req.json();
          if (body.status && body.status !== mem.status) {
            await updateMemoryStatus(id, body.status, `Status changed to ${body.status}`);
          }
          const updates: Record<string, unknown> = {};
          if (body.content !== undefined && body.content !== mem.content) updates.content = body.content;
          if (body.confidence !== undefined) updates.confidence = body.confidence;
          if (Object.keys(updates).length > 0) await updateMemory(id, updates as any);
          const updated = await getMemoryById(id);
          return Response.json(updated);
        }
        if (method === "DELETE") {
          await deleteMemory(id);
          return new Response(null, { status: 204 });
        }
      }

      // GET /api/knowledge-base
      if (path === "/api/knowledge-base" && method === "GET") {
        const pid = url.searchParams.get("projectId");
        if (!pid) return Response.json({ error: "projectId required" }, { status: 400 });
        const files = await listKBFiles(pid);
        return Response.json(files);
      }

      // POST /api/knowledge-base (upload)
      if (path === "/api/knowledge-base" && method === "POST") {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        const pid = formData.get("projectId") as string | null;

        if (!file || !pid) {
          return Response.json({ error: "file and projectId are required" }, { status: 400 });
        }

        const { isAllowedFile } = await import("../memory/chunking");
        if (!isAllowedFile(file.name)) {
          return Response.json({ error: `File type not allowed: ${file.name}` }, { status: 400 });
        }

        const MAX_FILE_SIZE = 10 * 1024 * 1024;
        if (file.size > MAX_FILE_SIZE) {
          return Response.json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }, { status: 400 });
        }

        const kbFile = await insertKBFile({
          projectId: pid,
          filename: file.name,
          mimeType: file.type || "text/plain",
          fileSize: file.size,
          status: "processing",
        });
        return Response.json({ id: kbFile.id, status: "processing" }, { status: 201 });
      }

      // /api/knowledge-base/:id
      const kbMatch = path.match(/^\/api\/knowledge-base\/([^/]+)$/);
      if (kbMatch) {
        const id = kbMatch[1]!;
        if (method === "GET") {
          const file = await getKBFile(id);
          if (!file) return Response.json({ error: "Not found" }, { status: 404 });
          return Response.json(file);
        }
        if (method === "DELETE") {
          const deleted = await deleteKBFile(id);
          if (!deleted) return Response.json({ error: "Not found" }, { status: 404 });
          return new Response(null, { status: 204 });
        }
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server.stop();
  await closeTestDb();
});

describe("Memory API routes", () => {
  test("GET /api/memories returns filtered results", async () => {
    const techMem = await insertTestMemory("API filter tech memory", { category: "technical" });
    const prefMem = await insertTestMemory("API filter pref memory", { category: "preferences" });
    const archivedMem = await insertTestMemory("API filter archived memory", { status: "archived" });

    // Filter by category
    const catRes = await fetch(`${baseUrl}/api/memories?projectId=${projectId}&category=preferences`);
    expect(catRes.status).toBe(200);
    const catData = await catRes.json();
    const catIds = catData.map((m: any) => m.id);
    expect(catIds).toContain(prefMem.id);
    expect(catIds).not.toContain(techMem.id);

    // Default excludes archived
    const defaultRes = await fetch(`${baseUrl}/api/memories?projectId=${projectId}`);
    const defaultData = await defaultRes.json();
    const defaultIds = defaultData.map((m: any) => m.id);
    expect(defaultIds).not.toContain(archivedMem.id);

    // Explicit archived filter
    const archRes = await fetch(`${baseUrl}/api/memories?projectId=${projectId}&status=archived`);
    const archData = await archRes.json();
    const archIds = archData.map((m: any) => m.id);
    expect(archIds).toContain(archivedMem.id);
  });

  test("GET /api/memories/:id returns single memory", async () => {
    const mem = await insertTestMemory("API single memory fetch");

    const res = await fetch(`${baseUrl}/api/memories/${mem.id}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(mem.id);
    expect(data.content).toBe("API single memory fetch");
    expect(data.category).toBe("technical");
    expect(data.status).toBe("active");
  });

  test("GET /api/memories/:id returns 404 for missing", async () => {
    const res = await fetch(`${baseUrl}/api/memories/nonexistent-id-12345`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Not found");
  });

  test("PUT /api/memories/:id updates content", async () => {
    const mem = await insertTestMemory("API update original content");

    const res = await fetch(`${baseUrl}/api/memories/${mem.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "API update new content" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.content).toBe("API update new content");
  });

  test("PUT /api/memories/:id updates status with audit log", async () => {
    const mem = await insertTestMemory("API status change memory");

    const res = await fetch(`${baseUrl}/api/memories/${mem.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("archived");

    // Verify audit log was created
    const db = getDb();
    const logs = await db
      .select()
      .from(memoryAuditLog)
      .where(eq(memoryAuditLog.memoryId, mem.id));
    const statusLog = logs.find((l: any) => l.action === "status_change");
    expect(statusLog).toBeDefined();
    expect(statusLog!.reason).toBe("Status changed to archived");
  });

  test("DELETE /api/memories/:id removes memory", async () => {
    const mem = await insertTestMemory("API delete target memory");

    const deleteRes = await fetch(`${baseUrl}/api/memories/${mem.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(204);

    const getRes = await fetch(`${baseUrl}/api/memories/${mem.id}`);
    expect(getRes.status).toBe(404);
  });
});

describe("Knowledge Base API routes", () => {
  test("GET /api/knowledge-base requires projectId", async () => {
    const res = await fetch(`${baseUrl}/api/knowledge-base`);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("projectId required");
  });

  test("GET /api/knowledge-base returns project files", async () => {
    await insertKBFile({
      projectId,
      filename: "test-doc.txt",
      mimeType: "text/plain",
      fileSize: 100,
      status: "ready",
    });
    await insertKBFile({
      projectId,
      filename: "test-doc-2.md",
      mimeType: "text/markdown",
      fileSize: 250,
      status: "ready",
    });

    const res = await fetch(`${baseUrl}/api/knowledge-base?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    const filenames = data.map((f: any) => f.filename);
    expect(filenames).toContain("test-doc.txt");
    expect(filenames).toContain("test-doc-2.md");
  });

  test("DELETE /api/knowledge-base/:id removes file", async () => {
    const file = await insertKBFile({
      projectId,
      filename: "to-delete.txt",
      mimeType: "text/plain",
      fileSize: 50,
      status: "ready",
    });

    const res = await fetch(`${baseUrl}/api/knowledge-base/${file.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    // Verify it's gone
    const check = await getKBFile(file.id);
    expect(check).toBeUndefined();
  });

  test("DELETE /api/knowledge-base/:id returns 404 for missing", async () => {
    const res = await fetch(`${baseUrl}/api/knowledge-base/nonexistent-kb-id`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Not found");
  });

  test("GET /api/knowledge-base/:id returns file", async () => {
    const file = await insertKBFile({
      projectId,
      filename: "get-test.md",
      mimeType: "text/markdown",
      fileSize: 300,
      status: "ready",
    });

    const res = await fetch(`${baseUrl}/api/knowledge-base/${file.id}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(file.id);
    expect(data.filename).toBe("get-test.md");
    expect(data.status).toBe("ready");
  });

  test("GET /api/knowledge-base/:id returns 404 for missing", async () => {
    const res = await fetch(`${baseUrl}/api/knowledge-base/nonexistent-kb-id`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("Not found");
  });

  test("POST /api/knowledge-base rejects disallowed file type", async () => {
    const form = new FormData();
    form.append("file", new File(["binary"], "virus.exe", { type: "application/octet-stream" }));
    form.append("projectId", projectId);

    const res = await fetch(`${baseUrl}/api/knowledge-base`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("File type not allowed");
  });

  test("POST /api/knowledge-base rejects missing projectId", async () => {
    const form = new FormData();
    form.append("file", new File(["hello"], "doc.txt", { type: "text/plain" }));

    const res = await fetch(`${baseUrl}/api/knowledge-base`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("file and projectId are required");
  });

  test("POST /api/knowledge-base rejects missing file", async () => {
    const form = new FormData();
    form.append("projectId", projectId);

    const res = await fetch(`${baseUrl}/api/knowledge-base`, { method: "POST", body: form });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("file and projectId are required");
  });

  test("POST /api/knowledge-base accepts valid file", async () => {
    const form = new FormData();
    form.append("file", new File(["# Hello World"], "readme.md", { type: "text/markdown" }));
    form.append("projectId", projectId);

    const res = await fetch(`${baseUrl}/api/knowledge-base`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.status).toBe("processing");
  });
});
