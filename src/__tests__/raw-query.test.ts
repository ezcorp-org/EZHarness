import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { EMBEDDING_DIMENSIONS } from "../memory/types";

// Mock db/connection before any imports that use it — include rawQuery so
// the hybridSearch SQL can be executed via rawQuery against the test PGlite.
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

// Import rawQuery after mocking
const { rawQuery } = await import("../db/connection");
const { toVectorLiteral } = await import("../memory/vector-utils");

/**
 * Test-local hybridSearch that mirrors the SQL from retrieval.ts but uses
 * the mocked rawQuery. This validates that hybridSearch's SQL works correctly
 * when executed via rawQuery (the fix for the PGlite-only bug).
 */
async function hybridSearch(
  query: string,
  embedding: number[],
  opts: { projectId?: string; isolateToProject?: boolean; limit?: number; k?: number },
) {
  const limit = opts.limit ?? 20;
  const k = opts.k ?? 60;
  const isolate = opts.isolateToProject === true;
  const projectId = opts.projectId ?? null;
  const vectorLiteral = toVectorLiteral(embedding);

  const baseFilter = "status != 'archived'";
  const isolationFilter = isolate && projectId
    ? `WHERE ${baseFilter} AND project_id = $2`
    : `WHERE ${baseFilter}`;
  const boostExpr = !isolate && projectId
    ? `CASE WHEN COALESCE(v.project_id, k.project_id) = $2 THEN 1.5 ELSE 1.0 END`
    : "1.0";
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

  const result = await rawQuery(sql, params);

  return (result.rows as any[]).map((row: any) => ({
    id: row.id,
    content: row.content,
    category: row.category,
    projectId: row.project_id ?? null,
    confidence: row.confidence,
    provenance: row.provenance ?? null,
    rrfScore: parseFloat(row.rrf_score),
  }));
}

function makeVector(seed: number): number[] {
  const vec = new Array(EMBEDDING_DIMENSIONS).fill(0);
  vec[seed % EMBEDDING_DIMENSIONS] = 0.9;
  vec[(seed + 1) % EMBEDDING_DIMENSIONS] = 0.3;
  vec[(seed + 2) % EMBEDDING_DIMENSIONS] = 0.1;
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / norm);
}

describe("rawQuery", () => {
  let pglite: ReturnType<typeof getTestPglite>;

  beforeAll(async () => {
    const setup = await setupTestDb();
    pglite = setup.pglite;

    await pglite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('proj-rq-a', 'RQ Project A', '/rq-a') ON CONFLICT DO NOTHING;
      INSERT INTO projects (id, name, path) VALUES ('proj-rq-b', 'RQ Project B', '/rq-b') ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await closeTestDb();
    try {
      const { restoreModuleMocks } = require("./helpers/mock-cleanup");
      restoreModuleMocks();
    } catch {}
  });

  beforeEach(async () => {
    await pglite.exec("DELETE FROM memories");
  });

  test("simple SELECT returns correct result", async () => {
    const result = await rawQuery("SELECT 1 as num", []);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].num).toBe(1);
  });

  test("parameterized query with $1", async () => {
    const result = await rawQuery("SELECT $1 as val", ["hello"]);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].val).toBe("hello");
  });

  test("multiple params $1 and $2", async () => {
    const result = await rawQuery("SELECT $1 as a, $2 as b", ["foo", "bar"]);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].a).toBe("foo");
    expect(result.rows[0].b).toBe("bar");
  });

  test("NULL param", async () => {
    const result = await rawQuery("SELECT $1::text as val", [null]);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].val).toBeNull();
  });

  test("query against memories table returns inserted row", async () => {
    const id = "rq-mem-1";
    const vec = makeVector(50);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, confidence, embedding)
      VALUES ('${id}', 'rawQuery test content', 'technical', 'high', '${vstr}');
    `);

    const result = await rawQuery("SELECT content FROM memories WHERE id = $1", [id]);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].content).toBe("rawQuery test content");
  });

  test("empty result for nonexistent id", async () => {
    const result = await rawQuery("SELECT * FROM memories WHERE id = $1", ["nonexistent"]);
    expect(result.rows).toEqual([]);
  });
});

describe("hybridSearch via rawQuery", () => {
  let pglite: ReturnType<typeof getTestPglite>;

  beforeAll(async () => {
    const setup = await setupTestDb();
    pglite = setup.pglite;

    await pglite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('proj-hs-a', 'HS Project A', '/hs-a') ON CONFLICT DO NOTHING;
      INSERT INTO projects (id, name, path) VALUES ('proj-hs-b', 'HS Project B', '/hs-b') ON CONFLICT DO NOTHING;
    `);
  });

  afterAll(async () => {
    await closeTestDb();
    try {
      const { restoreModuleMocks } = require("./helpers/mock-cleanup");
      restoreModuleMocks();
    } catch {}
  });

  beforeEach(async () => {
    await pglite.exec("DELETE FROM memories");
  });

  test("hybridSearch returns results for matching memories", async () => {
    const vec = makeVector(30);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, confidence, embedding)
      VALUES ('hs-m1', 'Hybrid search test memory content', 'technical', 'high', '${vstr}');
    `);

    const queryVec = makeVector(30);
    const results = await hybridSearch("hybrid search test", queryVec, {});

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.map(r => r.id)).toContain("hs-m1");
  });

  test("hybridSearch excludes archived memories", async () => {
    const vec = makeVector(31);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, confidence, status, embedding)
      VALUES ('hs-archived', 'Archived memory for exclusion test', 'technical', 'high', 'archived', '${vstr}');
      INSERT INTO memories (id, content, category, confidence, status, embedding)
      VALUES ('hs-active', 'Active memory for exclusion test', 'technical', 'high', 'active', '${vstr}');
    `);

    const queryVec = makeVector(31);
    const results = await hybridSearch("exclusion test", queryVec, {});

    const ids = results.map(r => r.id);
    expect(ids).not.toContain("hs-archived");
    expect(ids).toContain("hs-active");
  });

  test("hybridSearch with projectId filter isolates results", async () => {
    const vec = makeVector(32);
    const vstr = `[${vec.join(",")}]`;

    await pglite.exec(`
      INSERT INTO memories (id, content, category, project_id, confidence, embedding)
      VALUES ('hs-pa', 'Project isolation memory', 'technical', 'proj-hs-a', 'high', '${vstr}');
      INSERT INTO memories (id, content, category, project_id, confidence, embedding)
      VALUES ('hs-pb', 'Project isolation memory', 'technical', 'proj-hs-b', 'high', '${vstr}');
    `);

    const queryVec = makeVector(32);
    const results = await hybridSearch("project isolation", queryVec, {
      projectId: "proj-hs-a",
      isolateToProject: true,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe("hs-pa");
  });
});
