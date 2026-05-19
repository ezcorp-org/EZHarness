import { eq, desc, sql, and, ne, inArray } from "drizzle-orm";
import { getDb } from "../connection";
import { memories, memoryAuditLog, memoryProjects } from "../schema";
import type { Memory, NewMemory } from "../schema";
import type { MemoryConfidence, MemoryProvenance, MemoryStatus } from "../../memory/types";
import { toVectorLiteral } from "../../memory/vector-utils";

// ── Junction table helpers ────────────────────────────────────────

/** Bulk assign memory to projects (idempotent via ON CONFLICT DO NOTHING) */
export async function assignMemoryToProjects(memoryId: string, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const db = getDb();
  await db.insert(memoryProjects)
    .values(projectIds.map((projectId) => ({ memoryId, projectId })))
    .onConflictDoNothing();
}

/** Remove specific project assignments */
export async function removeMemoryFromProjects(memoryId: string, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const db = getDb();
  await db.delete(memoryProjects).where(
    and(eq(memoryProjects.memoryId, memoryId), inArray(memoryProjects.projectId, projectIds)),
  );
}

/** Replace all assignments (delete all, insert new) */
export async function setMemoryProjects(memoryId: string, projectIds: string[]): Promise<void> {
  const db = getDb();
  await db.delete(memoryProjects).where(eq(memoryProjects.memoryId, memoryId));
  if (projectIds.length > 0) {
    await db.insert(memoryProjects)
      .values(projectIds.map((projectId) => ({ memoryId, projectId })))
      .onConflictDoNothing();
  }
}

/** Get project IDs for a single memory */
export async function getMemoryProjectIds(memoryId: string): Promise<string[]> {
  const db = getDb();
  const rows = await db.select({ projectId: memoryProjects.projectId })
    .from(memoryProjects)
    .where(eq(memoryProjects.memoryId, memoryId));
  return rows.map((r: { projectId: string }) => r.projectId);
}

/** Batch fetch project IDs for multiple memories (returns Map) */
export async function getProjectIdsForMemories(memoryIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (memoryIds.length === 0) return result;
  for (const id of memoryIds) result.set(id, []);
  const db = getDb();
  const rows = await db.select({ memoryId: memoryProjects.memoryId, projectId: memoryProjects.projectId })
    .from(memoryProjects)
    .where(inArray(memoryProjects.memoryId, memoryIds));
  for (const row of rows) {
    result.get(row.memoryId)!.push(row.projectId);
  }
  return result;
}

// ── Core memory CRUD ──────────────────────────────────────────────

export async function insertMemory(data: NewMemory & { projectIds?: string[] }): Promise<Memory> {
  const db = getDb();
  const { projectIds, ...memoryData } = data;

  // Set legacy projectId to first project for backward compat
  if (projectIds && projectIds.length > 0 && !memoryData.projectId) {
    memoryData.projectId = projectIds[0];
  }

  const rows = await db.insert(memories).values(memoryData).returning();
  const memory = rows[0]!;

  // Assign to projects via junction table
  const resolvedProjectIds = projectIds ?? (memoryData.projectId ? [memoryData.projectId] : []);
  if (resolvedProjectIds.length > 0) {
    await assignMemoryToProjects(memory.id, resolvedProjectIds);
  }

  // Create audit log entry
  await db.insert(memoryAuditLog).values({
    memoryId: memory.id,
    action: "created",
    newContent: memory.content,
    reason: "Extracted from conversation",
  });

  return memory;
}

export async function updateMemory(
  id: string,
  updates: {
    content?: string;
    confidence?: MemoryConfidence;
    embedding?: number[];
    provenance?: MemoryProvenance;
  },
): Promise<void> {
  const db = getDb();

  // Get previous content for audit log
  const existing = await db.select().from(memories).where(eq(memories.id, id));
  const previousContent = existing[0]?.content;

  type MemoryUpdate = Partial<typeof memories.$inferInsert>;
  const setValues: MemoryUpdate = { updatedAt: new Date() };
  if (updates.content !== undefined) setValues.content = updates.content;
  if (updates.confidence !== undefined) setValues.confidence = updates.confidence;
  if (updates.provenance !== undefined) setValues.provenance = updates.provenance;

  // For embedding, use raw SQL since Drizzle doesn't handle vector assignment directly
  if (updates.embedding !== undefined) {
    await db.execute(
      sql`UPDATE memories SET embedding = ${sql.raw(toVectorLiteral(updates.embedding))} WHERE id = ${id}`,
    );
  }

  // Apply non-embedding updates
  const nonEmbeddingKeys = Object.keys(setValues).filter((k) => k !== "embedding");
  if (nonEmbeddingKeys.length > 0) {
    await db.update(memories).set(setValues).where(eq(memories.id, id));
  }

  // Create audit log entry
  await db.insert(memoryAuditLog).values({
    memoryId: id,
    action: "updated",
    previousContent: previousContent ?? null,
    newContent: updates.content ?? previousContent ?? null,
    reason: "Memory updated with newer information",
  });
}

export async function findSimilarMemory(
  embedding: number[],
  threshold: number = 0.85,
): Promise<{ id: string; content: string; similarity: number } | null> {
  const db = getDb();
  const vectorLiteral = toVectorLiteral(embedding);
  const results = await db.execute(sql`
    SELECT id, content, 1 - (embedding <=> ${sql.raw(vectorLiteral)}) as similarity
    FROM memories
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${sql.raw(vectorLiteral)}) > ${threshold}
    ORDER BY similarity DESC
    LIMIT 1
  `);

  if (!results.rows || results.rows.length === 0) return null;
  const row = results.rows[0] as { id: string; content: string; similarity: number | string };
  return { id: row.id, content: row.content, similarity: Number(row.similarity) };
}

export async function listMemories(opts?: {
  projectId?: string;
  category?: string;
  limit?: number;
  userId?: string;
}): Promise<Memory[]> {
  const db = getDb();
  const conditions = [];
  if (opts?.projectId) conditions.push(sql`EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = ${memories.id} AND mp.project_id = ${opts.projectId})`);
  if (opts?.category) conditions.push(eq(memories.category, opts.category as typeof memories.category._.data));
  if (opts?.userId) conditions.push(eq(memories.userId, opts.userId));

  const query = db
    .select()
    .from(memories)
    .orderBy(desc(memories.updatedAt))
    .limit(opts?.limit ?? 100);

  if (conditions.length > 0) {
    return query.where(conditions.length === 1 ? conditions[0]! : and(...conditions));
  }
  return query;
}

export async function getMemoryById(id: string): Promise<Memory | undefined> {
  const rows = await getDb().select().from(memories).where(eq(memories.id, id));
  return rows[0];
}

export async function searchMemories(opts?: {
  projectId?: string;
  scope?: "project" | "global" | "all";
  search?: string;
  status?: MemoryStatus | MemoryStatus[];
  category?: string;
  limit?: number;
  offset?: number;
  userId?: string;
}): Promise<Memory[]> {
  const db = getDb();
  const conditions: ReturnType<typeof eq>[] = [];

  if (opts?.scope === "global") {
    conditions.push(sql`NOT EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = ${memories.id})`);
  } else if (opts?.scope === "project" && opts.projectId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = ${memories.id} AND mp.project_id = ${opts.projectId})`);
  } else if (opts?.scope === "all" && opts.projectId) {
    conditions.push(sql`(EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = ${memories.id} AND mp.project_id = ${opts.projectId}) OR NOT EXISTS (SELECT 1 FROM memory_projects mp2 WHERE mp2.memory_id = ${memories.id}))`);
  } else if (opts?.projectId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = ${memories.id} AND mp.project_id = ${opts.projectId})`);
  }
  if (opts?.category) conditions.push(eq(memories.category, opts.category as typeof memories.category._.data));
  if (opts?.userId) conditions.push(eq(memories.userId, opts.userId));

  // Default: exclude archived
  if (opts?.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    conditions.push(inArray(memories.status, statuses));
  } else {
    conditions.push(ne(memories.status, "archived"));
  }

  if (opts?.search) {
    conditions.push(sql`to_tsvector('english', ${memories.content}) @@ plainto_tsquery('english', ${opts.search})`);
  }

  const where = conditions.length === 1 ? conditions[0]! : and(...conditions);
  return db
    .select()
    .from(memories)
    .where(where)
    .orderBy(desc(memories.updatedAt))
    .limit(opts?.limit ?? 100)
    .offset(opts?.offset ?? 0);
}

export async function updateMemoryStatus(
  id: string,
  status: MemoryStatus,
  reason?: string,
): Promise<void> {
  const db = getDb();
  type MemoryUpdate = Partial<typeof memories.$inferInsert>;
  const setValues: MemoryUpdate = {
    status,
    updatedAt: new Date(),
  };
  // Reactivating a memory refreshes lastAccessedAt
  if (status === "active") {
    setValues.lastAccessedAt = new Date();
  }
  await db.update(memories).set(setValues).where(eq(memories.id, id));

  await db.insert(memoryAuditLog).values({
    memoryId: id,
    action: "status_change",
    reason: reason ?? `Status changed to ${status}`,
  });
}

/**
 * v1.4: flip the per-memory `injection_eligible` flag.
 *
 * Returns the updated row (full shape). Idempotent on same-value
 * input — callers detect the no-op via the unchanged
 * `injectionEligible` field and skip the audit row at the API
 * layer (audit-row writing lives in the route handler so we can
 * thread `actor` / `userId` from the auth context).
 *
 * No write to `memory_audit_log` here: the resource-tier audit
 * table records content/status changes only. Injection-eligibility
 * is a governance concern and is audited via the shared
 * `audit_log` table with the
 * `MEMORY_INJECTION_ELIGIBILITY_CHANGED` action — wired in the
 * PATCH handler.
 */
export async function updateMemoryInjectionEligibility(
  id: string,
  injectionEligible: boolean,
): Promise<Memory | undefined> {
  const db = getDb();
  await db
    .update(memories)
    .set({ injectionEligible, updatedAt: new Date() })
    .where(eq(memories.id, id));
  const rows = await db.select().from(memories).where(eq(memories.id, id));
  return rows[0];
}

export async function deleteMemory(id: string): Promise<void> {
  const db = getDb();
  const existing = await db.select().from(memories).where(eq(memories.id, id));
  const previousContent = existing[0]?.content;

  await db.insert(memoryAuditLog).values({
    memoryId: id,
    action: "deleted",
    previousContent: previousContent ?? null,
    reason: "Memory deleted by user",
  });

  await db.delete(memories).where(eq(memories.id, id));
}

export async function touchMemoryAccess(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db.update(memories)
    .set({ lastAccessedAt: new Date() })
    .where(inArray(memories.id, ids));
}

export async function getMemoriesForDecay(): Promise<Memory[]> {
  const db = getDb();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  return db
    .select()
    .from(memories)
    .where(
      sql`(${memories.status} = 'active' AND ${memories.lastAccessedAt} < ${thirtyDaysAgo})
       OR (${memories.status} = 'stale' AND ${memories.lastAccessedAt} < ${sixtyDaysAgo})`,
    );
}

/** Fast check: does this project (or global scope) have any active/stale memories? */
export async function hasMemories(projectId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.execute(
    sql`SELECT EXISTS(
      SELECT 1 FROM memories
      WHERE status != 'archived'
        AND (EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = memories.id AND mp.project_id = ${projectId})
             OR NOT EXISTS (SELECT 1 FROM memory_projects mp2 WHERE mp2.memory_id = memories.id))
    ) AS has_data`,
  );
  return (rows.rows[0] as { has_data?: boolean } | undefined)?.has_data === true;
}
