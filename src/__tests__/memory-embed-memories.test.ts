/**
 * DB-audit fixes for src/db/queries/memories.ts (memory-embed group).
 *
 * Covers:
 *   - insertMemory / setMemoryProjects run their multi-step writes in ONE
 *     transaction, so a partial failure can NEVER leave a project-scoped memory
 *     with zero junction rows (which the scope queries treat as GLOBAL —
 *     silent scope widening).
 *   - deleteMemory / updateMemory wrap their mutation + audit pair atomically.
 *   - findSimilarMemory orders by the RAW pgvector distance operator (index
 *     path) and applies the threshold to the single returned row in TS, with
 *     the same nearest-row semantics as the old derived-similarity ORDER BY,
 *     plus the per-owner scope wall.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  insertMemory,
  updateMemory,
  deleteMemory,
  setMemoryProjects,
  getMemoryProjectIds,
  getMemoryById,
  findSimilarMemory,
  searchMemories,
} = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { getDb } = await import("../db/connection");
const { users, memories, memoryAuditLog } = await import("../db/schema");
const { sql, eq } = await import("drizzle-orm");

const OWNER_A = "mem-owner-a";
const OWNER_B = "mem-owner-b";
const BAD_PROJECT = "no-such-project-id";

let projectP1: string;
let projectP2: string;

/** A 384-dim vector that is 1 at `dim`, 0 elsewhere (cosine-orthogonal units). */
function unitVec(dim: number): number[] {
  const v = new Array(384).fill(0);
  v[dim] = 1;
  return v;
}

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values([
    { id: OWNER_A, email: "mem-a@test.local", name: "A", passwordHash: "h" },
    { id: OWNER_B, email: "mem-b@test.local", name: "B", passwordHash: "h" },
  ]).onConflictDoNothing();
  const p1 = await createProject({ name: "mem-p1", path: "/tmp/mem-p1" });
  const p2 = await createProject({ name: "mem-p2", path: "/tmp/mem-p2" });
  projectP1 = p1.id;
  projectP2 = p2.id;
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await getDb().execute(sql`TRUNCATE TABLE memories CASCADE`);
});

describe("insertMemory — atomic row + junction + audit", () => {
  test("a failing junction insert rolls back the whole write (no orphan memory, no audit row)", async () => {
    // projectIds contains a valid + an INVALID project. The memories row and
    // the P1 junction row insert fine; the bad junction row violates the FK,
    // which must roll BACK the already-inserted memory + audit rows.
    await expect(
      insertMemory({
        content: "atomic-insert-fact",
        category: "preferences",
        userId: OWNER_A,
        projectIds: [projectP1, BAD_PROJECT],
      } as never),
    ).rejects.toThrow();

    // No memory row survived.
    const rows = await getDb().select().from(memories).where(eq(memories.content, "atomic-insert-fact"));
    expect(rows.length).toBe(0);
    // No dangling audit row.
    const audits = await getDb().select().from(memoryAuditLog);
    expect(audits.length).toBe(0);
  });

  test("happy path inserts the memory, its junction rows, and a 'created' audit row", async () => {
    const mem = await insertMemory({
      content: "good-insert",
      category: "preferences",
      userId: OWNER_A,
      projectIds: [projectP1],
    } as never);
    expect(await getMemoryProjectIds(mem.id)).toEqual([projectP1]);
    const audits = await getDb().select().from(memoryAuditLog).where(eq(memoryAuditLog.memoryId, mem.id));
    expect(audits.length).toBe(1);
    expect(audits[0]!.action).toBe("created");
  });
});

describe("setMemoryProjects — atomic replace (no silent widening to global)", () => {
  test("a failing insert rolls back the delete — the original scoping survives", async () => {
    const mem = await insertMemory({
      content: "scoped-mem",
      category: "preferences",
      userId: OWNER_A,
      projectIds: [projectP1],
    } as never);

    // Replace with an INVALID project set — the insert FK-fails AFTER the delete.
    await expect(setMemoryProjects(mem.id, [BAD_PROJECT])).rejects.toThrow();

    // The delete must have rolled back: the memory is STILL scoped to P1, not
    // widened to zero-junction (== global).
    expect(await getMemoryProjectIds(mem.id)).toEqual([projectP1]);
  });

  test("happy path replaces the assignment set", async () => {
    const mem = await insertMemory({
      content: "rescope-mem",
      category: "preferences",
      userId: OWNER_A,
      projectIds: [projectP1],
    } as never);
    await setMemoryProjects(mem.id, [projectP2]);
    expect(await getMemoryProjectIds(mem.id)).toEqual([projectP2]);
  });
});

describe("deleteMemory / updateMemory — mutation + audit atomicity", () => {
  test("deleteMemory removes the memory (and cascades its junction rows)", async () => {
    const mem = await insertMemory({
      content: "to-delete",
      category: "preferences",
      userId: OWNER_A,
      projectIds: [projectP1],
    } as never);
    await deleteMemory(mem.id);
    expect(await getMemoryById(mem.id)).toBeUndefined();
    expect(await getMemoryProjectIds(mem.id)).toEqual([]);
  });

  test("updateMemory applies content + embedding + a 'updated' audit row together", async () => {
    const mem = await insertMemory({
      content: "before-update",
      category: "preferences",
      userId: OWNER_A,
      projectIds: [projectP1],
    } as never);
    await updateMemory(mem.id, { content: "after-update", embedding: unitVec(0) });

    const after = await getMemoryById(mem.id);
    expect(after!.content).toBe("after-update");
    const audits = await getDb().select().from(memoryAuditLog).where(
      eq(memoryAuditLog.memoryId, mem.id),
    );
    expect(audits.some((a: (typeof audits)[number]) => a.action === "updated")).toBe(true);
    // The embedding is now retrievable by findSimilarMemory.
    const hit = await findSimilarMemory(unitVec(0), 0.5);
    expect(hit?.id).toBe(mem.id);
  });
});

describe("findSimilarMemory — index-friendly distance order + threshold in TS", () => {
  async function seedMemoryWithEmbedding(content: string, vec: number[], userId?: string): Promise<string> {
    const mem = await insertMemory({
      content,
      category: "preferences",
      ...(userId ? { userId } : {}),
    } as never);
    await updateMemory(mem.id, { embedding: vec });
    return mem.id;
  }

  test("returns the nearest row above threshold; null when the nearest is below", async () => {
    const idA = await seedMemoryWithEmbedding("mem-A", unitVec(0), OWNER_A);
    await seedMemoryWithEmbedding("mem-B", unitVec(1), OWNER_A);

    // Query aligned with A → A is the max-similarity (nearest-distance) row.
    const hitA = await findSimilarMemory(unitVec(0), 0.85);
    expect(hitA?.id).toBe(idA);
    expect(hitA!.similarity).toBeGreaterThan(0.85);

    // Query orthogonal to BOTH stored vectors → nearest similarity ≈ 0 → null.
    expect(await findSimilarMemory(unitVec(5), 0.85)).toBeNull();
  });

  test("threshold is applied in TS to the returned row (strict '>' — exact match rejected at 1.0)", async () => {
    // Exact-match query → similarity 1.0 (deterministic HNSW recall). The
    // threshold check lives in TS now (`similarity <= threshold → null`), so a
    // threshold of 1.0 rejects even a perfect match, while 0.99 accepts it.
    const idA = await seedMemoryWithEmbedding("mem-A", unitVec(0), OWNER_A);
    const accepted = await findSimilarMemory(unitVec(0), 0.99);
    expect(accepted?.id).toBe(idA);
    expect(accepted!.similarity).toBeGreaterThan(0.99);
    expect(await findSimilarMemory(unitVec(0), 1.0)).toBeNull();
  });

  test("per-owner scope wall: another owner's row never matches; null-owner short-circuits", async () => {
    const idA = await seedMemoryWithEmbedding("owned-by-A", unitVec(0), OWNER_A);

    // A's own scope finds it.
    expect((await findSimilarMemory(unitVec(0), 0.5, { ownerUserId: OWNER_A }))?.id).toBe(idA);
    // B's scope finds nothing (the row is A's).
    expect(await findSimilarMemory(unitVec(0), 0.5, { ownerUserId: OWNER_B })).toBeNull();
    // Unattributable scope fails closed without querying.
    expect(await findSimilarMemory(unitVec(0), 0.5, { ownerUserId: null })).toBeNull();
  });
});

describe("scope queries still treat a zero-junction memory as global", () => {
  test("a global (no-junction) memory shows under scope='all' but a scoped one does not leak", async () => {
    // Global memory: no projectIds.
    await insertMemory({ content: "global-mem", category: "preferences", userId: OWNER_A } as never);
    // Scoped memory: P2 only.
    await insertMemory({ content: "p2-mem", category: "preferences", userId: OWNER_A, projectIds: [projectP2] } as never);

    const p1All = await searchMemories({ scope: "all", projectId: projectP1, userId: OWNER_A });
    const contents = p1All.map((m) => m.content);
    expect(contents).toContain("global-mem"); // global visible everywhere
    expect(contents).not.toContain("p2-mem"); // scoped to P2, not leaked to P1
  });
});
