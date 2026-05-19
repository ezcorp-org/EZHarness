import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, getTestPglite } from "./helpers/test-pglite";
import { mockEmbedding, mockEmbeddingsModule } from "./helpers/mock-vectors";
import type { MemoryProvenance } from "../memory/types";

mockDbConnection();
mockEmbeddingsModule();

// Dynamic imports after mocks
const { insertMemory, getMemoryById } = await import("../db/queries/memories");
const { runDecaySweep, startDecayTimer } = await import("../memory/lifecycle");
const { getMemoriesForDecay } = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { getDb } = await import("../db/connection");
const { memories } = await import("../db/schema");
const { eq } = await import("drizzle-orm");

let projectId: string;
let conversationId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "decay-test", path: "/tmp/decay" });
  projectId = project.id;
  const conv = await createConversation(projectId, { title: "decay conv" });
  conversationId = conv.id;
});

afterAll(async () => {
  await closeTestDb();
});

async function insertTestMemory(content: string, opts?: { category?: string; status?: string }) {
  const embedding = mockEmbedding();
  const provenance: MemoryProvenance = {
    sourceConversationId: conversationId,
    sourceMessageIds: ["msg-decay"],
    extractedAt: new Date(),
    confidence: "high",
    history: [{ action: "created", timestamp: new Date(), reason: "test" }],
  };
  const mem = await insertMemory({
    content,
    category: (opts?.category ?? "technical") as any,
    projectId,
    conversationId,
    messageIds: ["msg-decay"],
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

describe("runDecaySweep", () => {
  beforeEach(async () => {
    const pglite = getTestPglite();
    await pglite.exec("DELETE FROM memory_audit_log");
    await pglite.exec("DELETE FROM memories");
  });

  test("transitions active memories older than 30 days to stale", async () => {
    const mem = await insertTestMemory("Active memory that should go stale");

    const db = getDb();
    const pastDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000); // 35 days ago
    await db.update(memories).set({ lastAccessedAt: pastDate } as any).where(eq(memories.id, mem.id));

    await runDecaySweep();

    const updated = await getMemoryById(mem.id);
    expect((updated as any).status).toBe("stale");
  });

  test("transitions stale memories older than 60 days to archived", async () => {
    const mem = await insertTestMemory("Stale memory that should be archived", { status: "stale" });

    const db = getDb();
    const pastDate = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000); // 65 days ago
    await db.update(memories).set({ lastAccessedAt: pastDate } as any).where(eq(memories.id, mem.id));

    await runDecaySweep();

    const updated = await getMemoryById(mem.id);
    expect((updated as any).status).toBe("archived");
  });

  test("does not touch recently accessed memories", async () => {
    const mem = await insertTestMemory("Recently accessed memory");

    await runDecaySweep();

    const unchanged = await getMemoryById(mem.id);
    expect((unchanged as any).status).toBe("active");
  });

  test("returns count of updated memories", async () => {
    const mem1 = await insertTestMemory("First stale candidate");
    const mem2 = await insertTestMemory("Second stale candidate");

    const db = getDb();
    const pastDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000); // 35 days ago
    await db.update(memories).set({ lastAccessedAt: pastDate } as any).where(eq(memories.id, mem1.id));
    await db.update(memories).set({ lastAccessedAt: pastDate } as any).where(eq(memories.id, mem2.id));

    const count = await runDecaySweep();
    expect(count).toBe(2);
  });
});

describe("startDecayTimer", () => {
  beforeEach(async () => {
    const pglite = getTestPglite();
    await pglite.exec("DELETE FROM memory_audit_log");
    await pglite.exec("DELETE FROM memories");
  });

  test("calls runDecaySweep on interval", async () => {
    const mem = await insertTestMemory("Timer sweep candidate");
    const db = getDb();
    const pastDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    await db.update(memories).set({ lastAccessedAt: pastDate } as any).where(eq(memories.id, mem.id));

    const stop = startDecayTimer(20);
    await new Promise(resolve => setTimeout(resolve, 200));
    stop();

    const updated = await getMemoryById(mem.id);
    expect((updated as any).status).toBe("stale");
  });

  test("cleanup function stops the timer", async () => {
    const mem = await insertTestMemory("Timer cleanup candidate");
    const db = getDb();
    const pastDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    await db.update(memories).set({ lastAccessedAt: pastDate } as any).where(eq(memories.id, mem.id));

    const stop = startDecayTimer(20);
    stop(); // Stop immediately
    await new Promise(resolve => setTimeout(resolve, 200));

    const unchanged = await getMemoryById(mem.id);
    expect((unchanged as any).status).toBe("active");
  });
});

describe("getMemoriesForDecay", () => {
  beforeEach(async () => {
    const pglite = getTestPglite();
    await pglite.exec("DELETE FROM memory_audit_log");
    await pglite.exec("DELETE FROM memories");
  });

  test("returns active memories older than 30 days", async () => {
    const mem = await insertTestMemory("Old active for decay query");
    const db = getDb();
    const pastDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    await db.update(memories).set({ lastAccessedAt: pastDate } as any).where(eq(memories.id, mem.id));

    const candidates = await getMemoriesForDecay();
    expect(candidates.some((c: any) => c.id === mem.id)).toBe(true);
  });

  test("returns stale memories older than 60 days", async () => {
    const mem = await insertTestMemory("Old stale for decay query", { status: "stale" });
    const db = getDb();
    const pastDate = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000);
    await db.update(memories).set({ lastAccessedAt: pastDate } as any).where(eq(memories.id, mem.id));

    const candidates = await getMemoriesForDecay();
    expect(candidates.some((c: any) => c.id === mem.id)).toBe(true);
  });

  test("excludes recently accessed memories", async () => {
    const mem = await insertTestMemory("Recent memory should not decay");

    const candidates = await getMemoriesForDecay();
    expect(candidates.some((c: any) => c.id === mem.id)).toBe(false);
  });

  test("excludes archived memories", async () => {
    const mem = await insertTestMemory("Already archived", { status: "archived" });
    const db = getDb();
    const pastDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await db.update(memories).set({ lastAccessedAt: pastDate } as any).where(eq(memories.id, mem.id));

    const candidates = await getMemoriesForDecay();
    expect(candidates.some((c: any) => c.id === mem.id)).toBe(false);
  });
});
