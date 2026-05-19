// Memory compaction: merges highly similar memories via LLM
import { findSimilarMemory, insertMemory, deleteMemory, getMemoryById } from "../db/queries/memories";
import { searchMemories } from "../db/queries/memories";
import { getSetting, upsertSetting } from "../db/queries/settings";
import type { MemoryProvenance } from "./types";
import { logger } from "../logger";
const log = logger.child("memory");

// Lazy-imported to avoid loading onnxruntime-node at module evaluation time
async function generateEmbedding(text: string): Promise<number[]> {
  const { generateEmbedding: gen } = await import("./embeddings");
  return gen(text);
}

const COMPACTION_SIMILARITY_THRESHOLD = 0.90;
const LOCK_KEY = "compaction:lastRun";

// Cheapest-model lookup per provider family for the compaction merge
// LLM call. Inlined here in Phase 53 Stage 2 — previously imported as
// `getExtractionModel` from the now-deleted `src/memory/extraction.ts`.
// The bundled `memory-extractor` extension owns its own copy of this
// map; the compaction merge is host-internal so it carries its own.
const COMPACTION_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20250514",
  openai: "gpt-4o-mini",
  google: "gemini-2.0-flash-lite",
};

function pickCompactionModel(activeProvider: string): { provider: string; model: string } {
  const model = COMPACTION_MODELS[activeProvider];
  if (model) return { provider: activeProvider, model };
  return { provider: "google", model: "gemini-2.0-flash-lite" };
}

/**
 * Merge two memory contents via LLM into a single consolidated statement.
 * Falls back to concatenation if no LLM is available.
 */
export async function mergeContents(contentA: string, contentB: string): Promise<string> {
  try {
    const { complete } = await import("@mariozechner/pi-ai");
    const { resolveModel } = await import("../providers/router");
    const { getCredential } = await import("../providers/credentials");

    // Determine which provider/model to use (cheapest available)
    const settingsProvider = (await getSetting("global:provider") as string) ?? "google";
    const { provider, model } = pickCompactionModel(settingsProvider);

    const resolved = await resolveModel(provider, model);
    const cred = await getCredential(resolved.provider);

    const result = await complete(resolved.piModel, {
      messages: [{ role: "user", content: `Merge these two related facts into a single, clear statement that preserves all information:\n\nFact 1: ${contentA}\nFact 2: ${contentB}\n\nRespond with ONLY the merged statement, nothing else.`, timestamp: Date.now() }],
    }, { apiKey: cred.token, maxTokens: 256, temperature: 0 });

    const merged = result.content.filter((c) => c.type === "text").map((c) => (c as { type: "text"; text: string }).text).join("").trim();
    return merged || `${contentA}; ${contentB}`;
  } catch {
    log.warn("LLM unavailable, skipping merge");
    return "";
  }
}

/**
 * Run compaction: find similar active memories and merge them.
 * Uses a settings-based lock to prevent concurrent runs.
 */
export async function runCompaction(projectId?: string, mergeFn?: (a: string, b: string) => Promise<string>): Promise<number> {
  // Simple lock check via settings
  const lastRun = await getSetting(LOCK_KEY) as string | undefined;
  const now = Date.now();

  // Don't run if we ran less than 1 minute ago (prevents rapid re-runs)
  if (lastRun && now - new Date(lastRun).getTime() < 60_000) {
    return 0;
  }

  await upsertSetting(LOCK_KEY, new Date(now).toISOString());

  const memories = await searchMemories({
    projectId,
    status: "active",
    limit: 200,
  });

  let mergedCount = 0;
  const processedIds = new Set<string>();

  for (const memory of memories) {
    if (processedIds.has(memory.id)) continue;
    if (!memory.embedding) continue;

    // Find a similar memory (threshold 0.90)
    const similar = await findSimilarMemory(
      memory.embedding as number[],
      COMPACTION_SIMILARITY_THRESHOLD,
    );

    if (!similar || similar.id === memory.id) continue;
    if (processedIds.has(similar.id)) continue;

    // Verify the similar memory still exists and is active
    const similarMemory = await getMemoryById(similar.id);
    if (!similarMemory || similarMemory.status !== "active") continue;

    // Merge via LLM
    const mergedContent = await (mergeFn ?? mergeContents)(memory.content, similar.content);
    if (!mergedContent) continue; // LLM unavailable

    const embedding = await generateEmbedding(mergedContent);

    const provenance: MemoryProvenance = {
      sourceConversationId: (memory.provenance as MemoryProvenance | null)?.sourceConversationId ?? "",
      sourceMessageIds: [],
      extractedAt: new Date(),
      confidence: memory.confidence as "high" | "medium" | "low",
      history: [
        {
          action: "merged",
          timestamp: new Date(),
          reason: `Merged memory ${memory.id} and ${similar.id}`,
          previousContent: `${memory.content} ||| ${similar.content}`,
        },
      ],
    };

    // Create merged memory
    await insertMemory({
      content: mergedContent,
      category: memory.category,
      projectId: memory.projectId,
      confidence: memory.confidence,
      embedding,
      provenance,
    });

    // Delete originals
    await deleteMemory(memory.id);
    await deleteMemory(similar.id);

    processedIds.add(memory.id);
    processedIds.add(similar.id);
    mergedCount++;
  }

  return mergedCount;
}
