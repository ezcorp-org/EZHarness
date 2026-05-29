/**
 * Phase 65 Plan 01 — message-grained hybrid search (the SQL heart of v1.5).
 *
 * `searchMessages()` fuses a pgvector/HNSW *semantic* leg and a Postgres FTS
 * *lexical* leg via Reciprocal Rank Fusion in a single CTE round-trip. It is the
 * single source of truth the Wave-2 route (`65-02`) and Phases 66/67 consume.
 *
 * It mirrors two shipped functions:
 *   - `hybridSearch` (src/memory/retrieval.ts) — the RRF structure: two ranked
 *     CTEs, FULL OUTER JOIN, fused score `1/(k+rank_v) + 1/(k+rank_k)`, k=60.
 *   - `searchConversations` (src/db/queries/conversations.ts) — the lexical
 *     leg: `ts_headline(... '<mark>' ...)` snippet, the tenant triple
 *     (project_id + test-null-safe + optional user), and the <2-char guard.
 *
 * Execution copies the `searchKBChunks` DUAL-BACKEND pattern
 * (src/db/queries/knowledge-base.ts): `db.execute(sql\`…\`)` with every tenant
 * field PARAMETERIZED via the sql tag and ONLY the validated vector literal
 * spliced via `sql.raw(toVectorLiteral(...))`. The older `rawQuery()`
 * string-interpolation path that `hybridSearch` uses is intentionally NOT used.
 *
 * Tenant scope lives INSIDE the CTEs (SRCH-04/05): project_id + test-null-safe
 * exclusion + role IN (user,assistant) + optional user_id + embedding IS NOT
 * NULL. message_chunks carries a DENORMALIZED conversation_id so the ANN CTE
 * scopes without a hop back through messages.
 *
 * ── SRCH-05 HNSW deviation (vs plan's anti-pattern note) ──────────────────
 * The plan's Task-1 anti-pattern said "do NOT feature-detect
 * hnsw.iterative_scan — pgvector 0.8.0 default behavior satisfies SRCH-05 (no
 * GUC)". Live-probing the SHIPPED stack (PGlite 0.3.16 → pgvector 0.8.0)
 * disproved that: with the plan's JOIN-based scope (or any correlated
 * messages/conversations join in the ANN scan) the planner NEVER picks
 * `idx_message_chunks_embedding`; it falls back to a Bitmap/Seq scan + brute
 * sort, so the required "tenant Filter inside the HNSW Index Scan" plan never
 * appears. The ONLY structure that produces it is:
 *   (1) resolve the scoped conversation ids ONCE (InitPlan),
 *   (2) scan message_chunks ALONE ordered by `embedding <=> q LIMIT k` with the
 *       tenant predicate as `conversation_id = ANY(ARRAY(<scoped ids>))` (the
 *       denormalized column the schema was designed for — no join in the ANN),
 *   (3) apply the role filter + DISTINCT-ON + display join OUTSIDE the ANN scan,
 *   (4) `SET hnsw.iterative_scan='relaxed_order'` (best-effort) so the filtered
 *       ANN scan is correct + index-driven at scale.
 * Functional results are identical to the join form on small corpora (brute
 * fallback returns the same rows); the restructure is what makes the EXPLAIN
 * plan honest at scale. See 65-01-SUMMARY.md "Deviations".
 */
import { sql } from "drizzle-orm";
import { getDb } from "../connection";
import { toVectorLiteral } from "../../memory/vector-utils";

/** RRF constant. Named so RANK-01 (v2) has a one-line tune point. */
export const RRF_K = 60;

export type SearchMode = "hybrid" | "keyword" | "semantic";
export type MatchType = "lexical" | "semantic" | "both";

export interface MessageSearchHit {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  role: "user" | "assistant";
  createdAt: Date;
  /** `<mark>…</mark>` for lexical/both; plain leading slice for semantic. */
  snippet: string;
  matchType: MatchType;
  rankLexical: number | null;
  rankSemantic: number | null;
  score: number;
}

export interface SearchMessagesParams {
  projectId: string;
  query: string;
  mode: SearchMode;
  /** Required when the mode needs the semantic leg (hybrid/semantic). */
  queryEmbedding: number[] | null;
  userId?: string;
  limit?: number;
  offset?: number;
}

// ── Shared snippet options (verbatim from searchConversations) ──────────
const HEADLINE_OPTS = "StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15";

/**
 * Scoped-conversation id set as an `ANY(ARRAY(...))` subquery (parameterized).
 * Resolved once as an InitPlan by the planner so the ANN scan stays
 * single-table — the precondition for the HNSW Index Scan (see header note).
 */
function scopedConvArray(projectId: string, userId: string | undefined) {
  const userFilter = userId ? sql` AND c.user_id = ${userId}` : sql``;
  return sql`ANY (ARRAY(
    SELECT c.id FROM conversations c
    WHERE c.project_id = ${projectId}
      AND (c.test IS NULL OR c.test = false)${userFilter}
  ))`;
}

/**
 * Vector-leg ANN scan (parameterized): message_chunks scanned ALONE, ordered by
 * cosine distance, tenant-filtered via the denormalized conversation_id against
 * the scoped-conversation array. No join + no DISTINCT here — that is what lets
 * the planner drive `idx_message_chunks_embedding` (the HNSW node). The role
 * filter + DISTINCT-ON happen in the wrapping CTE / display join.
 *
 * `vectorLiteral` is pre-validated via toVectorLiteral and spliced raw; every
 * tenant value binds through the sql tag.
 */
function vectorLegInner(
  vectorLiteral: string,
  projectId: string,
  userId: string | undefined,
  fetchLimit: number,
) {
  return sql`
    SELECT
      mc.message_id AS message_id,
      (mc.embedding <=> ${sql.raw(vectorLiteral)}) AS dist,
      mc.content AS matched_content
    FROM message_chunks mc
    WHERE mc.embedding IS NOT NULL
      AND mc.conversation_id = ${scopedConvArray(projectId, userId)}
    ORDER BY mc.embedding <=> ${sql.raw(vectorLiteral)}
    LIMIT ${fetchLimit}
  `;
}

/**
 * Lexical-leg ranked CTE body (parameterized). ROW_NUMBER over ts_rank DESC,
 * with the `<mark>` ts_headline snippet. Mirrors searchConversations.
 */
function keywordLegInner(
  query: string,
  projectId: string,
  userId: string | undefined,
  fetchLimit: number,
) {
  const userFilter = userId ? sql` AND c.user_id = ${userId}` : sql``;
  return sql`
    SELECT
      m.id AS message_id,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', ${query})) DESC
      ) AS rank_k,
      ts_headline('english', m.content, plainto_tsquery('english', ${query}), ${HEADLINE_OPTS}) AS snippet
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE c.project_id = ${projectId}
      AND (c.test IS NULL OR c.test = false)
      ${userFilter}
      AND m.role IN ('user', 'assistant')
      AND to_tsvector('english', m.content) @@ plainto_tsquery('english', ${query})
    LIMIT ${fetchLimit}
  `;
}

/** Plain ~35-word leading slice of a chunk's content — semantic snippet (no <mark>). */
function plainSnippet(content: string): string {
  return content.split(/\s+/).filter(Boolean).slice(0, 35).join(" ");
}

interface RawRow {
  message_id: string;
  rank_v: string | number | null;
  rank_k: string | number | null;
  score: string | number;
  snippet: string | null;
  matched_content: string | null;
  conversation_id: string;
  conversation_title: string;
  role: string;
  created_at: string | Date;
}

function toHit(row: RawRow): MessageSearchHit {
  const rankSemantic = row.rank_v != null ? Number(row.rank_v) : null;
  const rankLexical = row.rank_k != null ? Number(row.rank_k) : null;
  const matchType: MatchType =
    rankSemantic != null && rankLexical != null
      ? "both"
      : rankLexical != null
        ? "lexical"
        : "semantic";

  // lexical/both → the ts_headline <mark> snippet; semantic-only → plain slice.
  const snippet =
    matchType === "semantic"
      ? plainSnippet(row.matched_content ?? "")
      : (row.snippet ?? plainSnippet(row.matched_content ?? ""));

  return {
    conversationId: row.conversation_id,
    conversationTitle: row.conversation_title,
    messageId: row.message_id,
    role: row.role as "user" | "assistant",
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    snippet,
    matchType,
    rankLexical,
    rankSemantic,
    score: Number(row.score),
  };
}

export async function searchMessages(params: SearchMessagesParams): Promise<MessageSearchHit[]> {
  const { projectId, query, mode, queryEmbedding, userId } = params;
  const limit = params.limit ?? 20;
  const offset = params.offset ?? 0;

  // <2-char/whitespace guard — verbatim from searchConversations. No SQL.
  if (!query || query.trim().length < 2) return [];

  const db = getDb();
  const fetchLimit = limit * 2;
  const needsVector = mode === "hybrid" || mode === "semantic";
  const vectorLiteral = needsVector && queryEmbedding ? toVectorLiteral(queryEmbedding) : null;

  // Best-effort: enable pgvector 0.8.0 in-filter ANN so the tenant-filtered
  // vector leg is driven by the HNSW index at scale (SRCH-05). Session-scoped,
  // harmless if absent on the backend (older pgvector), so swallow failures.
  if (needsVector) {
    try {
      await db.execute(sql`SET hnsw.iterative_scan = 'relaxed_order'`);
    } catch {
      // backend without the GUC — correctness is unaffected (brute fallback).
    }
  }

  let fused;
  if (mode === "keyword") {
    // Single lexical CTE; display join attaches conversation + role + createdAt.
    fused = sql`
      WITH keyword_ranked AS (
        ${keywordLegInner(query, projectId, userId, fetchLimit)}
      )
      SELECT
        k.message_id AS message_id,
        NULL::bigint AS rank_v,
        k.rank_k AS rank_k,
        (1.0 / (${RRF_K} + k.rank_k)) AS score,
        k.snippet AS snippet,
        NULL::text AS matched_content,
        c.id AS conversation_id,
        c.title AS conversation_title,
        m.role AS role,
        m.created_at AS created_at
      FROM keyword_ranked k
      JOIN messages m ON m.id = k.message_id
      JOIN conversations c ON c.id = m.conversation_id
      ORDER BY score DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else if (mode === "semantic") {
    if (!vectorLiteral) return [];
    fused = sql`
      WITH ann AS (
        ${vectorLegInner(vectorLiteral, projectId, userId, fetchLimit)}
      ),
      closest AS (
        SELECT DISTINCT ON (a.message_id) a.message_id, a.dist, a.matched_content
        FROM ann a
        ORDER BY a.message_id, a.dist
      ),
      vector_ranked AS (
        SELECT cl.message_id, cl.dist, cl.matched_content,
               ROW_NUMBER() OVER (ORDER BY cl.dist) AS rank_v
        FROM closest cl
      )
      SELECT
        v.message_id AS message_id,
        v.rank_v AS rank_v,
        NULL::bigint AS rank_k,
        (1.0 / (${RRF_K} + v.rank_v)) AS score,
        NULL::text AS snippet,
        v.matched_content AS matched_content,
        c.id AS conversation_id,
        c.title AS conversation_title,
        m.role AS role,
        m.created_at AS created_at
      FROM vector_ranked v
      JOIN messages m ON m.id = v.message_id AND m.role IN ('user', 'assistant')
      JOIN conversations c ON c.id = m.conversation_id
      ORDER BY score DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  } else {
    // hybrid: FULL OUTER JOIN of the two ranked legs on message_id.
    if (!vectorLiteral) return [];
    fused = sql`
      WITH ann AS (
        ${vectorLegInner(vectorLiteral, projectId, userId, fetchLimit)}
      ),
      closest AS (
        SELECT DISTINCT ON (a.message_id) a.message_id, a.dist, a.matched_content
        FROM ann a
        ORDER BY a.message_id, a.dist
      ),
      vector_ranked AS (
        SELECT cl.message_id, cl.dist, cl.matched_content,
               ROW_NUMBER() OVER (ORDER BY cl.dist) AS rank_v
        FROM closest cl
      ),
      keyword_ranked AS (
        ${keywordLegInner(query, projectId, userId, fetchLimit)}
      ),
      fused AS (
        SELECT
          COALESCE(v.message_id, k.message_id) AS message_id,
          v.rank_v AS rank_v,
          k.rank_k AS rank_k,
          (
            COALESCE(1.0 / (${RRF_K} + v.rank_v), 0) +
            COALESCE(1.0 / (${RRF_K} + k.rank_k), 0)
          ) AS score,
          k.snippet AS snippet,
          v.matched_content AS matched_content
        FROM vector_ranked v
        FULL OUTER JOIN keyword_ranked k ON v.message_id = k.message_id
      )
      SELECT
        f.message_id AS message_id,
        f.rank_v AS rank_v,
        f.rank_k AS rank_k,
        f.score AS score,
        f.snippet AS snippet,
        f.matched_content AS matched_content,
        c.id AS conversation_id,
        c.title AS conversation_title,
        m.role AS role,
        m.created_at AS created_at
      FROM fused f
      JOIN messages m ON m.id = f.message_id AND m.role IN ('user', 'assistant')
      JOIN conversations c ON c.id = m.conversation_id
      ORDER BY f.score DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  const result = await db.execute(fused);
  return ((result.rows ?? []) as unknown as RawRow[]).map(toHit);
}

/**
 * SRCH-05 helper: returns the literal `EXPLAIN ANALYZE` SQL string for the
 * vector leg's single-table ANN scan — the EXACT shape `searchMessages` runs
 * for the vector leg — so a test can prove the tenant filter lands inside the
 * HNSW Index Scan node (`idx_message_chunks_embedding`). The vector literal is
 * validated and spliced; projectId/userId are inlined (test-only, trusted ids)
 * because EXPLAIN runs the raw string form without the sql-tag binding layer.
 *
 * Pair with `SET hnsw.iterative_scan='relaxed_order'` before running (the test
 * does this) — that is the GUC `searchMessages` sets to drive the index scan.
 */
export function explainVectorLegSql(params: {
  projectId: string;
  queryEmbedding: number[];
  userId?: string;
  limit?: number;
}): string {
  const vectorLiteral = toVectorLiteral(params.queryEmbedding);
  const fetchLimit = (params.limit ?? 20) * 2;
  const esc = (s: string) => s.replace(/'/g, "''");
  const userFilter = params.userId ? ` AND c.user_id = '${esc(params.userId)}'` : "";
  return `EXPLAIN ANALYZE
    SELECT
      mc.message_id AS message_id,
      (mc.embedding <=> ${vectorLiteral}) AS dist,
      mc.content AS matched_content
    FROM message_chunks mc
    WHERE mc.embedding IS NOT NULL
      AND mc.conversation_id = ANY (ARRAY(
        SELECT c.id FROM conversations c
        WHERE c.project_id = '${esc(params.projectId)}'
          AND (c.test IS NULL OR c.test = false)${userFilter}
      ))
    ORDER BY mc.embedding <=> ${vectorLiteral}
    LIMIT ${fetchLimit}`;
}
