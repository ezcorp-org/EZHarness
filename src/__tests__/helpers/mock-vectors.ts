import { mock } from "bun:test";

export const EMBEDDING_DIM = 384;

export function mockEmbedding(): number[] {
  const val = 1 / Math.sqrt(EMBEDDING_DIM);
  return new Array(EMBEDDING_DIM).fill(val);
}

export function mockEmbeddingsModule() {
  mock.module("../../memory/embeddings", () => ({
    generateEmbedding: async () => mockEmbedding(),
    generateEmbeddings: async (texts: string[]) => texts.map(() => mockEmbedding()),
    resetEmbeddingProvider: () => {},
  }));

  mock.module("@huggingface/transformers", () => ({
    pipeline: async () => async () => ({ data: new Float32Array(EMBEDDING_DIM) }),
  }));
}
