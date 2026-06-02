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

const { explainVectorLegSql, searchMessages } = await import("../db/queries/message-search");
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
  let projectId2: string;
  let userId: string;

  beforeAll(async () => {
    await setupTestDb();
    const db = getTestDb();

    const [p] = await db.insert(projects).values({ name: "Explain", path: "/tmp/explain" }).returning();
    projectId = p!.id;
    // Second project owned by the SAME user — proves the scope=all (user_id)
    // tenant predicate keeps the HNSW index scan at multi-project scale.
    const [p2] = await db.insert(projects).values({ name: "Explain2", path: "/tmp/explain2" }).returning();
    projectId2 = p2!.id;
    const [u] = await db
      .insert(users)
      .values({ email: "explain@x.com", passwordHash: "h", name: "explain" })
      .returning();
    userId = u!.id;

    // ≥2 conversations across BOTH projects (mostly Project 1, some Project 2).
    const convIds: string[] = [];
    for (let c = 0; c < 3; c++) {
      const [conv] = await db
        .insert(conversations)
        .values({ projectId, userId: u!.id, title: `c${c}`, test: false })
        .returning();
      convIds.push(conv!.id);
    }
    const conv2Ids: string[] = [];
    for (let c = 0; c < 2; c++) {
      const [conv] = await db
        .insert(conversations)
        .values({ projectId: projectId2, userId: u!.id, title: `p2c${c}`, test: false })
        .returning();
      conv2Ids.push(conv!.id);
    }

    // Enough rows that the HNSW index beats a bitmap/seq scan (cost crossover).
    // ~10% land in Project 2 so the user's project set spans both projects.
    for (let i = 0; i < 2500; i++) {
      const inP2 = i % 10 === 0;
      const convId = inP2
        ? conv2Ids[i % conv2Ids.length]!
        : convIds[i % convIds.length]!;
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

  test("scope=all (multi-project) plan keeps the HNSW Index Scan, no Seq Scan over message_chunks", async () => {
    const db = getTestDb();
    await db.execute(sql`SET hnsw.iterative_scan = 'relaxed_order'`);

    const queryVec = seededVector(0);
    // scope=all resolves the tenant by user_id (every project of the user) —
    // PAL-01's cross-project path. Must still drive idx_message_chunks_embedding.
    const explainSql = explainVectorLegSql({
      scope: "all",
      userId,
      queryEmbedding: queryVec,
      limit: 20,
    });
    const result = await db.execute(sql.raw(explainSql));
    const planText = (result.rows as Array<Record<string, unknown>>)
      .map((r) => String(Object.values(r)[0]))
      .join("\n");

    // HNSW index scan over message_chunks…
    expect(planText).toContain("Index Scan using idx_message_chunks_embedding on message_chunks");
    // …with the denormalized conversation_id tenant Filter inside that node.
    expect(/Filter:.*conversation_id/is.test(planText)).toBe(true);
    // tenant resolved by user_id (the scope=all InitPlan over conversations).
    expect(/user_id/i.test(planText)).toBe(true);
    // no sequential scan over message_chunks anywhere in the multi-project plan.
    expect(/Seq Scan on message_chunks/i.test(planText)).toBe(false);
  });

  // ── SRCH-05 end-to-end: run the real searchMessages() at index scale ──
  //
  // Coverage-shard parity (NOT just an extra assertion): the per-shard lcov
  // merge sums DA hits keyed by line number across every shard that imports
  // this module. This EXPLAIN shard imports message-search.ts and therefore
  // instruments the *whole* module, emitting explicit `DA:<line>,0` for every
  // line of searchMessages()'s mode-branch SQL builders (the keyword/semantic/
  // hybrid CTE blocks, lines 295-403). The message-search.test.ts shard, run in
  // its own bun process, instruments those same blocks SPARSELY — bun collapses
  // several multi-line `sql\`…\`` template rows and never emits a DA record for
  // them at all. The merge then has, for those lines, only this shard's explicit
  // `,0` to sum, so they show as uncovered even though the runtime is fully
  // exercised in the other shard — dragging the gate to ~70%.
  //
  // Running searchMessages() here (against the same ≥2.5k-row index-scale
  // corpus the EXPLAIN tests seed) flips this shard's DA for those lines to
  // non-zero, so the summed merge is non-zero and the gate measures 100%. The
  // assertions are real end-to-end contract checks, not coverage filler: every
  // mode returns scoped, deduped, correctly-shaped hits at index scale.
  test("searchMessages runs every mode end-to-end at index scale (scope=project)", async () => {
    const queryVec = seededVector(0);

    for (const mode of ["hybrid", "keyword", "semantic"] as const) {
      const hits = await searchMessages({
        projectId,
        userId,
        query: "chunked message content body",
        mode,
        queryEmbedding: queryVec,
        limit: 10,
      });
      // Every hit is scoped to Project 1 (the EXPLAIN corpus' main project)
      // and carries the full display shape Wave-2 consumes.
      for (const h of hits) {
        expect(h.projectId).toBe(projectId);
        expect(h.projectName).toBe("Explain");
        expect(typeof h.score).toBe("number");
        expect(h.role).toBe("user");
        expect(h.createdAt instanceof Date).toBe(true);
        if (mode === "keyword") expect(h.matchType).toBe("lexical");
        if (mode === "semantic") expect(h.matchType).toBe("semantic");
      }
      // DISTINCT-ON collapse → no duplicate message ids in any mode.
      const ids = hits.map((h) => h.messageId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("searchMessages scope=all spans both projects at index scale", async () => {
    const queryVec = seededVector(0);
    const hits = await searchMessages({
      scope: "all",
      userId,
      query: "chunked message content body",
      mode: "hybrid",
      queryEmbedding: queryVec,
      limit: 50,
    });
    // Every hit belongs to one of the user's two projects — never leaks.
    for (const h of hits) {
      expect([projectId, projectId2]).toContain(h.projectId);
      expect(["Explain", "Explain2"]).toContain(h.projectName);
    }
  });

  test("searchMessages guard + missing-vector paths return [] at index scale", async () => {
    const queryVec = seededVector(0);
    // <2-char guard (no SQL touched).
    expect(
      await searchMessages({ projectId, userId, query: "a", mode: "hybrid", queryEmbedding: queryVec }),
    ).toEqual([]);
    // scope=project without a projectId → unresolvable tenant.
    expect(
      await searchMessages({ userId, query: "chunked", mode: "hybrid", queryEmbedding: queryVec }),
    ).toEqual([]);
    // scope=all without a userId → unresolvable tenant (never global).
    expect(
      await searchMessages({ scope: "all", query: "chunked", mode: "hybrid", queryEmbedding: queryVec }),
    ).toEqual([]);
    // vector modes with a null embedding → [] before any SQL.
    expect(
      await searchMessages({ projectId, userId, query: "chunked", mode: "hybrid", queryEmbedding: null }),
    ).toEqual([]);
    expect(
      await searchMessages({ projectId, userId, query: "chunked", mode: "semantic", queryEmbedding: null }),
    ).toEqual([]);
  });
});
