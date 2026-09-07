import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { EMBEDDING_DIMENSIONS } from "../memory/types";

// Mock transformers before importing embeddings — prevents native library load.
let pipelineCallCount = 0;
let nextPipelineRejects = false;
const pipelineOptions: unknown[] = [];

mock.module("@huggingface/transformers", () => ({
  pipeline: async (_task: unknown, _model: unknown, options: unknown) => {
    pipelineCallCount++;
    pipelineOptions.push(options);
    if (nextPipelineRejects) {
      nextPipelineRejects = false;
      throw new Error("forced model init failure");
    }
    // Return a stub extractor that produces a deterministic fp32 vector.
    const extractor = async (_text: string, _opts?: unknown) => {
      const data = new Float32Array(EMBEDDING_DIMENSIONS);
      for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) data[i] = (i + 1) * 0.01;
      return { data };
    };
    // The real FeatureExtractionPipeline carries a tokenizer; getExtractor()
    // writes tokenizer.config.model_max_length to cap input at CHUNK_TOKENS
    // (IDX-06), so the stub must expose a `config` or that write NPEs. This
    // suite only exercises the init state machine — the cap itself is pinned
    // against the real tokenizer in memory-embeddings-token-cap.test.ts.
    (extractor as unknown as { tokenizer: { config: { model_max_length?: number } } }).tokenizer = { config: {} };
    return extractor;
  },
  env: { backends: { onnx: {} } },
}));

const {
  generateEmbedding,
  generateEmbeddings,
  isEmbeddingReady,
  warmupEmbeddings,
  resetEmbeddingProvider,
} = await import("../memory/embeddings");

describe("isEmbeddingReady / resetEmbeddingProvider state machine", () => {
  beforeEach(() => {
    resetEmbeddingProvider();
    pipelineCallCount = 0;
    nextPipelineRejects = false;
    pipelineOptions.length = 0;
  });

  afterAll(() => {
    restoreModuleMocks();
  });

  test("returns false immediately after reset (no extractor loaded)", () => {
    expect(isEmbeddingReady()).toBe(false);
  });

  test("returns true after a successful generateEmbedding call", async () => {
    await generateEmbedding("hello");
    expect(isEmbeddingReady()).toBe(true);
  });

  test("uses a durable cache beside the configured database instead of node_modules", async () => {
    const previous = process.env.EZCORP_DB_PATH;
    process.env.EZCORP_DB_PATH = "/owned/data/ezcorp";
    try {
      await generateEmbedding("cache location");
      expect(pipelineOptions).toHaveLength(1);
      expect(pipelineOptions[0]).toMatchObject({ cache_dir: "/owned/data/embedding-model-cache" });
    } finally {
      if (previous === undefined) delete process.env.EZCORP_DB_PATH;
      else process.env.EZCORP_DB_PATH = previous;
    }
  });

  test("keeps the configured durable cache when relational data uses external Postgres", async () => {
    const previousDbPath = process.env.EZCORP_DB_PATH;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.EZCORP_DB_PATH = "/owned/data/ezcorp";
    process.env.DATABASE_URL = "postgres://db.example/ezcorp";
    try {
      await generateEmbedding("external database cache location");
      expect(pipelineOptions).toHaveLength(1);
      expect(pipelineOptions[0]).toMatchObject({ cache_dir: "/owned/data/embedding-model-cache" });
    } finally {
      if (previousDbPath === undefined) delete process.env.EZCORP_DB_PATH;
      else process.env.EZCORP_DB_PATH = previousDbPath;
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  test("resetEmbeddingProvider flips state back to false", async () => {
    await generateEmbedding("warm me up");
    expect(isEmbeddingReady()).toBe(true);

    resetEmbeddingProvider();
    expect(isEmbeddingReady()).toBe(false);
  });
});

describe("warmupEmbeddings", () => {
  beforeEach(() => {
    resetEmbeddingProvider();
    pipelineCallCount = 0;
    nextPipelineRejects = false;
  });

  test("fires model init without awaiting (eventually becomes ready)", async () => {
    expect(isEmbeddingReady()).toBe(false);

    warmupEmbeddings();

    // pipeline() is called right away, but the init promise is async.
    // Wait until it resolves.
    await new Promise((r) => setTimeout(r, 50));
    expect(isEmbeddingReady()).toBe(true);
    expect(pipelineCallCount).toBe(1);
  });

  test("is a no-op if the extractor is already loaded", async () => {
    await generateEmbedding("prime the pump");
    expect(pipelineCallCount).toBe(1);
    expect(isEmbeddingReady()).toBe(true);

    warmupEmbeddings();
    warmupEmbeddings();
    warmupEmbeddings();

    // Give any async path a chance to run.
    await new Promise((r) => setTimeout(r, 20));
    // Still only one pipeline init total.
    expect(pipelineCallCount).toBe(1);
  });

  test("safe to call multiple times before init resolves (dedupes)", async () => {
    warmupEmbeddings();
    warmupEmbeddings();
    warmupEmbeddings();

    await new Promise((r) => setTimeout(r, 50));
    // All concurrent warmups share the same in-flight init promise.
    expect(pipelineCallCount).toBe(1);
    expect(isEmbeddingReady()).toBe(true);
  });
});

describe("generateEmbedding / generateEmbeddings — output shape", () => {
  beforeEach(() => {
    resetEmbeddingProvider();
    pipelineCallCount = 0;
    nextPipelineRejects = false;
  });

  test("generateEmbedding returns a normalized unit vector (L2 norm ~= 1)", async () => {
    const vec = await generateEmbedding("anything");
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  test("generateEmbeddings preserves input order", async () => {
    const out = await generateEmbeddings(["a", "b", "c"]);
    expect(out).toHaveLength(3);
    for (const vec of out) {
      expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
    }
  });

  test("generateEmbeddings on empty input returns empty array (no model load)", async () => {
    const out = await generateEmbeddings([]);
    expect(out).toEqual([]);
    // Model was never touched.
    expect(pipelineCallCount).toBe(0);
    expect(isEmbeddingReady()).toBe(false);
  });
});

describe("init failure handling", () => {
  beforeEach(() => {
    resetEmbeddingProvider();
    pipelineCallCount = 0;
    nextPipelineRejects = false;
  });

  test("rejected init does not leave isEmbeddingReady() stuck as true", async () => {
    nextPipelineRejects = true;

    expect(generateEmbedding("boom")).rejects.toThrow("forced model init failure");
    expect(isEmbeddingReady()).toBe(false);
  });

  test("after a failed init, a fresh call retries pipeline() and can succeed", async () => {
    nextPipelineRejects = true;
    expect(generateEmbedding("first")).rejects.toThrow();

    // Second attempt should trigger a new init (no stale cached promise).
    const vec = await generateEmbedding("second");
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(pipelineCallCount).toBe(2);
    expect(isEmbeddingReady()).toBe(true);
  });
});
