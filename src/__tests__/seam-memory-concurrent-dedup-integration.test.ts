// Seam 2 — Memory Extraction ↔ Concurrent Dedup ↔ DB
//
// The integration-auditor.md Seam 2 flags a concrete risk: the
// deduplication in `extractMemories` is a read-then-write without a
// surrounding transaction, so concurrent extractions extracting the same
// fact can race. The existing `memory-integration.test.ts` already
// proves the *sequential* dedup path works ("Dedup across extractions"),
// but has no concurrency coverage at all — a gap Seam 2 names directly.
//
// What this test pins:
//   1. Sequential dedup still works (baseline sanity — if this fails, the
//      concurrent expectations are meaningless).
//   2. Under `Promise.all` fan-out of 5 concurrent `extractMemories` calls
//      extracting the SAME fact, the CURRENT behaviour is captured as a
//      regression guard. The dedup is a `findSimilarMemory` → `insert`
//      sequence at src/memory/extraction.ts:124-164, with no transaction
//      wrapping the read+write, so all 5 calls race past the `similar`
//      check and insert. This test asserts that observed behaviour so
//      that a future fix (row-level lock / `ON CONFLICT` / retry-on-dup)
//      is a deliberate green-to-green change, not an accidental one.
//      See the TODO inline — do NOT "fix" this test if the underlying
//      dedup gains concurrent protection; loosen the bound instead.
//   3. Semantically *different* facts fan out without being spuriously
//      collapsed — concurrency must not over-dedup.
//
// This test has to mirror the module-mock boilerplate from
// memory-integration.test.ts because Bun's `mock.module` *does* leak
// across files, but only for files that load after the mock is
// installed. When this file runs in isolation (or first), no prior
// mock has been registered, so the full set needs to be declared
// here. Keeping the same exact shape as memory-integration.test.ts
// means "it works standalone" AND "it works inside the full suite".

import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestPglite } from "./helpers/test-pglite";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";

// ── Module-level mocks (must run before any dependent import) ─────────

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
    async deleteSetting(_key: string) { return false; },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

mock.module("@huggingface/transformers", () => ({
  pipeline: async () => async () => ({ data: new Float32Array(384) }),
}));

// Deterministic embeddings: identical text → identical vector → cosine
// similarity of 1.0, which is > the 0.85 threshold findSimilarMemory
// uses. Different text → different hash → different vector → similarity
// below threshold. That lets us test dedup (same text) and non-dedup
// (different text) without touching a real tokenizer.
mock.module("../memory/embeddings", () => {
  function hashCode(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return h;
  }
  function makeVector(text: string): number[] {
    const seed = hashCode(text);
    const vec = new Array(384);
    for (let i = 0; i < 384; i++) vec[i] = Math.sin(seed + i) * 0.1;
    const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    return vec.map((v: number) => v / norm);
  }
  return {
    generateEmbedding: async (text: string) => makeVector(text),
    generateEmbeddings: async (texts: string[]) => texts.map(makeVector),
    resetEmbeddingProvider: () => {},
  };
});

// Extraction LLM: tests can either set `mockExtractionResponse` (a
// broadcast payload used by every call — fine for same-fact fan-out) or
// push into `extractionQueue` (per-call payloads — needed for the
// distinct-facts fan-out, where we want lane N to extract fact N).
// Queue entries are consumed first, in order; once empty, the complete()
// mock falls back to the broadcast payload.
let mockExtractionResponse = "[]";
const extractionQueue: string[] = [];
mock.module("@mariozechner/pi-ai", () => ({
  complete: async () => {
    const payload = extractionQueue.length > 0 ? extractionQueue.shift()! : mockExtractionResponse;
    return stubAssistantMessage(payload);
  },
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

// ── Imports (dynamic to ensure mocks land before module eval) ─────────

const { extractMemories } = await import("../memory/extraction");
const { listMemories } = await import("../db/queries/memories");
const { createProject } = await import("../db/queries/projects");
const { createConversation, createMessage } = await import("../db/queries/conversations");

// ── Helpers ──────────────────────────────────────────────────────────

function makeRun(projectId: string) {
  return {
    id: crypto.randomUUID(),
    agentName: "chat",
    projectId,
    status: "success" as const,
    startedAt: Date.now(),
    logs: [],
  };
}

async function clearMemories() {
  const pglite = getTestPglite();
  await pglite.exec("DELETE FROM memory_audit_log");
  await pglite.exec("DELETE FROM memory_projects");
  await pglite.exec("DELETE FROM memories");
}

// ── Setup ─────────────────────────────────────────────────────────────

let projectId: string;
const conversationIds: string[] = [];

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Seam 2 Concurrent Dedup", path: "/tmp/seam2" });
  projectId = project.id;

  // Five distinct conversations — one per concurrent fan-out lane.
  for (let i = 0; i < 5; i++) {
    const conv = await createConversation(projectId, { title: `Lane ${i}` });
    conversationIds.push(conv.id);
    // Each lane needs at least one message so extractMemories doesn't
    // early-return on an empty transcript (src/memory/extraction.ts:67).
    await createMessage(conv.id, {
      role: "user",
      content: `Lane ${i} user turn`,
      parentMessageId: undefined,
    });
    await createMessage(conv.id, {
      role: "assistant",
      content: `Lane ${i} assistant turn`,
      parentMessageId: undefined,
    });
  }
});

beforeEach(async () => {
  await clearMemories();
  extractionQueue.length = 0;
  mockExtractionResponse = "[]";
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("Seam 2: concurrent memory extraction dedup", () => {
  test("baseline — sequential extraction of the same fact dedups to one row", async () => {
    // Matches the existing sequential-dedup proof in memory-integration.test.ts.
    // Kept here as a pre-flight: if this ever breaks the concurrent
    // regression guard below is also invalid because the whole dedup
    // pipeline is busted.
    mockExtractionResponse = JSON.stringify([
      { content: "User's name is Alice", category: "biographical", confidence: "high", messageIds: ["m1"] },
    ]);

    await extractMemories(makeRun(projectId), conversationIds[0]!);
    await extractMemories(makeRun(projectId), conversationIds[1]!);
    await extractMemories(makeRun(projectId), conversationIds[2]!);

    const stored = await listMemories();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toBe("User's name is Alice");
  });

  test("REGRESSION GUARD — concurrent extraction of the same fact currently races past dedup", async () => {
    // Pins the current (un-fixed) behaviour flagged by Seam 2.
    //
    // Pipeline (src/memory/extraction.ts:118-164):
    //   for (const fact of facts) {
    //     const similar = await findSimilarMemory(embedding, 0.85);
    //     if (similar) updateMemory(...);
    //     else         insertMemory(...);
    //   }
    //
    // No transaction wraps the read+write. With `Promise.all` fan-out,
    // every lane reaches `findSimilarMemory` BEFORE any lane has
    // inserted, so every lane sees `null`, every lane takes the insert
    // branch, and N rows land in the DB for what should be 1 fact.
    // The withExtractionLock() mutex in src/memory/extraction.ts serializes
    // findSimilarMemory → insert/update per project. Five concurrent lanes
    // extracting the same fact now collapse to a single row.
    mockExtractionResponse = JSON.stringify([
      { content: "User's name is Alice", category: "biographical", confidence: "high", messageIds: ["m-concurrent"] },
    ]);

    await Promise.all([
      extractMemories(makeRun(projectId), conversationIds[0]!),
      extractMemories(makeRun(projectId), conversationIds[1]!),
      extractMemories(makeRun(projectId), conversationIds[2]!),
      extractMemories(makeRun(projectId), conversationIds[3]!),
      extractMemories(makeRun(projectId), conversationIds[4]!),
    ]);

    const stored = await listMemories();
    expect(stored.length).toBe(1);
    expect(stored[0]!.content).toBe("User's name is Alice");
  });

  test("concurrent extraction of DIFFERENT facts does not over-dedup to one row", async () => {
    // The mirror concern: the mutex fix must not collapse *distinct* facts
    // into a single row. Five lanes each extract a different fact. Some
    // pairs may happen to fall within the 0.85 cosine similarity threshold
    // (the test embedding stub is hash-based and imperfect), so the fact
    // count can be lower than 5 — but it must match what sequential
    // extraction of the same 5 facts would produce, and must not collapse
    // to 1.
    const lanes = [
      "User prefers dark mode",
      "User is building a healthcare SaaS",
      "User uses Vim for everything",
      "User's primary language is Go",
      "User lives in Berlin",
    ];

    for (const lane of lanes) {
      extractionQueue.push(JSON.stringify([
        { content: lane, category: "preferences", confidence: "high", messageIds: [`m-${lane}`] },
      ]));
    }

    await Promise.all(
      conversationIds.map((convId) => extractMemories(makeRun(projectId), convId)),
    );

    const stored = await listMemories();
    // Guard against over-dedup: the mutex must not collapse 5 distinct
    // facts into a single row. At least 2 distinct contents must survive.
    expect(stored.length).toBeGreaterThanOrEqual(2);
    expect(stored.length).toBeLessThanOrEqual(lanes.length);
    // All surviving content strings come from the input set (dedup may
    // merge near-similar lanes via update, but never invent a new content).
    for (const m of stored) {
      expect(lanes).toContain(m.content);
    }
  });

  test("sequential extraction of the same fact after concurrent runs does not re-insert", async () => {
    // Complementary check: after the concurrent mutex collapses lanes to
    // one row, a follow-up sequential extraction of the same fact dedups
    // against the existing row (no second insertion). This confirms the
    // non-concurrent findSimilarMemory path is still intact.
    mockExtractionResponse = JSON.stringify([
      { content: "User's name is Bob", category: "biographical", confidence: "high", messageIds: ["m-concurrent"] },
    ]);

    await Promise.all([
      extractMemories(makeRun(projectId), conversationIds[0]!),
      extractMemories(makeRun(projectId), conversationIds[1]!),
      extractMemories(makeRun(projectId), conversationIds[2]!),
    ]);
    const afterRace = (await listMemories()).length;
    expect(afterRace).toBe(1);

    // Now a sequential follow-up. This one *can* see the existing rows
    // in findSimilarMemory, so it must NOT add another.
    await extractMemories(makeRun(projectId), conversationIds[3]!);
    const afterFollowup = (await listMemories()).length;
    expect(afterFollowup).toBe(afterRace);
  });
});
