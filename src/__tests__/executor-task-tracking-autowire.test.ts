/**
 * Executor task-tracking auto-wire coverage (commit fd4c482).
 *
 * Before fd4c482, task-tracking was a "wire-on-first-use" extension that
 * only got wired when `/api/tool-invoke` fired — which never happens for
 * LLM-driven tool calls. The result: the LLM never saw task_plan /
 * task_add / task_list even after the user asked it to plan.
 *
 * The fix: `src/runtime/executor.ts` now calls
 * `ensureTaskTrackingWired(conversationId)` inside the 2c block, BEFORE
 * `wireMentionedExtensions` + `getConversationExtensionIds`, so path 3
 * (the convExtIds → registry.getToolsForExtension → agentTools pipeline)
 * picks up the task-tracking tools every turn. The call is wrapped in a
 * try/catch that logs a warn on failure — a bad wire must not abort the
 * turn.
 *
 * This suite mirrors the harness style of
 * src/__tests__/executor-agent-wiring.test.ts — stub every runtime
 * import so `streamChat` runs end-to-end with a captured `Agent` opts
 * object. The `../runtime/task-tracking-host` module is mocked so we
 * can spy on `ensureTaskTrackingWired` per-test.
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

mock.module("@mariozechner/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: undefined };
    constructor(opts: any) {
      capturedAgentOpts = opts;
    }
    prompt = mockPrompt;
    subscribe = mockSubscribe;
  },
}));

// ── Stub providers / observability / runs / memory ──
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

mock.module("../providers/shell", () => ({
  createShellProvider: () => ({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
}));

mock.module("../providers/file", () => ({
  createFileProvider: () => ({
    read: async () => "",
    write: async () => {},
    exists: async () => false,
  }),
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

mock.module("../memory/embeddings", () => ({
  generateEmbedding: async () => new Float32Array(384),
}));

mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async (sys: string | undefined) => ({
    systemPrompt: sys ?? "",
    memoriesUsed: [],
  }),
}));

// ── Task-tracking host spy ─────────────────────────────────────────────
// The spy lives on the module-level mock so every dynamic `import("./
// task-tracking-host")` inside executor.ts resolves to the SAME spy.
// Per-test knobs:
//   - `forceTaskWireThrow` flips the spy into a throw-on-call mode so we
//     can exercise the warn-swallow branch.
//   - `taskWireCalls` is a call log — asserted in test 1.
const taskWireCalls: Array<{ conversationId: string }> = [];
let forceTaskWireThrow = false;

mock.module("../runtime/task-tracking-host", () => ({
  ensureTaskTrackingWired: async (conversationId: string) => {
    taskWireCalls.push({ conversationId });
    if (forceTaskWireThrow) {
      throw new Error("simulated task-tracking wire failure");
    }
  },
  getTaskTrackingExtensionId: async () => "ext-task-tracking",
}));

// ── Extension registry — inject a fake task-tracking extension whose
//    tools appear on the convExtIds → getToolsForExtension path. This is
//    what Task A test 3 asserts: with the ext id returned by
//    getConversationExtensionIds, the resolved agentTools include
//    task_plan (and friends).
const TASK_TOOL_NAMES = [
  "task_plan",
  "task_add",
  "task_list",
  "task_start",
  "task_complete",
  "task_fail",
] as const;

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getToolsForAgent: async () => [],
      getToolsForExtension: (extensionId: string) => {
        if (extensionId !== "ext-task-tracking") return [];
        return TASK_TOOL_NAMES.map((name) => ({
          name,
          description: `task-tracking tool ${name}`,
          inputSchema: { type: "object", properties: {}, required: [] },
        }));
      },
    }),
  },
}));

// Stub extensionToAgentTool so the injected fake tools surface in
// agentTools with the `name` preserved — the executor's pipeline calls
// this on every convExtId → RegisteredTool mapping.
mock.module("../extensions/tool-executor", () => ({
  ToolExecutor: class {
    setStateMediator() {}
    setExecutor() {}
    setSpawnQuota() {}
    setCurrentUserId() {}
    setCurrentModel() {}
    setCurrentProvider() {}
    // Refactor f912990 (wire PermissionEngine into ToolExecutor sites)
    // added setArgsResolver + setCurrentAgentConfigId calls along the
    // path-3 convExtIds pipeline in stream-chat/setup-tools.ts:371-398.
    // Stub them as no-ops here so the path-3 block reaches the
    // for-loop that pushes task-tracking tools into ctx.agentTools.
    // Without these stubs, the calls throw and the surrounding
    // non-fatal try/catch at setup-tools.ts:399 swallows the error,
    // leaving toolNames missing task_plan in test 3.
    setArgsResolver() {}
    setCurrentAgentConfigId() {}
  },
  extensionToAgentTool: (
    tool: { name: string; description: string; inputSchema: unknown },
  ) => ({
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

// Stub mention-wiring so `wireMentionedExtensions` is a no-op. The
// point of this suite is the auto-wire, not the mention parser.
mock.module("../runtime/mention-wiring", () => ({
  wireMentionedExtensions: async () => {},
  resolveMentionedAgents: async () => [],
  resolveMentionedTeams: async () => [],
  applyCommandExpansion: async (s: string) => s,
}));

// Stub getConversationExtensionIds to ALWAYS return the fake
// task-tracking extension id. In the real flow,
// `ensureTaskTrackingWired` inserts a row in conversation_extensions
// which this query reads back; we bypass the insert and hand it the id
// directly — we're testing the auto-wire callsite, not the DB plumbing.
mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => ["ext-task-tracking"],
}));

// Stub the orchestration host so we don't need a real wire for
// invoke_agent / ask_human. Not part of this suite's surface area.
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
  const project = await createProject({ name: "Task Autowire Test", path: "/tmp/tt-autowire" });
  projectId = project.id;
  const conv = await createConversation(projectId);
  convId = conv.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function createExecutor() {
  const bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(new Map(), bus, { persist: false });
  return { executor, bus };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("executor task-tracking auto-wire (commit fd4c482)", () => {
  test("calls ensureTaskTrackingWired with the conversationId on every streamChat turn", async () => {
    const { executor } = createExecutor();
    taskWireCalls.length = 0;
    capturedAgentOpts = null;

    await executor.streamChat(convId, "Please plan some tasks", { projectId });

    // The auto-wire must have fired exactly once, with our conv id.
    expect(taskWireCalls.length).toBeGreaterThanOrEqual(1);
    expect(taskWireCalls.some((c) => c.conversationId === convId)).toBe(true);

    // Second turn also triggers the wire — it's per-turn, not
    // per-conversation (the executor dynamically imports the host each
    // time). Verifies the call lives inside the turn setup and isn't
    // gated on some one-shot flag.
    const before = taskWireCalls.length;
    await executor.streamChat(convId, "Plan more tasks", { projectId });
    expect(taskWireCalls.length).toBeGreaterThan(before);
  });

  test("swallows wire failures with a warn log — turn still proceeds", async () => {
    const { executor } = createExecutor();
    taskWireCalls.length = 0;
    capturedAgentOpts = null;
    forceTaskWireThrow = true;

    // Capture stderr so we can assert the warn line without conflating
    // with the rest of the test output. `warn` writes to stderr per
    // src/logger.ts:35.
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const stderrLines: string[] = [];
    (process.stderr as any).write = (chunk: string | Uint8Array) => {
      stderrLines.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    };

    try {
      // Must NOT throw — the try/catch inside executor.ts:655-662 must
      // swallow the wire error.
      await executor.streamChat(convId, "Plan with a bad wire", { projectId });
    } finally {
      forceTaskWireThrow = false;
      (process.stderr as any).write = originalStderrWrite;
    }

    // The spy still recorded the invocation (and the throw).
    expect(taskWireCalls.length).toBeGreaterThanOrEqual(1);

    // Turn completed — Agent was constructed, so the rest of the
    // streamChat setup ran.
    expect(capturedAgentOpts).not.toBeNull();

    // The warn line emitted by the catch branch must be present.
    const joined = stderrLines.join("");
    expect(joined).toMatch(/Task-tracking wire failed/);
    // The error stringification carries the original throw message
    // through — useful for diagnosing real-world failures.
    expect(joined).toContain("simulated task-tracking wire failure");
  });

  test("task-tracking tools flow into agentTools via the mention-wiring path 3", async () => {
    // With the wire succeeding + getConversationExtensionIds returning
    // the task-tracking ext id, path 3 (the convExtIds → registry →
    // agentTools pipeline at executor.ts:665-689) must pick up the
    // task-tracking tools and push them into agentTools. This is the
    // bug fd4c482 actually fixed — the user-visible symptom was the
    // LLM never seeing task_plan.
    const { executor } = createExecutor();
    taskWireCalls.length = 0;
    capturedAgentOpts = null;

    await executor.streamChat(convId, "Please break this into tasks", {
      projectId,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: Array<{ name: string }> = capturedAgentOpts.initialState.tools;
    const toolNames = tools.map((t) => t.name);

    // The core of the fix — task_plan must be visible to the LLM.
    expect(toolNames).toContain("task_plan");
    // And the rest of the injected task-tracking surface.
    expect(toolNames).toContain("task_add");
    expect(toolNames).toContain("task_list");
    expect(toolNames).toContain("task_start");
    expect(toolNames).toContain("task_complete");
    expect(toolNames).toContain("task_fail");
  });
});
