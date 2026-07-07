/**
 * Memory dedup helper — host-side, cross-extension by design.
 *
 * Extracted from `src/memory/extraction.ts` in Phase 53.4 Stage 1 so
 * that Stage 2's deletion of `extraction.ts` doesn't break the bundled
 * memory-extractor's dedup path. The decision is locked in
 * tasks/v1.3-phase-53-bundled-extension-ports.md:
 *
 *   > Memory dedup stays host-side. Cross-extension by nature; an
 *   > extension cannot dedup against memories it can't see. Extension
 *   > calls `ctx.memory.write` and the host applies dedup before
 *   > insert. The dedup helper migrates from `src/memory/extraction.ts`
 *   > to a new `src/memory/dedup.ts` host module that survives the
 *   > deletion.
 *
 * Today's wiring:
 *   - Stage 1: `extraction.ts::extractMemories` continues to call the
 *     dedup helper directly (re-exported from this module so the legacy
 *     listener path keeps working unchanged during Stage 1).
 *   - The bundled extension's `ctx.memory.write` flows through the
 *     host's memory-handler which (per the spec) consults this module
 *     before insert. The host-handler integration is deliberately a
 *     thin v1 — it surfaces the dedup decision to the caller via the
 *     same insert/update path the legacy code uses, so the parity test
 *     can assert identical row shapes.
 *
 * The mutex below is a per-project serialization gate. Concurrent
 * `run:complete` events extracting overlapping facts must not race past
 * the similarity check (the `findSimilarMemory` query and the
 * subsequent insert/update are not atomic). The legacy implementation
 * lived in `extraction.ts`; moving it here ensures both the Stage-1
 * legacy path and the bundled-extension path share a single mutex
 * instance — without the shared instance, both paths could be holding
 * "their" lock and still race against each other across a project.
 *
 * Stage 2 cleanup: when `extraction.ts` is deleted, the only callers
 * of this module are the host-side memory-handler (via
 * `runtime.memory.dedupMemoryWrite`) and the bundled extractor's
 * post-write path. The mutex stays here because cross-extension memory
 * writes must continue to serialize.
 */

import type { ExtractedFact, MemoryProvenance } from "./types";
import { findSimilarMemory, insertMemory, updateMemory } from "../db/queries/memories";
import { getConversation } from "../db/queries/conversations";
import { logger } from "../logger";

const log = logger.child("memory.dedup");
void log;

// ── Per-project extraction mutex ────────────────────────────────────
//
// Same shape as the original lock in `extraction.ts`. Exposed via
// `withDedupLock` so both code paths (legacy + bundled extension)
// hold the same lock during the similarity-check + insert/update
// sequence.
const dedupLocks = new Map<string, Promise<void>>();

export async function withDedupLock<T>(projectKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = dedupLocks.get(projectKey) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  dedupLocks.set(projectKey, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (dedupLocks.get(projectKey) === next) dedupLocks.delete(projectKey);
  }
}

/** Project-scope key used by the mutex. Memories without a project
 *  share a single global slot ("__global__"); this matches the
 *  legacy behavior. */
export function dedupLockKey(projectId: string | null | undefined): string {
  return projectId ?? "__global__";
}

// ── Similarity threshold (extraction-time) ──────────────────────────
//
// 0.85 is the legacy default copied from `extraction.ts`. Lower than
// the compaction threshold (0.90) because extraction-time dedup needs
// to merge near-duplicates aggressively (the LLM may rephrase the same
// fact across runs); compaction is a stricter sweep. Both numbers are
// host-controlled — extensions cannot widen them.
export const EXTRACTION_DEDUP_THRESHOLD = 0.85;

// ── Embedding dependency ────────────────────────────────────────────
//
// Lazy-imported to keep onnxruntime-node off the import graph for
// modules that just want the dedup helper without paying the model
// load (Vite SSR on NixOS chokes on the eager import).
async function generateEmbedding(text: string): Promise<number[]> {
  const { generateEmbedding: gen } = await import("./embeddings");
  return gen(text);
}

// ── Dedup-aware memory write ────────────────────────────────────────
//
// Single entry point used by both the legacy extraction listener and
// the bundled memory-extractor's post-write hook. Returns the same
// shape callers expect today: `{action: "inserted" | "updated", id}`.
//
// Behavior:
//   1. Generate / receive an embedding for the candidate content.
//   2. Find the most-similar existing active memory (cross-extension).
//   3. If similarity >= threshold: update the existing row in place
//      (newer wins, history-extended provenance).
//   4. Otherwise: insert a new memory row with full provenance.
//
// The full sequence runs under `withDedupLock(projectKey)` so two
// concurrent run:complete events touching the same project cannot
// both pass the similarity check and produce duplicate rows.
//
// `provenanceFactory` lets the caller stamp extension-specific fields
// (`source`, `extensionId`, `injectionEligible`) without this module
// knowing about extension identity — which keeps the cross-extension
// dedup invariant intact.
export interface DedupWriteInput {
  fact: ExtractedFact;
  conversationId: string;
  projectId: string | null | undefined;
  /** Pre-computed embedding. If omitted, the helper computes one. */
  embedding?: number[];
  /** Provenance factory for the INSERT branch. The factory receives
   *  the action ("created") and returns the full provenance object.
   *  The UPDATE branch always uses the legacy "updated" provenance
   *  shape (see updateProvenanceShape below) so cross-extension
   *  updates remain shape-compatible with the legacy pipeline. */
  provenanceFactory: (
    action: "created",
    fact: ExtractedFact,
    conversationId: string,
  ) => MemoryProvenance;
}

export interface DedupWriteResult {
  action: "inserted" | "updated";
  memoryId: string;
}

export async function dedupAndWriteMemory(
  input: DedupWriteInput,
): Promise<DedupWriteResult> {
  const { fact, conversationId, projectId, provenanceFactory } = input;
  const embedding = input.embedding ?? (await generateEmbedding(fact.content));

  return withDedupLock(dedupLockKey(projectId), async () => {
    // Memories are per-user-private: scope the similar-match to the acting
    // conversation's owner. Unscoped, one user's extracted fact could match —
    // and then OVERWRITE — another user's memory row via the update branch
    // below. A conversation with no resolvable owner matches nothing
    // (fail-closed) and falls through to a fresh insert.
    const conv = await getConversation(conversationId);
    const similar = await findSimilarMemory(embedding, EXTRACTION_DEDUP_THRESHOLD, {
      ownerUserId: conv?.userId ?? null,
    });
    if (similar) {
      const updatedProvenance: MemoryProvenance = {
        sourceConversationId: conversationId,
        sourceMessageIds: fact.messageIds ?? [],
        extractedAt: new Date(),
        confidence: fact.confidence ?? "medium",
        history: [
          {
            action: "updated",
            timestamp: new Date(),
            reason: "Updated with newer information",
            previousContent: similar.content,
          },
        ],
      };
      await updateMemory(similar.id, {
        content: fact.content,
        confidence: fact.confidence ?? "medium",
        embedding,
        provenance: updatedProvenance,
      });
      return { action: "updated", memoryId: similar.id };
    }

    const provenance = provenanceFactory("created", fact, conversationId);
    const inserted = await insertMemory({
      content: fact.content,
      category: fact.category,
      projectId: projectId ?? null,
      conversationId,
      messageIds: fact.messageIds ?? [],
      confidence: fact.confidence ?? "medium",
      embedding,
      provenance,
    });
    return { action: "inserted", memoryId: inserted.id };
  });
}

/** Default provenance factory matching the legacy `extractMemories`
 *  shape (no `source` / `extensionId` / `injectionEligible` fields).
 *  Used by `extraction.ts` Stage 1 so the legacy callsite continues
 *  to produce identical rows after the helper move. */
export function legacyExtractionProvenance(
  _action: "created",
  fact: ExtractedFact,
  conversationId: string,
): MemoryProvenance {
  return {
    sourceConversationId: conversationId,
    sourceMessageIds: fact.messageIds ?? [],
    extractedAt: new Date(),
    confidence: fact.confidence ?? "medium",
    history: [
      { action: "created", timestamp: new Date(), reason: "Extracted from conversation" },
    ],
  };
}
