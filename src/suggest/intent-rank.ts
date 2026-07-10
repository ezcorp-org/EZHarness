/**
 * Intent-ranking core for composer suggestions.
 *
 * A reusable, pure primitive: given a draft-prompt embedding and candidate
 * tool-description embeddings, rank candidates by blended cosine relevance +
 * per-user usage prior. Deliberately IO-free — embedding generation lives in
 * embedding-cache.ts, priors in user-tool-priors.ts — so future consumers
 * (mode routing, dynamic tool loading) can reuse the same scoring without
 * dragging in the composer route's dependencies.
 *
 * Popular-tool-spam guard: the `minScore` threshold applies to the RAW
 * cosine (semantic relevance), never the blended score, so a heavily-used
 * tool can only be boosted among relevant candidates — it can't ride its
 * prior into a draft it has nothing to do with. Conversely a never-used
 * tool with a strong cosine match always survives (cold start).
 */

export interface RankCandidate {
  /** Stable candidate key — namespaced tool name (`ext__tool`, or the bare
   *  built-in name). Doubles as the lookup key into the priors record. */
  key: string;
  embedding: number[];
}

export interface RankedCandidate {
  key: string;
  /** Blended score in [0,1]: cosine * (1-priorWeight) + prior * priorWeight. */
  score: number;
  cosine: number;
  prior: number;
}

export interface RankOptions {
  topK?: number;
  /** Minimum RAW cosine a candidate needs to be suggested at all. */
  minScore?: number;
  /** Weight of the usage prior in the blended score, in [0,1]. */
  priorWeight?: number;
}

export const RANK_DEFAULTS = {
  topK: 4,
  minScore: 0.28,
  priorWeight: 0.25,
} as const;

/** Cosine similarity. Returns 0 for mismatched/empty/zero-norm vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Rank candidates against a draft embedding. Priors are expected normalized
 * to [0,1] (see computeToolPriors); missing keys count as 0. Ties break by
 * key so the ordering is deterministic across runs.
 */
export function rankCandidates(
  draftEmbedding: number[],
  candidates: RankCandidate[],
  priors: Record<string, number>,
  opts?: RankOptions,
): RankedCandidate[] {
  const { topK, minScore, priorWeight } = { ...RANK_DEFAULTS, ...opts };
  return candidates
    .map((c) => {
      const cosine = cosineSimilarity(draftEmbedding, c.embedding);
      const prior = priors[c.key] ?? 0;
      return {
        key: c.key,
        score: cosine * (1 - priorWeight) + prior * priorWeight,
        cosine,
        prior,
      };
    })
    .filter((c) => c.cosine >= minScore)
    .sort((x, y) => y.score - x.score || x.key.localeCompare(y.key))
    .slice(0, topK);
}
