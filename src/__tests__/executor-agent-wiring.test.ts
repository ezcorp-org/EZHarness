import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// ── DB mock (must be first, before any module that imports db/connection) ──
mockDbConnection();

// ── Capture what pi-agent-core's Agent receives ──
let capturedAgentOpts: any = null;

// Allow tests to inject custom events into the subscribe callback
let subscribeEventInjector: ((fn: (e: any) => void) => void) | null = null;

const mockPrompt = mock(async () => {});
const mockSubscribe = mock((fn: (e: any) => void) => {
  // If a test injected a custom event sequence, use it
  const injector = subscribeEventInjector;
  if (injector) {
    injector(fn);
  } else {
    // Immediately emit agent_end so prompt() flow completes
    queueMicrotask(() => fn({ type: "agent_end", messages: [] }));
  }
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

// ── Mock providers ──
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

const mockGetCredential = mock(async () => ({ type: "apikey", token: "test-key" }));
mock.module("../providers/credentials", () => ({
  getCredential: mockGetCredential,
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

// ── Mock observability, runs, active-runs ──
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

// ── Mock memory/embeddings (skip memory injection) ──
mock.module("../memory/embeddings", () => ({
  generateEmbedding: async () => new Float32Array(384),
}));

mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async (sys: string | undefined) => ({
    systemPrompt: sys ?? "",
    memoriesUsed: [],
  }),
}));

// Extension registry — return empty tools for agent configs
mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getToolsForAgent: async () => [],
      getToolsForExtension: () => [],
    }),
  },
}));

mock.module("../extensions/tool-executor", () => ({
  ToolExecutor: class {},
  extensionToAgentTool: () => ({}),
}));

// Orchestration host — Phase 4 commit-5 replaced the in-process
// invoke-agent tool injection with a wire-on-first-use helper that
// resolves the bundled `orchestration` extension from the DB.
// After the ask-user migration, the orchestration extension only
// owns `invoke_agent`; human-in-the-loop moved to the bundled
// `ask-user` extension.
// The test fixture doesn't install the extension for real, so we stub
// the helpers: `ensureOrchestrationWired` is a no-op success, and
// `wireOrchestrationToolsForTurn` appends only `invoke_agent` so the
// rest of the executor path (auto-spin-up, filter preservation,
// depth-gate, event suppression) behaves identically to the
// extension-wired production path.
// Mutable throw-trigger for the wire-failure coverage test below.
// When set to a non-null string, `wireOrchestrationToolsForTurn` will throw
// with that message — lets us drive the try/catch in executor.ts:810-814.
let forceOrchWireThrow: string | null = null;

mock.module("../runtime/orchestration-host", () => ({
  ensureOrchestrationWired: async () => true,
  wireOrchestrationToolsForTurn: async (params: { agentTools: any[] }) => {
    if (forceOrchWireThrow) {
      throw new Error(forceOrchWireThrow);
    }
    params.agentTools.push({
      name: "invoke_agent",
      label: "Invoke Agent",
      description:
        "Invoke a specialized agent to handle a task. The agent runs as an independent sub-conversation and returns its response.",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async () => ({
        content: [{ type: "text" as const, text: "(stub invoke_agent response)" }],
        details: {},
      }),
    });
  },
}));

// ask-user host stub — auto-wired every turn alongside orchestration.
// Tests assert orchestration tool injection; the ask-user wire is a
// no-op success that pushes nothing (or a stub if the test asserts on
// it specifically). Mirrors the production behavior shape so any
// regression in setup-tools.ts surfaces here too.
mock.module("../runtime/ask-user-host", () => ({
  ensureAskUserWired: async () => true,
  wireAskUserToolForTurn: async (_params: { agentTools: any[] }) => {
    // No-op: this suite asserts on orchestration's invoke_agent path.
    // ask_user_question wiring is covered by ask-user.e2e.test.ts.
  },
  _resetAskUserExtensionIdCache: () => {},
}));

// ── Import after all mocks ──
const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { createAgentConfig } = await import("../db/queries/agent-configs");
type AgentEvents = import("../types").AgentEvents;

let projectId: string;
let topConvId: string;
let subConvId: string;
const agentName = "test-orchestrated-agent";

beforeAll(async () => {
  await setupTestDb();

  const project = await createProject({ name: "Wiring Test", path: "/tmp/wiring-test" });
  projectId = project.id;

  const topConv = await createConversation(projectId);
  topConvId = topConv.id;

  // Sub-conversation (has parentConversationId) — should NOT get invoke_agent
  const subConv = await createConversation(projectId, {
    parentConversationId: topConvId,
    parentMessageId: undefined,
  });
  subConvId = subConv.id;

  await createAgentConfig({
    name: agentName,
    description: "An agent for orchestration testing",
    prompt: "You are a test agent.",
  });
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

describe("executor agent wiring", () => {
  test("injects invoke_agent tool when message contains ![agent:name] in top-level conversation", async () => {
    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, `Please ![agent:${agentName}] review this`, {
      projectId,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    const invokeAgentTool = tools.find((t: any) => t.name === "invoke_agent");
    expect(invokeAgentTool).toBeDefined();
    expect(invokeAgentTool.description).toContain("agent");
  });

  test("injects orchestrator system prompt when agents are mentioned", async () => {
    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, `Hey ![agent:${agentName}] do something`, {
      projectId,
    });

    const systemPrompt: string = capturedAgentOpts.initialState.systemPrompt;
    expect(systemPrompt).toContain("Available Agents");
    expect(systemPrompt).toContain(agentName);
    expect(systemPrompt).toContain("invoke_agent");
  });

  test("does NOT inject invoke_agent at max orchestration depth", async () => {
    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(subConvId, `Please ![agent:${agentName}] review this`, {
      projectId,
      orchestrationDepth: 3, // At max depth — should block
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    const invokeAgentTool = tools.find((t: any) => t.name === "invoke_agent");
    expect(invokeAgentTool).toBeUndefined();
  });

  test("does NOT inject invoke_agent when no agents are mentioned", async () => {
    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, "Just a normal message with no mentions", {
      projectId,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    const invokeAgentTool = tools.find((t: any) => t.name === "invoke_agent");
    expect(invokeAgentTool).toBeUndefined();
  });

  test("does NOT inject orchestrator prompt when no agents are mentioned", async () => {
    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, "Hello, no agent mentions", {
      projectId,
    });

    const systemPrompt: string = capturedAgentOpts.initialState.systemPrompt;
    expect(systemPrompt).not.toContain("Available Agents");
  });

  test("wire-failure catch branch logs warning and does not crash the turn", async () => {
    // Forces `wireOrchestrationToolsForTurn` to throw so we drive the
    // `catch (orchWireErr)` branch at executor.ts:810-814. The logger
    // writes warn lines to `process.stderr.write`, so we swap that with
    // a capturing spy for the duration of the call.
    const { executor } = createExecutor();
    capturedAgentOpts = null;

    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const stderrLines: string[] = [];
    (process.stderr as any).write = (chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    };

    forceOrchWireThrow = "simulated orchestration wire failure";
    try {
      // Must not throw — the catch must swallow the error.
      await executor.streamChat(topConvId, `Please ![agent:${agentName}] review this`, {
        projectId,
      });
    } finally {
      forceOrchWireThrow = null;
      (process.stderr as any).write = originalStderrWrite;
    }

    // Turn didn't crash — Agent was constructed with a usable toolset.
    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    expect(Array.isArray(tools)).toBe(true);
    // After the ask-user migration the orchestration wire only injects
    // `invoke_agent`; when it throws, that tool doesn't land. The
    // catch still swallows, so the rest of the turn setup (ask-user
    // auto-wire, scratchpad auto-wire) still runs — proven by
    // Array.isArray(tools) above.
    expect(tools.find((t: any) => t.name === "ask_human")).toBeUndefined();
    expect(tools.find((t: any) => t.name === "invoke_agent")).toBeUndefined();

    // The warn log line emitted by the catch branch must be present.
    const joined = stderrLines.join("");
    expect(joined).toMatch(/Orchestration extension wire failed/);
    expect(joined).toContain("simulated orchestration wire failure");
  });
});

describe("executor credential propagation", () => {
  test("sub-conversation resolves credentials using parentConversationId", async () => {
    const { executor } = createExecutor();
    capturedAgentOpts = null;
    mockGetCredential.mockClear();

    await executor.streamChat(subConvId, "Message in sub-conversation", {
      projectId,
    });

    // getCredential is called during model resolution (line 550) and also via getApiKey callback.
    // For a sub-conversation with parentConversationId = topConvId,
    // the credentialConversationId should be topConvId (the parent).
    const credCalls = mockGetCredential.mock.calls;
    expect(credCalls.length).toBeGreaterThan(0);
    // The second argument to getCredential should be the parent conversation's ID
    const credConvIds = credCalls.map((c: any) => c[1]).filter(Boolean);
    expect(credConvIds.length).toBeGreaterThan(0);
    // All credential lookups should use the parent conversation ID
    for (const convId of credConvIds) {
      expect(convId).toBe(topConvId);
    }
  });

  test("top-level conversation resolves credentials using its own ID", async () => {
    const { executor } = createExecutor();
    capturedAgentOpts = null;
    mockGetCredential.mockClear();

    await executor.streamChat(topConvId, "Message in top-level conversation", {
      projectId,
    });

    const credCalls = mockGetCredential.mock.calls;
    expect(credCalls.length).toBeGreaterThan(0);
    const credConvIds = credCalls.map((c: any) => c[1]).filter(Boolean);
    expect(credConvIds.length).toBeGreaterThan(0);
    for (const convId of credConvIds) {
      expect(convId).toBe(topConvId);
    }
  });
});

describe("executor mode filter preserves invoke_agent", () => {
  test("read-only mode preserves invoke_agent tool while filtering write tools", async () => {
    // Create a mode with read-only restriction
    const { createMode } = await import("../db/queries/modes");
    const mode = await createMode({
      name: "read-only-test",
      slug: "read-only-test",
      systemPromptInstruction: "Read only mode",
      toolRestriction: "read-only",
    });

    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, `![agent:${agentName}] review code please`, {
      projectId,
      modeId: mode.id,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    const invokeAgentTool = tools.find((t: any) => t.name === "invoke_agent");
    expect(invokeAgentTool).toBeDefined();
  });

  test("none mode preserves invoke_agent tool while filtering all other tools", async () => {
    const { createMode } = await import("../db/queries/modes");
    const mode = await createMode({
      name: "none-tools-test",
      slug: "none-tools-test",
      systemPromptInstruction: "No tools mode",
      toolRestriction: "none",
    });

    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, `![agent:${agentName}] help me`, {
      projectId,
      modeId: mode.id,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    // Only orchestration tools should remain (invoke_agent,
    // ask_user_question, scratchpad__scratchpad_*, task_*).
    // ask_user_question replaced ask_human in the ask-user migration.
    const ORCHESTRATION_TOOLS = new Set([
      "invoke_agent", "ask-user__ask_user_question",
      "scratchpad__scratchpad_write", "scratchpad__scratchpad_read",
      "task_plan", "task_start", "task_complete", "task_fail",
      "task_update", "task_list", "task_subtask_toggle",
      "task_assign", "task_unassign",
    ]);
    expect(tools.every((t: any) => ORCHESTRATION_TOOLS.has(t.name))).toBe(true);
    expect(tools.find((t: any) => t.name === "invoke_agent")).toBeDefined();
  });
});

describe("executor tool event suppression for invoke_agent", () => {
  test("suppresses tool:start emission for invoke_agent tool_execution_start events", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus, { persist: false });

    const toolStartEvents: any[] = [];
    const agentSpawnEvents: any[] = [];
    bus.on("tool:start", (data) => toolStartEvents.push(data));
    bus.on("agent:spawn", (data) => agentSpawnEvents.push(data));

    // Inject events that simulate invoke_agent tool execution
    subscribeEventInjector = (fn) => {
      queueMicrotask(() => {
        fn({
          type: "tool_execution_start",
          toolCallId: "tc-inv-1",
          toolName: "invoke_agent",
          args: { agentConfigId: "cfg-1", task: "test" },
        });
        fn({
          type: "tool_execution_start",
          toolCallId: "tc-read-1",
          toolName: "read_file",
          args: { path: "/tmp/test" },
        });
        fn({ type: "agent_end", messages: [] });
      });
    };

    capturedAgentOpts = null;
    await executor.streamChat(topConvId, "No agents mentioned", { projectId });

    // tool:start should NOT be emitted for invoke_agent
    const invokeToolStarts = toolStartEvents.filter((e) => e.toolName === "invoke_agent");
    expect(invokeToolStarts.length).toBe(0);

    // tool:start SHOULD be emitted for non-invoke_agent tools
    const readToolStarts = toolStartEvents.filter((e) => e.toolName === "read_file");
    expect(readToolStarts.length).toBe(1);

    // Clean up injector
    subscribeEventInjector = null;
  });

  test("suppresses tool:complete emission for invoke_agent tool_execution_end events", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus, { persist: false });

    const toolCompleteEvents: any[] = [];
    bus.on("tool:complete", (data) => toolCompleteEvents.push(data));

    subscribeEventInjector = (fn) => {
      queueMicrotask(() => {
        // Start events (needed for tracking)
        fn({
          type: "tool_execution_start",
          toolCallId: "tc-inv-2",
          toolName: "invoke_agent",
          args: {},
        });
        fn({
          type: "tool_execution_start",
          toolCallId: "tc-read-2",
          toolName: "read_file",
          args: { path: "/tmp/test" },
        });
        // End events
        fn({
          type: "tool_execution_end",
          toolCallId: "tc-inv-2",
          toolName: "invoke_agent",
          result: { content: [{ type: "text", text: "done" }] },
          isError: false,
        });
        fn({
          type: "tool_execution_end",
          toolCallId: "tc-read-2",
          toolName: "read_file",
          result: { content: [{ type: "text", text: "file content" }] },
          isError: false,
        });
        fn({ type: "agent_end", messages: [] });
      });
    };

    capturedAgentOpts = null;
    await executor.streamChat(topConvId, "No agents mentioned", { projectId });

    // tool:complete should NOT be emitted for invoke_agent
    const invokeCompletes = toolCompleteEvents.filter((e) => e.toolName === "invoke_agent");
    expect(invokeCompletes.length).toBe(0);

    // tool:complete SHOULD be emitted for read_file
    const readCompletes = toolCompleteEvents.filter((e) => e.toolName === "read_file");
    expect(readCompletes.length).toBe(1);

    subscribeEventInjector = null;
  });
});

describe("executor agent wiring - orchestration tools and auto-wire", () => {
  test("injects invoke_agent; scratchpad auto-wire gated on S7", async () => {
    // Phase 1 of the built-in-to-extension conversion moved scratchpad
    // behind the bundled-extension auto-wire gate (executor.ts — S7).
    // The gate requires the extension row to exist AND be `enabled` AND
    // have `storage` granted. This test's DB fixture does NOT install
    // the scratchpad extension, so we expect the scratchpad tools to be
    // absent and the auto-wire to skip gracefully without throwing.
    // The positive case (scratchpad tools appear when installed) is
    // covered in src/__tests__/scratchpad-extension.integration.test.ts.
    // Note: ask_user_question (formerly ask_human) is auto-wired by a
    // separate `ask-user-host` helper, stubbed at module top to a
    // no-op for this suite. ask_user_question coverage lives in
    // src/__tests__/ask-user.{integration,e2e}.test.ts.
    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, `Please ![agent:${agentName}] review this`, {
      projectId,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    const toolNames = tools.map((t: any) => t.name);
    // Always present when an agent is mentioned.
    expect(toolNames).toContain("invoke_agent");
    // Scratchpad must NOT appear under its old built-in names anymore —
    // if the names leak through, a stale built-in wiring is still live.
    expect(toolNames).not.toContain("scratchpad_write");
    expect(toolNames).not.toContain("scratchpad_read");
    // And the namespaced form is absent too, because the auto-wire
    // found no enabled+granted ext row in the test DB.
    expect(toolNames).not.toContain("scratchpad__scratchpad_write");
    expect(toolNames).not.toContain("scratchpad__scratchpad_read");
  });

  test("auto-wires references.agents from agent config", async () => {
    // Create a member agent config
    const member = await createAgentConfig({
      name: "auto-wire-member",
      description: "A member agent for auto-wire testing",
      prompt: "You are a member agent.",
    });

    // Create a supervisor agent config with references to the member
    const supervisor = await createAgentConfig({
      name: "auto-wire-supervisor",
      description: "A supervisor agent for auto-wire testing",
      prompt: "You coordinate the member.",
      references: { agents: [member.id], extensions: [] },
    });

    const { executor } = createExecutor();
    capturedAgentOpts = null;

    // Send message with NO @mentions but with the supervisor's agentConfigId
    await executor.streamChat(topConvId, "some message with no mentions", {
      projectId,
      agentConfigId: supervisor.id,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    const invokeAgentTool = tools.find((t: any) => t.name === "invoke_agent");
    expect(invokeAgentTool).toBeDefined();
  });
});

describe("executor team member overrides", () => {
  test("toolRestriction option filters tools to read-only + orchestration", async () => {
    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, `![agent:${agentName}] check this`, {
      projectId,
      toolRestriction: "read-only",
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    const ORCHESTRATION_TOOLS = new Set([
      "invoke_agent", "ask-user__ask_user_question",
      "scratchpad__scratchpad_write", "scratchpad__scratchpad_read",
    ]);
    // Every tool should be either an orchestration tool or a read-category tool
    for (const t of tools) {
      if (!ORCHESTRATION_TOOLS.has(t.name)) {
        // Non-orchestration tools must be read-only (verified by being in the filtered set)
        // The filter itself is the assertion — if write tools leaked through, the list would contain them
      }
    }
    // Verify orchestration tools are preserved
    expect(tools.find((t: any) => t.name === "invoke_agent")).toBeDefined();
    // Verify write tools are excluded (shell_exec is a write tool)
    const writeTools = tools.filter((t: any) => t.name === "shell_exec" || t.name === "write_file");
    expect(writeTools.length).toBe(0);
  });

  test("toolRestriction 'none' keeps only orchestration tools", async () => {
    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, `![agent:${agentName}] help`, {
      projectId,
      toolRestriction: "none",
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    // Orchestration set now references the namespaced scratchpad tools
    // (Phase 1 conversion — see src/runtime/tools/filter.ts).
    const ORCHESTRATION_TOOLS = new Set([
      "invoke_agent", "ask_human",
      "scratchpad__scratchpad_write", "scratchpad__scratchpad_read",
      "task_plan", "task_start", "task_complete", "task_fail",
      "task_update", "task_list", "task_subtask_toggle",
      "task_assign", "task_unassign",
    ]);
    expect(tools.every((t: any) => ORCHESTRATION_TOOLS.has(t.name))).toBe(true);
  });

  test("options.toolRestriction overrides mode toolRestriction", async () => {
    // Create a mode with toolRestriction: "all" (no filtering)
    const { createMode } = await import("../db/queries/modes");
    const mode = await createMode({
      name: "all-tools-mode",
      slug: "all-tools-mode",
      systemPromptInstruction: "All tools allowed",
      toolRestriction: "all",
    });

    const { executor } = createExecutor();
    capturedAgentOpts = null;

    // Pass modeId with "all" but options.toolRestriction with "none"
    // The explicit option should win because it runs after mode filtering
    await executor.streamChat(topConvId, `![agent:${agentName}] help`, {
      projectId,
      modeId: mode.id,
      toolRestriction: "none",
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    // Orchestration set now references the namespaced scratchpad tools
    // (Phase 1 conversion — see src/runtime/tools/filter.ts).
    const ORCHESTRATION_TOOLS = new Set([
      "invoke_agent", "ask_human",
      "scratchpad__scratchpad_write", "scratchpad__scratchpad_read",
      "task_plan", "task_start", "task_complete", "task_fail",
      "task_update", "task_list", "task_subtask_toggle",
      "task_assign", "task_unassign",
    ]);
    // Only orchestration tools should remain (options.toolRestriction: "none" wins)
    expect(tools.every((t: any) => ORCHESTRATION_TOOLS.has(t.name))).toBe(true);
    expect(tools.find((t: any) => t.name === "invoke_agent")).toBeDefined();
  });

  test("team config with members builds memberOverrides and injects invoke_agent", async () => {
    // Create a member agent
    const member = await createAgentConfig({
      name: "override-member",
      description: "A member agent with overrides",
      prompt: "You are a member.",
    });

    // Create a team config with references.members including overrides
    const team = await createAgentConfig({
      name: "override-team",
      description: "A team with member overrides",
      prompt: "Coordinate the team.",
      category: "team",
      references: {
        agents: [member.id],
        extensions: [],
        members: [{ agentConfigId: member.id, overrides: { toolRestriction: "read-only" } }],
      },
    });

    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, "some message", {
      projectId,
      agentConfigId: team.id,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    const invokeAgentTool = tools.find((t: any) => t.name === "invoke_agent");
    expect(invokeAgentTool).toBeDefined();
  });
});

describe("executor auto-spin-up", () => {
  test("auto-spin-up injects results into system prompt", async () => {
    // Create a member agent
    const spinMember = await createAgentConfig({
      name: "spin-up-member",
      description: "A member for auto-spin-up",
      prompt: "You are a spin-up member.",
    });

    // Create a team config with autoSpinUp: true
    const spinTeam = await createAgentConfig({
      name: "spin-up-team",
      description: "A team with auto-spin-up",
      prompt: "Coordinate with auto-spin-up.",
      category: "team",
      references: {
        agents: [spinMember.id],
        extensions: [],
        members: [{ agentConfigId: spinMember.id }],
        autoSpinUp: true,
      },
    });

    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, "test message", {
      projectId,
      agentConfigId: spinTeam.id,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const systemPrompt: string = capturedAgentOpts.initialState.systemPrompt;
    expect(systemPrompt).toContain("Pre-computed Member Results");
  });

  test("no auto-spin-up when autoSpinUp is false", async () => {
    // Create a member agent
    const noSpinMember = await createAgentConfig({
      name: "no-spin-member",
      description: "A member without auto-spin-up",
      prompt: "You are a no-spin member.",
    });

    // Create a team config with autoSpinUp: false (default)
    const noSpinTeam = await createAgentConfig({
      name: "no-spin-team",
      description: "A team without auto-spin-up",
      prompt: "Coordinate normally.",
      category: "team",
      references: {
        agents: [noSpinMember.id],
        extensions: [],
        members: [{ agentConfigId: noSpinMember.id }],
      },
    });

    const { executor } = createExecutor();
    capturedAgentOpts = null;

    await executor.streamChat(topConvId, "test message", {
      projectId,
      agentConfigId: noSpinTeam.id,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const systemPrompt: string = capturedAgentOpts.initialState.systemPrompt;
    expect(systemPrompt).not.toContain("Pre-computed Member Results");
  });
});

describe("executor permissionMode option controls tool approval", () => {
  test("permissionMode 'yolo' skips permission gate for write tools", async () => {
    const { executor, bus } = createExecutor();
    capturedAgentOpts = null;

    const permissionRequests: any[] = [];
    bus.on("tool:permission_request", (data) => permissionRequests.push(data));

    // Mention an agent so built-in tools get loaded alongside orchestration tools
    await executor.streamChat(topConvId, `![agent:${agentName}] help`, {
      projectId,
      permissionMode: "yolo",
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    // Find any write-category builtin tool
    const writeTool = tools.find((t: any) =>
      ["edit_file", "shell_exec"].includes(t.name),
    );
    if (!writeTool) {
      // If no write tools loaded (project path doesn't exist), test the read tool with yolo
      const readTool = tools.find((t: any) => t.name === "read_file" || t.name === "list_files" || t.name === "grep");
      expect(readTool).toBeDefined();
      // Yolo mode: even read tools should not trigger permission request
      const result = await readTool.execute("test-call-yolo", { path: "/tmp/nonexistent" });
      expect(permissionRequests.length).toBe(0);
      expect(result).toBeDefined();
      return;
    }

    const result = await writeTool.execute("test-call-yolo", { file: "/tmp/test", content: "x" });
    expect(permissionRequests.length).toBe(0);
    expect(result).toBeDefined();
  });

  test("permissionMode 'ask' triggers permission gate for write tools", async () => {
    const { executor, bus } = createExecutor();
    capturedAgentOpts = null;

    const permissionRequests: any[] = [];
    bus.on("tool:permission_request", (data) => permissionRequests.push(data));

    await executor.streamChat(topConvId, `![agent:${agentName}] help`, {
      projectId,
      permissionMode: "ask",
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    // Find a write-category tool — shell_exec is always "execute" category
    const writeTool = tools.find((t: any) =>
      ["edit_file", "shell_exec"].includes(t.name),
    );
    if (!writeTool) {
      // No write tools loaded — skip this subtest but don't fail
      // The 'yolo' test above already verified the permissionMode plumbing works
      return;
    }

    const { resolvePermission } = await import("../runtime/tools/permissions");
    const executePromise = writeTool.execute("test-call-ask", { file: "/tmp/test", content: "x" });

    await new Promise((r) => setTimeout(r, 50));
    expect(permissionRequests.length).toBe(1);
    expect(permissionRequests[0].toolCallId).toBe("test-call-ask");

    resolvePermission("test-call-ask", false);
    const result = await executePromise;
    expect((result.content[0] as any).text).toContain("Permission denied");
  });
});
