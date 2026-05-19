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
  insertMemory, searchMemories, deleteMemory,
  assignMemoryToProjects, removeMemoryFromProjects, setMemoryProjects,
  getMemoryProjectIds, getProjectIdsForMemories,
} = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");

let projectA: string;
let projectB: string;
let projectC: string;
let conversationId: string;

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
  const pA = await createProject({ name: "proj-a", path: "/tmp/proj-a" });
  const pB = await createProject({ name: "proj-b", path: "/tmp/proj-b" });
  const pC = await createProject({ name: "proj-c", path: "/tmp/proj-c" });
  projectA = pA.id;
  projectB = pB.id;
  projectC = pC.id;
  const conv = await createConversation(projectA, { title: "multi-proj conv" });
  conversationId = conv.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

// ── Happy Path Tests ──────────────────────────────────────────────

describe("multi-project assignment operations", () => {
  test("assign memory to multiple projects", async () => {
    const mem = await insertTestMemory("multi-project memory");
    await assignMemoryToProjects(mem.id, [projectA, projectB]);
    const ids = await getMemoryProjectIds(mem.id);
    expect(ids.sort()).toEqual([projectA, projectB].sort());
  });

  test("assign memory to zero projects (global)", async () => {
    const mem = await insertTestMemory("global memory");
    const ids = await getMemoryProjectIds(mem.id);
    expect(ids).toEqual([]);
  });

  test("assign memory to single project", async () => {
    const mem = await insertTestMemory("single-project memory");
    await assignMemoryToProjects(mem.id, [projectA]);
    const ids = await getMemoryProjectIds(mem.id);
    expect(ids).toEqual([projectA]);
  });

  test("setMemoryProjects replaces existing assignments", async () => {
    const mem = await insertTestMemory("replace-projects memory");
    await assignMemoryToProjects(mem.id, [projectA, projectB]);

    await setMemoryProjects(mem.id, [projectB, projectC]);

    const ids = await getMemoryProjectIds(mem.id);
    expect(ids.sort()).toEqual([projectB, projectC].sort());
    expect(ids).not.toContain(projectA);
  });

  test("removeMemoryFromProjects removes specific assignments", async () => {
    const mem = await insertTestMemory("remove-specific memory");
    await assignMemoryToProjects(mem.id, [projectA, projectB, projectC]);

    await removeMemoryFromProjects(mem.id, [projectB]);

    const ids = await getMemoryProjectIds(mem.id);
    expect(ids.sort()).toEqual([projectA, projectC].sort());
    expect(ids).not.toContain(projectB);
  });

  test("duplicate assignment is idempotent", async () => {
    const mem = await insertTestMemory("idempotent memory");
    await assignMemoryToProjects(mem.id, [projectA, projectA]);
    const ids = await getMemoryProjectIds(mem.id);
    expect(ids).toEqual([projectA]);
  });

  test("getProjectIdsForMemories batch fetch", async () => {
    const mem1 = await insertTestMemory("batch-1");
    const mem2 = await insertTestMemory("batch-2");
    const mem3 = await insertTestMemory("batch-3 global");
    await assignMemoryToProjects(mem1.id, [projectA]);
    await assignMemoryToProjects(mem2.id, [projectB, projectC]);
    // mem3 has no assignments (global)

    const result = await getProjectIdsForMemories([mem1.id, mem2.id, mem3.id]);
    expect(result.get(mem1.id)).toEqual([projectA]);
    expect(result.get(mem2.id)!.sort()).toEqual([projectB, projectC].sort());
    expect(result.get(mem3.id)).toEqual([]);
  });

  test("deleting a project cascades to junction rows", async () => {
    const tempProj = await createProject({ name: "temp-proj", path: "/tmp/temp-proj" });
    const mem = await insertTestMemory("cascade-project memory");
    await assignMemoryToProjects(mem.id, [tempProj.id, projectA]);

    const { sql } = await import("drizzle-orm");
    await getDb().execute(sql`DELETE FROM projects WHERE id = ${tempProj.id}`);

    const ids = await getMemoryProjectIds(mem.id);
    expect(ids).toEqual([projectA]);
    expect(ids).not.toContain(tempProj.id);
  });

  test("deleting a memory cascades to junction rows", async () => {
    const mem = await insertTestMemory("cascade-memory memory");
    await assignMemoryToProjects(mem.id, [projectA, projectB]);

    await deleteMemory(mem.id);

    // Junction rows should be gone — verify via raw SQL
    const { sql } = await import("drizzle-orm");
    const rows = await getDb().execute(sql`SELECT * FROM memory_projects WHERE memory_id = ${mem.id}`);
    expect(rows.rows).toHaveLength(0);
  });
});

// ── Scope Query Tests ─────────────────────────────────────────────

describe("scope queries with multi-project memories", () => {
  test("scope=project finds multi-project memory", async () => {
    const mem = await insertTestMemory("scope-multi-ab");
    await assignMemoryToProjects(mem.id, [projectA, projectB]);

    const results = await searchMemories({ scope: "project", projectId: projectA });
    const foundIds = results.map((m) => m.id);
    expect(foundIds).toContain(mem.id);
  });

  test("scope=project for different project finds same memory", async () => {
    const mem = await insertTestMemory("scope-multi-ab-2");
    await assignMemoryToProjects(mem.id, [projectA, projectB]);

    const results = await searchMemories({ scope: "project", projectId: projectB });
    const foundIds = results.map((m) => m.id);
    expect(foundIds).toContain(mem.id);
  });

  test("scope=project excludes memory from unassigned project", async () => {
    const mem = await insertTestMemory("scope-excluded");
    await assignMemoryToProjects(mem.id, [projectA, projectB]);

    const results = await searchMemories({ scope: "project", projectId: projectC });
    const foundIds = results.map((m) => m.id);
    expect(foundIds).not.toContain(mem.id);
  });

  test("scope=global only returns memories with no project assignments", async () => {
    const globalMem = await insertTestMemory("scope-global-only");
    // No project assignments — this is global

    const projMem = await insertTestMemory("scope-not-global");
    await assignMemoryToProjects(projMem.id, [projectA]);

    const results = await searchMemories({ scope: "global" });
    const foundIds = results.map((m) => m.id);
    expect(foundIds).toContain(globalMem.id);
    expect(foundIds).not.toContain(projMem.id);
  });

  test("scope=all returns project memories + global memories", async () => {
    const projMem = await insertTestMemory("scope-all-proj");
    await assignMemoryToProjects(projMem.id, [projectA]);

    const globalMem = await insertTestMemory("scope-all-global");
    // No assignment — global

    const results = await searchMemories({ scope: "all", projectId: projectA });
    const foundIds = results.map((m) => m.id);
    expect(foundIds).toContain(projMem.id);
    expect(foundIds).toContain(globalMem.id);
  });

  test("no scope + projectId backward compat", async () => {
    const mem = await insertTestMemory("compat-junction");
    await assignMemoryToProjects(mem.id, [projectA]);

    const results = await searchMemories({ projectId: projectA });
    const foundIds = results.map((m) => m.id);
    expect(foundIds).toContain(mem.id);
  });
});

// ── Bad Path Tests ────────────────────────────────────────────────

describe("multi-project assignment edge cases", () => {
  test("assignMemoryToProjects with empty array is no-op", async () => {
    const mem = await insertTestMemory("empty-assign");
    await assignMemoryToProjects(mem.id, []);
    const ids = await getMemoryProjectIds(mem.id);
    expect(ids).toEqual([]);
  });

  test("removeMemoryFromProjects with empty array is no-op", async () => {
    const mem = await insertTestMemory("empty-remove");
    await assignMemoryToProjects(mem.id, [projectA]);
    await removeMemoryFromProjects(mem.id, []);
    const ids = await getMemoryProjectIds(mem.id);
    expect(ids).toEqual([projectA]);
  });

  test("setMemoryProjects with empty array removes all", async () => {
    const mem = await insertTestMemory("set-empty");
    await assignMemoryToProjects(mem.id, [projectA, projectB]);

    await setMemoryProjects(mem.id, []);

    const ids = await getMemoryProjectIds(mem.id);
    expect(ids).toEqual([]);
  });
});
