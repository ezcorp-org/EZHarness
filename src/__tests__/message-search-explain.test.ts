/**
 * Phase 65 Plan 01 — SRCH-05 EXPLAIN ANALYZE proof.
 *
 * Seeds a corpus large enough that the planner prefers the HNSW index over a
 * Bitmap/Seq scan (the plan's original "≥100" floor was based on a research
 * claim that pgvector 0.8.0 picks HNSW by default — live-probing the SHIPPED
 * PGlite 0.3.16 stack disproved that: the planner only chooses
 * `idx_message_chunks_embedding` once the table is large AND
 * `hnsw.iterative_scan` is enabled; ~2k rows clears the cost crossover). Runs
 * `ANALYZE message_chunks` for real stats, then EXPLAIN ANALYZEs the SAME
 * single-table ANN SQL the builder runs (via `explainVectorLegSql()`). The plan
 * must show the tenant `Filter:` predicate applied INSIDE the HNSW
 * `Index Scan using idx_message_chunks_embedding` node, with NO `Seq Scan` over
 * message_chunks. See message-search.ts "SRCH-05 HNSW deviation" for why.
 *
 * No mocking — pure SQL against real PGlite (pgvector 0.8.0).
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { explainVectorLegSql } = await import("../db/queries/message-search");
const { EMBEDDING_MODEL_ID } = await import("../memory/embeddings");
const { projects, users, conversations, messages } = await import("../db/schema");
const { sql } = await import("drizzle-orm");
const { toVectorLiteral } = await import("../memory/vector-utils");

const DIM = 384;

/** A pseudo-random but deterministic unit-ish vector for chunk i. */
function seededVector(i: number): number[] {
  const v = new Array(DIM).fill(0);
  // sprinkle a few non-zero components so cosine distance varies per row
  v[i % DIM] = 1;
  v[(i * 7 + 3) % DIM] = 0.5;
  v[(i * 13 + 11) % DIM] = 0.25;
  return v;
}

describe("searchMessages vector leg — EXPLAIN ANALYZE (SRCH-05)", () => {
  let projectId: string;

  beforeAll(async () => {
    await setupTestDb();
    const db = getTestDb();

    const [p] = await db.insert(projects).values({ name: "Explain", path: "/tmp/explain" }).returning();
    projectId = p!.id;
    const [u] = await db
      .insert(users)
      .values({ email: "explain@x.com", passwordHash: "h", name: "explain" })
      .returning();

    // ≥2 conversations
    const convIds: string[] = [];
    for (let c = 0; c < 3; c++) {
      const [conv] = await db
        .insert(conversations)
        .values({ projectId, userId: u!.id, title: `c${c}`, test: false })
        .returning();
      convIds.push(conv!.id);
    }

    // Enough rows that the HNSW index beats a bitmap/seq scan (cost crossover).
    for (let i = 0; i < 2500; i++) {
      const convId = convIds[i % convIds.length]!;
      const [msg] = await db
        .insert(messages)
        .values({ conversationId: convId, role: "user", content: `chunked message ${i} content body` })
        .returning();
      const lit = toVectorLiteral(seededVector(i));
      await db.execute(sql`
        INSERT INTO message_chunks (id, message_id, conversation_id, content, chunk_index, embedding, embedding_model_id)
        VALUES (${crypto.randomUUID()}, ${msg!.id}, ${convId}, ${`chunk ${i}`}, 0, ${sql.raw(lit)}, ${EMBEDDING_MODEL_ID})
      `);
    }

    await db.execute(sql`ANALYZE message_chunks`);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  test("vector-leg plan filters tenant inside the HNSW Index Scan, no Seq Scan over message_chunks", async () => {
    const db = getTestDb();
    // pgvector 0.8.0 in-filter ANN — required for the tenant-filtered HNSW scan
    // to be index-driven (see message-search.ts SRCH-05 deviation note).
    await db.execute(sql`SET hnsw.iterative_scan = 'relaxed_order'`);

    const queryVec = seededVector(0);
    const explainSql = explainVectorLegSql({
      projectId,
      queryEmbedding: queryVec,
      limit: 20,
    });
    const result = await db.execute(sql.raw(explainSql));
    const planText = (result.rows as Array<Record<string, unknown>>)
      .map((r) => String(Object.values(r)[0]))
      .join("\n");

    // The ANN node is the HNSW index scan over message_chunks…
    expect(planText).toContain("Index Scan using idx_message_chunks_embedding on message_chunks");
    // …with the tenant predicate applied as a Filter INSIDE that node.
    expect(/Filter:.*conversation_id/is.test(planText)).toBe(true);
    // tenant project scope resolved (InitPlan over conversations)
    expect(/project_id/i.test(planText)).toBe(true);
    // no sequential scan over message_chunks anywhere in the plan.
    expect(/Seq Scan on message_chunks/i.test(planText)).toBe(false);
  });
});
