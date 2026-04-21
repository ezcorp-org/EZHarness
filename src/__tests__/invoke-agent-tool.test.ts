import { test, expect, describe, beforeAll, afterAll, mock, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, restoreFetch } from "./helpers/test-pglite";

mockDbConnection();

beforeEach(() => {
  restoreFetch();
  mockDbConnection();
});

import { createInvokeAgentTool, type InvokeAgentOpts } from "../runtime/tools/invoke-agent";
import { EventBus } from "../runtime/events";
import { CURRENT_MODEL_SENTINEL, type AgentEvents } from "../types";
import { createProject } from "../db/queries/projects";
import { createAgentConfig } from "../db/queries/agent-configs";
import { createMessage } from "../db/queries/conversations";
import { createConversation } from "../db/queries/conversations";

let projectId: string;
let parentConvId: string;
let agentConfigId: string;
let currentModelAgentId: string;
let specificModelAgentId: string;
const agentName = "test-agent";
const agentDescription = "A test agent for invocation";

beforeAll(async () => {
  restoreFetch();
  mockDbConnection();
  await setupTestDb();
  const project = await createProject({ name: "Invoke Test", path: "/tmp/invoke-test" });
  projectId = project.id;
  const conv = await createConversation(projectId);
  parentConvId = conv.id;
  const config = await createAgentConfig({
    name: agentName,
    description: agentDescription,
    prompt: "You are a test agent.",
  });
  agentConfigId = config.id;

  // Agent with model set to "__current__" sentinel
  const currentModelConfig = await createAgentConfig({
    name: "current-model-agent",
    description: "Agent that uses current chat model",
    prompt: "You follow the chat model.",
    provider: CURRENT_MODEL_SENTINEL,
    model: CURRENT_MODEL_SENTINEL,
  });
  currentModelAgentId = currentModelConfig.id;

  // Agent with a specific model set
  const specificModelConfig = await createAgentConfig({
    name: "specific-model-agent",
    description: "Agent with a hardcoded model",
    prompt: "You use a specific model.",
    provider: "openai",
    model: "gpt-4o",
  });
  specificModelAgentId = specificModelConfig.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function makeOpts(overrides?: Partial<InvokeAgentOpts>): InvokeAgentOpts {
  const bus = new EventBus<AgentEvents>();
  const mockExecutor = {
    streamChat: mock(async (subConvId: string, task: string, opts: any) => {
      // Insert fake assistant message so getLatestLeaf finds it
      await createMessage(subConvId, { role: "assistant", content: "Agent response text" });
      return { id: opts.runId, status: "success", agentName: "chat", startedAt: Date.now(), logs: [] };
    }),
    cancelRun: mock(() => true),
  };

  return {
    executor: mockExecutor as any,
    bus,
    parentConversationId: parentConvId,
    parentRunId: crypto.randomUUID(),
    projectId,
    availableAgents: [{ id: agentConfigId, name: agentName, description: agentDescription }],
    ...overrides,
  };
}

// ── Shape ─────────────────────────────────────────────────────────────

describe("createInvokeAgentTool", () => {
  test("returns AgentTool with correct name, description, and parameters schema", () => {
    const opts = makeOpts();
    const tool = createInvokeAgentTool(opts);
    expect(tool.name).toBe("invoke_agent");
    expect(tool.description).toContain("specialized agent");
    expect(tool.parameters).toBeDefined();
  });

  test("parameters schema includes agentConfigId and task", () => {
    const opts = makeOpts();
    const tool = createInvokeAgentTool(opts);
    const schema = tool.parameters as any;
    expect(schema.type).toBe("object");
    expect(schema.properties.agentConfigId).toBeDefined();
    expect(schema.properties.task).toBeDefined();
    expect(schema.required).toContain("agentConfigId");
    expect(schema.required).toContain("task");
  });
});

// ── Happy Path ────────────────────────────────────────────────────────

describe("invoke_agent execution - happy path", () => {
  test("creates sub-conversation with correct parentConversationId and agentConfigId", async () => {
    const opts = makeOpts();
    const tool = createInvokeAgentTool(opts);

    const result = await tool.execute("tc-1", { agentConfigId, task: "Do something" });

    // The mock executor was called — verify sub-conversation was created
    // by checking the executor's streamChat first arg is a valid conv id
    const streamCall = (opts.executor.streamChat as any).mock.calls[0];
    expect(streamCall).toBeDefined();
    const subConvId = streamCall[0];
    expect(typeof subConvId).toBe("string");

    // Verify streamChat was called with the correct agentConfigId
    const streamOpts = streamCall[2];
    expect(streamOpts.agentConfigId).toBe(agentConfigId);
  });

  test("emits agent:spawn event with all required fields", async () => {
    const opts = makeOpts();
    const tool = createInvokeAgentTool(opts);

    const spawnEvents: any[] = [];
    opts.bus.on("agent:spawn", (data) => spawnEvents.push(data));

    await tool.execute("tc-2", { agentConfigId, task: "Plan things" });

    expect(spawnEvents.length).toBe(1);
    const ev = spawnEvents[0];
    expect(ev.runId).toBe(opts.parentRunId);
    expect(ev.agentRunId).toBeDefined();
    expect(ev.subConversationId).toBeDefined();
    expect(ev.agentName).toBe(agentName);
    expect(ev.agentConfigId).toBe(agentConfigId);
    expect(ev.task).toBe("Plan things");
    expect(ev.parentConversationId).toBe(parentConvId);
  });

  test("emits agent:complete with success=true on successful run", async () => {
    const opts = makeOpts();
    const tool = createInvokeAgentTool(opts);

    const completeEvents: any[] = [];
    opts.bus.on("agent:complete", (data) => completeEvents.push(data));

    await tool.execute("tc-3", { agentConfigId, task: "Review code" });

    expect(completeEvents.length).toBe(1);
    const ev = completeEvents[0];
    expect(ev.success).toBe(true);
    expect(ev.agentName).toBe(agentName);
    expect(ev.agentConfigId).toBe(agentConfigId);
    expect(ev.runId).toBe(opts.parentRunId);
    expect(ev.resultPreview).toContain("Agent response text");
  });

  test("returns tool result containing agent's response text", async () => {
    const opts = makeOpts();
    const tool = createInvokeAgentTool(opts);

    const result = await tool.execute("tc-4", { agentConfigId, task: "Summarize" });

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]!.type).toBe("text");
    expect((result.content[0] as any).text).toBe("Agent response text");
  });

  test("includes _agentMeta in result details on success", async () => {
    const opts = makeOpts();
    const tool = createInvokeAgentTool(opts);

    const result = await tool.execute("tc-meta-1", { agentConfigId, task: "Meta test" });

    const meta = (result as any).details?._agentMeta;
    expect(meta).toBeDefined();
    expect(meta.agentName).toBe(agentName);
    expect(meta.agentConfigId).toBe(agentConfigId);
    expect(typeof meta.subConversationId).toBe("string");
  });

  test("truncates resultPreview to 200 chars with ellipsis for long responses", async () => {
    const longText = "A".repeat(300);
    const longExecutor = {
      streamChat: mock(async (subConvId: string, _task: string, opts: any) => {
        await createMessage(subConvId, { role: "assistant", content: longText });
        return { id: opts.runId, status: "success", agentName: "chat", startedAt: Date.now(), logs: [] };
      }),
      cancelRun: mock(() => true),
    };

    const opts = makeOpts({ executor: longExecutor as any });
    const tool = createInvokeAgentTool(opts);

    const completeEvents: any[] = [];
    opts.bus.on("agent:complete", (data) => completeEvents.push(data));

    await tool.execute("tc-trunc-1", { agentConfigId, task: "Long response" });

    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0].resultPreview.length).toBeLessThanOrEqual(203); // 200 + "..."
    expect(completeEvents[0].resultPreview.endsWith("...")).toBe(true);
  });
});

// ── Error Handling ────────────────────────────────────────────────────

describe("invoke_agent execution - error handling", () => {
  test("rejects invalid agentConfigId not in available agents list", async () => {
    const opts = makeOpts();
    const tool = createInvokeAgentTool(opts);

    const result = await tool.execute("tc-err-1", {
      agentConfigId: "nonexistent-id",
      task: "This should fail",
    });

    expect((result.content[0] as any).text).toContain("Error");
    expect((result.content[0] as any).text).toContain("Unknown agent");
    expect((result as any).details?.isError).toBe(true);
  });

  test("emits agent:complete with success=false when streamChat throws", async () => {
    const failingExecutor = {
      streamChat: mock(async () => {
        throw new Error("LLM provider failed");
      }),
      cancelRun: mock(() => true),
    };

    const opts = makeOpts({ executor: failingExecutor as any });
    const tool = createInvokeAgentTool(opts);

    const completeEvents: any[] = [];
    opts.bus.on("agent:complete", (data) => completeEvents.push(data));

    const result = await tool.execute("tc-err-2", { agentConfigId, task: "Fail please" });

    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0].success).toBe(false);
    expect(completeEvents[0].resultPreview).toContain("LLM provider failed");
  });

  test("returns error content in tool result when agent fails", async () => {
    const failingExecutor = {
      streamChat: mock(async () => {
        throw new Error("Connection timeout");
      }),
      cancelRun: mock(() => true),
    };

    const opts = makeOpts({ executor: failingExecutor as any });
    const tool = createInvokeAgentTool(opts);

    const result = await tool.execute("tc-err-3", { agentConfigId, task: "Timeout test" });

    expect((result.content[0] as any).text).toContain("failed");
    expect((result.content[0] as any).text).toContain("Connection timeout");
    expect((result as any).details?.isError).toBe(true);
  });

  test("includes _agentMeta in result details even on failure", async () => {
    const failingExecutor = {
      streamChat: mock(async () => {
        throw new Error("Agent crash");
      }),
      cancelRun: mock(() => true),
    };

    const opts = makeOpts({ executor: failingExecutor as any });
    const tool = createInvokeAgentTool(opts);

    const result = await tool.execute("tc-err-meta", { agentConfigId, task: "Meta error" });

    const meta = (result as any).details?._agentMeta;
    expect(meta).toBeDefined();
    expect(meta.agentName).toBe(agentName);
    expect(meta.agentConfigId).toBe(agentConfigId);
    expect(typeof meta.subConversationId).toBe("string");
    expect((result as any).details?.isError).toBe(true);
  });
});

// ── Status Bridging ───────────────────────────────────────────────────

describe("invoke_agent execution - status bridging", () => {
  test("bridges run:status events from agentRunId to agent:status with parent runId", async () => {
    const bus = new EventBus<AgentEvents>();
    let capturedAgentRunId: string | undefined;

    const slowExecutor = {
      streamChat: mock(async (subConvId: string, task: string, opts: any) => {
        capturedAgentRunId = opts.runId;
        // Emit a run:status event for the agent's runId during execution
        bus.emit("run:status", { runId: opts.runId, status: "generating" } as any);
        // Insert message for getLatestLeaf
        await createMessage(subConvId, { role: "assistant", content: "Done" });
        return { id: opts.runId, status: "success", agentName: "chat", startedAt: Date.now(), logs: [] };
      }),
      cancelRun: mock(() => true),
    };

    const parentRunId = crypto.randomUUID();
    const opts = makeOpts({ executor: slowExecutor as any, bus, parentRunId });
    const tool = createInvokeAgentTool(opts);

    const statusEvents: any[] = [];
    bus.on("agent:status", (data) => statusEvents.push(data));

    await tool.execute("tc-status-1", { agentConfigId, task: "Bridge test" });

    expect(statusEvents.length).toBe(1);
    expect(statusEvents[0].runId).toBe(parentRunId);
    expect(statusEvents[0].status).toBe("generating");
    expect(statusEvents[0].agentName).toBe(agentName);
  });

  test("unsubscribes from run:status after execution completes", async () => {
    const bus = new EventBus<AgentEvents>();
    let capturedAgentRunId: string | undefined;

    const executor = {
      streamChat: mock(async (subConvId: string, task: string, opts: any) => {
        capturedAgentRunId = opts.runId;
        await createMessage(subConvId, { role: "assistant", content: "Done" });
        return { id: opts.runId, status: "success", agentName: "chat", startedAt: Date.now(), logs: [] };
      }),
      cancelRun: mock(() => true),
    };

    const opts = makeOpts({ executor: executor as any, bus });
    const tool = createInvokeAgentTool(opts);

    const statusEvents: any[] = [];
    bus.on("agent:status", (data) => statusEvents.push(data));

    await tool.execute("tc-status-2", { agentConfigId, task: "Unsub test" });

    // After execute completes, emit a run:status for the agent's runId
    // It should NOT be bridged because the subscription was cleaned up
    bus.emit("run:status", { runId: capturedAgentRunId!, status: "late-event" } as any);

    expect(statusEvents.length).toBe(0);
  });
});

// ── Member Overrides ─────────────────────────────────────────────────

describe("invoke-agent member overrides", () => {
  test("applies model override from memberOverrides", async () => {
    const memberOverrides = new Map([
      [agentConfigId, { model: "gpt-4o" }],
    ]);
    const opts = makeOpts({ memberOverrides });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-mo-1", { agentConfigId, task: "Model override test" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(streamOpts.model).toBe("gpt-4o");
  });

  test("applies provider override from memberOverrides", async () => {
    const memberOverrides = new Map([
      [agentConfigId, { provider: "openai" }],
    ]);
    const opts = makeOpts({ memberOverrides });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-mo-2", { agentConfigId, task: "Provider override test" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(streamOpts.provider).toBe("openai");
  });

  test("applies permissionMode override from memberOverrides", async () => {
    const memberOverrides = new Map([
      [agentConfigId, { permissionMode: "yolo" as const }],
    ]);
    const opts = makeOpts({ memberOverrides });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-mo-3", { agentConfigId, task: "Permission override test" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(streamOpts.permissionMode).toBe("yolo");
  });

  test("applies toolRestriction override from memberOverrides", async () => {
    const memberOverrides = new Map([
      [agentConfigId, { toolRestriction: "read-only" as const }],
    ]);
    const opts = makeOpts({ memberOverrides });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-mo-4", { agentConfigId, task: "Tool restriction override test" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(streamOpts.toolRestriction).toBe("read-only");
  });

  test("applies systemPromptAppend by concatenating with original prompt", async () => {
    const memberOverrides = new Map([
      [agentConfigId, { systemPromptAppend: "Extra instructions" }],
    ]);
    const opts = makeOpts({ memberOverrides });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-mo-5", { agentConfigId, task: "System prompt append test" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    // The system prompt should contain the original agent prompt plus the appended text
    expect(streamOpts.system).toContain("You are a test agent.");
    expect(streamOpts.system).toContain("Extra instructions");
    // Verify they're concatenated with separator
    expect(streamOpts.system).toBe("You are a test agent.\n\nExtra instructions");
  });

  test("no overrides applied when agentConfigId is not in memberOverrides map", async () => {
    const otherAgentId = "some-other-agent-id";
    const memberOverrides = new Map([
      [otherAgentId, { model: "gpt-4o", provider: "openai", permissionMode: "yolo" as const }],
    ]);
    const opts = makeOpts({ memberOverrides });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-mo-6", { agentConfigId, task: "No override test" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    // Should use agent config defaults, not the overrides from a different agent
    expect(streamOpts.model).not.toBe("gpt-4o");
    expect(streamOpts.provider).not.toBe("openai");
    // updated for test-regression: invoke-agent now defaults sub-agents to "yolo"
    // permissionMode (see commit cbbb749) so unattended tool execution isn't blocked
    // on approval gates — the "no override" case falls through to that default, not undefined.
    expect(streamOpts.permissionMode).toBe("yolo");
  });

  test("passes subAgentMembers for next nesting level", async () => {
    const subAgentMembers = [
      {
        agentConfigId,
        subAgents: [{ agentConfigId: "agent-2" }],
      },
    ];
    const opts = makeOpts({ subAgentMembers });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-mo-7", { agentConfigId, task: "Sub-agent members test" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(streamOpts.subAgentMembers).toEqual([{ agentConfigId: "agent-2" }]);
  });

  test("returns error for unknown agentConfigId", async () => {
    const opts = makeOpts();
    const tool = createInvokeAgentTool(opts);

    const result = await tool.execute("tc-mo-8", {
      agentConfigId: "nonexistent-agent",
      task: "This should fail",
    });

    expect(result.content).toBeDefined();
    expect(result.content.length).toBe(1);
    expect(result.content[0]!.type).toBe("text");
    expect((result.content[0] as any).text).toContain("Error");
    expect((result.content[0] as any).text).toContain("Unknown agent");
    expect((result as any).details.isError).toBe(true);
  });

  test("passes modeId override to streamChat", async () => {
    const memberOverrides = new Map([
      [agentConfigId, { modeId: "mode-123" }],
    ]);
    const opts = makeOpts({ memberOverrides });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-mo-mode-1", { agentConfigId, task: "Mode override test" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(streamOpts.modeId).toBe("mode-123");
  });
});

// ── Current Model Sentinel ──────────────────────────────────────────

describe("invoke-agent __current__ model sentinel", () => {
  function makeCurrentOpts(overrides?: Partial<InvokeAgentOpts>): InvokeAgentOpts {
    const bus = new EventBus<AgentEvents>();
    const mockExecutor = {
      streamChat: mock(async (subConvId: string, _task: string, opts: any) => {
        await createMessage(subConvId, { role: "assistant", content: "Agent response" });
        return { id: opts.runId, status: "success", agentName: "chat", startedAt: Date.now(), logs: [] };
      }),
      cancelRun: mock(() => true),
    };
    return {
      executor: mockExecutor as any,
      bus,
      parentConversationId: parentConvId,
      parentRunId: crypto.randomUUID(),
      projectId,
      parentModel: "claude-sonnet-4-20250514",
      parentProvider: "anthropic",
      availableAgents: [
        { id: agentConfigId, name: agentName, description: agentDescription },
        { id: currentModelAgentId, name: "current-model-agent", description: "Uses current chat model" },
        { id: specificModelAgentId, name: "specific-model-agent", description: "Uses specific model" },
      ],
      ...overrides,
    };
  }

  test("agent config with __current__ resolves to parentModel/parentProvider", async () => {
    const opts = makeCurrentOpts();
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-cur-1", { agentConfigId: currentModelAgentId, task: "Use current model" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(streamOpts.model).toBe("claude-sonnet-4-20250514");
    expect(streamOpts.provider).toBe("anthropic");
  });

  test("member override __current__ overrides agent config's specific model", async () => {
    const memberOverrides = new Map([
      [specificModelAgentId, {
        model: CURRENT_MODEL_SENTINEL,
        provider: CURRENT_MODEL_SENTINEL,
      }],
    ]);
    const opts = makeCurrentOpts({ memberOverrides });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-cur-2", { agentConfigId: specificModelAgentId, task: "Override to current" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(streamOpts.model).toBe("claude-sonnet-4-20250514");
    expect(streamOpts.provider).toBe("anthropic");
  });

  test("agent with no model (null) still falls back to parentModel", async () => {
    const opts = makeCurrentOpts();
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-cur-3", { agentConfigId, task: "Null model fallback" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(streamOpts.model).toBe("claude-sonnet-4-20250514");
    expect(streamOpts.provider).toBe("anthropic");
  });

  test("specific model on agent config is NOT overridden when no sentinel is used", async () => {
    const opts = makeCurrentOpts();
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-cur-4", { agentConfigId: specificModelAgentId, task: "Keep specific model" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(streamOpts.model).toBe("gpt-4o");
    expect(streamOpts.provider).toBe("openai");
  });

  test("__current__ with undefined parentModel falls through gracefully", async () => {
    const opts = makeCurrentOpts({ parentModel: undefined, parentProvider: undefined });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-cur-5", { agentConfigId: currentModelAgentId, task: "No parent model" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    // Should be undefined (will be resolved downstream by resolveModel defaults)
    expect(streamOpts.model).toBeUndefined();
    expect(streamOpts.provider).toBeUndefined();
  });

  test("integration: team config members with __current__ override built like executor", async () => {
    // Simulate the exact path the executor uses to build memberOverrides from a team config.
    // This mirrors executor.ts lines 711-719.
    const teamMembers: import("../types").TeamMember[] = [
      {
        agentConfigId: specificModelAgentId,
        overrides: { model: CURRENT_MODEL_SENTINEL, provider: CURRENT_MODEL_SENTINEL },
      },
      {
        agentConfigId: currentModelAgentId,
        // no overrides — agent config itself has __current__
      },
      {
        agentConfigId: agentConfigId,
        // no overrides, no model on agent config — pure fallback
      },
    ];

    // Build overridesMap exactly as executor does
    const overridesMap = new Map<string, import("../types").TeamMemberOverrides>();
    for (const m of teamMembers) {
      if (m.overrides) overridesMap.set(m.agentConfigId, m.overrides);
    }

    const opts = makeCurrentOpts({
      memberOverrides: overridesMap,
      subAgentMembers: teamMembers,
    });
    const tool = createInvokeAgentTool(opts);

    // Invoke all three agents and check model resolution

    // Agent with override __current__: should use parentModel
    await tool.execute("tc-int-1", { agentConfigId: specificModelAgentId, task: "test" });
    const call1 = (opts.executor.streamChat as any).mock.calls[0][2];
    expect(call1.model).toBe("claude-sonnet-4-20250514");
    expect(call1.provider).toBe("anthropic");

    // Agent with config __current__ (no override): should use parentModel
    await tool.execute("tc-int-2", { agentConfigId: currentModelAgentId, task: "test" });
    const call2 = (opts.executor.streamChat as any).mock.calls[1][2];
    expect(call2.model).toBe("claude-sonnet-4-20250514");
    expect(call2.provider).toBe("anthropic");

    // Agent with no model anywhere: should use parentModel (fallback)
    await tool.execute("tc-int-3", { agentConfigId, task: "test" });
    const call3 = (opts.executor.streamChat as any).mock.calls[2][2];
    expect(call3.model).toBe("claude-sonnet-4-20250514");
    expect(call3.provider).toBe("anthropic");
  });

  test("override __current__ only overrides model, preserves other override fields", async () => {
    const memberOverrides = new Map([
      [specificModelAgentId, {
        model: CURRENT_MODEL_SENTINEL,
        provider: CURRENT_MODEL_SENTINEL,
        systemPromptAppend: "Extra instructions",
        permissionMode: "yolo" as const,
      }],
    ]);
    const opts = makeCurrentOpts({ memberOverrides });
    const tool = createInvokeAgentTool(opts);

    await tool.execute("tc-cur-mixed", { agentConfigId: specificModelAgentId, task: "Mixed overrides" });

    const streamOpts = (opts.executor.streamChat as any).mock.calls[0][2];
    // Model resolved to parent (current chat)
    expect(streamOpts.model).toBe("claude-sonnet-4-20250514");
    expect(streamOpts.provider).toBe("anthropic");
    // Other overrides preserved
    expect(streamOpts.system).toContain("Extra instructions");
    expect(streamOpts.permissionMode).toBe("yolo");
  });
});

// ── Task Assignment Sentinel Resolution ─────────────────────────────

describe("task assignment __current__ sentinel resolution", () => {
  // Simulates the exact resolution logic from start/+server.ts.
  // The endpoint now accepts bodyModel/bodyProvider from the frontend,
  // which is the user's currently-selected chat model.
  function resolveForTaskAssignment(
    configModel: string | null | undefined,
    configProvider: string | null | undefined,
    bodyModel: string | undefined,
    bodyProvider: string | undefined,
    convModel: string | null | undefined,
    convProvider: string | null | undefined,
  ) {
    return {
      model: configModel === CURRENT_MODEL_SENTINEL
        ? (bodyModel ?? convModel ?? undefined)
        : (configModel ?? bodyModel ?? convModel ?? undefined),
      provider: configProvider === CURRENT_MODEL_SENTINEL
        ? (bodyProvider ?? convProvider ?? undefined)
        : (configProvider ?? bodyProvider ?? convProvider ?? undefined),
    };
  }

  test("__current__ on agent config resolves to body model (current chat model)", () => {
    const result = resolveForTaskAssignment(
      CURRENT_MODEL_SENTINEL, CURRENT_MODEL_SENTINEL,
      "claude-sonnet-4-20250514", "anthropic",
      null, null,
    );
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
  });

  test("__current__ falls back to conv model when body has no model", () => {
    const result = resolveForTaskAssignment(
      CURRENT_MODEL_SENTINEL, CURRENT_MODEL_SENTINEL,
      undefined, undefined,
      "claude-sonnet-4-20250514", "anthropic",
    );
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
  });

  test("specific agent model takes precedence over body and conversation model", () => {
    const result = resolveForTaskAssignment(
      "gpt-4o", "openai",
      "claude-sonnet-4-20250514", "anthropic",
      "gemini-pro", "google",
    );
    expect(result.model).toBe("gpt-4o");
    expect(result.provider).toBe("openai");
  });

  test("null agent model falls back to body model (default agent uses chat model)", () => {
    const result = resolveForTaskAssignment(
      null, null,
      "claude-sonnet-4-20250514", "anthropic",
      null, null,
    );
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
  });

  test("null agent model, no body model, falls back to conversation model", () => {
    const result = resolveForTaskAssignment(
      null, null,
      undefined, undefined,
      "claude-sonnet-4-20250514", "anthropic",
    );
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
  });

  test("__current__ with no body and no conv model resolves to undefined", () => {
    const result = resolveForTaskAssignment(
      CURRENT_MODEL_SENTINEL, CURRENT_MODEL_SENTINEL,
      undefined, undefined,
      null, null,
    );
    expect(result.model).toBeUndefined();
    expect(result.provider).toBeUndefined();
  });

  test("sentinel string never leaks through to resolved values", () => {
    const cases = [
      { cm: CURRENT_MODEL_SENTINEL, cp: CURRENT_MODEL_SENTINEL, bm: "x", bp: "y", vm: null, vp: null },
      { cm: CURRENT_MODEL_SENTINEL, cp: CURRENT_MODEL_SENTINEL, bm: undefined, bp: undefined, vm: null, vp: null },
      { cm: CURRENT_MODEL_SENTINEL, cp: "openai", bm: "x", bp: "y", vm: null, vp: null },
      { cm: "gpt-4o", cp: CURRENT_MODEL_SENTINEL, bm: "x", bp: "y", vm: null, vp: null },
    ];
    for (const c of cases) {
      const result = resolveForTaskAssignment(c.cm, c.cp, c.bm, c.bp, c.vm, c.vp);
      expect(result.model).not.toBe(CURRENT_MODEL_SENTINEL);
      expect(result.provider).not.toBe(CURRENT_MODEL_SENTINEL);
    }
  });
});

// ── Timeout path (Promise.race) ───────────────────────────────────────

describe("createInvokeAgentTool — timeout handling", () => {
  test("emits agent:complete {success:false} when streamChat hangs past timeout", async () => {
    // Mock executor whose streamChat never settles — simulates a leaked promise.
    const busEvents: Array<{ type: string; data: unknown }> = [];
    const bus = new EventBus<AgentEvents>();
    bus.on("agent:complete", (data) => busEvents.push({ type: "agent:complete", data }));
    bus.on("agent:spawn", (data) => busEvents.push({ type: "agent:spawn", data }));

    let cancelled = false;
    const hangingExecutor = {
      streamChat: mock(() => new Promise<any>(() => {})), // never resolves
      cancelRun: mock(() => { cancelled = true; return true; }),
    };

    const tool = createInvokeAgentTool({
      executor: hangingExecutor as any,
      bus,
      parentConversationId: parentConvId,
      parentRunId: crypto.randomUUID(),
      projectId,
      availableAgents: [{ id: agentConfigId, name: agentName, description: agentDescription }],
      timeoutMs: 50, // short enough to finish the test quickly
    });

    const result = await tool.execute("tc-timeout-1", { agentConfigId, task: "Hang forever" });

    // Result should indicate timeout failure
    expect((result as any).details?.isError).toBe(true);
    const text = (result as any).content[0].text as string;
    expect(text.toLowerCase()).toContain("timed out");

    // agent:complete must have been emitted with success=false — this is the critical
    // invariant: the parent run cannot be stuck waiting for a missing agent:complete.
    const completes = busEvents.filter((e) => e.type === "agent:complete");
    expect(completes.length).toBe(1);
    expect((completes[0]!.data as any).success).toBe(false);
    expect((completes[0]!.data as any).resultPreview).toContain("timed out");

    // cancelRun should have been best-effort called on the inner run
    expect(cancelled).toBe(true);
  });

  test("success path is unaffected by timeout race", async () => {
    const busEvents: Array<{ type: string; data: unknown }> = [];
    const bus = new EventBus<AgentEvents>();
    bus.on("agent:complete", (data) => busEvents.push({ type: "agent:complete", data }));

    const fastExecutor = {
      streamChat: mock(async (subConvId: string, _task: string, opts: any) => {
        await createMessage(subConvId, { role: "assistant", content: "Quick response" });
        return { id: opts.runId, status: "success", agentName: "chat", startedAt: Date.now(), logs: [] };
      }),
      cancelRun: mock(() => true),
    };

    const tool = createInvokeAgentTool({
      executor: fastExecutor as any,
      bus,
      parentConversationId: parentConvId,
      parentRunId: crypto.randomUUID(),
      projectId,
      availableAgents: [{ id: agentConfigId, name: agentName, description: agentDescription }],
      timeoutMs: 5_000, // plenty of time
    });

    const result = await tool.execute("tc-timeout-2", { agentConfigId, task: "Finish quickly" });

    expect((result as any).details?.isError).toBeUndefined();
    const completes = busEvents.filter((e) => e.type === "agent:complete");
    expect(completes.length).toBe(1);
    expect((completes[0]!.data as any).success).toBe(true);
    expect((completes[0]!.data as any).resultPreview).toBe("Quick response");
  });
});
