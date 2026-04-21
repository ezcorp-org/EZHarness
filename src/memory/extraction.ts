import type { AgentRun, AgentEvents } from "../types";
import type { EventBus } from "../runtime/events";
import type { ExtractedFact, MemoryProvenance } from "./types";
// Lazy-imported to avoid loading onnxruntime-node at module evaluation time (breaks Vite SSR on NixOS)
async function generateEmbedding(text: string): Promise<number[]> {
  const { generateEmbedding: gen } = await import("./embeddings");
  return gen(text);
}
import { insertMemory, updateMemory, findSimilarMemory } from "../db/queries/memories";
import { logger } from "../logger";
const log = logger.child("memory");

// Per-project extraction mutex: serializes findSimilarMemory → insert/update within
// a project so concurrent run:complete events can't race past the dedup check.
// See src/__tests__/seam-memory-concurrent-dedup-integration.test.ts.
const extractionLocks = new Map<string, Promise<void>>();
async function withExtractionLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = extractionLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  extractionLocks.set(projectId, prev.then(() => next));
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (extractionLocks.get(projectId) === next) extractionLocks.delete(projectId);
  }
}
import { getSetting } from "../db/queries/settings";
import { getMessages } from "../db/queries/conversations";

// ── Cheapest model per provider family ──────────────────────────────

export const EXTRACTION_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20250514",
  openai: "gpt-4o-mini",
  google: "gemini-2.0-flash-lite",
};

export function getExtractionModel(activeProvider: string): { provider: string; model: string } {
  const model = EXTRACTION_MODELS[activeProvider];
  if (model) return { provider: activeProvider, model };
  return { provider: "google", model: "gemini-2.0-flash-lite" };
}

// ── Extraction Prompt ───────────────────────────────────────────────

export const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Analyze the conversation and extract structured facts worth remembering for future conversations.

Extract ONLY facts that would be useful context in future conversations. Do NOT extract:
- Transient information (weather today, current task status)
- Obvious conversational filler
- Information the system already knows (model names, capabilities)

For each fact, provide:
- content: A clear, standalone natural language statement
- category: One of "preferences", "biographical", "technical", "decisions_goals"
- confidence: "high", "medium", or "low"
- messageIds: Array of message IDs this fact was extracted from

Respond with a JSON array. If no facts are worth extracting, respond with [].

Example output:
[
  {"content": "User prefers TypeScript over JavaScript", "category": "preferences", "confidence": "high", "messageIds": ["msg-123"]},
  {"content": "User is building a SaaS product for healthcare", "category": "biographical", "confidence": "medium", "messageIds": ["msg-124", "msg-125"]}
]`;

// ── Extraction Pipeline ─────────────────────────────────────────────

export async function extractMemories(
  run: AgentRun,
  conversationId: string,
): Promise<void> {
  // Check global toggle -- treat missing setting as enabled
  const memoryEnabled = await getSetting("global:memoryEnabled");
  if (memoryEnabled === false) return;

  // Only extract from successful chat completions
  if (run.agentName !== "chat" || run.status !== "success") return;

  // Fetch conversation messages
  const allMessages = await getMessages(conversationId);
  if (allMessages.length === 0) return;

  // Take last ~20 messages (10 pairs) for context
  const recentMessages = allMessages.slice(-20);
  const conversationText = recentMessages
    .map((m) => `[${m.id}] ${m.role}: ${m.content}`)
    .join("\n\n");

  // Determine cheapest model for this provider
  const provider = run.provider ?? "google";
  const { provider: extractionProvider, model } = getExtractionModel(provider);

  // Use pi-ai for LLM call
  const { complete } = await import("@mariozechner/pi-ai");
  const { resolveModel } = await import("../providers/router");
  const { getCredential } = await import("../providers/credentials");

  const resolved = await resolveModel(extractionProvider, model);
  const cred = await getCredential(resolved.provider);

  const result = await complete(resolved.piModel, {
    systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Extract facts from this conversation:\n\n${conversationText}`, timestamp: Date.now() }],
  }, { apiKey: cred.token, maxTokens: 2048, temperature: 0 });

  // Parse JSON response
  let facts: ExtractedFact[];
  try {
    const text = result.content.filter((c) => c.type === "text").map((c) => (c as { type: "text"; text: string }).text).join("");
    let jsonText = text.trim();
    const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonText = jsonMatch[1]!.trim();
    if (!jsonText) {
      log.warn("Memory extraction: empty response from LLM");
      return;
    }
    if (!jsonText.startsWith("[")) {
      const arrayStart = jsonText.indexOf("[");
      if (arrayStart !== -1) jsonText = jsonText.slice(arrayStart);
    }
    facts = JSON.parse(jsonText);
    if (!Array.isArray(facts)) {
      log.warn("Memory extraction: expected JSON array", { got: typeof facts });
      return;
    }
  } catch (err) {
    log.warn("Memory extraction: failed to parse JSON response", { error: (err as Error).message });
    return;
  }

  // Process each extracted fact
  for (const fact of facts) {
    if (!fact.content || !fact.category) continue;

    const embedding = await generateEmbedding(fact.content);

    // Serialize similarity check + insert/update per project so concurrent
    // run:complete events extracting overlapping facts cannot race past the
    // dedup check and create duplicate rows (the findSimilarMemory query and
    // the subsequent insertMemory/updateMemory are not atomic).
    await withExtractionLock(run.projectId ?? "__global__", async () => {
    // Check for existing similar memory (deduplication)
    const similar = await findSimilarMemory(embedding, 0.85);

    if (similar) {
      // Update existing memory (newer wins)
      const updatedProvenance: MemoryProvenance = {
        sourceConversationId: conversationId,
        sourceMessageIds: fact.messageIds ?? [],
        extractedAt: new Date(),
        confidence: fact.confidence ?? "medium",
        history: [
          { action: "updated", timestamp: new Date(), reason: "Updated with newer information", previousContent: similar.content },
        ],
      };
      await updateMemory(similar.id, {
        content: fact.content,
        confidence: fact.confidence ?? "medium",
        embedding,
        provenance: updatedProvenance,
      });
    } else {
      // Insert new memory with full provenance
      const provenance: MemoryProvenance = {
        sourceConversationId: conversationId,
        sourceMessageIds: fact.messageIds ?? [],
        extractedAt: new Date(),
        confidence: fact.confidence ?? "medium",
        history: [
          { action: "created", timestamp: new Date(), reason: "Extracted from conversation" },
        ],
      };
      await insertMemory({
        content: fact.content,
        category: fact.category,
        projectId: run.projectId,
        conversationId,
        messageIds: fact.messageIds ?? [],
        confidence: fact.confidence ?? "medium",
        embedding,
        provenance,
      });
    }
    });
  }
}

// ── Event Listener Registration ─────────────────────────────────────

export function registerExtractionListener(
  bus: EventBus<AgentEvents>,
): () => void {
  return bus.on("run:complete", (data: { run: AgentRun; conversationId?: string }) => {
    const { run, conversationId } = data;
    if (!conversationId) return;
    // Fire-and-forget: never block the chat response
    extractMemories(run, conversationId).catch((err) =>
      log.error("Memory extraction failed", { error: String(err) }),
    );
  });
}
