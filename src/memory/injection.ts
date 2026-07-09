// System prompt builder: appends relevant memories within token budget
import { hybridSearch } from "./retrieval";
import type { KBChunkResult } from "./types";
// Lazy-imported to avoid loading onnxruntime-node at module evaluation time (breaks Vite SSR on NixOS)
async function generateEmbedding(text: string): Promise<number[]> {
  const { generateEmbedding: gen } = await import("./embeddings");
  return gen(text);
}
import { getSetting } from "../db/queries/settings";

export interface MemoryInjectionResult {
  systemPrompt: string;
  /**
   * The raw injected memory/KB block WITHOUT the base prompt (`""` when
   * nothing was injected). `systemPrompt` is always `base + injectionBlock`;
   * cache-aware callers (setup-tools → build-pi-agent) consume the block
   * alone so the base system prompt stays byte-stable for prompt caching —
   * see src/runtime/stream-chat/system-cache-split.ts.
   */
  injectionBlock: string;
  memoriesUsed: { id: string; content: string; category: string }[];
  kbSourcesUsed: { id: string; filename: string; chunkIndex: number }[];
}

const DEFAULT_TOKEN_BUDGET = 2000;

/** Estimate tokens using text.length / 4 heuristic */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function buildSystemPromptWithMemories(
  basePrompt: string | undefined,
  query: string,
  projectId: string,
  // REQUIRED (not optional): memories are per-user PII, so the acting user must
  // always be supplied. The non-optionality is the compile-time guard that
  // stops the cross-user injection leak from silently recurring. Pass the
  // conversation owner's id, or `null` for an unowned run (→ zero memories,
  // fail-closed).
  userId: string | null,
  opts?: { tokenBudget?: number; kbChunks?: KBChunkResult[]; queryEmbedding?: number[] },
): Promise<MemoryInjectionResult> {
  const base = basePrompt ?? "";

  // Check if memory system is globally disabled
  const memoryEnabled = await getSetting("global:memoryEnabled");
  if (memoryEnabled === false) {
    return { systemPrompt: base, injectionBlock: "", memoriesUsed: [], kbSourcesUsed: [] };
  }

  // Check per-project isolation setting
  const isolationSetting = await getSetting(`project:${projectId}:memoryIsolation`);
  const isolateToProject = Boolean(isolationSetting);

  // Reuse pre-computed embedding if provided, otherwise generate
  const embedding = opts?.queryEmbedding ?? await generateEmbedding(query);

  // Hybrid search for relevant memories
  const results = await hybridSearch(query, embedding, {
    projectId,
    isolateToProject,
    limit: 20,
    userId,
    // System-prompt injection reads only auto-inject-eligible memories.
    injectionEligibleOnly: true,
  });

  const tokenBudget = opts?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  let tokensUsed = 0;
  const memoriesUsed: { id: string; content: string; category: string }[] = [];
  const memoryLines: string[] = [];

  // Greedy fill memories within token budget
  for (const mem of results) {
    const line = `- [${mem.category}] ${mem.content} (confidence: ${mem.confidence})`;
    const lineTokens = estimateTokens(line);

    if (tokensUsed + lineTokens > tokenBudget) break;

    tokensUsed += lineTokens;
    memoryLines.push(line);
    memoriesUsed.push({ id: mem.id, content: mem.content, category: mem.category });
  }

  // Build KB chunk section if chunks provided and budget remains
  const kbChunks = opts?.kbChunks ?? [];
  const kbSourcesUsed: { id: string; filename: string; chunkIndex: number }[] = [];
  const kbLines: string[] = [];

  if (kbChunks.length > 0) {
    for (let i = 0; i < kbChunks.length; i++) {
      const chunk = kbChunks[i]!;
      const line = `[Source ${i + 1}: ${chunk.filename}] ${chunk.content}`;
      const lineTokens = estimateTokens(line);

      if (tokensUsed + lineTokens > tokenBudget) break;

      tokensUsed += lineTokens;
      kbLines.push(line);
      kbSourcesUsed.push({ id: chunk.id, filename: chunk.filename, chunkIndex: chunk.chunkIndex });
    }
  }

  if (memoriesUsed.length === 0 && kbSourcesUsed.length === 0) {
    return { systemPrompt: base, injectionBlock: "", memoriesUsed: [], kbSourcesUsed: [] };
  }

  let injectionBlock = "";

  if (memoriesUsed.length > 0) {
    injectionBlock += `\n\n## Relevant Memories\nThe following facts were remembered from previous conversations:\n${memoryLines.join("\n")}`;
  }

  if (kbSourcesUsed.length > 0) {
    injectionBlock += `\n\n## Knowledge Base\nWhen using information from the Knowledge Base sections below, cite your sources using numbered markers like [1], [2]. Only cite sources you actually use.\n${kbLines.join("\n")}`;
  }

  return {
    systemPrompt: base + injectionBlock,
    injectionBlock,
    memoriesUsed,
    kbSourcesUsed,
  };
}
