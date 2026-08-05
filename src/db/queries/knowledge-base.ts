import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { knowledgeBaseFiles, knowledgeBaseChunks } from "../schema";
import type { KBFile, NewKBFile, KBChunk, NewKBChunk } from "../schema";
import type { KBChunkResult } from "../../memory/types";
import { toVectorLiteral } from "../../memory/vector-utils";
import { sanitizeNulString } from "../sanitize-nul";

export async function insertKBFile(data: NewKBFile): Promise<KBFile> {
  const db = getDb();
  const rows = await db.insert(knowledgeBaseFiles).values(data).returning();
  return rows[0]!;
}

export async function updateKBFile(
  id: string,
  updates: Partial<Pick<KBFile, "status" | "chunkCount">>,
): Promise<void> {
  const db = getDb();
  await db.update(knowledgeBaseFiles).set(updates).where(eq(knowledgeBaseFiles.id, id));
}

export async function listKBFiles(projectId: string): Promise<KBFile[]> {
  const db = getDb();
  return db
    .select()
    .from(knowledgeBaseFiles)
    .where(eq(knowledgeBaseFiles.projectId, projectId))
    .orderBy(desc(knowledgeBaseFiles.createdAt));
}

export async function getKBFile(id: string): Promise<KBFile | undefined> {
  const db = getDb();
  const rows = await db.select().from(knowledgeBaseFiles).where(eq(knowledgeBaseFiles.id, id));
  return rows[0];
}

export async function deleteKBFile(id: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.delete(knowledgeBaseFiles).where(eq(knowledgeBaseFiles.id, id)).returning();
  return rows.length > 0;
}

/**
 * Share a file with its project: null the owner, recording who it came from.
 *
 * `user_id = NULL` IS the sharing mechanism (anchor `KB-SHARED-NULL-OWNER`),
 * so this one UPDATE is the whole state change — retrieval and both read
 * surfaces pick it up with no further edits. `shared_by` is provenance for the
 * inverse operation and is never read by a visibility predicate.
 *
 * The ownership test lives in the WHERE clause, not in the caller, and that is
 * load-bearing rather than stylistic: the route reads the row, decides, and
 * then writes, so a concurrent share/delete could land in between. Conditioning
 * the UPDATE on `user_id = ownerId` makes the decision and the write one
 * statement — a lost race writes nothing and returns `undefined` instead of
 * publishing a row whose owner changed underneath the check.
 *
 * @returns the updated row, or `undefined` if `ownerId` no longer owns it.
 */
export async function shareKBFile(id: string, ownerId: string): Promise<KBFile | undefined> {
  const db = getDb();
  const rows = await db
    .update(knowledgeBaseFiles)
    .set({ userId: null, sharedBy: ownerId })
    .where(and(eq(knowledgeBaseFiles.id, id), eq(knowledgeBaseFiles.userId, ownerId)))
    .returning();
  return rows[0];
}

/**
 * Take a shared file back out of the project, returning it to `restoreTo`.
 *
 * `restoreTo` is the row's own `shared_by` — the ORIGINAL owner — never the
 * caller. An instance admin may invoke this (un-sharing only narrows exposure)
 * and still cannot end up owning the file, so the escape hatch is not a way to
 * take one.
 *
 * Guarded in SQL for the same reason as {@link shareKBFile}, and with the
 * `shared_by = restoreTo` term doing real work: it pins the row to the exact
 * provenance the route authorized against, so a re-share by someone else
 * between the read and the write cannot be silently redirected to the wrong
 * owner. `user_id IS NULL` is re-checked here too, so an already-un-shared row
 * cannot have its owner overwritten.
 *
 * @returns the updated row, or `undefined` if the row moved under the check.
 */
export async function unshareKBFile(id: string, restoreTo: string): Promise<KBFile | undefined> {
  const db = getDb();
  const rows = await db
    .update(knowledgeBaseFiles)
    .set({ userId: restoreTo, sharedBy: null })
    .where(
      and(
        eq(knowledgeBaseFiles.id, id),
        isNull(knowledgeBaseFiles.userId),
        eq(knowledgeBaseFiles.sharedBy, restoreTo),
      ),
    )
    .returning();
  return rows[0];
}

export async function insertKBChunk(data: NewKBChunk): Promise<KBChunk> {
  const db = getDb();
  // Use raw SQL for vector insertion
  if (data.embedding) {
    const vectorLiteral = toVectorLiteral(data.embedding);
    // A bare `sql` template binds values straight to the driver, so this branch
    // BYPASSES the PgText column mapper that scrubs NULs everywhere else (see
    // src/db/nul-column-patch.ts). Chunk content is extracted from
    // user-uploaded files, which routinely yield U+0000 — and Postgres rejects
    // it in `text`, failing the whole insert. The non-vector branch below goes
    // through drizzle and is scrubbed for free.
    const content = sanitizeNulString(data.content);
    const results = await db.execute(sql`
      INSERT INTO knowledge_base_chunks (id, file_id, content, chunk_index, embedding)
      VALUES (${data.id ?? crypto.randomUUID()}, ${data.fileId}, ${content}, ${data.chunkIndex}, ${sql.raw(vectorLiteral)})
      RETURNING id, file_id as "fileId", content, chunk_index as "chunkIndex", created_at as "createdAt"
    `);
    return (results.rows ?? [])[0] as unknown as KBChunk;
  }
  const rows = await db.insert(knowledgeBaseChunks).values(data).returning();
  return rows[0]!;
}

/**
 * The ready-file ids whose chunks `userId` is allowed to see, as a scalar
 * subquery for `file_id = ANY (...)`.
 *
 * ── KB-RETRIEVAL-FOLLOWS-API ─────────────────────────────────────────────
 * This predicate is deliberately the SAME one the read API applies, so what
 * the model is fed matches what the user can open:
 *   list   `web/src/routes/api/knowledge-base/+server.ts`
 *          `files.filter(f => !f.userId || f.userId === user.id)`
 *   detail `web/src/routes/api/knowledge-base/[id]/+server.ts` (GET)
 *          `if (file.userId && file.userId !== user.id) → 404`
 * i.e. **your own rows, plus ownerless (shared) rows** — and nobody else's.
 * Retrieval used to filter on `project_id` + `status` ALONE, so one member's
 * upload was injected verbatim into every other member's chat turn while
 * those same members got a 404 from the API. Do not relax this back to
 * project-wide without moving the two API predicates with it; the three are
 * one contract, pinned by
 * `src/__tests__/security/kb-retrieval-is-user-scoped.test.ts`.
 *
 * `userId` is REQUIRED (not optional) at every call site on purpose: an
 * argument you must supply cannot be forgotten the way an omitted optional
 * one can. A `null` actor (agent/CLI run, ownerless conversation) binds
 * `f.user_id = NULL`, which SQL never satisfies, so it degrades to the
 * ownerless-only subset — the same rows any caller may read, never more.
 */
function visibleReadyFileIds(projectId: string, userId: string | null) {
  return sql`ARRAY(
    SELECT f.id FROM knowledge_base_files f
    WHERE f.project_id = ${projectId} AND f.status = 'ready'
      AND (f.user_id IS NULL OR f.user_id = ${userId})
  )`;
}

export async function searchKBChunks(
  embedding: number[],
  projectId: string,
  userId: string | null,
  limit: number = 5,
): Promise<KBChunkResult[]> {
  const db = getDb();
  const vectorLiteral = toVectorLiteral(embedding);
  // SRCH-05 restructure (mirrors message-search.ts): a correlated join
  // (`JOIN knowledge_base_files f ... WHERE f.project_id = …`) inside the ANN
  // scan makes the pgvector-0.8 planner FALL BACK to a seq scan + brute sort —
  // idx_kb_chunks_embedding never drives it. Resolve the project's ready file
  // ids ONCE as an InitPlan (`file_id = ANY(ARRAY(...))`), scan
  // knowledge_base_chunks ALONE ordered by the distance operator (the HNSW
  // node), then attach the filename via a display join OUTSIDE the ANN scan.
  try {
    await db.execute(sql`SET hnsw.iterative_scan = 'relaxed_order'`);
  } catch {
    // Backend without the GUC (older pgvector) — correctness unaffected.
  }
  const results = await db.execute(sql`
    WITH ann AS (
      SELECT c.id, c.content, c.chunk_index as "chunkIndex", c.file_id as "fileId",
             (c.embedding <=> ${sql.raw(vectorLiteral)}) as distance
      FROM knowledge_base_chunks c
      WHERE c.embedding IS NOT NULL
        AND c.file_id = ANY (${visibleReadyFileIds(projectId, userId)})
      ORDER BY c.embedding <=> ${sql.raw(vectorLiteral)}
      LIMIT ${limit}
    )
    SELECT ann.id, ann.content, ann."chunkIndex", f.filename, ann."fileId",
           1 - ann.distance as similarity
    FROM ann
    JOIN knowledge_base_files f ON f.id = ann."fileId"
    ORDER BY ann.distance
  `);
  return (results.rows ?? []) as unknown as KBChunkResult[];
}

/** Fast check: does this project have any indexed KB chunks THIS user may see?
 *  Imported dynamically by src/runtime/stream-chat/setup-tools.ts, where a
 *  `false` skips the embedding call entirely. Scoped by the same
 *  KB-RETRIEVAL-FOLLOWS-API predicate as `searchKBChunks` so the fast path
 *  cannot answer `true` for a caller the search would then return nothing to —
 *  that mismatch would buy an embedding round-trip for a guaranteed-empty
 *  result. */
// fallow-ignore-next-line unused-export
export async function hasKBChunks(projectId: string, userId: string | null): Promise<boolean> {
  const db = getDb();
  const rows = await db.execute(
    sql`SELECT EXISTS(
      SELECT 1 FROM knowledge_base_chunks c
      WHERE c.file_id = ANY (${visibleReadyFileIds(projectId, userId)})
    ) AS has_data`,
  );
  return (rows.rows[0] as { has_data?: boolean } | undefined)?.has_data === true;
}
