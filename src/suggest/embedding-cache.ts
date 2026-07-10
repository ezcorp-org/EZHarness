/**
 * Content-keyed cache of tool-description embeddings.
 *
 * Tool descriptions change on install/update, so the cache key is the
 * content itself (`name\0description`) — a changed description is simply a
 * new key and re-embeds lazily on the next request; stale entries age out
 * of the LRU. No invalidation wiring against the extension registry needed.
 *
 * The embedder is injectable so unit tests never load the MiniLM model.
 */

import { generateEmbedding } from "../memory/embeddings";

export type EmbedFn = (text: string) => Promise<number[]>;

/** Bounded LRU: bundled extensions expose a few hundred tools; 1024 gives
 *  ample headroom without letting a pathological registry grow unbounded. */
export const MAX_CACHED_TOOL_EMBEDDINGS = 1024;

const cache = new Map<string, number[]>();

/**
 * Embed `"name: description"` (cached). The name is included in the
 * embedded text because tool names often carry signal descriptions lack
 * (e.g. `create_issue`).
 */
export async function getToolEmbedding(
  name: string,
  description: string,
  embed: EmbedFn = generateEmbedding,
): Promise<number[]> {
  const key = `${name}\u0000${description}`;
  const hit = cache.get(key);
  if (hit) {
    // LRU bump: re-insert so iteration order tracks recency.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const vector = await embed(`${name}: ${description}`);
  cache.set(key, vector);
  if (cache.size > MAX_CACHED_TOOL_EMBEDDINGS) {
    cache.delete(cache.keys().next().value!);
  }
  return vector;
}

export function toolEmbeddingCacheSize(): number {
  return cache.size;
}

/** Reset — for tests. */
export function clearToolEmbeddingCache(): void {
  cache.clear();
}
