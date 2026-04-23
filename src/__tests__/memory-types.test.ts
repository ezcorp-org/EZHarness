import { test, expect, describe } from "bun:test";
import {
  EMBEDDING_DIMENSIONS,
  type MemoryCategory,
  type MemoryConfidence,
  type MemoryStatus,
  type ProvenanceEntry,
  type MemoryProvenance,
  type ExtractedFact,
  type KBChunkResult,
} from "../memory/types";

describe("EMBEDDING_DIMENSIONS constant", () => {
  test("equals 384 (all-MiniLM-L6-v2 output dim)", () => {
    expect(EMBEDDING_DIMENSIONS).toBe(384);
  });

  test("is a positive integer", () => {
    expect(Number.isInteger(EMBEDDING_DIMENSIONS)).toBe(true);
    expect(EMBEDDING_DIMENSIONS).toBeGreaterThan(0);
  });

  test("can size a Float32Array buffer exactly", () => {
    const buf = new Float32Array(EMBEDDING_DIMENSIONS);
    expect(buf.length).toBe(384);
  });
});

describe("MemoryCategory type discriminants", () => {
  test("accepts all four documented categories as values", () => {
    const cats: MemoryCategory[] = [
      "preferences",
      "biographical",
      "technical",
      "decisions_goals",
    ];
    // Round-trip through JSON to assert they are serializable string literals.
    const serialized = JSON.stringify(cats);
    const parsed = JSON.parse(serialized) as MemoryCategory[];
    expect(parsed).toEqual(cats);
    expect(parsed).toHaveLength(4);
  });
});

describe("MemoryConfidence type discriminants", () => {
  test("accepts high / medium / low", () => {
    const levels: MemoryConfidence[] = ["high", "medium", "low"];
    expect(levels).toContain("high");
    expect(levels).toContain("medium");
    expect(levels).toContain("low");
  });
});

describe("MemoryStatus type discriminants", () => {
  test("accepts active / stale / archived", () => {
    const statuses: MemoryStatus[] = ["active", "stale", "archived"];
    expect(statuses).toHaveLength(3);
    // Confirm the values are mutually distinct (no silent typos).
    const unique = new Set(statuses);
    expect(unique.size).toBe(3);
  });
});

describe("ProvenanceEntry action discriminants", () => {
  test("all four actions serialize/deserialize through JSON", () => {
    const entries: ProvenanceEntry[] = [
      { action: "created", timestamp: new Date(0), reason: "r1" },
      { action: "updated", timestamp: new Date(0), reason: "r2", previousContent: "before" },
      { action: "merged", timestamp: new Date(0), reason: "r3" },
      { action: "contradiction_resolved", timestamp: new Date(0), reason: "r4" },
    ];
    const json = JSON.parse(JSON.stringify(entries)) as { action: string }[];
    expect(json.map((e) => e.action)).toEqual([
      "created",
      "updated",
      "merged",
      "contradiction_resolved",
    ]);
  });
});

describe("MemoryProvenance JSON round-trip", () => {
  test("preserves all fields through JSON serialization (as stored in JSONB)", () => {
    const prov: MemoryProvenance = {
      sourceConversationId: "conv-99",
      sourceMessageIds: ["m1", "m2"],
      extractedAt: new Date("2026-04-23T00:00:00Z"),
      confidence: "high",
      history: [
        { action: "created", timestamp: new Date("2026-04-23T00:00:00Z"), reason: "init" },
        { action: "updated", timestamp: new Date("2026-04-23T01:00:00Z"), reason: "refresh", previousContent: "old" },
      ],
    };

    const restored = JSON.parse(JSON.stringify(prov)) as Record<string, unknown> & {
      history: { action: string; previousContent?: string }[];
    };

    expect(restored.sourceConversationId).toBe("conv-99");
    expect(restored.sourceMessageIds).toEqual(["m1", "m2"]);
    expect(restored.confidence).toBe("high");
    expect(restored.history).toHaveLength(2);
    expect(restored.history[0]!.action).toBe("created");
    expect(restored.history[1]!.previousContent).toBe("old");
  });
});

describe("ExtractedFact shape", () => {
  test("messageIds is a string array", () => {
    const fact: ExtractedFact = {
      content: "User is a staff engineer",
      category: "biographical",
      confidence: "medium",
      messageIds: ["msg-1", "msg-2", "msg-3"],
    };
    expect(Array.isArray(fact.messageIds)).toBe(true);
    expect(fact.messageIds).toHaveLength(3);
    expect(typeof fact.messageIds[0]).toBe("string");
  });
});

describe("KBChunkResult shape", () => {
  test("has numeric chunkIndex and similarity", () => {
    const chunk: KBChunkResult = {
      id: "kb1",
      content: "Chapter 1 content",
      chunkIndex: 0,
      filename: "book.md",
      fileId: "f1",
      similarity: 0.92,
    };
    expect(typeof chunk.chunkIndex).toBe("number");
    expect(typeof chunk.similarity).toBe("number");
    expect(chunk.similarity).toBeGreaterThanOrEqual(0);
    expect(chunk.similarity).toBeLessThanOrEqual(1);
  });
});
