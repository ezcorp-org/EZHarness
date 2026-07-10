import { test, expect, describe, beforeEach } from "bun:test";
import {
  getToolEmbedding,
  clearToolEmbeddingCache,
  toolEmbeddingCacheSize,
  MAX_CACHED_TOOL_EMBEDDINGS,
} from "../embedding-cache";

let embedCalls: string[] = [];
const fakeEmbed = async (text: string): Promise<number[]> => {
  embedCalls.push(text);
  return [text.length, 0, 0];
};

beforeEach(() => {
  clearToolEmbeddingCache();
  embedCalls = [];
});

describe("getToolEmbedding", () => {
  test("embeds 'name: description' and caches by content", async () => {
    const v1 = await getToolEmbedding("scan", "Scan code", fakeEmbed);
    expect(embedCalls).toEqual(["scan: Scan code"]);
    const v2 = await getToolEmbedding("scan", "Scan code", fakeEmbed);
    expect(embedCalls).toHaveLength(1); // cache hit — no second embed
    expect(v2).toBe(v1);
    expect(toolEmbeddingCacheSize()).toBe(1);
  });

  test("a changed description is a NEW key (lazy reindex)", async () => {
    await getToolEmbedding("scan", "Scan code", fakeEmbed);
    await getToolEmbedding("scan", "Scan code v2", fakeEmbed);
    expect(embedCalls).toHaveLength(2);
    expect(toolEmbeddingCacheSize()).toBe(2);
  });

  test("name/description boundary is unambiguous", async () => {
    await getToolEmbedding("a b", "c", fakeEmbed);
    await getToolEmbedding("a", "b c", fakeEmbed);
    expect(toolEmbeddingCacheSize()).toBe(2);
  });

  test("evicts the least-recently-used entry beyond the cap", async () => {
    for (let i = 0; i < MAX_CACHED_TOOL_EMBEDDINGS; i++) {
      await getToolEmbedding(`tool${i}`, "d", fakeEmbed);
    }
    // Touch tool0 so it's most-recent, then overflow by one.
    await getToolEmbedding("tool0", "d", fakeEmbed);
    await getToolEmbedding("overflow", "d", fakeEmbed);
    expect(toolEmbeddingCacheSize()).toBe(MAX_CACHED_TOOL_EMBEDDINGS);
    // tool0 survived (LRU bump); tool1 was evicted → re-embeds.
    const before = embedCalls.length;
    await getToolEmbedding("tool0", "d", fakeEmbed);
    expect(embedCalls).toHaveLength(before);
    await getToolEmbedding("tool1", "d", fakeEmbed);
    expect(embedCalls).toHaveLength(before + 1);
  });
});
