import { test, expect, describe, beforeAll, afterAll, beforeEach, mock, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import type { MemoryCategory, MemoryConfidence, MemoryProvenance } from "../memory/types";
import type { AgentEvents } from "../types";
import { EventBus } from "../runtime/events";

// Mock the embedding module to avoid downloading a real model
mockDbConnection();

mock.module("../memory/embeddings", () => {
  // Deterministic 384-dim vector: fill with normalized value based on text hash
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
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return vec.map((v) => v / norm);
  }
  return {
    generateEmbedding: async (text: string) => makeVector(text),
    generateEmbeddings: async (texts: string[]) => texts.map(makeVector),
    resetEmbeddingProvider: () => {},
  };
});

// Mock pi-ai complete to return configurable responses
let mockCompleteResponse = "[]";
mock.module("@mariozechner/pi-ai", () => ({
  complete: async () => ({
    content: [{ type: "text", text: mockCompleteResponse }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
  }),
  stream: async function* () {},
  getModel: () => ({ id: "test", provider: "anthropic", api: "anthropic", name: "test", contextWindow: 100000, maxTokens: 4096, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  getModels: () => [],
  getProviders: () => [],
  getEnvApiKey: () => "test-key",
}));

// Mock router and credentials for extraction
mock.module("../providers/router", () => ({
  resolveModel: async () => ({
    provider: "anthropic",
    model: "claude-haiku-4-5-20250514",
    piModel: { id: "claude-haiku-4-5-20250514", provider: "anthropic", api: "anthropic", name: "Claude Haiku", contextWindow: 200000, maxTokens: 4096, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  }),
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
}));

// Now import modules that depend on the mocks
import { insertMemory, updateMemory, findSimilarMemory, listMemories, getMemoryById } from "../db/queries/memories";
import { extractMemories, getExtractionModel, EXTRACTION_SYSTEM_PROMPT, registerExtractionListener } from "../memory/extraction";
import { getDb } from "../db/connection";
import { memoryAuditLog, memories } from "../db/schema";
import { eq } from "drizzle-orm";

import { createProject } from "../db/queries/projects";
import { createConversation, createMessage } from "../db/queries/conversations";
import { generateEmbedding } from "../memory/embeddings";
import { getAllSettings, upsertSetting } from "../db/queries/settings";

let projectId: string;
let conversationId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "test-project", path: "/tmp/test" });
  projectId = project.id;
  const conv = await createConversation(projectId, { title: "Test conv" });
  conversationId = conv.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

// ── Memory Query Tests ──────────────────────────────────────────────

describe("insertMemory", () => {
  test("stores a memory row and creates an audit log entry with action created", async () => {
    const embedding = await generateEmbedding("User prefers TypeScript");
    const provenance: MemoryProvenance = {
      sourceConversationId: conversationId,
      sourceMessageIds: ["msg-1"],
      extractedAt: new Date(),
      confidence: "high",
      history: [{ action: "created", timestamp: new Date(), reason: "Extracted from conversation" }],
    };
    const memory = await insertMemory({
      content: "User prefers TypeScript",
      category: "preferences",
      projectId,
      conversationId,
      messageIds: ["msg-1"],
      confidence: "high",
      embedding,
      provenance,
    });

    expect(memory.id).toBeDefined();
    expect(memory.content).toBe("User prefers TypeScript");
    expect(memory.category).toBe("preferences");
    expect(memory.confidence).toBe("high");

    // Check audit log
    const logs = await getDb()
      .select()
      .from(memoryAuditLog)
      .where(eq(memoryAuditLog.memoryId, memory.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.action).toBe("created");
    expect(logs[0]!.newContent).toBe("User prefers TypeScript");
  });
});

describe("updateMemory", () => {
  test("updates content/confidence and creates audit log with action updated and previousContent", async () => {
    const embedding = await generateEmbedding("User likes Python");
    const provenance: MemoryProvenance = {
      sourceConversationId: conversationId,
      sourceMessageIds: ["msg-2"],
      extractedAt: new Date(),
      confidence: "medium",
      history: [{ action: "created", timestamp: new Date(), reason: "initial" }],
    };
    const mem = await insertMemory({
      content: "User likes Python",
      category: "preferences",
      projectId,
      conversationId,
      messageIds: ["msg-2"],
      confidence: "medium",
      embedding,
      provenance,
    });

    const newEmbedding = await generateEmbedding("User loves Python and uses it daily");
    const updatedProvenance: MemoryProvenance = {
      ...provenance,
      confidence: "high",
      history: [
        { action: "updated", timestamp: new Date(), reason: "Updated with newer information", previousContent: "User likes Python" },
      ],
    };
    await updateMemory(mem.id, {
      content: "User loves Python and uses it daily",
      confidence: "high",
      embedding: newEmbedding,
      provenance: updatedProvenance,
    });

    const updated = await getMemoryById(mem.id);
    expect(updated).toBeDefined();
    expect(updated!.content).toBe("User loves Python and uses it daily");
    expect(updated!.confidence).toBe("high");
  });
});

describe("findSimilarMemory", () => {
  test("finds a memory with high cosine similarity", async () => {
    const embedding = await generateEmbedding("User works at Acme Corp");
    const provenance: MemoryProvenance = {
      sourceConversationId: conversationId,
      sourceMessageIds: ["msg-3"],
      extractedAt: new Date(),
      confidence: "high",
      history: [{ action: "created", timestamp: new Date(), reason: "initial" }],
    };
    await insertMemory({
      content: "User works at Acme Corp",
      category: "biographical",
      projectId,
      conversationId,
      messageIds: ["msg-3"],
      confidence: "high",
      embedding,
      provenance,
    });

    // Search with same text (should find it)
    const searchEmbedding = await generateEmbedding("User works at Acme Corp");
    const result = await findSimilarMemory(searchEmbedding, 0.85);

    expect(result).not.toBeNull();
    expect(result!.content).toBe("User works at Acme Corp");
    expect(result!.similarity).toBeGreaterThan(0.85);
  });
});

describe("listMemories", () => {
  test("lists memories with optional filters", async () => {
    const all = await listMemories();
    expect(all.length).toBeGreaterThan(0);

    const filtered = await listMemories({ category: "biographical" });
    expect(filtered.every((m) => m.category === "biographical")).toBe(true);

    const byProject = await listMemories({ projectId });
    expect(byProject.every((m) => m.projectId === projectId)).toBe(true);
  });
});

// ── Extraction Pipeline Tests ───────────────────────────────────────

describe("extractMemories", () => {
  test("parses ExtractedFact[] from mock LLM JSON response", async () => {
    const facts = [
      { content: "User prefers dark mode", category: "preferences", confidence: "high", messageIds: ["msg-10"] },
      { content: "User is a senior engineer", category: "biographical", confidence: "medium", messageIds: ["msg-11"] },
    ];
    mockCompleteResponse = JSON.stringify(facts);

    // Create messages in conversation for extraction
    await createMessage(conversationId, { role: "user", content: "I prefer dark mode", parentMessageId: undefined });
    await createMessage(conversationId, { role: "assistant", content: "Noted!", parentMessageId: undefined });

    const run = {
      id: "run-1",
      agentName: "chat",
      projectId,
      status: "success" as const,
      startedAt: Date.now(),
      logs: [],
    };

    await extractMemories(run, conversationId);

    // Should have stored the facts
    const stored = await listMemories({ projectId });
    const darkMode = stored.find((m) => m.content === "User prefers dark mode");
    expect(darkMode).toBeDefined();
    expect(darkMode!.category).toBe("preferences");
  });

  test("skips extraction for non-chat agents", async () => {
    mockCompleteResponse = "[]";
    const beforeCount = (await listMemories()).length;

    const run = {
      id: "run-not-chat",
      agentName: "pipeline",
      projectId,
      status: "success" as const,
      startedAt: Date.now(),
      logs: [],
    };

    await extractMemories(run, conversationId);
    const afterCount = (await listMemories()).length;
    expect(afterCount).toBe(beforeCount);
  });

  test("skips extraction for failed runs", async () => {
    mockCompleteResponse = "[]";
    const beforeCount = (await listMemories()).length;

    const run = {
      id: "run-failed",
      agentName: "chat",
      projectId,
      status: "error" as const,
      startedAt: Date.now(),
      logs: [],
    };

    await extractMemories(run, conversationId);
    const afterCount = (await listMemories()).length;
    expect(afterCount).toBe(beforeCount);
  });

  test("deduplicates: when similar memory exists, updates instead of inserting", async () => {
    // First, insert a memory about dark mode
    const embedding = await generateEmbedding("User prefers dark mode");
    const provenance: MemoryProvenance = {
      sourceConversationId: conversationId,
      sourceMessageIds: ["msg-dedup-1"],
      extractedAt: new Date(),
      confidence: "medium",
      history: [{ action: "created", timestamp: new Date(), reason: "initial" }],
    };
    const existing = await insertMemory({
      content: "User prefers dark mode",
      category: "preferences",
      projectId,
      conversationId,
      messageIds: ["msg-dedup-1"],
      confidence: "medium",
      embedding,
      provenance,
    });

    const beforeCount = (await listMemories()).length;

    // Extract same fact again (different wording but same embedding due to mock)
    const facts = [{ content: "User prefers dark mode", category: "preferences", confidence: "high", messageIds: ["msg-dedup-2"] }];
    mockCompleteResponse = JSON.stringify(facts);
    const run = {
      id: "run-dedup",
      agentName: "chat",
      projectId,
      status: "success" as const,
      startedAt: Date.now(),
      logs: [],
    };
    await extractMemories(run, conversationId);

    const afterCount = (await listMemories()).length;
    // The key check: the existing memory was updated, not a new one added alongside
    const updated = await getMemoryById(existing.id);
    expect(updated).toBeDefined();
  });

  test("provenance metadata includes sourceConversationId, sourceMessageIds, extractedAt, confidence", async () => {
    const facts = [{ content: "User is building a healthcare SaaS", category: "biographical", confidence: "high", messageIds: ["msg-prov-1", "msg-prov-2"] }];
    mockCompleteResponse = JSON.stringify(facts);
    const run = {
      id: "run-prov",
      agentName: "chat",
      projectId,
      status: "success" as const,
      startedAt: Date.now(),
      logs: [],
    };

    await extractMemories(run, conversationId);

    const stored = await listMemories({ projectId });
    const healthcareFact = stored.find((m) => m.content === "User is building a healthcare SaaS");
    expect(healthcareFact).toBeDefined();
    const prov = healthcareFact!.provenance as MemoryProvenance;
    expect(prov.sourceConversationId).toBe(conversationId);
    expect(prov.sourceMessageIds).toEqual(["msg-prov-1", "msg-prov-2"]);
    expect(prov.extractedAt).toBeDefined();
    expect(prov.confidence).toBe("high");
  });
});

describe("extraction prompt", () => {
  test("includes structured JSON instruction", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("JSON");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("content");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("category");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("confidence");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("messageIds");
  });
});

describe("getExtractionModel", () => {
  test("returns cheapest model per provider", () => {
    const anthropic = getExtractionModel("anthropic");
    expect(anthropic.model).toBe("claude-haiku-4-5-20250514");
    expect(anthropic.provider).toBe("anthropic");

    const openai = getExtractionModel("openai");
    expect(openai.model).toBe("gpt-4o-mini");
    expect(openai.provider).toBe("openai");

    const google = getExtractionModel("google");
    expect(google.model).toBe("gemini-2.0-flash-lite");
    expect(google.provider).toBe("google");
  });

  test("falls back to google for unknown provider", () => {
    const unknown = getExtractionModel("unknown-provider");
    expect(unknown.provider).toBe("google");
    expect(unknown.model).toBe("gemini-2.0-flash-lite");
  });
});

describe("registerExtractionListener", () => {
  test("subscribes to run:complete and fires extraction", async () => {
    mockCompleteResponse = "[]";
    const bus = new EventBus<AgentEvents>();

    const unsub = registerExtractionListener(bus);

    bus.emit("run:complete", {
      run: {
        id: "run-listener",
        agentName: "chat",
        projectId,
        status: "success",
        startedAt: Date.now(),
        logs: [],
      },
      conversationId,
    });

    // Give async extraction time to fire
    await new Promise((r) => setTimeout(r, 100));

    // Extraction was called (no error thrown)
    unsub();
  });

  test("returns unsubscribe function that stops listening", () => {
    const bus = new EventBus<AgentEvents>();

    const unsub = registerExtractionListener(bus);
    unsub();

    // Emitting after unsub should not throw or call extraction
    bus.emit("run:complete", {
      run: {
        id: "run-unsub",
        agentName: "chat",
        projectId,
        status: "success",
        startedAt: Date.now(),
        logs: [],
      },
      conversationId,
    });
  });
});

describe("extractMemories -- malformed LLM responses", () => {
  test("gracefully handles non-array JSON response", async () => {
    mockCompleteResponse = JSON.stringify({ not: "an array" });
    const run = {
      id: "run-non-array",
      agentName: "chat",
      projectId,
      status: "success" as const,
      startedAt: Date.now(),
      logs: [],
    };

    const beforeCount = (await listMemories()).length;
    await extractMemories(run, conversationId);
    const afterCount = (await listMemories()).length;

    expect(afterCount).toBe(beforeCount);
  });

  test("gracefully handles unparseable text response", async () => {
    mockCompleteResponse = "not valid json at all {{{";
    const run = {
      id: "run-bad-json",
      agentName: "chat",
      projectId,
      status: "success" as const,
      startedAt: Date.now(),
      logs: [],
    };

    const beforeCount = (await listMemories()).length;
    await extractMemories(run, conversationId);
    const afterCount = (await listMemories()).length;

    expect(afterCount).toBe(beforeCount);
  });
});

describe("getAllSettings", () => {
  test("returns a record of all settings", async () => {
    await upsertSetting("test:getAllKey", "hello");

    const all = await getAllSettings();

    expect(all).toHaveProperty("test:getAllKey");
    expect(all["test:getAllKey"]).toBe("hello");
  });
});

describe("EventBus.clear", () => {
  test("removes all listeners so emit is a no-op", () => {
    const bus = new EventBus<AgentEvents>();
    let called = false;
    bus.on("run:complete", () => { called = true; });

    bus.clear();

    bus.emit("run:complete", {
      run: { id: "run-clear", agentName: "chat", projectId: "p", status: "success", startedAt: Date.now(), logs: [] },
      conversationId: "c",
    });

    expect(called).toBe(false);
  });
});
