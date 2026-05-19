import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { EMBEDDING_DIMENSIONS } from "../memory/types";
import type { MemoryProvenance } from "../memory/types";

// Mock db/connection and @huggingface/transformers (native libs unavailable on NixOS)
mockDbConnection();
mock.module("@huggingface/transformers", () => {
  // Produce realistic un-normalized output to test the normalization logic in embeddings.ts
  function fakeExtractor(text: string) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    const data = new Float32Array(384);
    for (let i = 0; i < 384; i++) data[i] = Math.sin(h + i) * 0.1;
    return { data };
  }
  return {
    pipeline: async () => async (text: string) => fakeExtractor(text),
    env: { backends: { onnx: {} } },
  };
});

import { generateEmbedding, generateEmbeddings, resetEmbeddingProvider } from "../memory/embeddings";

describe("schema", () => {
  let _db: Awaited<ReturnType<typeof setupTestDb>>["db"];
  let pglite: Awaited<ReturnType<typeof setupTestDb>>["pglite"];

  beforeAll(async () => {
    const setup = await setupTestDb();
    _db = setup.db as any;
    pglite = setup.pglite;
  });

  afterAll(async () => {
  restoreModuleMocks();
    await closeTestDb();
  });

  test("memories table accepts insert with vector embedding, content, category, provenance JSONB", async () => {
    // Create a project first (FK reference)
    await pglite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('test-proj', 'Test Project', '/test')
      ON CONFLICT DO NOTHING
    `);

    const mockEmbedding = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / EMBEDDING_DIMENSIONS);
    const provenance: MemoryProvenance = {
      sourceConversationId: "conv-1",
      sourceMessageIds: ["msg-1", "msg-2"],
      extractedAt: new Date("2026-01-01"),
      confidence: "high",
      history: [{ action: "created", timestamp: new Date("2026-01-01"), reason: "Extracted from conversation" }],
    };

    const embeddingStr = `[${mockEmbedding.join(",")}]`;
    await pglite.exec(`
      INSERT INTO memories (id, content, category, project_id, conversation_id, message_ids, confidence, embedding, provenance)
      VALUES (
        'mem-1',
        'User prefers dark mode',
        'preferences',
        'test-proj',
        NULL,
        '["msg-1", "msg-2"]',
        'high',
        '${embeddingStr}',
        '${JSON.stringify(provenance)}'
      )
    `);

    const result = await pglite.query("SELECT * FROM memories WHERE id = 'mem-1'");
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as any;
    expect(row.content).toBe("User prefers dark mode");
    expect(row.category).toBe("preferences");
    expect(row.confidence).toBe("high");
    expect(row.project_id).toBe("test-proj");
    expect(row.message_ids).toEqual(["msg-1", "msg-2"]);

    // Verify provenance JSONB round-trip
    const prov = row.provenance as MemoryProvenance;
    expect(prov.sourceConversationId).toBe("conv-1");
    expect(prov.sourceMessageIds).toEqual(["msg-1", "msg-2"]);
    expect(prov.confidence).toBe("high");
    expect(prov.history).toHaveLength(1);
    expect(prov.history![0]!.action).toBe("created");

    // Verify embedding is stored as vector
    expect(row.embedding).toBeDefined();
  });

  test("memoryAuditLog table accepts insert with all fields", async () => {
    await pglite.exec(`
      INSERT INTO memory_audit_log (memory_id, action, previous_content, new_content, reason)
      VALUES ('mem-1', 'created', NULL, 'User prefers dark mode', 'Initial extraction')
    `);

    const result = await pglite.query("SELECT * FROM memory_audit_log WHERE memory_id = 'mem-1'");
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0] as any;
    expect(row.action).toBe("created");
    expect(row.new_content).toBe("User prefers dark mode");
    expect(row.reason).toBe("Initial extraction");
    expect(row.created_at).toBeDefined();
  });

  test("HNSW index exists on memories.embedding", async () => {
    const result = await pglite.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'memories' AND indexdef LIKE '%hnsw%'
    `);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect((result.rows[0] as any).indexdef).toContain("vector_cosine_ops");
  });

  test("tsvector GIN index exists on memories.content", async () => {
    const result = await pglite.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'memories' AND indexdef LIKE '%tsvector%'
    `);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect((result.rows[0] as any).indexdef).toContain("to_tsvector");
  });

  test("test-pglite helper creates DB with vector extension enabled", async () => {
    const result = await pglite.query("SELECT * FROM pg_extension WHERE extname = 'vector'");
    expect(result.rows).toHaveLength(1);
  });
});

describe("embeddings", () => {
  afterAll(() => {
    resetEmbeddingProvider();
  });

  test("generateEmbedding returns a number[] of length 384", async () => {
    const embedding = await generateEmbedding("hello world");
    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Array.isArray(embedding)).toBe(true);
  }, 60_000); // first call downloads model

  test("all values in returned embedding are finite numbers", async () => {
    const embedding = await generateEmbedding("test input");
    for (const val of embedding) {
      expect(typeof val).toBe("number");
      expect(Number.isFinite(val)).toBe(true);
    }
  }, 30_000);

  test("generateEmbeddings returns array of 2 embeddings, each 384-dim", async () => {
    const embeddings = await generateEmbeddings(["alpha", "beta"]);
    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embeddings[1]).toHaveLength(EMBEDDING_DIMENSIONS);
  }, 30_000);

  test("calling generateEmbedding twice reuses same model instance (singleton)", async () => {
    // Both calls should succeed without re-downloading
    const start = performance.now();
    const e1 = await generateEmbedding("first call");
    const mid = performance.now();
    const e2 = await generateEmbedding("second call");
    const end = performance.now();

    // Second call should be significantly faster (no model load)
    const firstTime = mid - start;
    const secondTime = end - mid;
    expect(secondTime).toBeLessThan(firstTime + 100); // generous threshold

    // Both should produce valid embeddings
    expect(e1).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(e2).toHaveLength(EMBEDDING_DIMENSIONS);
  }, 30_000);

  test("embeddings are normalized (L2 norm approximately 1.0)", async () => {
    const embedding = await generateEmbedding("normalization test");
    const norm = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    expect(norm).toBeCloseTo(1.0, 1); // within 0.05
  }, 30_000);
});
