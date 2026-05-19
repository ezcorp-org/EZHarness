// ── Memory — typed client for ezcorp/memory reverse RPC ────────
//
// Wraps the host's memory-handler with a scoped, action-discriminated
// API. Provenance is stamped HOST-SIDE (the subprocess cannot lie
// about its identity); extension-authored memories default to
// `injectionEligible: false` so they don't auto-inject into LLM
// system prompts.

import { getChannel, JsonRpcError } from "./channel";

export type MemoryCategory = "preferences" | "biographical" | "technical" | "decisions_goals";
export type MemoryConfidence = "high" | "medium" | "low";
export type MemoryStatus = "active" | "stale" | "archived";

export interface MemoryRecord {
  id: string;
  content: string;
  category: MemoryCategory;
  confidence: MemoryConfidence;
  status: MemoryStatus;
  projectId?: string | null;
  conversationId?: string | null;
  createdAt: string;
  updatedAt: string;
  provenance?: unknown;
}

export interface MemoryWriteInput {
  content: string;
  category: MemoryCategory;
  confidence?: MemoryConfidence;
  sourceMessageIds?: string[];
  projectId?: string | null;
}

export interface MemoryListOpts {
  category?: MemoryCategory;
  limit?: number;
}

export class Memory {
  async list(opts?: MemoryListOpts): Promise<MemoryRecord[]> {
    const result = await getChannel().request<{ memories: MemoryRecord[] }>(
      "ezcorp/memory",
      { action: "list", ...(opts?.category ? { category: opts.category } : {}), ...(opts?.limit !== undefined ? { limit: opts.limit } : {}) },
    );
    return result.memories;
  }

  async get(id: string): Promise<MemoryRecord | null> {
    try {
      const result = await getChannel().request<{ memory: MemoryRecord }>(
        "ezcorp/memory",
        { action: "get", id },
      );
      return result.memory;
    } catch (err) {
      if (err instanceof JsonRpcError && err.code === -32001) return null;
      throw err;
    }
  }

  async write(input: MemoryWriteInput): Promise<MemoryRecord> {
    const result = await getChannel().request<{ memory: MemoryRecord }>(
      "ezcorp/memory",
      { action: "write", input },
    );
    return result.memory;
  }

  async update(id: string, patch: { content?: string; confidence?: MemoryConfidence }): Promise<{ ok: true }> {
    return getChannel().request<{ ok: true }>(
      "ezcorp/memory",
      { action: "update", id, patch },
    );
  }

  async archive(id: string): Promise<{ ok: true }> {
    return getChannel().request<{ ok: true }>(
      "ezcorp/memory",
      { action: "archive", id },
    );
  }
}
