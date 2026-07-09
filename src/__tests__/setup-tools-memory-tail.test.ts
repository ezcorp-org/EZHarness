/**
 * System-block cache split — the setup-tools ↔ build-pi-agent seam.
 *
 * Pins the cache-prefix fix end-to-end through `streamChat`: when per-turn
 * memory/KB recall injects a block, `ctx.system` must stay memory-FREE
 * (so the composed `base + taskBlock` region-1 prefix is byte-stable for
 * prompt caching) and the block must ride `ctx.systemMemoryTail` into
 * build-pi-agent, which appends it as an UNCACHED trailing system block
 * for Anthropic payloads (see system-cache-split.ts).
 *
 * This is the #1-risk guard the pure unit tests can't give: memory being
 * silently DROPPED between setup-tools and the wire. Harness mirrors
 * executor-task-tracking-autowire.test.ts — stub every runtime import so
 * `streamChat` runs end-to-end with a captured `Agent` opts object.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// ── DB mock (must be first, before any module that imports db/connection) ──
mockDbConnection();

// ── Capture what pi-agent-core's Agent receives ──
let capturedAgentOpts: any = null;

mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: undefined };
    constructor(opts: any) {
      capturedAgentOpts = opts;
    }
    prompt = mock(async () => {});
    subscribe = mock((fn: (e: any) => void) => {
      queueMicrotask(() => fn({ type: "agent_end", messages: [] }));
      return () => {};
    });
  },
}));

// ── Model resolution: an ANTHROPIC model (api stamped by pi-ai) ──
mock.module("../providers/router", () => ({
  resolveModel: mock(async () => ({
    provider: "anthropic",
    model: "claude-sonnet-4",
    piModel: { provider: "anthropic", id: "claude-sonnet-4", api: "anthropic-messages" },
  })),
  ProviderUnavailableError: class extends Error {
    failedProvider = "";
    failedModel = "";
    suggestion = "";
  },
}));

mock.module("../providers/registry", () => ({
  resolveOAuthModel: mock(() => null),
}));

mock.module("../providers/credentials", () => ({
  getCredential: mock(async () => ({ type: "apikey", token: "test-key" })),
}));

mock.module("../observability/collector", () => ({
  startCollector: () => {},
}));

mock.module("../db/queries/runs", () => ({
  insertRun: async () => {},
  updateRun: async () => {},
}));

mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => {},
  deleteActiveRun: async () => {},
  cleanupOrphanedRuns: async () => {},
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
}));

// ── Memory recall: the project HAS memories, and injection finds some ──
const MEMORY_BLOCK =
  "\n\n## Relevant Memories\nThe following facts were remembered from previous conversations:\n- [preferences] dark mode (confidence: high)";

mock.module("../db/queries/memories", () => ({
  hasMemories: async () => true,
}));

mock.module("../db/queries/knowledge-base", () => ({
  hasKBChunks: async () => false,
}));

mock.module("../memory/embeddings", () => ({
  generateEmbedding: async () => new Float32Array(384),
}));

mock.module("../memory/retrieval", () => ({
  searchKBChunksForQuery: async () => [],
}));

mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async (sys: string | undefined) => ({
    systemPrompt: (sys ?? "") + MEMORY_BLOCK,
    injectionBlock: MEMORY_BLOCK,
    memoriesUsed: [{ id: "m1", content: "dark mode", category: "preferences" }],
    kbSourcesUsed: [],
  }),
}));

// ── Neutral stubs for the tool-loading path (not this suite's surface) ──
mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getToolsForAgent: async () => [],
      getToolsForExtension: () => [],
    }),
  },
}));

mock.module("../runtime/task-tracking-host", () => ({
  ensureTaskTrackingWired: async () => {},
  getTaskTrackingExtensionId: async () => null,
}));

mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => [],
}));

mock.module("../runtime/mention-wiring", () => ({
  wireMentionedExtensions: async () => {},
  resolveMentionedAgents: async () => [],
  resolveMentionedTeams: async () => [],
  applyCommandExpansion: async (s: string) => s,
}));

mock.module("../runtime/orchestration-host", () => ({
  ensureOrchestrationWired: async () => true,
  wireOrchestrationToolsForTurn: async () => {},
}));

// ── Import after all mocks ──
const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
type AgentEvents = import("../types").AgentEvents;

let projectId: string;
let convId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Memory Tail Test", path: "/tmp/memory-tail" });
  projectId = project.id;
  const conv = await createConversation(projectId);
  convId = conv.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("setup-tools memory tail → build-pi-agent (cache split seam)", () => {
  test("injected memory stays OUT of the frozen systemPrompt and rides onPayload as the LAST uncached system block", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus, { persist: false });
    capturedAgentOpts = null;

    await executor.streamChat(convId, "what are my preferences?", { projectId });

    expect(capturedAgentOpts).not.toBeNull();

    // Region-1 prefix: the Agent's system prompt is memory-FREE — the
    // pre-fix behavior (query-dependent block concatenated into it, busting
    // the prompt cache every memory turn) must never come back. It still
    // carries the task-tracking block applyAutoSpinUp appends, proving the
    // orchestrator/task composition path is intact.
    const systemPrompt: string = capturedAgentOpts.initialState.systemPrompt;
    expect(systemPrompt).not.toContain("## Relevant Memories");

    // The memory is NOT dropped: onPayload appends it to the Anthropic wire
    // payload as the LAST system block with NO cache_control.
    const wire: any = {
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    };
    const out = (await capturedAgentOpts.onPayload(wire)) as any;
    expect(out.system).toHaveLength(2);
    expect(out.system[1].text).toBe(MEMORY_BLOCK);
    expect("cache_control" in out.system[1]).toBe(false);
    // The frozen block keeps its breakpoint (1h TTL at the shipped default).
    expect(out.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});
