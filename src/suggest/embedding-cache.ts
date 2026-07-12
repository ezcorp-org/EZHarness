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

/** Bounded LRU: a registry can expose a few hundred tools, and each also
 *  contributes up to a few authored `suggestExamples` (embedded verbatim
 *  via getRawTextEmbedding) plus per-extension example texts — 4096 gives
 *  ample headroom (≈12 MB ceiling) without letting it grow unbounded. */
export const MAX_CACHED_TOOL_EMBEDDINGS = 4096;

const cache = new Map<string, number[]>();

/**
 * Shared content-keyed get-or-compute over the bounded LRU. On a hit it
 * bumps recency (re-insert so iteration order tracks recency); on a miss it
 * computes, inserts, and evicts the least-recently-used entry past the cap.
 * The single home for the cache mechanics — `getToolEmbedding` and
 * `getRawTextEmbedding` differ only in their key + embed-text derivation.
 */
async function cached(key: string, compute: () => Promise<number[]>): Promise<number[]> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const vector = await compute();
  cache.set(key, vector);
  if (cache.size > MAX_CACHED_TOOL_EMBEDDINGS) {
    cache.delete(cache.keys().next().value!);
  }
  return vector;
}

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
  return cached(key, () => embed(`${name}: ${description}`));
}

/**
 * Embed `text` VERBATIM (cached). Unlike getToolEmbedding, nothing is
 * prepended: this is for authored example user-phrasings, where the
 * draft↔example (query↔query) cosine is the signal and any prefix only adds
 * noise (an `ext__` prefix measured −0.04 live). The key is the reserved
 * `"raw "` prefix + the text — collision-proof against a tool key, which is
 * always joined by a NUL (`name\0description`) that a raw key never carries,
 * so the two key spaces are disjoint.
 */
export async function getRawTextEmbedding(
  text: string,
  embed: EmbedFn = generateEmbedding,
): Promise<number[]> {
  return cached(`raw ${text}`, () => embed(text));
}

export function toolEmbeddingCacheSize(): number {
  return cache.size;
}

/** Reset — for tests. */
export function clearToolEmbeddingCache(): void {
  cache.clear();
}
