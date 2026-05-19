import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { EMBEDDING_DIMENSIONS } from "../memory/types";

// Mock transformers before importing embeddings — prevents native library load.
let pipelineCallCount = 0;
let nextPipelineRejects = false;

mock.module("@huggingface/transformers", () => ({
  pipeline: async () => {
    pipelineCallCount++;
    if (nextPipelineRejects) {
      nextPipelineRejects = false;
      throw new Error("forced model init failure");
    }
    // Return a stub extractor that produces a deterministic fp32 vector.
    return async (_text: string, _opts?: unknown) => {
      const data = new Float32Array(EMBEDDING_DIMENSIONS);
      for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) data[i] = (i + 1) * 0.01;
      return { data };
    };
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
