// Memory system types — Phase 03-01

export const EMBEDDING_DIMENSIONS = 384;

export type MemoryCategory =
  | "preferences"
  | "biographical"
  | "technical"
  | "decisions_goals";

export type MemoryConfidence = "high" | "medium" | "low";

export interface ProvenanceEntry {
  action: "created" | "updated" | "merged" | "contradiction_resolved";
  timestamp: Date;
  reason: string;
  previousContent?: string;
}

export interface MemoryProvenance {
  sourceConversationId: string;
  sourceMessageIds: string[];
  extractedAt: Date;
  confidence: MemoryConfidence;
  history: ProvenanceEntry[];
}

export interface ExtractedFact {
  content: string;
  category: MemoryCategory;
  confidence: MemoryConfidence;
  messageIds: string[];
}

export type MemoryStatus = "active" | "stale" | "archived";

export interface KBChunkResult {
  id: string;
  content: string;
  chunkIndex: number;
  filename: string;
  fileId: string;
  similarity: number;
}

// Memory and NewMemory types are exported from ../db/schema
// Import them from there directly when needed:
//   import type { Memory, NewMemory } from "../db/schema";
