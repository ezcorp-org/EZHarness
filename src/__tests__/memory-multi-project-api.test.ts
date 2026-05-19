import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, mockRealSettings } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { MemoryProvenance } from "../memory/types";

// Module-level mocks MUST be called before dynamic imports
mockDbConnection();
mockRealSettings();
mockEmbeddingsModule();

// Dynamic imports AFTER mocks
const {
  insertMemory, searchMemories, getMemoryById, deleteMemory,
  setMemoryProjects, getMemoryProjectIds, getProjectIdsForMemories,
  assignMemoryToProjects,
} = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CATEGORIES = ["preferences", "biographical", "technical", "decisions_goals"];

let projectA: string;
let projectB: string;
let projectC: string;
let conversationId: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

async function insertTestMemory(content: string, opts?: { projectId?: string | null; category?: string; status?: string }) {
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
    projectId: opts?.projectId ?? undefined,
    conversationId,
    messageIds: ["msg-test"],
    confidence: "high",
    embedding,
    provenance,
  });
  if (opts?.status && opts.status !== "active") {
    const db = getDb();
    const { memories } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(memories).set({ status: opts.status } as any).where(eq(memories.id, mem.id));
  }
  return mem;
}

beforeAll(async () => {
  await setupTestDb();
  const pA = await createProject({ name: "api-proj-a", path: "/tmp/api-proj-a" });
  const pB = await createProject({ name: "api-proj-b", path: "/tmp/api-proj-b" });
  const pC = await createProject({ name: "api-proj-c", path: "/tmp/api-proj-c" });
  projectA = pA.id;
  projectB = pB.id;
  projectC = pC.id;
  const conv = await createConversation(projectA, { title: "api multi-proj conv" });
  conversationId = conv.id;

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // GET /api/memories — list with batch projectIds
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
        // Batch-attach projectIds
        const memIds = results.map((m) => m.id);
        const projectMap = memIds.length > 0 ? await getProjectIdsForMemories(memIds) : new Map();
        const enriched = results.map((m) => ({
          ...m,
          projectIds: projectMap.get(m.id) ?? [],
        }));
        return Response.json(enriched);
      }

      // POST /api/memories — create with projectIds
      if (path === "/api/memories" && method === "POST") {
        const body = await req.json();

        // Validation: content required
        if (!body.content || typeof body.content !== "string" || body.content.trim() === "") {
          return Response.json({ error: "content is required" }, { status: 400 });
        }

        // Validation: category
        if (body.category && !VALID_CATEGORIES.includes(body.category)) {
          return Response.json({ error: `Invalid category: ${body.category}` }, { status: 400 });
        }

        // Resolve projectIds — support both projectIds (new) and projectId (legacy)
        let projectIds: string[] = [];
        if (body.projectIds !== undefined) {
          if (!Array.isArray(body.projectIds)) {
            return Response.json({ error: "projectIds must be an array" }, { status: 400 });
          }
          if (body.projectIds.length > 50) {
            return Response.json({ error: "projectIds exceeds maximum of 50" }, { status: 400 });
          }
          for (const id of body.projectIds) {
            if (typeof id !== "string" || !UUID_RE.test(id)) {
              return Response.json({ error: `Invalid UUID in projectIds: ${id}` }, { status: 400 });
            }
          }
          projectIds = body.projectIds;
        } else if (body.projectId && typeof body.projectId === "string") {
          // Legacy: single projectId field
          projectIds = [body.projectId];
        }

        const embedding = mockEmbedding();
        const provenance: MemoryProvenance = {
          sourceConversationId: conversationId,
          sourceMessageIds: body.messageIds ?? ["msg-api"],
          extractedAt: new Date(),
          confidence: body.confidence ?? "high",
          history: [{ action: "created", timestamp: new Date(), reason: "api" }],
        };

        const mem = await insertMemory({
          content: body.content,
          category: (body.category ?? "technical") as any,
          projectId: projectIds[0] ?? undefined,
          conversationId,
          messageIds: body.messageIds ?? ["msg-api"],
          confidence: body.confidence ?? "high",
          embedding,
          provenance,
        });

        // Assign to all projects via junction table
        if (projectIds.length > 0) {
          await assignMemoryToProjects(mem.id, projectIds);
        }

        const memProjectIds = await getMemoryProjectIds(mem.id);
        return Response.json({ ...mem, projectIds: memProjectIds }, { status: 201 });
      }

      // /api/memories/:id
      const memoryMatch = path.match(/^\/api\/memories\/([^/]+)$/);
      if (memoryMatch) {
        const id = memoryMatch[1]!;

        if (method === "GET") {
          const mem = await getMemoryById(id);
          if (!mem) return Response.json({ error: "Not found" }, { status: 404 });
          const memProjectIds = await getMemoryProjectIds(mem.id);
          return Response.json({ ...mem, projectIds: memProjectIds });
        }

        if (method === "PUT") {
          const mem = await getMemoryById(id);
          if (!mem) return Response.json({ error: "Not found" }, { status: 404 });
          const body = await req.json();

          // Validate projectIds if provided
          if (body.projectIds !== undefined) {
            if (!Array.isArray(body.projectIds)) {
              return Response.json({ error: "projectIds must be an array" }, { status: 400 });
            }
            if (body.projectIds.length > 50) {
              return Response.json({ error: "projectIds exceeds maximum of 50" }, { status: 400 });
            }
            for (const pid of body.projectIds) {
              if (typeof pid !== "string" || !UUID_RE.test(pid)) {
                return Response.json({ error: `Invalid UUID in projectIds: ${pid}` }, { status: 400 });
              }
            }
            await setMemoryProjects(id, body.projectIds);
          }

          const updated = await getMemoryById(id);
          const memProjectIds = await getMemoryProjectIds(id);
          return Response.json({ ...updated, projectIds: memProjectIds });
        }

        if (method === "DELETE") {
          const mem = await getMemoryById(id);
          if (!mem) return Response.json({ error: "Not found" }, { status: 404 });
          await deleteMemory(id);
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
  restoreModuleMocks();
  await closeTestDb();
});

// ── Happy Path Tests ──────────────────────────────────────────────

describe("Memory multi-project API — happy paths", () => {
  test("POST with projectIds creates multi-project memory", async () => {
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "API multi-project memory",
        category: "technical",
        projectIds: [projectA, projectB],
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.content).toBe("API multi-project memory");
    expect(data.projectIds.sort()).toEqual([projectA, projectB].sort());
  });

  test("POST without projectIds creates global memory", async () => {
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "API global memory",
        category: "technical",
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.projectIds).toEqual([]);
  });

  test("POST with legacy projectId still works", async () => {
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "API legacy projectId memory",
        category: "technical",
        projectId: projectA,
      }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.projectIds).toEqual([projectA]);
  });

  test("GET list returns projectIds for each memory", async () => {
    // Create memories with different assignments
    const mem1 = await insertTestMemory("api-list-1");
    await assignMemoryToProjects(mem1.id, [projectA]);
    const mem2 = await insertTestMemory("api-list-2");
    await assignMemoryToProjects(mem2.id, [projectB, projectC]);

    const res = await fetch(`${baseUrl}/api/memories`);
    expect(res.status).toBe(200);
    const data = await res.json();

    const found1 = data.find((m: any) => m.id === mem1.id);
    const found2 = data.find((m: any) => m.id === mem2.id);
    expect(found1).toBeDefined();
    expect(found1.projectIds).toEqual([projectA]);
    expect(found2).toBeDefined();
    expect(found2.projectIds.sort()).toEqual([projectB, projectC].sort());
  });

  test("GET single memory returns projectIds", async () => {
    const mem = await insertTestMemory("api-single-proj");
    await assignMemoryToProjects(mem.id, [projectA, projectB]);

    const res = await fetch(`${baseUrl}/api/memories/${mem.id}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(mem.id);
    expect(data.projectIds.sort()).toEqual([projectA, projectB].sort());
  });

  test("PUT with projectIds updates assignments", async () => {
    const mem = await insertTestMemory("api-put-update");
    await assignMemoryToProjects(mem.id, [projectA]);

    const res = await fetch(`${baseUrl}/api/memories/${mem.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds: [projectB, projectC] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.projectIds.sort()).toEqual([projectB, projectC].sort());

    // Verify A is removed
    const ids = await getMemoryProjectIds(mem.id);
    expect(ids).not.toContain(projectA);
  });

  test("scope=project with multi-project memory works via API", async () => {
    const mem = await insertTestMemory("api-scope-multi");
    await assignMemoryToProjects(mem.id, [projectA, projectB]);

    const res = await fetch(`${baseUrl}/api/memories?scope=project&projectId=${projectA}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const foundIds = data.map((m: any) => m.id);
    expect(foundIds).toContain(mem.id);
  });

  test("scope=global returns global memories via API", async () => {
    const globalMem = await insertTestMemory("api-scope-global-only");
    // No project assignment — global

    const projMem = await insertTestMemory("api-scope-not-global");
    await assignMemoryToProjects(projMem.id, [projectA]);

    const res = await fetch(`${baseUrl}/api/memories?scope=global`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const foundIds = data.map((m: any) => m.id);
    expect(foundIds).toContain(globalMem.id);
    expect(foundIds).not.toContain(projMem.id);
  });
});

// ── Bad Path Tests ────────────────────────────────────────────────

describe("Memory multi-project API — bad paths", () => {
  test("POST with invalid UUID in projectIds returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "bad uuid memory",
        category: "technical",
        projectIds: ["not-a-uuid"],
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid UUID");
  });

  test("POST with too many projectIds returns 400", async () => {
    const tooMany = Array.from({ length: 51 }, () => crypto.randomUUID());
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "too many projects memory",
        category: "technical",
        projectIds: tooMany,
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("exceeds maximum");
  });

  test("POST with non-array projectIds returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "non-array projectIds memory",
        category: "technical",
        projectIds: "not-an-array",
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("must be an array");
  });

  test("PUT with invalid UUID in projectIds returns 400", async () => {
    const mem = await insertTestMemory("put-bad-uuid");

    const res = await fetch(`${baseUrl}/api/memories/${mem.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectIds: ["not-a-valid-uuid"] }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid UUID");
  });

  test("POST with empty content still returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "",
        category: "technical",
        projectIds: [projectA],
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("content is required");
  });

  test("POST with invalid category still returns 400", async () => {
    const res = await fetch(`${baseUrl}/api/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "invalid cat memory",
        category: "not_a_category",
        projectIds: [projectA],
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid category");
  });
});
