import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestPglite } from "./helpers/test-pglite";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";

// ── Module-level mocks (must happen before any dependent imports) ────

// Re-establish real settings implementation -- parallel tests mock this globally in Bun.
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

mockDbConnection();

mock.module("@huggingface/transformers", () => ({
  pipeline: async () => async () => ({ data: new Float32Array(384) }),
}));

// Re-mock retrieval to undo the injection test's mock leak (Bun mocks leak globally).
// We inline the real hybridSearch since the original module may already be replaced.
mock.module("../memory/retrieval", () => {
  const { getPglite } = require("../db/connection");

  async function hybridSearch(
    query: string,
    embedding: number[],
    opts: { projectId?: string; isolateToProject?: boolean; limit?: number; k?: number },
  ) {
    const pg = getPglite();
    if (!pg) return [];
    const limit = opts.limit ?? 20;
    const k = opts.k ?? 60;
    const isolate = opts.isolateToProject === true;
    const projectId = opts.projectId ?? null;
    const embeddingStr = `[${embedding.join(",")}]`;
    const isolationFilter = isolate && projectId ? `WHERE project_id = '${projectId}'` : "";
    const boostExpr = !isolate && projectId
      ? `CASE WHEN COALESCE(v.project_id, k.project_id) = '${projectId}' THEN 1.5 ELSE 1.0 END`
      : "1.0";
    const sql = `
      WITH vector_ranked AS (
        SELECT id, content, category, project_id, confidence, provenance,
               ROW_NUMBER() OVER (ORDER BY embedding <=> '${embeddingStr}'::vector) AS rank_v
        FROM memories ${isolationFilter}
        ORDER BY embedding <=> '${embeddingStr}'::vector
        LIMIT ${limit * 2}
      ),
      keyword_ranked AS (
        SELECT id, content, category, project_id, confidence, provenance,
               ROW_NUMBER() OVER (ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $1)) DESC) AS rank_k
        FROM memories
        ${isolationFilter ? isolationFilter + " AND" : "WHERE"} to_tsvector('english', content) @@ plainto_tsquery('english', $1)
        LIMIT ${limit * 2}
      )
      SELECT
        COALESCE(v.id, k.id) AS id,
        COALESCE(v.content, k.content) AS content,
        COALESCE(v.category, k.category) AS category,
        COALESCE(v.project_id, k.project_id) AS project_id,
        COALESCE(v.confidence, k.confidence) AS confidence,
        COALESCE(v.provenance, k.provenance) AS provenance,
        (COALESCE(1.0 / (${k} + v.rank_v), 0) + COALESCE(1.0 / (${k} + k.rank_k), 0)) * ${boostExpr} AS rrf_score
      FROM vector_ranked v
      FULL OUTER JOIN keyword_ranked k ON v.id = k.id
      ORDER BY rrf_score DESC
      LIMIT ${limit}
    `;
    const result = await pg.query(sql, [query]);
    return (result.rows as any[]).map((row: any) => ({
      id: row.id,
      content: row.content,
      category: row.category,
      projectId: row.project_id ?? null,
      confidence: row.confidence,
      provenance: row.provenance ?? null,
      rrfScore: Number(row.rrf_score),
    }));
  }

  return { hybridSearch };
});

mock.module("../memory/embeddings", () => {
  function hashCode(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h;
  }
  function makeVector(text: string): number[] {
    const seed = hashCode(text);
    const vec = new Array(384);
    for (let i = 0; i < 384; i++) {
      vec[i] = Math.sin(seed + i) * 0.1;
    }
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    return vec.map((v: number) => v / norm);
  }
  return {
    generateEmbedding: async (text: string) => makeVector(text),
    generateEmbeddings: async (texts: string[]) => texts.map(makeVector),
    resetEmbeddingProvider: () => {},
  };
});

// Mock pi-ai complete() to return configurable extraction results
let mockExtractionResponse = "[]";

mock.module("@mariozechner/pi-ai", () => ({
  complete: async () => stubAssistantMessage(mockExtractionResponse),
  stream: () => ({ [Symbol.asyncIterator]: async function* () {}, result: async () => stubAssistantMessage() }),
  getModel: () => ({ id: "test-model", provider: "anthropic" }),
  getModels: () => [],
  getProviders: () => ["anthropic", "openai", "google"],
  getEnvApiKey: () => undefined,
}));

mock.module("../providers/router", () => ({
  resolveModel: async () => ({
    provider: "anthropic",
    model: "test-model",
    piModel: { id: "test-model", provider: "anthropic", api: "anthropic-messages", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 },
  }),
  ProviderUnavailableError: class extends Error {
    failedProvider: string; failedModel: string; suggestion: any;
    constructor(msg: string, fp: string, fm: string, sug: any) { super(msg); this.failedProvider = fp; this.failedModel = fm; this.suggestion = sug; }
  },
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
  getApiKey: async () => "test-key",
}));

// ── Imports (dynamic to ensure mocks are applied first) ─────────────

const { extractMemories } = await import("../memory/extraction");
const { buildSystemPromptWithMemories } = await import("../memory/injection");
const { hybridSearch } = await import("../memory/retrieval");
const { listMemories } = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { createConversation, createMessage } = await import("../db/queries/conversations");
const { upsertSetting, deleteSetting } = await import("../db/queries/settings");
const { generateEmbedding } = await import("../memory/embeddings");

// ── Helpers ──────────────────────────────────────────────────────────

function makeRun(overrides: Partial<{ id: string; projectId: string; agentName: string; status: string }> = {}) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    agentName: overrides.agentName ?? "chat",
    projectId: overrides.projectId ?? "",
    status: (overrides.status ?? "success") as "success",
    startedAt: Date.now(),
    logs: [],
  };
}

async function clearMemories() {
  const pglite = getTestPglite();
  await pglite.exec("DELETE FROM memory_audit_log");
  await pglite.exec("DELETE FROM memories");
}

// ── Setup ────────────────────────────────────────────────────────────

let projectA: string;
let projectB: string;
let convA: string;
let convB: string;

beforeAll(async () => {
  await setupTestDb();

  const pA = await createProject({ name: "Integration A", path: "/tmp/int-a" });
  projectA = pA.id;
  const pB = await createProject({ name: "Integration B", path: "/tmp/int-b" });
  projectB = pB.id;

  const cA = await createConversation(projectA, { title: "Conv A" });
  convA = cA.id;
  const cB = await createConversation(projectB, { title: "Conv B" });
  convB = cB.id;

  // Seed messages in both conversations
  await createMessage(convA, { role: "user", content: "I prefer dark mode", parentMessageId: undefined });
  await createMessage(convA, { role: "assistant", content: "Noted!", parentMessageId: undefined });
  await createMessage(convB, { role: "user", content: "I use Vim for everything", parentMessageId: undefined });
  await createMessage(convB, { role: "assistant", content: "Great choice!", parentMessageId: undefined });
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("Extract -> Store -> Retrieve pipeline", () => {
  test("extracted facts are stored and retrievable via hybridSearch", async () => {
    await clearMemories();

    const facts = [
      { content: "User prefers dark mode", category: "preferences", confidence: "high", messageIds: ["msg-1"] },
      { content: "User is building a healthcare SaaS", category: "biographical", confidence: "medium", messageIds: ["msg-2"] },
    ];
    // Set pi-ai complete() to return these facts
    mockExtractionResponse = JSON.stringify(facts);
    const run = makeRun({ projectId: projectA });

    // extractMemories now uses pi-ai internally (no llm parameter)
    await extractMemories(run, convA);

    // Verify stored
    const stored = await listMemories({ projectId: projectA });
    expect(stored.length).toBeGreaterThanOrEqual(2);
    const darkMode = stored.find((m) => m.content === "User prefers dark mode");
    expect(darkMode).toBeDefined();
    expect(darkMode!.category).toBe("preferences");

    // Verify retrievable via hybrid search
    const queryEmb = await generateEmbedding("dark mode preference");
    const results = await hybridSearch("dark mode", queryEmb, { projectId: projectA });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const match = results.find((r) => r.content === "User prefers dark mode");
    expect(match).toBeDefined();
    expect(match!.rrfScore).toBeGreaterThan(0);
  });
});

describe("Extract -> Store -> Inject into system prompt", () => {
  test("extracted facts appear in built system prompt", async () => {
    await clearMemories();

    const facts = [
      { content: "User loves functional programming", category: "technical", confidence: "high", messageIds: ["msg-10"] },
    ];
    mockExtractionResponse = JSON.stringify(facts);
    const run = makeRun({ projectId: projectA });

    await extractMemories(run, convA);

    const result = await buildSystemPromptWithMemories(
      "Base prompt.",
      "functional programming",
      projectA,
    );

    expect(result.systemPrompt).toContain("## Relevant Memories");
    expect(result.systemPrompt).toContain("User loves functional programming");
    expect(result.systemPrompt).toStartWith("Base prompt.");
    expect(result.memoriesUsed.length).toBeGreaterThanOrEqual(1);
    const injected = result.memoriesUsed.find((m) => m.content === "User loves functional programming");
    expect(injected).toBeDefined();
    expect(injected!.id).toBeDefined();
  });
});

describe("Dedup across extractions", () => {
  test("similar fact from second conversation updates existing memory instead of duplicating", async () => {
    // Clear memories first
    await clearMemories();

    // Extract from conversation A
    const factsA = [
      { content: "User prefers dark mode", category: "preferences", confidence: "medium", messageIds: ["msg-a1"] },
    ];
    mockExtractionResponse = JSON.stringify(factsA);
    await extractMemories(makeRun({ projectId: projectA }), convA);

    const countAfterFirst = (await listMemories()).length;
    expect(countAfterFirst).toBe(1);

    // Extract similar fact from conversation B (same text = same embedding = dedup hit)
    const factsB = [
      { content: "User prefers dark mode", category: "preferences", confidence: "high", messageIds: ["msg-b1"] },
    ];
    mockExtractionResponse = JSON.stringify(factsB);
    await extractMemories(makeRun({ projectId: projectA }), convB);

    const countAfterSecond = (await listMemories()).length;
    // Dedup should have updated, not inserted
    expect(countAfterSecond).toBe(1);

    // The surviving memory should have high confidence (from the update)
    const all = await listMemories();
    expect(all[0]!.confidence).toBe("high");
  });
});

describe("Project isolation", () => {
  test("hybridSearch with isolateToProject only returns matching project memories", async () => {
    await clearMemories();

    // Extract into project A
    const factsA = [
      { content: "Project A uses React", category: "technical", confidence: "high", messageIds: ["msg-pa"] },
    ];
    mockExtractionResponse = JSON.stringify(factsA);
    await extractMemories(
      makeRun({ projectId: projectA }),
      convA,
    );

    // Extract into project B
    const factsB = [
      { content: "Project B uses Vue", category: "technical", confidence: "high", messageIds: ["msg-pb"] },
    ];
    mockExtractionResponse = JSON.stringify(factsB);
    await extractMemories(
      makeRun({ projectId: projectB }),
      convB,
    );

    // Verify both exist
    const allMemories = await listMemories();
    expect(allMemories.length).toBe(2);

    // Search with isolation for project A
    const embA = await generateEmbedding("React framework");
    const resultsA = await hybridSearch("React", embA, {
      projectId: projectA,
      isolateToProject: true,
    });

    // Only project A memory should appear
    expect(resultsA.length).toBe(1);
    expect(resultsA[0]!.content).toBe("Project A uses React");
    expect(resultsA[0]!.projectId).toBe(projectA);
  });
});

describe("Memory-disabled toggle", () => {
  test("buildSystemPromptWithMemories returns base prompt when disabled", async () => {
    await upsertSetting("global:memoryEnabled", false);

    const result = await buildSystemPromptWithMemories("Base prompt.", "anything", projectA);

    expect(result.systemPrompt).toBe("Base prompt.");
    expect(result.memoriesUsed).toEqual([]);

    await deleteSetting("global:memoryEnabled");
  });

  test("extractMemories skips extraction when disabled", async () => {
    await upsertSetting("global:memoryEnabled", false);

    await clearMemories();

    const facts = [{ content: "Should not be stored", category: "preferences", confidence: "high", messageIds: ["msg-x"] }];
    mockExtractionResponse = JSON.stringify(facts);
    await extractMemories(
      makeRun({ projectId: projectA }),
      convA,
    );

    const stored = await listMemories();
    expect(stored).toHaveLength(0);

    await deleteSetting("global:memoryEnabled");
  });
});
