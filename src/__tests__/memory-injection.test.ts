import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// Re-establish real settings implementation — parallel tests mock this globally in Bun.
mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting(key: string, value: unknown) {
      const { getDb } = require("../db/connection");
      const db = getDb();
      const rows = await db.select().from(tbl).where(eq(tbl.key, key));
      if (rows[0]) {
        await db.update(tbl).set({ value, updatedAt: new Date() }).where(eq(tbl.key, key));
      } else {
        await db.insert(tbl).values({ key, value, updatedAt: new Date() });
      }
    },
    async deleteSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      if (!rows[0]) return false;
      await getDb().delete(tbl).where(eq(tbl.key, key));
      return true;
    },
    async isListingInstalled() { return false; },
  };
});

// Track calls manually
let mockHybridSearchResults: any[] = [];
let mockHybridSearchCalls: any[][] = [];

// Must mock before any import that triggers the real module
mockDbConnection();

mock.module("../memory/retrieval", () => ({
  hybridSearch: async (...args: any[]) => {
    mockHybridSearchCalls.push(args);
    return mockHybridSearchResults;
  },
}));

mock.module("../memory/embeddings", () => {
  // Normalized unit vector (L2 norm = 1.0) — mocks leak globally in Bun
  const dim = 384;
  const val = 1 / Math.sqrt(dim); // ~0.051, normalized so sum of squares = 1.0
  return {
    generateEmbedding: async () => new Array(dim).fill(val),
    generateEmbeddings: async (texts: string[]) => texts.map(() => new Array(dim).fill(val)),
    resetEmbeddingProvider: () => {},
  };
});

// Also mock the transformers dependency to prevent sharp loading
mock.module("@huggingface/transformers", () => ({
  pipeline: async () => async () => ({ data: new Float32Array(384) }),
}));

const { buildSystemPromptWithMemories } = await import("../memory/injection");
const { upsertSetting, deleteSetting } = await import("../db/queries/settings");

describe("buildSystemPromptWithMemories", () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
  restoreModuleMocks();
    await closeTestDb();
  });

  beforeEach(async () => {
    mockHybridSearchResults = [];
    mockHybridSearchCalls = [];
  });

  test("appends '## Relevant Memories' block to base system prompt", async () => {
    mockHybridSearchResults = [
      { id: "m1", content: "User prefers dark mode", category: "preferences", projectId: null, confidence: "high", provenance: null, rrfScore: 0.5 },
    ];

    const result = await buildSystemPromptWithMemories("You are a helpful assistant.", "hello", "proj-1");

    expect(result.systemPrompt).toContain("## Relevant Memories");
    expect(result.systemPrompt).toContain("User prefers dark mode");
    expect(result.systemPrompt).toStartWith("You are a helpful assistant.");
  });

  test("respects token budget (2000 default) -- stops adding memories when budget exhausted", async () => {
    mockHybridSearchResults = Array.from({ length: 50 }, (_, i) => ({
      id: `m${i}`,
      content: "A".repeat(200),
      category: "technical",
      projectId: null,
      confidence: "high",
      provenance: null,
      rrfScore: 0.5 - i * 0.01,
    }));

    const result = await buildSystemPromptWithMemories("Base prompt.", "query", "proj-1");

    expect(result.memoriesUsed.length).toBeLessThan(50);
    expect(result.memoriesUsed.length).toBeGreaterThan(0);
  });

  test("returns base prompt unchanged when no relevant memories found", async () => {
    mockHybridSearchResults = [];

    const result = await buildSystemPromptWithMemories("Base prompt.", "query", "proj-1");

    expect(result.systemPrompt).toBe("Base prompt.");
    expect(result.memoriesUsed).toEqual([]);
  });

  test("returns base prompt unchanged when memory system is disabled", async () => {
    await upsertSetting("global:memoryEnabled", false);
    mockHybridSearchResults = [
      { id: "m1", content: "Should not appear", category: "preferences", projectId: null, confidence: "high", provenance: null, rrfScore: 0.5 },
    ];

    const result = await buildSystemPromptWithMemories("Base prompt.", "query", "proj-1");

    expect(result.systemPrompt).toBe("Base prompt.");
    expect(result.memoriesUsed).toEqual([]);
    expect(mockHybridSearchCalls).toHaveLength(0);

    await deleteSetting("global:memoryEnabled");
  });

  test("reads project isolation setting and passes isolateToProject to hybridSearch when true", async () => {
    await upsertSetting("project:proj-1:memoryIsolation", true);
    mockHybridSearchResults = [];

    await buildSystemPromptWithMemories("Base.", "query", "proj-1");

    expect(mockHybridSearchCalls).toHaveLength(1);
    const [query, _embedding, opts] = mockHybridSearchCalls[0]!;
    expect(query).toBe("query");
    expect(opts.isolateToProject).toBe(true);
    expect(opts.projectId).toBe("proj-1");

    await deleteSetting("project:proj-1:memoryIsolation");
  });

  test("MemoryInjectionResult includes list of memory IDs that were injected", async () => {
    mockHybridSearchResults = [
      { id: "m1", content: "Likes TypeScript", category: "technical", projectId: null, confidence: "high", provenance: null, rrfScore: 0.5 },
      { id: "m2", content: "Uses Vim", category: "preferences", projectId: null, confidence: "medium", provenance: null, rrfScore: 0.3 },
    ];

    const result = await buildSystemPromptWithMemories("Base.", "query", "proj-1");

    expect(result.memoriesUsed).toHaveLength(2);
    expect(result.memoriesUsed[0]!.id).toBe("m1");
    expect(result.memoriesUsed[1]!.id).toBe("m2");
    expect(result.memoriesUsed[0]!.content).toBe("Likes TypeScript");
    expect(result.memoriesUsed[0]!.category).toBe("technical");
  });

  test("token estimation uses text.length / 4 heuristic", async () => {
    mockHybridSearchResults = [
      { id: "m1", content: "A".repeat(7900), category: "technical", projectId: null, confidence: "high", provenance: null, rrfScore: 0.5 },
      { id: "m2", content: "Should not fit", category: "preferences", projectId: null, confidence: "medium", provenance: null, rrfScore: 0.3 },
    ];

    const result = await buildSystemPromptWithMemories("Base.", "query", "proj-1");

    expect(result.memoriesUsed.length).toBeGreaterThanOrEqual(1);
  });

  test("handles undefined base prompt (returns empty string prefix)", async () => {
    mockHybridSearchResults = [
      { id: "m1", content: "A fact", category: "technical", projectId: null, confidence: "high", provenance: null, rrfScore: 0.5 },
    ];

    const result = await buildSystemPromptWithMemories(undefined, "query", "proj-1");

    expect(result.systemPrompt).toContain("## Relevant Memories");
    expect(result.systemPrompt).toContain("A fact");
  });

  test("memory lines are formatted as '- [category] content (confidence: level)'", async () => {
    mockHybridSearchResults = [
      { id: "m1", content: "Uses Bun runtime", category: "technical", projectId: null, confidence: "high", provenance: null, rrfScore: 0.5 },
    ];

    const result = await buildSystemPromptWithMemories("Base.", "query", "proj-1");

    expect(result.systemPrompt).toContain("- [technical] Uses Bun runtime (confidence: high)");
  });

  test("returns base prompt unchanged with empty memoriesUsed when token budget is exceeded on first memory", async () => {
    mockHybridSearchResults = [
      { id: "m1", content: "A".repeat(1000), category: "technical", projectId: null, confidence: "high", provenance: null, rrfScore: 0.5 },
    ];

    const result = await buildSystemPromptWithMemories("Base.", "query", "proj-1", { tokenBudget: 1 });

    expect(result.systemPrompt).toBe("Base.");
    expect(result.memoriesUsed).toEqual([]);
  });

  test("buildSystemPromptWithMemories includes KB chunks with citation instructions", async () => {
    mockHybridSearchResults = [
      { id: "m1", content: "User likes TypeScript", category: "technical", projectId: null, confidence: "high", provenance: null, rrfScore: 0.5 },
    ];

    const kbChunks = [
      { id: "kb1", content: "TypeScript best practices include...", chunkIndex: 0, filename: "ts-guide.md", fileId: "f1", similarity: 0.9 },
      { id: "kb2", content: "Advanced typing patterns...", chunkIndex: 1, filename: "advanced.md", fileId: "f2", similarity: 0.85 },
    ];

    const result = await buildSystemPromptWithMemories("Base.", "query", "proj-1", { kbChunks });

    expect(result.systemPrompt).toContain("## Knowledge Base");
    expect(result.systemPrompt).toContain("cite your sources using numbered markers");
    expect(result.systemPrompt).toContain("[Source 1: ts-guide.md]");
    expect(result.systemPrompt).toContain("[Source 2: advanced.md]");
    expect(result.systemPrompt).toContain("TypeScript best practices include...");
  });

  test("buildSystemPromptWithMemories returns kbSourcesUsed", async () => {
    mockHybridSearchResults = [];

    const kbChunks = [
      { id: "kb1", content: "Some KB content here", chunkIndex: 3, filename: "notes.md", fileId: "f1", similarity: 0.8 },
    ];

    const result = await buildSystemPromptWithMemories("Base.", "query", "proj-1", { kbChunks });

    expect(result.kbSourcesUsed).toHaveLength(1);
    expect(result.kbSourcesUsed[0]!.id).toBe("kb1");
    expect(result.kbSourcesUsed[0]!.filename).toBe("notes.md");
    expect(result.kbSourcesUsed[0]!.chunkIndex).toBe(3);
  });

  test("buildSystemPromptWithMemories handles no KB chunks gracefully", async () => {
    mockHybridSearchResults = [
      { id: "m1", content: "A fact", category: "technical", projectId: null, confidence: "high", provenance: null, rrfScore: 0.5 },
    ];

    // Test with undefined kbChunks
    const result1 = await buildSystemPromptWithMemories("Base.", "query", "proj-1");
    expect(result1.systemPrompt).not.toContain("## Knowledge Base");
    expect(result1.kbSourcesUsed).toEqual([]);

    // Test with empty array
    const result2 = await buildSystemPromptWithMemories("Base.", "query", "proj-1", { kbChunks: [] });
    expect(result2.systemPrompt).not.toContain("## Knowledge Base");
    expect(result2.kbSourcesUsed).toEqual([]);
  });
});
