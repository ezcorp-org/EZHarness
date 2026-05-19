import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { MemoryProvenance } from "../memory/types";

// Custom mock that includes rawQuery (required by hybridSearch)
mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
  rawQuery: async (sql: string, params: (string | null)[] = []) => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    return pg.query(sql, params);
  },
}));

// Re-establish real settings backed by the test DB
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      return Object.fromEntries((await getDb().select().from(tbl)).map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      if (!rows[0]) return false;
      await getDb().delete(tbl).where(eq(tbl.key, key));
      return true;
    },
    async isListingInstalled() { return false; },
  };
});

mockEmbeddingsModule();

// Dynamic imports AFTER mocks
const { insertMemory } = await import("../db/queries/memories");
const { hybridSearch } = await import("../memory/retrieval");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");

let projectAId: string;
let projectBId: string;
let projectCId: string;
let conversationId: string;

let memA: { id: string };
let memB: { id: string };
let memGlobal: { id: string };
let memAB: { id: string };
let memArchived: { id: string };
let memStale: { id: string };

async function insertTestMemory(content: string, opts?: { projectId?: string | null; projectIds?: string[]; category?: string; status?: string }) {
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
    projectId: opts?.projectId === null ? undefined : (opts?.projectId ?? undefined),
    conversationId,
    messageIds: ["msg-test"],
    confidence: "high",
    embedding,
    provenance,
    ...(opts?.projectIds ? { projectIds: opts.projectIds } : {}),
  });
  if (opts?.status && opts.status !== "active") {
    const db = getDb();
    const { memories } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(memories).set({ status: opts.status } as any).where(eq(memories.id, mem.id));
  }
  return mem;
}

describe("hybridSearch project filtering", () => {
  beforeAll(async () => {
    await setupTestDb();

    const projA = await createProject({ name: "Project Alpha", path: "/alpha" });
    const projB = await createProject({ name: "Project Beta", path: "/beta" });
    const projC = await createProject({ name: "Project Charlie", path: "/charlie" });
    projectAId = projA.id;
    projectBId = projB.id;
    projectCId = projC.id;

    const conv = await createConversation(projectAId, { title: "test-conv" });
    conversationId = conv.id;

    memA = await insertTestMemory("Alpha project API endpoints", { projectId: projectAId });
    memB = await insertTestMemory("Beta project UI components", { projectId: projectBId });
    memGlobal = await insertTestMemory("Organization wide coding guide", { projectId: null });
    memAB = await insertTestMemory("Shared CI CD pipeline", { projectIds: [projectAId, projectBId] });
    memArchived = await insertTestMemory("Old deprecated docs", { projectId: projectAId, status: "archived" });
    memStale = await insertTestMemory("Stale project A config", { projectId: projectAId, status: "stale" });
  });

  afterAll(async () => {
    await closeTestDb();
    restoreModuleMocks();
  });

  test("with projectId filters to project + global memories", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("API", embedding, { projectId: projectAId });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(memA.id);
    expect(ids).toContain(memGlobal.id);
    expect(ids).not.toContain(memB.id);
  });

  test("without projectId returns all non-archived memories", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("project", embedding, {});
    const ids = results.map((r) => r.id);
    expect(ids).toContain(memA.id);
    expect(ids).toContain(memB.id);
    expect(ids).toContain(memGlobal.id);
    expect(ids).not.toContain(memArchived.id);
  });

  test("with isolation=true excludes global memories", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("coding guide", embedding, { projectId: projectAId, isolateToProject: true });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(memGlobal.id);
    // memA should be present (it's assigned to projectA)
    expect(ids).toContain(memA.id);
  });

  test("with isolation=false includes global memories", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("coding guide", embedding, { projectId: projectAId, isolateToProject: false });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(memGlobal.id);
  });

  test("never returns memories from other projects (isolation=false)", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("UI components", embedding, { projectId: projectAId, isolateToProject: false });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(memB.id);
  });

  test("never returns memories from other projects (isolation=true)", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("UI components", embedding, { projectId: projectAId, isolateToProject: true });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(memB.id);
  });

  test("multi-project memory appears in both projects", async () => {
    const embedding = mockEmbedding();

    const resultsA = await hybridSearch("CI CD pipeline", embedding, { projectId: projectAId });
    expect(resultsA.map((r) => r.id)).toContain(memAB.id);

    const resultsB = await hybridSearch("CI CD pipeline", embedding, { projectId: projectBId });
    expect(resultsB.map((r) => r.id)).toContain(memAB.id);
  });

  test("multi-project memory does NOT appear in unassigned project", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("CI CD pipeline", embedding, { projectId: projectCId });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(memAB.id);
  });

  test("archived memories excluded regardless of project", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("deprecated", embedding, { projectId: projectAId });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(memArchived.id);
  });

  test("stale memories included but present in results", async () => {
    const embedding = mockEmbedding();
    const results = await hybridSearch("stale config", embedding, { projectId: projectAId });
    // Stale memories are not excluded — they just get a lower score
    // With keyword matching on "stale config", memStale should appear
    const ids = results.map((r) => r.id);
    expect(ids).toContain(memStale.id);
  });

  test("project boost gives higher score to project memories vs global", async () => {
    // Insert two memories with identical content — one project-scoped, one global
    // This ensures both get the same vector + keyword RRF, so the only difference is the 1.5x project boost
    const boostedProjectMem = await insertTestMemory("Identical boosted content for testing", { projectId: projectAId });
    const boostedGlobalMem = await insertTestMemory("Identical boosted content for testing", { projectId: null });

    const embedding = mockEmbedding();
    const results = await hybridSearch("identical boosted content", embedding, { projectId: projectAId, isolateToProject: false });

    const projectResult = results.find((r) => r.id === boostedProjectMem.id);
    const globalResult = results.find((r) => r.id === boostedGlobalMem.id);

    expect(projectResult).toBeDefined();
    expect(globalResult).toBeDefined();
    // Project memory should score higher due to 1.5x boost
    expect(projectResult!.rrfScore).toBeGreaterThan(globalResult!.rrfScore);
  });
});
