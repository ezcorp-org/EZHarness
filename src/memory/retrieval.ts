// Hybrid search: combines vector cosine similarity with tsvector keyword matching using RRF scoring
import { rawQuery } from "../db/connection";
import { touchMemoryAccess } from "../db/queries/memories";
import { searchKBChunks } from "../db/queries/knowledge-base";
import { toVectorLiteral } from "./vector-utils";
import type { MemoryCategory, MemoryProvenance, KBChunkResult } from "./types";
import { logger } from "../logger";
const log = logger.child("memory");

export interface HybridSearchResult {
  id: string;
  content: string;
  category: MemoryCategory;
  projectId: string | null;
  confidence: string;
  provenance: MemoryProvenance | null;
  rrfScore: number;
}

interface HybridSearchOptions {
  projectId?: string;
  isolateToProject?: boolean;
  limit?: number;
  k?: number;
  /**
   * Acting user for per-user PII scoping. Memories are per-user-private, so
   * the injection entry point (`buildSystemPromptWithMemories`) ALWAYS passes
   * this. When set (including `null`), results are restricted to memories the
   * user owns; a `null`/unowned actor therefore matches nothing (fail-closed).
   * When `undefined` (non-user reuse of hybridSearch), the scope is skipped.
   */
  userId?: string | null;
}

export async function hybridSearch(
  query: string,
  embedding: number[],
  opts: HybridSearchOptions,
): Promise<HybridSearchResult[]> {
  const limit = opts.limit ?? 20;
  const k = opts.k ?? 60;
  const isolate = opts.isolateToProject === true;
  const projectId = opts.projectId ?? null;

  const vectorLiteral = toVectorLiteral(embedding);

  // Build WHERE clause: always exclude archived, filter by project scope
  // projectId is parameterized as $2 to prevent SQL injection
  const baseFilter = "status != 'archived'";
  let isolationFilter: string;
  if (isolate && projectId) {
    // Strict isolation: only memories assigned to this project (no global)
    isolationFilter = `WHERE ${baseFilter} AND EXISTS (SELECT 1 FROM memory_projects WHERE memory_id = memories.id AND project_id = $2)`;
  } else if (projectId) {
    // Default: this project's memories + global memories (no cross-project leak)
    isolationFilter = `WHERE ${baseFilter} AND (EXISTS (SELECT 1 FROM memory_projects WHERE memory_id = memories.id AND project_id = $2) OR NOT EXISTS (SELECT 1 FROM memory_projects WHERE memory_id = memories.id))`;
  } else {
    // No project context: all non-archived memories
    isolationFilter = `WHERE ${baseFilter}`;
  }

  // Per-user PII scope. Memories are per-user-private (see ownedByActingUser in
  // src/extensions/memory-handler.ts). Appended to the SHARED isolationFilter so
  // BOTH the vector_ranked and keyword_ranked CTEs inherit it. userId is $3 —
  // always paired with projectId ($2) because the injection entry point always
  // passes both. Two ownership shapes, mirroring ownedByActingUser:
  //   (1) memories.user_id = userId              (directly-attributed rows)
  //   (2) user_id IS NULL, but the source conversation is owned by userId
  //       (host-extracted rows — dedup/compaction don't stamp user_id).
  // A null/unowned actor matches neither shape → zero rows (fail-closed).
  if (opts.userId !== undefined) {
    // Single-line string on purpose: a multi-line template literal makes Bun's
    // coverage instrumenter emit phantom (never-hit) DA records for the interior
    // lines, which trips the patch-coverage gate.
    isolationFilter += ` AND (memories.user_id = $3 OR (memories.user_id IS NULL AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = memories.conversation_id AND c.user_id = $3)))`;
  }

  // Project boost: in global mode, multiply RRF by 1.5 for matching project
  // In isolation mode, all results are already from the project so no boost needed
  const boostExpr = !isolate && projectId
    ? `CASE WHEN EXISTS (SELECT 1 FROM memory_projects WHERE memory_id = COALESCE(v.id, k.id) AND project_id = $2) THEN 1.5 ELSE 1.0 END`
    : "1.0";

  // Status-aware weight: active=1.0, stale=0.5
  const statusWeightExpr = `CASE WHEN COALESCE(v.status, k.status) = 'stale' THEN 0.5 ELSE 1.0 END`;

  const sql = `
    WITH vector_ranked AS (
      SELECT id, content, category, project_id, confidence, provenance, status,
             ROW_NUMBER() OVER (ORDER BY embedding <=> ${vectorLiteral}) AS rank_v
      FROM memories
      ${isolationFilter}
      ORDER BY embedding <=> ${vectorLiteral}
      LIMIT ${limit * 2}
    ),
    keyword_ranked AS (
      SELECT id, content, category, project_id, confidence, provenance, status,
             ROW_NUMBER() OVER (ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $1)) DESC) AS rank_k
      FROM memories
      ${isolationFilter} AND to_tsvector('english', content) @@ plainto_tsquery('english', $1)
      LIMIT ${limit * 2}
    )
    SELECT
      COALESCE(v.id, k.id) AS id,
      COALESCE(v.content, k.content) AS content,
      COALESCE(v.category, k.category) AS category,
      COALESCE(v.project_id, k.project_id) AS project_id,
      COALESCE(v.confidence, k.confidence) AS confidence,
      COALESCE(v.provenance, k.provenance) AS provenance,
      COALESCE(v.status, k.status) AS status,
      (
        COALESCE(1.0 / (${k} + v.rank_v), 0) +
        COALESCE(1.0 / (${k} + k.rank_k), 0)
      ) * ${boostExpr} * ${statusWeightExpr} AS rrf_score
    FROM vector_ranked v
    FULL OUTER JOIN keyword_ranked k ON v.id = k.id
    ORDER BY rrf_score DESC
    LIMIT ${limit}
  `;

  const params: (string | null)[] = [query];
  if (projectId) params.push(projectId);
  // $3 — the acting user (may be null → fail-closed). Only pushed when the
  // caller opts into user scoping, keeping the placeholder count in sync with
  // the isolationFilter predicate above.
  if (opts.userId !== undefined) params.push(opts.userId);

  const result = await rawQuery(sql, params);

  const results = (result.rows as any[]).map((row) => ({
    id: row.id,
    content: row.content,
    category: row.category as MemoryCategory,
    projectId: row.project_id ?? null,
    confidence: row.confidence,
    provenance: row.provenance ?? null,
    rrfScore: Number(row.rrf_score),
  }));

  // Update lastAccessedAt for returned memories
  const resultIds = results.map((r) => r.id);
  if (resultIds.length > 0) {
    touchMemoryAccess(resultIds).catch((err) => {
      log.error("touchMemoryAccess failed", { error: String(err) });
    });
  }

  return results;
}

/**
 * Search KB chunks for a query. Wrapper around searchKBChunks for consistent interface.
 */
export async function searchKBChunksForQuery(
  _query: string,
  embedding: number[],
  projectId: string,
  limit?: number,
): Promise<KBChunkResult[]> {
  return searchKBChunks(embedding, projectId, limit);
}
