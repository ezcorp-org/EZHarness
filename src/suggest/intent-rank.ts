/**
 * Intent-ranking core for composer suggestions.
 *
 * A reusable, pure primitive: given a draft-prompt embedding and candidate
 * tool-description embeddings, rank candidates by blended relevance +
 * per-user usage prior. Deliberately IO-free — embedding generation lives in
 * embedding-cache.ts, priors in user-tool-priors.ts — so future consumers
 * (mode routing, dynamic tool loading) can reuse the same scoring without
 * dragging in the composer route's dependencies.
 *
 * Relevance is HYBRID (live finding, 2026-07-10): MiniLM cosine alone
 * under-scores natural query→description pairs — measured live,
 * "search the web for the latest bun runtime release notes" hit only 0.19
 * against web-search's own description (below the gate) while an unrelated
 * "briefing report" tool cleared 0.32. Token overlap nails exactly those
 * drafts (the user often names the tool's own vocabulary), so relevance =
 * max(cosine, lexical): either signal qualifies a candidate, and the
 * stronger one ranks it.
 *
 * Popular-tool-spam guard: the `minScore` threshold applies to RELEVANCE
 * (semantic/lexical match), never the blended score, so a heavily-used tool
 * can only be boosted among relevant candidates — it can't ride its prior
 * into a draft it has nothing to do with. Conversely a never-used tool with
 * a strong match always survives (cold start).
 */

export interface RankCandidate {
  /** Stable candidate key — namespaced tool name (`ext__tool`, or the bare
   *  built-in name). Doubles as the lookup key into the priors record. */
  key: string;
  embedding: number[];
  /** Embeddings of the candidate's authored example user-phrasings (see
   *  `ToolDefinition.suggestExamples`). Folded into the cosine as a MAX with
   *  the description embedding — any single example matching the draft
   *  qualifies the candidate. Examples are query-phrasing surrogates, so
   *  query↔example cosine is the signal (see `getRawTextEmbedding`). */
  exampleEmbeddings?: number[][];
  /** Tokens of the tool/extension NAME — a draft hitting these is the
   *  strongest lexical signal (counted double). */
  nameTokens?: ReadonlySet<string>;
  /** Tokens of the tool description. */
  descTokens?: ReadonlySet<string>;
}

export interface RankedCandidate {
  key: string;
  /** Blended score in [0,1]: relevance * (1-priorWeight) + prior * priorWeight. */
  score: number;
  /** max(cosine, lexical) — the gated signal. */
  relevance: number;
  cosine: number;
  lexical: number;
  prior: number;
}

export interface RankOptions {
  topK?: number;
  /** Minimum RELEVANCE a candidate needs to be suggested at all. */
  minScore?: number;
  /** Weight of the usage prior in the blended score, in [0,1]. */
  priorWeight?: number;
}

export const RANK_DEFAULTS = {
  topK: 4,
  minScore: 0.28,
  priorWeight: 0.25,
} as const;

/**
 * Ranking defaults for whole-EXTENSION suggestions (distinct from the
 * per-tool `RANK_DEFAULTS`). `minScore` sits at 0.35 — deliberately ABOVE
 * the 0.32 noise cosine measured live — because an extension chip commits
 * the user to a heavier accept than a single tool, so the bar must stay
 * clear of semantic noise. Only `topK: 2` slots for the same reason:
 * surface fewer, higher-confidence extensions.
 */
export const EXTENSION_SUGGEST_DEFAULTS = {
  topK: 2,
  minScore: 0.35,
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
 * Cosine of the draft against a candidate's description embedding, folded
 * as a MAX with the best of its authored-example embeddings. Examples are
 * user-phrasing surrogates (query↔example cosine is the signal), so one
 * matching example qualifies the candidate even when the description cosine
 * is weak — the same "either signal wins" spirit as the lexical max. No
 * examples → identical to the plain description cosine (back-compat).
 */
export function maxExampleCosine(
  draftEmbedding: number[],
  descEmbedding: number[],
  exampleEmbeddings: number[][] = [],
): number {
  let best = cosineSimilarity(draftEmbedding, descEmbedding);
  for (const ex of exampleEmbeddings) {
    const c = cosineSimilarity(draftEmbedding, ex);
    if (c > best) best = c;
  }
  return best;
}

/** Function words that carry no tool-intent signal. Kept deliberately small
 *  and English-only — a miss just means slightly noisier lexical scores. */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto",
  "are", "was", "were", "will", "can", "could", "should", "would",
  "about", "please", "you", "your", "our", "their", "its", "get", "use",
]);

/** Lowercased alphanumeric content tokens (length ≥ 3, stop-words dropped). */
export function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

/**
 * Lexical relevance in [0,1]: the fraction of the draft's content tokens
 * found in the tool's name/description — name hits counted double (a draft
 * using the tool's own name is the strongest possible signal).
 */
export function lexicalScore(
  draftTokens: ReadonlySet<string>,
  nameTokens: ReadonlySet<string> = new Set(),
  descTokens: ReadonlySet<string> = new Set(),
): number {
  if (draftTokens.size === 0) return 0;
  let hits = 0;
  for (const token of draftTokens) {
    if (nameTokens.has(token)) hits += 2;
    else if (descTokens.has(token)) hits += 1;
  }
  return Math.min(1, hits / draftTokens.size);
}

/**
 * Rank candidates against a draft. Priors are expected normalized to [0,1]
 * (see computeToolPriors); missing keys count as 0. Ties break by key so the
 * ordering is deterministic across runs. `draftTokens` (see contentTokens)
 * powers the lexical half; omit it for embedding-only ranking.
 */
export function rankCandidates(
  draftEmbedding: number[],
  candidates: RankCandidate[],
  priors: Record<string, number>,
  opts?: RankOptions,
  draftTokens: ReadonlySet<string> = new Set(),
): RankedCandidate[] {
  const { topK, minScore, priorWeight } = { ...RANK_DEFAULTS, ...opts };
  return candidates
    .map((c) => {
      const cosine = maxExampleCosine(draftEmbedding, c.embedding, c.exampleEmbeddings);
      const lexical = lexicalScore(draftTokens, c.nameTokens, c.descTokens);
      const relevance = Math.max(cosine, lexical);
      const prior = priors[c.key] ?? 0;
      return {
        key: c.key,
        score: relevance * (1 - priorWeight) + prior * priorWeight,
        relevance,
        cosine,
        lexical,
        prior,
      };
    })
    .filter((c) => c.relevance >= minScore)
    .sort((x, y) => y.score - x.score || x.key.localeCompare(y.key))
    .slice(0, topK);
}
