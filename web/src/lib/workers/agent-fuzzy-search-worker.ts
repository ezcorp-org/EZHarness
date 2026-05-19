/**
 * agent-fuzzy-search-worker — off-main-thread fuzzy ranker for the
 * /agents page (Phase 49.2).
 *
 * The fuzzy scoring logic (`fuzzyScore` + `bestFuzzyScore`) is pure
 * and runs comfortably on the main thread for tens of agents, but the
 * /agents page can grow to hundreds of cards in real deployments and
 * a 100ms keystroke debounce should NEVER stall the input box. So:
 * once the candidate list crosses 100 agents, the bridge offloads
 * scoring here.
 *
 * Protocol (mirrors `kokoro-tts-worker`):
 *   request:  { type: "rank", id, query, candidates }
 *     candidates: { name: string, description?: string }[]
 *   response: { type: "ranked", id, indices: number[], scores: number[] }
 *     indices[k] = original index of the kth-ranked candidate
 *     scores[k]  = its bestFuzzyScore (best of name+description)
 *
 * Why ship indices rather than the candidates themselves: the page
 * already holds the agent objects in state — re-emitting them across
 * the postMessage boundary would double the wire payload for no
 * benefit. The bridge correlates indices back to agents on the main
 * side.
 */

import { fuzzyScore, bestFuzzyScore } from "../fuzzy-match";

export type RankRequest = {
  type: "rank";
  id: string;
  query: string;
  candidates: { name: string; description?: string | null }[];
};

export type RankResponse = {
  type: "ranked";
  id: string;
  indices: number[];
  scores: number[];
};

export function rank(req: RankRequest): RankResponse {
  const q = req.query;
  const scored: { idx: number; score: number; name: string }[] = [];
  for (let i = 0; i < req.candidates.length; i++) {
    const c = req.candidates[i]!;
    const best = bestFuzzyScore([
      fuzzyScore(q, c.name ?? ""),
      fuzzyScore(q, c.description ?? ""),
    ]);
    if (best === null) continue;
    scored.push({ idx: i, score: best, name: c.name ?? "" });
  }
  // Higher score first; ties broken by name asc so the order is stable
  // and predictable to the user.
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });
  return {
    type: "ranked",
    id: req.id,
    indices: scored.map((s) => s.idx),
    scores: scored.map((s) => s.score),
  };
}

// Worker entry — only register the listener when running inside an
// actual Worker context (the `importScripts` predicate is the cheapest
// way to discriminate a real Worker from jsdom's Window, which lacks
// it). The exported `rank` function is what unit tests exercise
// directly, so this branch is dead code under test runners.
const isWorker =
  typeof self !== "undefined" &&
  typeof (self as unknown as { importScripts?: unknown }).importScripts ===
    "function";

if (isWorker) {
  self.addEventListener("message", (ev: MessageEvent<RankRequest>) => {
    const data = ev.data;
    if (!data || data.type !== "rank") return;
    const reply = rank(data);
    (self as unknown as { postMessage: (m: unknown) => void }).postMessage(
      reply,
    );
  });
}
