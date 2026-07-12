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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    // An ANTHROPIC model (api stamped by pi-ai) so region-1 (the frozen
    // systemPrompt) is observably SEPARATE from the uncached memory/preprocess
    // tail, which build-pi-agent applies in onPayload — matching
    // setup-tools-memory-tail.test.ts. This lets us assert the grounding note
    // rides the tail and NEVER the cached region-1 (the WS1 cache invariant).
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

// The conversation's wired extension ids — mutable so the disabled-skip
// integration test can wire a real (disabled) DB extension id instead.
let wiredExtIds: string[] = ["ext-scanner"];
mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => wiredExtIds,
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
const { PREPROCESS_NOTE_CLOSE, PREPROCESS_NOTE_OPEN, PREPROCESS_RESULT_ROLE } = await import(
  "../runtime/stream-chat/preprocess"
);
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

    // 3. The grounding note rides the UNCACHED systemMemoryTail, NOT the
    //    byte-stable cached region-1 (preprocess completed BEFORE the
    //    pi-agent was constructed). Region-1 = the frozen systemPrompt must
    //    stay note-FREE so the system+tools prefix cache survives every
    //    preprocess-bearing turn (the WS1 cache invariant); the note is
    //    appended by onPayload as the LAST uncached Anthropic system block.
    expect(capturedAgentOpts).not.toBeNull();
    const systemPrompt: string = capturedAgentOpts.initialState.systemPrompt;
    expect(systemPrompt).not.toContain("[Deterministic preprocess");

    const wire: any = {
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    };
    const out = (await capturedAgentOpts.onPayload(wire)) as any;
    // The frozen region-1 block is untouched (keeps its breakpoint); the note
    // rides a SEPARATE trailing block with NO cache_control.
    expect(out.system).toHaveLength(2);
    expect("cache_control" in out.system[1]).toBe(false);
    const tailText: string = out.system[1].text;
    // Injection hardening: the tool output sits INSIDE explicit untrusted-data
    // delimiters, in header → open → output → close order.
    expect(tailText).toContain(
      `[Deterministic preprocess graded-card-scanner:identify_slab on slab.png]\n${PREPROCESS_NOTE_OPEN}\n{"cert":"49392223","grader":"PSA"}\n${PREPROCESS_NOTE_CLOSE}`,
    );
  });

  test("region-1 cache invariant: a preprocess-note turn yields a BYTE-IDENTICAL frozen systemPrompt to a note-less turn; the note rides only the uncached tail (#56)", async () => {
    // The WS1 regression guard: a per-turn grounding note must NOT perturb the
    // cached region-1 (system + tools) prefix — otherwise every
    // preprocess-bearing turn rewrites it and busts Anthropic's prompt cache
    // (the cost-negative class this fix closes, mirroring the memory-injection
    // split in setup-tools-memory-tail.test.ts). Run one turn WITH a note and
    // one WITHOUT, and assert their frozen systemPrompt is byte-for-byte equal.
    const { executor } = createExecutor();
    toolResultMode = "success";

    // Turn WITH a preprocess note (attachment present → preprocessor fires).
    toolCalls.length = 0;
    capturedAgentOpts = null;
    const withNote = await seedTurn();
    await executor.streamChat(withNote.conv.id, "what is this slab worth?", {
      projectId,
      parentMessageId: withNote.userMsg.id,
      attachments: stagedFor(withNote.attRow),
    });
    expect(toolCalls).toHaveLength(1);
    const region1WithNote: string = capturedAgentOpts.initialState.systemPrompt;
    const withWire: any = {
      system: [{ type: "text", text: region1WithNote, cache_control: { type: "ephemeral" } }],
    };
    const withOut = (await capturedAgentOpts.onPayload(withWire)) as any;

    // Turn WITHOUT a note (no attachment → preprocess never fires).
    toolCalls.length = 0;
    capturedAgentOpts = null;
    const noNote = await seedTurn();
    await executor.streamChat(noNote.conv.id, "what is this slab worth?", {
      projectId,
      parentMessageId: noNote.userMsg.id,
    });
    expect(toolCalls).toHaveLength(0);
    const region1NoNote: string = capturedAgentOpts.initialState.systemPrompt;
    const noWire: any = {
      system: [{ type: "text", text: region1NoNote, cache_control: { type: "ephemeral" } }],
    };
    const noOut = (await capturedAgentOpts.onPayload(noWire)) as any;

    // Region-1 is BYTE-IDENTICAL across the two turns — the note never touches
    // the cached prefix — and carries none of the note text.
    expect(region1WithNote).toBe(region1NoNote);
    expect(region1WithNote).not.toContain("[Deterministic preprocess");

    // The note appears ONLY in the with-note turn's uncached trailing block;
    // the note-less turn emits no tail block at all (onPayload no-op).
    expect(withOut.system).toHaveLength(2);
    expect(withOut.system[1].text).toContain(
      "[Deterministic preprocess graded-card-scanner:identify_slab on slab.png]",
    );
    expect("cache_control" in withOut.system[1]).toBe(false);
    expect(noOut.system).toHaveLength(1);
  });

  test("failing preprocessor → ok:false row + FAILED do-not-retry note on the tail", async () => {
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

    // Changed decision: a failure now emits a FAILED do-not-retry note —
    // but it rides the UNCACHED tail (onPayload), never the cached region-1
    // systemPrompt, so the prompt cache stays warm.
    expect(capturedAgentOpts).not.toBeNull();
    expect(capturedAgentOpts.initialState.systemPrompt).not.toContain(
      "[Deterministic preprocess",
    );
    const wire = {
      system: [
        {
          type: "text",
          text: capturedAgentOpts.initialState.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
    };
    const out = (await capturedAgentOpts.onPayload(wire)) as { system: Array<{ text: string }> };
    expect(out.system[1]!.text).toContain(
      "[Deterministic preprocess graded-card-scanner:identify_slab on slab.png FAILED]",
    );
    expect(out.system[1]!.text).toContain(
      "Do not call identify_slab on this attachment again this turn",
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

    // The FAILED note rides the uncached tail; region-1 stays clean.
    expect(capturedAgentOpts).not.toBeNull();
    expect(capturedAgentOpts.initialState.systemPrompt).not.toContain(
      "[Deterministic preprocess",
    );
    const wire = {
      system: [
        {
          type: "text",
          text: capturedAgentOpts.initialState.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
    };
    const out = (await capturedAgentOpts.onPayload(wire)) as { system: Array<{ text: string }> };
    expect(out.system[1]!.text).toContain("FAILED]");
    expect(out.system[1]!.text).toContain("decode failed");
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

  test("run:status surfaces 'Running <ext> preprocessor…' during the loop, then restores 'Preparing...'", async () => {
    const { executor, bus } = createExecutor();
    toolCalls.length = 0;
    toolResultMode = "success";
    const statuses: string[] = [];
    bus.on("run:status", (data) => {
      statuses.push((data as { status: string }).status);
    });
    const { conv, userMsg, attRow } = await seedTurn();

    await executor.streamChat(conv.id, "what is this slab worth?", {
      projectId,
      parentMessageId: userMsg.id,
      attachments: stagedFor(attRow),
    });

    // The preprocess loop announced itself on the run-status channel…
    const runningIdx = statuses.indexOf("Running graded-card-scanner preprocessor…");
    expect(runningIdx).toBeGreaterThanOrEqual(0);
    // …AFTER the initial "Preparing..." emit at the top of setupTools…
    const firstPreparingIdx = statuses.indexOf("Preparing...");
    expect(firstPreparingIdx).toBeGreaterThanOrEqual(0);
    expect(firstPreparingIdx).toBeLessThan(runningIdx);
    // …and the generic setup status was RESTORED once the loop finished
    // (the preprocessor line must not stay stuck for the rest of setup).
    const restoredIdx = statuses.indexOf("Preparing...", runningIdx + 1);
    expect(restoredIdx).toBeGreaterThan(runningIdx);
  });

  test("turn without preprocess work emits no preprocessor status line", async () => {
    const { executor, bus } = createExecutor();
    toolCalls.length = 0;
    toolResultMode = "success";
    const statuses: string[] = [];
    bus.on("run:status", (data) => {
      statuses.push((data as { status: string }).status);
    });
    const { conv, userMsg } = await seedTurn();

    await executor.streamChat(conv.id, "plain text turn", {
      projectId,
      parentMessageId: userMsg.id,
    });

    expect(statuses.some((s) => s.includes("preprocessor"))).toBe(false);
  });

  test("disabled wired extension → skip row persisted + chained (getExtension reads the disabled row)", async () => {
    const { executor } = createExecutor();
    toolCalls.length = 0;
    capturedAgentOpts = null;
    toolResultMode = "success";

    // A REAL disabled extension row (getDisabledExtension in setup-tools
    // reads it via getExtension, which does NOT filter on `enabled`). The
    // registry mock returns undefined for its id (disabled → not loaded),
    // so it becomes a disabled-skip candidate.
    const { createExtension } = await import("../db/queries/extensions");
    const disabledName = `disabled-scanner-${crypto.randomUUID().slice(0, 8)}`;
    const disabledExt = await createExtension({
      name: disabledName,
      version: "1.0.0",
      description: "disabled scanner",
      manifest: {
        schemaVersion: 2,
        name: disabledName,
        version: "1.0.0",
        description: "d",
        author: { name: "t" },
        entrypoint: "./index.ts",
        tools: [
          { name: "identify_slab", description: "d", inputSchema: { type: "object" }, cardType: "grade-delta-chart" },
        ],
        preprocessors: [{ tool: "identify_slab", accepts: ["image/png", "image/jpeg"] }],
        permissions: {},
      },
      source: "local:/tmp/disabled-scanner",
      installPath: "/tmp/disabled-scanner",
      enabled: false,
      grantedPermissions: { grantedAt: {} },
      checksumVerified: false,
      consecutiveFailures: 3,
    });
    wiredExtIds = [disabledExt.id];
    try {
      const { conv, userMsg, attRow } = await seedTurn();
      await executor.streamChat(conv.id, "what is this slab worth?", {
        projectId,
        parentMessageId: userMsg.id,
        attachments: stagedFor(attRow),
      });

      // The disabled extension is never dispatched…
      expect(toolCalls).toHaveLength(0);
      // …but a single "skipped, disabled" row is persisted + chained off
      // the user message.
      const rows = await getMessages(conv.id);
      const ppRows = rows.filter((m) => m.role === PREPROCESS_RESULT_ROLE);
      expect(ppRows).toHaveLength(1);
      expect(ppRows[0]!.parentMessageId).toBe(userMsg.id);
      const payload = JSON.parse(ppRows[0]!.content);
      expect(payload.ok).toBe(false);
      expect(payload.toolName).toBe("identify_slab");
      expect(payload.output).toContain("is disabled");
      expect(payload.output).toContain("Re-enable it from the Extensions page");

      // The skip note rides the uncached tail; region-1 stays clean.
      expect(capturedAgentOpts).not.toBeNull();
      expect(capturedAgentOpts.initialState.systemPrompt).not.toContain(
        "[Deterministic preprocess",
      );
      const wire = {
        system: [
          {
            type: "text",
            text: capturedAgentOpts.initialState.systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
      };
      const out = (await capturedAgentOpts.onPayload(wire)) as { system: Array<{ text: string }> };
      expect(out.system[1]!.text).toContain("SKIPPED");
      expect(out.system[1]!.text).toContain("the extension is disabled; report it to the user");
    } finally {
      wiredExtIds = ["ext-scanner"];
    }
  });

  test("wired ext ENABLED in DB but absent from registry → getDisabledExtension null, no skip row", async () => {
    // Covers the getDisabledExtension `return null` branch: the row exists
    // and is ENABLED (a benign registry-vs-DB lag), so it is NOT surfaced
    // as a disabled skip.
    const { executor } = createExecutor();
    toolCalls.length = 0;
    toolResultMode = "success";
    const { createExtension } = await import("../db/queries/extensions");
    const enabledName = `enabled-unregistered-${crypto.randomUUID().slice(0, 8)}`;
    const enabledExt = await createExtension({
      name: enabledName,
      version: "1.0.0",
      description: "enabled but not in registry",
      manifest: {
        schemaVersion: 2,
        name: enabledName,
        version: "1.0.0",
        description: "d",
        author: { name: "t" },
        entrypoint: "./index.ts",
        tools: [{ name: "identify_slab", description: "d", inputSchema: { type: "object" } }],
        preprocessors: [{ tool: "identify_slab", accepts: ["image/png"] }],
        permissions: {},
      },
      source: "local:/tmp/enabled-unregistered",
      installPath: "/tmp/enabled-unregistered",
      enabled: true,
      grantedPermissions: { grantedAt: {} },
      checksumVerified: false,
      consecutiveFailures: 0,
    });
    wiredExtIds = [enabledExt.id];
    try {
      const { conv, userMsg, attRow } = await seedTurn();
      await executor.streamChat(conv.id, "what is this?", {
        projectId,
        parentMessageId: userMsg.id,
        attachments: stagedFor(attRow),
      });
      const rows = await getMessages(conv.id);
      expect(rows.filter((m) => m.role === PREPROCESS_RESULT_ROLE)).toHaveLength(0);
      expect(toolCalls).toHaveLength(0);
    } finally {
      wiredExtIds = ["ext-scanner"];
    }
  });
});

describe("setup-tools source ordering (locked decision 3)", () => {
  // wireMentionedExtensions is MOCKED to a no-op in this harness, so the
  // behavioral suites above can't pin that the preprocess runner fires
  // AFTER the same-message `![ext:…]` mention wire. Pin it structurally
  // instead (indexOf pattern from executor-attachment-resolver-wiring):
  // the 2c block awaits wireMentionedExtensions BEFORE it awaits
  // runPreprocessorsForTurn, so a mention + attachment in ONE message
  // triggers the preprocessor in the SAME turn.
  test("setupTools awaits wireMentionedExtensions BEFORE runPreprocessorsForTurn", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "runtime", "stream-chat", "setup-tools.ts"),
      "utf-8",
    );
    const wireIdx = src.indexOf("await wireMentionedExtensions(");
    const preprocessIdx = src.indexOf("await runPreprocessorsForTurn(");
    expect(wireIdx).toBeGreaterThan(-1);
    expect(preprocessIdx).toBeGreaterThan(-1);
    expect(wireIdx).toBeLessThan(preprocessIdx);
  });
});
