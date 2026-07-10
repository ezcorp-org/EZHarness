/**
 * Executor wiring coverage for deterministic extension pre-processing
 * (tasks/deterministic-preprocess.md, locked decision 3):
 *
 *   The runner fires inside setup-tools' 2c block, AFTER
 *   `wireMentionedExtensions`, reusing the conversation-extension
 *   ToolExecutor — and completes BEFORE the pi-agent is constructed, so
 *   the grounding note is present in the Agent's initialState
 *   systemPrompt and the `preprocess-result` rows are chained into the
 *   branch (user → row → assistant parent base) before any turn saves.
 *
 * Harness style mirrors executor-task-tracking-autowire.test.ts: stub
 * every provider/runtime import so `streamChat` runs end-to-end against
 * a real PGlite DB with a captured `Agent` opts object. The extension
 * registry + ToolExecutor are mocked; message/attachment persistence is
 * REAL so the row chain is asserted from the DB.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// ── DB mock (must be first, before any module that imports db/connection) ──
mockDbConnection();

// ── Capture what pi-agent-core's Agent receives ──
let capturedAgentOpts: any = null;

const mockPrompt = mock(async () => {});
const mockSubscribe = mock((fn: (e: any) => void) => {
  queueMicrotask(() => fn({ type: "agent_end", messages: [] }));
  return () => {};
});

mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: undefined };
    constructor(opts: any) {
      capturedAgentOpts = opts;
    }
    prompt = mockPrompt;
    subscribe = mockSubscribe;
  },
}));

// ── Stub providers / runs / memory (verbatim autowire-harness set) ──
mock.module("../providers/router", () => ({
  resolveModel: mock(async () => ({
    provider: "anthropic",
    model: "claude-sonnet-4",
    piModel: { provider: "anthropic", id: "claude-sonnet-4" },
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

// NOTE: ../db/queries/runs is deliberately NOT mocked — the persisted
// `preprocess-result` rows carry `runId`, whose FK references runs.id,
// so the real `insertRun` must write the run row into PGlite first
// (mirrors production, where insertRun runs before setupTools).

mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => {},
  deleteActiveRun: async () => {},
  cleanupOrphanedRuns: async () => {},
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
}));

mock.module("../memory/embeddings", () => ({
  generateEmbedding: async () => new Float32Array(384),
}));

mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async (sys: string | undefined) => ({
    systemPrompt: sys ?? "",
    memoriesUsed: [],
  }),
}));

// ── Extension registry: one fake extension declaring a preprocessor ──
const SCANNER_MANIFEST = {
  schemaVersion: 2 as const,
  name: "graded-card-scanner",
  version: "1.0.0",
  description: "t",
  author: { name: "t" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "identify_slab",
      description: "identify a slab photo",
      inputSchema: { type: "object" },
      cardType: "grade-delta-chart",
    },
  ],
  preprocessors: [
    { tool: "identify_slab", accepts: ["image/png", "image/jpeg"] },
  ],
  permissions: {},
};

// Flipped per-test: manifest served WITHOUT preprocessors.
let serveManifestWithoutPreprocessors = false;

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getToolsForAgent: async () => [],
      getToolsForExtension: (extensionId: string) => {
        if (extensionId !== "ext-scanner") return [];
        return [
          {
            name: "graded-card-scanner__identify_slab",
            originalName: "identify_slab",
            description: "identify a slab photo",
            inputSchema: { type: "object" },
          },
        ];
      },
      getManifest: (extensionId: string) => {
        if (extensionId !== "ext-scanner") return undefined;
        if (serveManifestWithoutPreprocessors) {
          const { preprocessors: _omit, ...rest } = SCANNER_MANIFEST;
          return rest;
        }
        return SCANNER_MANIFEST;
      },
    }),
  },
}));

// ── ToolExecutor: record dispatches; result/throw is per-test knob ──
const toolCalls: Array<{
  toolName: string;
  input: Record<string, unknown>;
  conversationId: string;
  messageId: string | null;
}> = [];
// Interleaved op log across ALL ToolExecutor instances — pins ordering
// contracts (e.g. setCurrentUserId(<owner>) BEFORE the preprocess
// dispatch) that per-call arrays can't express.
const executorOps: string[] = [];
let toolResultMode: "success" | "isError" | "throw" = "success";

mock.module("../extensions/tool-executor", () => ({
  ToolExecutor: class {
    setStateMediator() {}
    setExecutor() {}
    setSpawnQuota() {}
    setCurrentUserId(userId: string) {
      executorOps.push(`setCurrentUserId:${userId}`);
    }
    setCurrentModel() {}
    setCurrentProvider() {}
    setArgsResolver() {}
    setCurrentAgentConfigId() {}
    setPendingPermissionGate() {}
    async executeToolCall(
      toolName: string,
      input: Record<string, unknown>,
      conversationId: string,
      messageId: string | null,
    ) {
      executorOps.push(`executeToolCall:${toolName}`);
      toolCalls.push({ toolName, input, conversationId, messageId });
      if (toolResultMode === "throw") throw new Error("simulated PDP denial");
      if (toolResultMode === "isError") {
        return { content: [{ type: "text", text: "decode failed" }], isError: true };
      }
      return {
        content: [{ type: "text", text: '{"cert":"49392223","grader":"PSA"}' }],
        isError: false,
      };
    }
  },
  extensionToAgentTool: (tool: { name: string; description: string; inputSchema: unknown }) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    execute: async () => ({
      content: [{ type: "text" as const, text: "(stub)" }],
      details: {},
    }),
  }),
}));

// Mention-wiring: no-op (the mention parser isn't this suite's surface).
mock.module("../runtime/mention-wiring", () => ({
  wireMentionedExtensions: async () => {},
  resolveMentionedAgents: async () => [],
  resolveMentionedTeams: async () => [],
  applyCommandExpansion: async (s: string) => s,
  stripEzActionTokens: (s: string) => ({ stripped: s, actions: [] }),
}));

// The conversation has the scanner extension wired.
mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => ["ext-scanner"],
}));

mock.module("../runtime/task-tracking-host", () => ({
  ensureTaskTrackingWired: async () => {},
  getTaskTrackingExtensionId: async () => null,
}));

mock.module("../runtime/orchestration-host", () => ({
  ensureOrchestrationWired: async () => true,
  wireOrchestrationToolsForTurn: async () => {},
}));

mock.module("../runtime/ask-user-host", () => ({
  ensureAskUserWired: async () => false,
  wireAskUserToolForTurn: async () => {},
}));

// ── Import after all mocks ──
const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { createProject } = await import("../db/queries/projects");
const { createConversation, createMessage, getMessages } = await import(
  "../db/queries/conversations"
);
const { createUser } = await import("../db/queries/users");
const { insertAttachment } = await import("../db/queries/attachments");
const { PREPROCESS_RESULT_ROLE } = await import("../runtime/stream-chat/preprocess");
type AgentEvents = import("../types").AgentEvents;

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Preprocess Wiring Test", path: "/tmp/pp-wiring" });
  projectId = project.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function createExecutor() {
  const bus = new EventBus<AgentEvents>();
  // persist: true — the preprocess block is gated on host.persist (the
  // cards are the user-facing contract); run-row writes are mocked above,
  // message/attachment writes hit the real PGlite.
  const executor = new AgentExecutor(new Map(), bus, { persist: true });
  return { executor, bus };
}

/** Seed a conversation + user message + one PNG attachment row. */
async function seedTurn(sizeBytes = 2048, ownerUserId?: string) {
  const conv = await createConversation(
    projectId,
    ownerUserId !== undefined ? { userId: ownerUserId } : undefined,
  );
  const userMsg = await createMessage(conv.id, {
    role: "user",
    content: "what is this slab worth? ![ext:graded-card-scanner]",
  });
  const attRow = await insertAttachment({
    messageId: userMsg.id,
    conversationId: conv.id,
    filename: "slab.png",
    mimeType: "image/png",
    sizeBytes,
    storagePath: "/tmp/pp-wiring/slab.png",
    kind: "image",
  });
  return { conv, userMsg, attRow };
}

function stagedFor(attRow: { id: string; filename: string; mimeType: string; storagePath: string }) {
  return [
    {
      id: attRow.id,
      filename: attRow.filename,
      mimeType: attRow.mimeType,
      storagePath: attRow.storagePath,
    },
  ];
}

describe("executor deterministic-preprocess wiring (setup-tools 2c)", () => {
  test("attachment + wired preprocessor → tool dispatched, row chained, system note grounds the turn", async () => {
    const { executor } = createExecutor();
    toolCalls.length = 0;
    capturedAgentOpts = null;
    toolResultMode = "success";
    const { conv, userMsg, attRow } = await seedTurn();

    await executor.streamChat(conv.id, "what is this slab worth?", {
      projectId,
      parentMessageId: userMsg.id,
      attachments: stagedFor(attRow),
    });

    // 1. Dispatch went through the (mocked) ToolExecutor with the
    //    REGISTERED namespaced name + the locked input contract.
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      toolName: "graded-card-scanner__identify_slab",
      input: {
        attachment: `ez-attachment://${attRow.id}`,
        filename: "slab.png",
        mimeType: "image/png",
      },
      conversationId: conv.id,
      messageId: null,
    });

    // 2. The preprocess-result row persisted, chained off the user msg.
    const rows = await getMessages(conv.id);
    const ppRows = rows.filter((m) => m.role === PREPROCESS_RESULT_ROLE);
    expect(ppRows).toHaveLength(1);
    expect(ppRows[0]!.parentMessageId).toBe(userMsg.id);
    expect(ppRows[0]!.excluded).toBe(false);
    const payload = JSON.parse(ppRows[0]!.content);
    expect(payload).toEqual({
      extensionName: "graded-card-scanner",
      toolName: "identify_slab",
      cardType: "grade-delta-chart",
      ok: true,
      output: '{"cert":"49392223","grader":"PSA"}',
    });

    // 3. The grounding note landed in the Agent's system prompt
    //    (preprocess completed BEFORE the pi-agent was constructed).
    expect(capturedAgentOpts).not.toBeNull();
    const systemPrompt: string = capturedAgentOpts.initialState.systemPrompt;
    expect(systemPrompt).toContain(
      "[Deterministic preprocess graded-card-scanner:identify_slab on slab.png]",
    );
    expect(systemPrompt).toContain('{"cert":"49392223","grader":"PSA"}');
  });

  test("failing preprocessor → ok:false row persisted, NO note, turn still completes", async () => {
    const { executor } = createExecutor();
    toolCalls.length = 0;
    capturedAgentOpts = null;
    toolResultMode = "throw";
    const { conv, userMsg, attRow } = await seedTurn();

    await executor.streamChat(conv.id, "what is this?", {
      projectId,
      parentMessageId: userMsg.id,
      attachments: stagedFor(attRow),
    });

    const rows = await getMessages(conv.id);
    const ppRows = rows.filter((m) => m.role === PREPROCESS_RESULT_ROLE);
    expect(ppRows).toHaveLength(1);
    const payload = JSON.parse(ppRows[0]!.content);
    expect(payload.ok).toBe(false);
    expect(payload.output).toContain("simulated PDP denial");

    // Failure produces NO grounding note (the card carries the error) —
    // and the turn still reached the Agent (failure isolation).
    expect(capturedAgentOpts).not.toBeNull();
    expect(capturedAgentOpts.initialState.systemPrompt).not.toContain(
      "[Deterministic preprocess",
    );
  });

  test("no attachments on the turn → preprocess never fires", async () => {
    const { executor } = createExecutor();
    toolCalls.length = 0;
    capturedAgentOpts = null;
    toolResultMode = "success";
    const { conv, userMsg } = await seedTurn();

    await executor.streamChat(conv.id, "plain text turn", {
      projectId,
      parentMessageId: userMsg.id,
    });

    expect(toolCalls).toHaveLength(0);
    const rows = await getMessages(conv.id);
    expect(rows.filter((m) => m.role === PREPROCESS_RESULT_ROLE)).toHaveLength(0);
  });

  test("wired extension WITHOUT preprocessors → no dispatch, no rows", async () => {
    const { executor } = createExecutor();
    toolCalls.length = 0;
    capturedAgentOpts = null;
    toolResultMode = "success";
    serveManifestWithoutPreprocessors = true;
    try {
      const { conv, userMsg, attRow } = await seedTurn();
      await executor.streamChat(conv.id, "image turn, plain extension", {
        projectId,
        parentMessageId: userMsg.id,
        attachments: stagedFor(attRow),
      });
      expect(toolCalls).toHaveLength(0);
      const rows = await getMessages(conv.id);
      expect(rows.filter((m) => m.role === PREPROCESS_RESULT_ROLE)).toHaveLength(0);
    } finally {
      serveManifestWithoutPreprocessors = false;
    }
  });

  test("isError tool result → ok:false row persisted, NO note, turn completes", async () => {
    const { executor } = createExecutor();
    toolCalls.length = 0;
    capturedAgentOpts = null;
    toolResultMode = "isError";
    const { conv, userMsg, attRow } = await seedTurn();

    await executor.streamChat(conv.id, "what is this?", {
      projectId,
      parentMessageId: userMsg.id,
      attachments: stagedFor(attRow),
    });

    // The dispatch happened; the executor-level isError result (as
    // opposed to a THROW — the previous test) persists the honest
    // ok:false card with the tool's own error text as output.
    expect(toolCalls).toHaveLength(1);
    const rows = await getMessages(conv.id);
    const ppRows = rows.filter((m) => m.role === PREPROCESS_RESULT_ROLE);
    expect(ppRows).toHaveLength(1);
    const payload = JSON.parse(ppRows[0]!.content);
    expect(payload.ok).toBe(false);
    expect(payload.output).toBe("decode failed");

    // No grounding note for a failure — and the turn still reached the
    // Agent (failure isolation).
    expect(capturedAgentOpts).not.toBeNull();
    expect(capturedAgentOpts.initialState.systemPrompt).not.toContain(
      "[Deterministic preprocess",
    );
  });

  test("persist-less executor (host.persist absent) → no dispatch, no rows", async () => {
    // The preprocess block is gated on host.persist: the cards ARE the
    // user-facing contract, and a persist-less executor has no
    // transcript to show them in. Constructing WITHOUT the persist
    // option exercises the absent/false default.
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);
    toolCalls.length = 0;
    capturedAgentOpts = null;
    toolResultMode = "success";
    const { conv, userMsg, attRow } = await seedTurn();

    await executor.streamChat(conv.id, "what is this slab worth?", {
      projectId,
      parentMessageId: userMsg.id,
      attachments: stagedFor(attRow),
    });

    expect(toolCalls).toHaveLength(0);
    const rows = await getMessages(conv.id);
    expect(rows.filter((m) => m.role === PREPROCESS_RESULT_ROLE)).toHaveLength(0);
  });

  test("acting user: setCurrentUserId(<conversation owner>) is threaded BEFORE the preprocess dispatch", async () => {
    const { executor } = createExecutor();
    toolCalls.length = 0;
    executorOps.length = 0;
    capturedAgentOpts = null;
    toolResultMode = "success";
    const owner = await createUser({
      email: `pp-owner-${crypto.randomUUID()}@test.local`,
      passwordHash: "x",
      name: "PP Owner",
    });
    const { conv, userMsg, attRow } = await seedTurn(2048, owner.id);

    await executor.streamChat(conv.id, "what is this slab worth?", {
      projectId,
      parentMessageId: userMsg.id,
      attachments: stagedFor(attRow),
    });

    // The dispatch acts on-behalf-of the conversation owner: the 2c
    // block threads setCurrentUserId(convRecord.userId) into the SAME
    // ToolExecutor BEFORE runPreprocessorsForTurn dispatches through it
    // (same semantics as /api/tool-invoke).
    const userIdx = executorOps.indexOf(`setCurrentUserId:${owner.id}`);
    const dispatchIdx = executorOps.indexOf(
      "executeToolCall:graded-card-scanner__identify_slab",
    );
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(dispatchIdx).toBeGreaterThan(userIdx);
    expect(toolCalls).toHaveLength(1);
  });

  test("oversized attachment (DB-resolved size) is skipped", async () => {
    const { executor } = createExecutor();
    toolCalls.length = 0;
    toolResultMode = "success";
    const { conv, userMsg, attRow } = await seedTurn(9 * 1024 * 1024);

    await executor.streamChat(conv.id, "huge image", {
      projectId,
      parentMessageId: userMsg.id,
      attachments: stagedFor(attRow),
    });

    expect(toolCalls).toHaveLength(0);
    const rows = await getMessages(conv.id);
    expect(rows.filter((m) => m.role === PREPROCESS_RESULT_ROLE)).toHaveLength(0);
  });
});
