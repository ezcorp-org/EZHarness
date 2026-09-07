import { eq, desc, sql, and, ne, inArray } from "drizzle-orm";
import { getDb } from "../connection";
import type { DbTransaction } from "../connection";
import { conversations, memories, memoryAuditLog, memoryProjects } from "../schema";
import type { Memory, NewMemory } from "../schema";
import type { MemoryConfidence, MemoryProvenance, MemoryStatus } from "../../memory/types";
import { toVectorLiteral } from "../../memory/vector-utils";

// ── Junction table helpers ────────────────────────────────────────

/** Bulk assign memory to projects (idempotent via ON CONFLICT DO NOTHING) */
async function syncLegacyProjectId(
  tx: DbTransaction,
  memoryId: string,
  preferredProjectId?: string | null,
): Promise<void> {
  const rows = await tx.select({ projectId: memoryProjects.projectId })
    .from(memoryProjects)
    .where(eq(memoryProjects.memoryId, memoryId));
  const projectIds = rows.map((row: { projectId: string }) => row.projectId);
  const projectId = preferredProjectId && projectIds.includes(preferredProjectId)
    ? preferredProjectId
    : (projectIds[0] ?? null);
  await tx.update(memories).set({ projectId }).where(eq(memories.id, memoryId));
}

export async function assignMemoryToProjects(memoryId: string, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const db = getDb();
  await db.transaction(async (tx: DbTransaction) => {
    const memory = (await tx.select({ projectId: memories.projectId }).from(memories)
      .where(eq(memories.id, memoryId))
      .for("update", { of: memories }))[0];
    await tx.insert(memoryProjects)
      .values(projectIds.map((projectId) => ({ memoryId, projectId })))
      .onConflictDoNothing();
    await syncLegacyProjectId(tx, memoryId, memory?.projectId ?? projectIds[0]);
  });
}

/** Remove specific project assignments */
export async function removeMemoryFromProjects(memoryId: string, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const db = getDb();
  await db.transaction(async (tx: DbTransaction) => {
    const memory = (await tx.select({ projectId: memories.projectId }).from(memories)
      .where(eq(memories.id, memoryId))
      .for("update", { of: memories }))[0];
    await tx.delete(memoryProjects).where(
      and(eq(memoryProjects.memoryId, memoryId), inArray(memoryProjects.projectId, projectIds)),
    );
    await syncLegacyProjectId(tx, memoryId, memory?.projectId ?? null);
  });
}

/**
 * Replace all assignments (delete all, insert new).
 *
 * The delete + insert run in ONE transaction (mirrors createMessage in
 * conversations.ts): a crash or DB error between the delete and the insert
 * would otherwise leave the memory with ZERO junction rows, which the scope
 * queries (`searchMemories` scope='all', `hasMemories`) treat as GLOBAL —
 * silently widening a project-scoped memory into every project. Atomic
 * replace closes that window.
 */
export async function setMemoryProjects(memoryId: string, projectIds: string[]): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx: DbTransaction) => {
    await tx.select({ id: memories.id }).from(memories)
      .where(eq(memories.id, memoryId))
      .for("update", { of: memories });
    await tx.delete(memoryProjects).where(eq(memoryProjects.memoryId, memoryId));
    if (projectIds.length > 0) {
      await tx.insert(memoryProjects)
        .values(projectIds.map((projectId) => ({ memoryId, projectId })))
        .onConflictDoNothing();
    }
    // `memories.project_id` is compatibility data only; keeping it aligned
    // with the junction prevents a later migration from reviving a project
    // assignment the user deliberately removed.
    await tx.update(memories)
      .set({ projectId: projectIds[0] ?? null })
      .where(eq(memories.id, memoryId));
  });
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

type MemoryInsertData = NewMemory & {
  projectIds?: string[];
  auditReason?: string;
};

async function insertMemoryInTransaction(
  tx: DbTransaction,
  data: MemoryInsertData,
): Promise<Memory> {
  const { projectIds, auditReason, ...memoryData } = data;

  // An explicit membership set owns the compatibility mirror too. In
  // particular, `projectIds: []` means global even when an older caller also
  // supplied the legacy projectId field.
  if (projectIds !== undefined) memoryData.projectId = projectIds[0] ?? null;

  // Assign to projects via junction table
  const resolvedProjectIds = projectIds ?? (memoryData.projectId ? [memoryData.projectId] : []);

  // The row insert, the junction assignment, AND the audit row are ONE atomic
  // unit (mirrors createMessage in conversations.ts). A crash between the row
  // insert and the junction insert would otherwise leave a project-scoped
  // memory with ZERO junction rows — which the scope queries treat as GLOBAL,
  // silently widening it into every project.
  const rows = await tx.insert(memories).values(memoryData).returning();
  const memory = rows[0]!;

  if (resolvedProjectIds.length > 0) {
    await tx.insert(memoryProjects)
      .values(resolvedProjectIds.map((projectId) => ({ memoryId: memory.id, projectId })))
      .onConflictDoNothing();
  }

  await tx.insert(memoryAuditLog).values({
    memoryId: memory.id,
    action: "created",
    newContent: memory.content,
    reason: auditReason ?? "Extracted from conversation",
  });
  return memory;
}

export async function insertMemory(data: NewMemory & { projectIds?: string[] }): Promise<Memory> {
  const db = getDb();
  return db.transaction((tx: DbTransaction) => insertMemoryInTransaction(tx, data));
}

function sameProjectIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((projectId) => rightIds.has(projectId));
}

/**
 * Replace two still-eligible source memories with one merged memory.
 *
 * The LLM call happens before this function. The transaction then rechecks
 * every mutable eligibility boundary before it writes, so an edit during that
 * wait cannot produce a partial or incorrectly scoped merge.
 */
export async function mergeMemoriesAtomically(
  sourceIds: [string, string],
  expected: {
    ownerUserId: string;
    projectIds: string[];
    injectionEligible: boolean;
    sourceSnapshots: Record<string, { content: string; updatedAt: Date }>;
  },
  merged: NewMemory & { projectIds: string[] },
): Promise<Memory | null> {
  const db = getDb();
  return db.transaction(async (tx: DbTransaction) => {
    // All contenders lock the same two rows in ID order. Locking the source
    // table explicitly avoids attempting to lock the nullable conversation
    // side of the owner join.
    const lockedSourceIds = [...sourceIds].sort() as [string, string];
    const sources = await tx.select({
      id: memories.id,
      status: memories.status,
      userId: memories.userId,
      conversationUserId: conversations.userId,
      injectionEligible: memories.injectionEligible,
      content: memories.content,
      updatedAt: memories.updatedAt,
    })
      .from(memories)
      .leftJoin(conversations, eq(memories.conversationId, conversations.id))
      .where(inArray(memories.id, lockedSourceIds))
      .orderBy(memories.id)
      .for("update", { of: memories });
    if (sources.length !== 2) return null;
    if (sources.some((source: {
      id: string;
      status: MemoryStatus;
      userId: string | null;
      conversationUserId: string | null;
      injectionEligible: boolean;
      content: string;
      updatedAt: Date;
    }) =>
      source.status !== "active"
      || source.injectionEligible !== expected.injectionEligible
      || (source.userId ?? source.conversationUserId) !== expected.ownerUserId
      || source.content !== expected.sourceSnapshots[source.id]?.content
      || source.updatedAt.getTime() !== expected.sourceSnapshots[source.id]?.updatedAt.getTime()
    )) return null;

    const memberships = await tx.select({
      memoryId: memoryProjects.memoryId,
      projectId: memoryProjects.projectId,
    })
      .from(memoryProjects)
      .where(inArray(memoryProjects.memoryId, lockedSourceIds));
    const projectIdsByMemory = new Map(sourceIds.map((id) => [id, [] as string[]]));
    for (const membership of memberships) projectIdsByMemory.get(membership.memoryId)!.push(membership.projectId);
    if (sourceIds.some((id) => !sameProjectIds(projectIdsByMemory.get(id)!, expected.projectIds))) {
      return null;
    }

    const replacement = await insertMemoryInTransaction(tx, merged);
    await tx.delete(memories).where(inArray(memories.id, lockedSourceIds));
    return replacement;
  });
}

/**
 * Atomically reserve one extension memory-write allowance and create the
 * memory. The quota is charged only when the memory, its membership and its
 * resource audit row commit together.
 */
export async function insertMemoryWithDailyExtensionQuota(
  data: NewMemory & { projectIds?: string[] },
  quota: { extensionId: string; day: string; maxWrites: number },
): Promise<Memory | null> {
  if (quota.maxWrites <= 0) return null;
  const db = getDb();
  return db.transaction(async (tx: DbTransaction) => {
    const claimed = await tx.execute(sql`
      INSERT INTO extension_memory_writes_daily (extension_id, day, writes)
      VALUES (${quota.extensionId}, ${quota.day}::date, 1)
      ON CONFLICT (extension_id, day) DO UPDATE
      SET writes = extension_memory_writes_daily.writes + 1,
          updated_at = NOW()
      WHERE extension_memory_writes_daily.writes < ${quota.maxWrites}
      RETURNING writes
    `);
    if (claimed.rows.length === 0) return null;
    return insertMemoryInTransaction(tx, {
      ...data,
      auditReason: `ext:${quota.extensionId}`,
    });
  });
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

  const nonEmbeddingKeys = Object.keys(setValues).filter((k) => k !== "embedding");

  // Embedding update, column update, and audit row are ONE atomic unit — a
  // failure mid-sequence would otherwise leave an updated embedding paired with
  // stale content (or an audit row for an update that never committed).
  await db.transaction(async (tx: DbTransaction) => {
    // For embedding, use raw SQL since Drizzle doesn't handle vector assignment directly
    if (updates.embedding !== undefined) {
      await tx.execute(
        sql`UPDATE memories SET embedding = ${sql.raw(toVectorLiteral(updates.embedding))} WHERE id = ${id}`,
      );
    }

    // Apply non-embedding updates
    if (nonEmbeddingKeys.length > 0) {
      await tx.update(memories).set(setValues).where(eq(memories.id, id));
    }

    // Create audit log entry
    await tx.insert(memoryAuditLog).values({
      memoryId: id,
      action: "updated",
      previousContent: previousContent ?? null,
      newContent: updates.content ?? previousContent ?? null,
      reason: "Memory updated with newer information",
    });
  });
}

export async function findSimilarMemory(
  embedding: number[],
  threshold: number = 0.85,
  /**
   * Per-user ownership scope. Memories are per-user-private, so dedup/
   * compaction callers MUST constrain candidates to the acting owner's rows —
   * an unscoped match lets one user's content merge into (or overwrite)
   * another user's memory. `ownerUserId: null` matches nothing (fail-closed:
   * an unattributable row may not claim anyone's memories). Omit the param
   * only for owner-agnostic maintenance reuse.
   */
  scope?: {
    ownerUserId: string | null;
    excludeMemoryId?: string;
    projectId?: string;
    /** Exact junction membership. `[]` means global; omitted is unscoped. */
    projectIds?: string[];
    status?: MemoryStatus;
    injectionEligible?: boolean;
  },
): Promise<{ id: string; content: string; similarity: number } | null> {
  if (scope && scope.ownerUserId === null) return null;
  const db = getDb();
  const vectorLiteral = toVectorLiteral(embedding);
  // Same two ownership shapes as the injection predicate in
  // src/memory/retrieval.ts: directly-attributed rows, or unattributed rows
  // whose source conversation belongs to the owner.
  const ownerFilter = scope
    ? sql` AND (user_id = ${scope.ownerUserId} OR (user_id IS NULL AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = memories.conversation_id AND c.user_id = ${scope.ownerUserId})))`
    : sql``;
  const excludeFilter = scope?.excludeMemoryId
    ? sql` AND id <> ${scope.excludeMemoryId}`
    : sql``;
  const statusFilter = scope?.status
    ? sql` AND status = ${scope.status}`
    : sql``;
  const injectionEligibilityFilter = scope?.injectionEligible === undefined
    ? sql``
    : sql` AND injection_eligible = ${scope.injectionEligible}`;
  const projectFilter = scope?.projectId
    ? sql` AND EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = memories.id AND mp.project_id = ${scope.projectId})`
    : sql``;
  const exactProjectIds = scope?.projectIds === undefined
    ? undefined
    : [...new Set(scope.projectIds)];
  const exactProjectFilter = exactProjectIds === undefined
    ? sql``
    : exactProjectIds.length === 0
      ? sql` AND NOT EXISTS (SELECT 1 FROM memory_projects mp WHERE mp.memory_id = memories.id)`
      : sql` AND (
        SELECT count(*) FROM memory_projects mp WHERE mp.memory_id = memories.id
      ) = ${exactProjectIds.length}${sql.join(
        exactProjectIds.map((projectId) => sql`
          AND EXISTS (
            SELECT 1 FROM memory_projects mp
            WHERE mp.memory_id = memories.id AND mp.project_id = ${projectId}
          )
        `),
        sql``,
      )}`;
  // Order by the RAW pgvector distance operator (ASC) so idx_memories_embedding_hnsw
  // drives the scan — a derived `1 - (embedding <=> vec)` in ORDER BY (or the
  // threshold in WHERE) forces a seq scan over every row. `ORDER BY embedding
  // <=> q LIMIT 1` is the canonical HNSW query and needs no GUC. Because
  // similarity is monotonic in distance, the nearest-by-distance row IS the
  // max-similarity row, so the threshold applies to the single returned row in
  // TS. (Deliberately NOT setting hnsw.iterative_scan here: with LIMIT 1 the
  // relaxed scan can terminate early and MISS the true nearest — a missed dedup;
  // the strict default returns the exact nearest, which dedup requires.)
  const results = await db.execute(sql`
    SELECT id, content, (embedding <=> ${sql.raw(vectorLiteral)}) as distance
    FROM memories
    WHERE embedding IS NOT NULL${ownerFilter}${excludeFilter}${statusFilter}${injectionEligibilityFilter}${projectFilter}${exactProjectFilter}
    ORDER BY embedding <=> ${sql.raw(vectorLiteral)}
    LIMIT 1
  `);

  if (!results.rows || results.rows.length === 0) return null;
  const row = results.rows[0] as { id: string; content: string; distance: number | string };
  const similarity = 1 - Number(row.distance);
  if (similarity <= threshold) return null;
  return { id: row.id, content: row.content, similarity };
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

  // Audit insert + delete are ONE atomic unit so a failed delete can never
  // leave behind a 'deleted' audit row for a memory that still exists
  // (backwards forensic evidence). The audit row is written BEFORE the delete
  // because memory_audit_log.memory_id FK-references memories with ON DELETE
  // CASCADE — inserting it after the delete would violate the FK.
  await db.transaction(async (tx: DbTransaction) => {
    await tx.insert(memoryAuditLog).values({
      memoryId: id,
      action: "deleted",
      previousContent: previousContent ?? null,
      reason: "Memory deleted by user",
    });
    await tx.delete(memories).where(eq(memories.id, id));
  });
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
