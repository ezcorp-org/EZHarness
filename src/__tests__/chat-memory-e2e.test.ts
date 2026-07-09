import { mock, test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";
import { EMBEDDING_DIMENSIONS } from "../memory/types";

// Generate a fixed embedding vector for testing
const FIXED_EMBEDDING = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1.0 : 0.0));

mockDbConnection();

// Mock embedding generation to return fixed vector (avoids onnxruntime dependency)
mock.module("../memory/embeddings", () => ({
  generateEmbedding: async () => FIXED_EMBEDDING,
}));

// Capture what system prompt the Agent is constructed with
let capturedSystemPrompt: string = "";
let _capturedAgentOpts: any = null;

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

mock.module("@earendil-works/pi-ai", () => ({
  stream: () => ({ [Symbol.asyncIterator]: async function* () {}, result: async () => stubAssistantMessage() }),
  complete: async () => stubAssistantMessage(),
  getModel: () => ({ id: "test-model", provider: "anthropic" }),
  getModels: () => [],
  getProviders: () => ["anthropic", "openai", "google"],
  getEnvApiKey: () => undefined,
}));

mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    private _subs: any[] = [];
    private _opts: any;
    constructor(opts: any) {
      _capturedAgentOpts = opts;
      this._opts = opts;
      capturedSystemPrompt = opts.initialState?.systemPrompt ?? "";
    }
    subscribe(cb: any) { this._subs.push(cb); return () => {}; }
    abort() {}
    async prompt() {
      // Replicate pi-ai's request build enough to exercise the onPayload
      // hook: on anthropic-messages models the memory/KB tail is appended
      // there as a separate uncached trailing system block, so the full
      // wire-visible system content = initialState.systemPrompt + tail.
      const payload: any = {
        system: [{
          type: "text",
          text: this._opts.initialState?.systemPrompt ?? "",
          cache_control: { type: "ephemeral" },
        }],
      };
      await this._opts.onPayload?.(payload);
      capturedSystemPrompt = payload.system.map((b: any) => b.text).join("\n\n");
      // Emit text response
      for (const sub of this._subs) {
        sub({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "response",
            partial: stubAssistantMessage("response"),
          },
        });
      }
      const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      for (const sub of this._subs) {
        sub({ type: "turn_end", message: stubAssistantMessage("response", { usage }) });
      }
    }
  },
}));

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { createProject } from "../db/queries/projects";
import { createConversation } from "../db/queries/conversations";
import { getDb } from "../db/connection";
import { memories, knowledgeBaseFiles, knowledgeBaseChunks, users } from "../db/schema";
import type { AgentEvents } from "../types";

let projectId: string;
let ownerUserId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Memory E2E", path: "/tmp/memory-e2e" });
  projectId = project.id;
  // Memory injection is fail-closed per-user: only memories owned by the
  // conversation owner are injected. Seed an owner for both sides.
  const [user] = await getDb().insert(users).values({
    email: "memory-e2e@example.com",
    passwordHash: "x",
    name: "Memory E2E",
    role: "member",
  }).returning();
  ownerUserId = user!.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("Chat Memory Injection E2E", () => {
  test("relevant memories are injected into system prompt", async () => {
    // Insert a memory with known embedding
    const db = getDb();
    await db.insert(memories).values({
      content: "The user prefers dark mode for all interfaces",
      category: "preferences",
      projectId,
      userId: ownerUserId,
      confidence: "high",
      status: "active",
      embedding: FIXED_EMBEDDING,
    });

    const conv = await createConversation(projectId, { title: "Memory Injection Test", userId: ownerUserId });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);

    capturedSystemPrompt = "";
    await executor.streamChat(conv.id, "What are my preferences?", { projectId });

    // The system prompt captured from Agent constructor should contain injected memories
    expect(capturedSystemPrompt).toContain("Relevant Memories");
    expect(capturedSystemPrompt).toContain("dark mode");
  });

  test("KB chunks are injected alongside memories", async () => {
    const db = getDb();

    // Insert a KB file and chunk with known embedding
    const [kbFile] = await db.insert(knowledgeBaseFiles).values({
      projectId,
      filename: "guide.md",
      mimeType: "text/markdown",
      fileSize: 100,
      chunkCount: 1,
      status: "ready",
    }).returning();

    await db.insert(knowledgeBaseChunks).values({
      fileId: kbFile!.id,
      content: "API rate limit is 1000 requests per minute",
      chunkIndex: 0,
      embedding: FIXED_EMBEDDING,
    });

    const conv = await createConversation(projectId, { title: "KB Injection Test" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);

    capturedSystemPrompt = "";
    await executor.streamChat(conv.id, "What is the rate limit?", { projectId });

    expect(capturedSystemPrompt).toContain("Knowledge Base");
    expect(capturedSystemPrompt).toContain("rate limit");
    expect(capturedSystemPrompt).toContain("guide.md");
  });
});
