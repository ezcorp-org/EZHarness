import { test, expect, describe, beforeEach } from "bun:test";
import {
  getToolEmbedding,
  getRawTextEmbedding,
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

  test("cap is 4096 — tools plus their authored example texts", () => {
    expect(MAX_CACHED_TOOL_EMBEDDINGS).toBe(4096);
  });
});

describe("getRawTextEmbedding", () => {
  test("embeds text VERBATIM (no 'name:' prefix) and caches by content", async () => {
    const v1 = await getRawTextEmbedding("clean up my downloads folder", fakeEmbed);
    expect(embedCalls).toEqual(["clean up my downloads folder"]); // verbatim
    const v2 = await getRawTextEmbedding("clean up my downloads folder", fakeEmbed);
    expect(embedCalls).toHaveLength(1); // cache hit — no second embed
    expect(v2).toBe(v1);
    expect(toolEmbeddingCacheSize()).toBe(1);
  });

  test("raw key never collides with a tool embedding of the same visible text", async () => {
    await getToolEmbedding("web-search search-web", "clean up my downloads folder", fakeEmbed);
    await getRawTextEmbedding("clean up my downloads folder", fakeEmbed);
    // Tool key is NUL-joined, raw key is "raw "-prefixed → disjoint slots.
    expect(toolEmbeddingCacheSize()).toBe(2);
    expect(embedCalls).toEqual([
      "web-search search-web: clean up my downloads folder",
      "clean up my downloads folder",
    ]);
  });

  test("no collision even with a tool literally named 'raw'", async () => {
    await getToolEmbedding("raw", "hello world", fakeEmbed); // key: raw\0hello world
    await getRawTextEmbedding("hello world", fakeEmbed); // key: raw hello world
    expect(toolEmbeddingCacheSize()).toBe(2);
  });

  test("shares the one bounded LRU with getToolEmbedding (cross-writer eviction)", async () => {
    for (let i = 0; i < MAX_CACHED_TOOL_EMBEDDINGS; i++) {
      await getToolEmbedding(`tool${i}`, "d", fakeEmbed);
    }
    // A raw insert past the cap evicts the LRU tool entry (tool0).
    await getRawTextEmbedding("brand new example phrasing", fakeEmbed);
    expect(toolEmbeddingCacheSize()).toBe(MAX_CACHED_TOOL_EMBEDDINGS);
    const before = embedCalls.length;
    await getToolEmbedding("tool0", "d", fakeEmbed); // evicted → re-embeds
    expect(embedCalls).toHaveLength(before + 1);
  });
});
