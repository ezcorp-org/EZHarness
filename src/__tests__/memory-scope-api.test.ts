import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { MemoryProvenance } from "../memory/types";

mockDbConnection();
mockRealSettings();
mockEmbeddingsModule();

const { insertMemory, searchMemories } = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");

let projectId: string;
let conversationId: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

// IDs for pre-created test memories
let globalMem1Id: string;
let globalMem2Id: string;
let projectMem1Id: string;
let projectMem2Id: string;

async function insertTestMemory(content: string, opts?: { category?: string; projectId?: string | null }) {
  const embedding = mockEmbedding();
  const provenance: MemoryProvenance = {
    sourceConversationId: conversationId,
    sourceMessageIds: ["msg-scope-test"],
    extractedAt: new Date(),
    confidence: "high",
    history: [{ action: "created", timestamp: new Date(), reason: "test" }],
  };
  return insertMemory({
    content,
    category: (opts?.category ?? "technical") as any,
    projectId: opts?.projectId === null ? undefined : (opts?.projectId ?? projectId),
    conversationId,
    messageIds: ["msg-scope-test"],
    confidence: "high",
    embedding,
    provenance,
  });
}

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "scope-test", path: "/tmp/scope-test" });
  projectId = project.id;
  const conv = await createConversation(projectId, { title: "scope conv" });
  conversationId = conv.id;

  // Create test data: 2 global + 2 project-specific
  const g1 = await insertTestMemory("Global memory one", { projectId: null });
  const g2 = await insertTestMemory("Global memory two", { category: "preferences", projectId: null });
  const p1 = await insertTestMemory("Project memory one");
  const p2 = await insertTestMemory("Project memory two", { category: "preferences" });
  globalMem1Id = g1.id;
  globalMem2Id = g2.id;
  projectMem1Id = p1.id;
  projectMem2Id = p2.id;

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // GET /api/memories — mirrors web/src/routes/api/memories/+server.ts
      if (path === "/api/memories" && method === "GET") {
        const params: any = {};
        if (url.searchParams.get("projectId")) params.projectId = url.searchParams.get("projectId");
        if (url.searchParams.get("scope")) params.scope = url.searchParams.get("scope");
        if (url.searchParams.get("search")) params.search = url.searchParams.get("search");
        if (url.searchParams.get("status")) params.status = url.searchParams.get("status");
        if (url.searchParams.get("category")) params.category = url.searchParams.get("category");
        if (url.searchParams.get("limit")) params.limit = parseInt(url.searchParams.get("limit")!, 10);
        if (url.searchParams.get("offset")) params.offset = parseInt(url.searchParams.get("offset")!, 10);
        const results = await searchMemories(params);
        return Response.json(results);
      }

      // POST /api/memories — mirrors web/src/routes/api/memories/+server.ts
      if (path === "/api/memories" && method === "POST") {
        const body = await req.json();
        const { content, category, confidence, projectId: bodyProjectId } = body;

        if (!content || typeof content !== "string" || content.trim().length === 0) {
          return Response.json({ error: "content is required and must be a non-empty string" }, { status: 400 });
        }

        const VALID_CATEGORIES = ["preferences", "biographical", "technical", "decisions_goals"] as const;
        if (!category || !VALID_CATEGORIES.includes(category)) {
          return Response.json({ error: `category must be one of: ${VALID_CATEGORIES.join(", ")}` }, { status: 400 });
        }

        const embedding = mockEmbedding();
        const memory = await insertMemory({
          content: content.trim(),
          category,
          confidence: confidence ?? "medium",
          embedding,
          ...(bodyProjectId ? { projectId: bodyProjectId } : {}),
        });

        return Response.json(memory, { status: 201 });
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server.stop();
  await closeTestDb();
  restoreModuleMocks();
});

describe("Memory scope API", () => {
  test("GET with scope=all returns project + global memories", async () => {
    const res = await fetch(`${baseUrl}/api/memories?projectId=${projectId}&scope=all`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const ids = data.map((m: any) => m.id);
    expect(ids).toContain(globalMem1Id);
    expect(ids).toContain(globalMem2Id);
    expect(ids).toContain(projectMem1Id);
    expect(ids).toContain(projectMem2Id);
  });

  test("GET with scope=project returns only project memories", async () => {
    const res = await fetch(`${baseUrl}/api/memories?projectId=${projectId}&scope=project`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const ids = data.map((m: any) => m.id);
    expect(ids).toContain(projectMem1Id);
    expect(ids).toContain(projectMem2Id);
    expect(ids).not.toContain(globalMem1Id);
    expect(ids).not.toContain(globalMem2Id);
  });

  test("GET with scope=global returns only global memories", async () => {
    const res = await fetch(`${baseUrl}/api/memories?scope=global`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const ids = data.map((m: any) => m.id);
    expect(ids).toContain(globalMem1Id);
    expect(ids).toContain(globalMem2Id);
    expect(ids).not.toContain(projectMem1Id);
    expect(ids).not.toContain(projectMem2Id);
  });

  test("GET with no scope and no projectId returns all memories", async () => {
    const res = await fetch(`${baseUrl}/api/memories`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const ids = data.map((m: any) => m.id);
    expect(ids).toContain(globalMem1Id);
    expect(ids).toContain(globalMem2Id);
    expect(ids).toContain(projectMem1Id);
    expect(ids).toContain(projectMem2Id);
  });

  test("POST with projectId creates project-scoped memory", async () => {
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Created project memory via API",
        category: "technical",
        projectId,
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.content).toBe("Created project memory via API");
    expect(data.projectId).toBe(projectId);
  });

  test("POST without projectId creates global memory", async () => {
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Created global memory via API",
        category: "preferences",
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toBeDefined();
    expect(data.content).toBe("Created global memory via API");
    expect(data.projectId).toBeNull();
  });

  test("POST-created memories appear correctly when filtered by scope", async () => {
    // Create one project and one global memory
    const projectRes = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Scope verify project mem",
        category: "technical",
        projectId,
      }),
    });
    const projectMem = await projectRes.json();

    const globalRes = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Scope verify global mem",
        category: "technical",
      }),
    });
    const globalMem = await globalRes.json();

    // scope=project should include the project mem but not the global one
    const projOnly = await fetch(`${baseUrl}/api/memories?projectId=${projectId}&scope=project`);
    const projData = await projOnly.json();
    const projIds = projData.map((m: any) => m.id);
    expect(projIds).toContain(projectMem.id);
    expect(projIds).not.toContain(globalMem.id);

    // scope=global should include the global mem but not the project one
    const globalOnly = await fetch(`${baseUrl}/api/memories?scope=global`);
    const globalData = await globalOnly.json();
    const globalIds = globalData.map((m: any) => m.id);
    expect(globalIds).toContain(globalMem.id);
    expect(globalIds).not.toContain(projectMem.id);

    // scope=all should include both
    const allRes = await fetch(`${baseUrl}/api/memories?projectId=${projectId}&scope=all`);
    const allData = await allRes.json();
    const allIds = allData.map((m: any) => m.id);
    expect(allIds).toContain(projectMem.id);
    expect(allIds).toContain(globalMem.id);
  });
});
