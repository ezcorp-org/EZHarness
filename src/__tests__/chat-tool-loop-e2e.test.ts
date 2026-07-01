import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";
import { resolve } from "path";
import type { AgentEvents } from "../types";

mockDbConnection();

// Track tool events emitted through pi-agent-core subscriber
let toolCallCount = 0;

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

// Mock pi-agent-core Agent to simulate tool call loop
mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: null };
    private _subs: any[] = [];
    private _tools: any[] = [];
    constructor(opts: any) {
      this._tools = opts.initialState?.tools ?? [];
    }
    subscribe(cb: any) { this._subs.push(cb); return () => {}; }
    abort() {}
    async prompt() {
      toolCallCount++;

      // If we have tools, simulate a tool call then text response
      if (this._tools.length > 0 && toolCallCount <= 1) {
        const tool = this._tools[0];

        // Emit tool_execution_start
        for (const sub of this._subs) {
          sub({
            type: "tool_execution_start",
            toolName: tool.name,
            args: { text: "ping" },
          });
        }

        // Actually execute the tool
        let toolResult: any;
        try {
          toolResult = await tool.execute({ text: "ping" });
        } catch (err) {
          toolResult = { error: String(err) };
        }

        // Emit tool_execution_end
        for (const sub of this._subs) {
          sub({
            type: "tool_execution_end",
            toolName: tool.name,
            result: toolResult,
            isError: false,
          });
        }
      }

      // Emit text response
      const responseText = this._tools.length > 0 ? "Got: ping" : "Hello";
      for (const sub of this._subs) {
        sub({
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: responseText,
            partial: stubAssistantMessage(responseText),
          },
        });
      }

      // Emit turn_end with usage
      const usage = {
        input: 15, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 23,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      for (const sub of this._subs) {
        sub({ type: "turn_end", message: stubAssistantMessage(responseText, { usage }) });
      }
    }
  },
}));

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { createExtension } from "../db/queries/extensions";
import { createAgentConfig } from "../db/queries/agent-configs";
import { ExtensionRegistry } from "../extensions/registry";
import { createProject } from "../db/queries/projects";
import { createConversation } from "../db/queries/conversations";
import { getConversationObservability } from "../db/queries/observability";
import { upsertSetting } from "../db/queries/settings";
import { getDb } from "../db/connection";
import { agentConfigs } from "../db/schema";
import { eq } from "drizzle-orm";

const MOCK_EXT_DIR = resolve(__dirname, "helpers/mock-extension");

let extensionId: string;
let agentConfigId: string;
let projectId: string;

beforeAll(async () => {
  await setupTestDb();

  const project = await createProject({ name: "Tool Loop E2E", path: "/tmp/tool-loop-e2e" });
  projectId = project.id;

  const ext = await createExtension({
    name: "e2e-echo",
    version: "1.0.0",
    manifest: {
      name: "e2e-echo",
      version: "1.0.0",
      description: "E2E test extension",
      entrypoint: "./entrypoint.ts",
      tools: [{ name: "echo", description: "Echoes text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
      permissions: {},
    },
    source: "local:/test",
    installPath: MOCK_EXT_DIR,
  });
  extensionId = ext.id;

  const agent = await createAgentConfig({
    name: "e2e-tool-agent",
    description: "E2E tool test agent",
    prompt: "You are a test agent with tools.",
  });
  agentConfigId = agent.id;

  // Link extension to agent config (createAgentConfig doesn't set extensions field)
  await getDb()
    .update(agentConfigs)
    .set({ extensions: [extensionId] })
    .where(eq(agentConfigs.id, agentConfigId));

  // Grant permissions so the permission checker allows tool calls
  await upsertSetting(`ext:${extensionId}:always_allow:shell`, true);
  await upsertSetting(`ext:${extensionId}:always_allow:filesystem`, true);

  ExtensionRegistry.resetInstance();
  await ExtensionRegistry.getInstance().loadFromDb();
});

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  await closeTestDb();
  restoreModuleMocks();
});

describe("Chat + Tool Loop E2E", () => {
  test("tool loop executes and produces final text response", async () => {
    toolCallCount = 0;
    const conv = await createConversation(projectId, { title: "Tool Loop Text" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);

    const run = await executor.streamChat(conv.id, "Use the echo tool", { agentConfigId });

    expect(run.status).toBe("success");
    expect((run.result?.output as any)?.fullText).toBe("Got: ping");
  });

  test("tool execution emits observability events", async () => {
    toolCallCount = 0;
    const conv = await createConversation(projectId, { title: "Tool Obs Events" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);

    const toolEvents: any[] = [];
    bus.on("tool:start", (data) => toolEvents.push({ type: "start", ...data }));
    bus.on("tool:complete", (data) => toolEvents.push({ type: "complete", ...data }));

    await executor.streamChat(conv.id, "Echo test", { agentConfigId });

    const startEvent = toolEvents.find((e) => e.type === "start");
    const completeEvent = toolEvents.find((e) => e.type === "complete");

    expect(startEvent).toBeDefined();
    expect(startEvent.toolName).toBe("e2e-echo__echo");
    expect(completeEvent).toBeDefined();
    expect(completeEvent.toolName).toBe("e2e-echo__echo");
    expect(completeEvent.success).toBe(true);
  });

  test("obs:turn event includes LLM and tool timing", async () => {
    toolCallCount = 0;
    const conv = await createConversation(projectId, { title: "Tool Turn Timing" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);

    let turnEvent: any = null;
    bus.on("obs:turn", (data) => { turnEvent = data; });

    await executor.streamChat(conv.id, "Timing test", { agentConfigId });

    expect(turnEvent).not.toBeNull();
    expect(turnEvent.conversationId).toBe(conv.id);
    expect(turnEvent.llmDurationMs).toBeGreaterThanOrEqual(0);
    expect(turnEvent.totalDurationMs).toBeGreaterThanOrEqual(0);
    // Usage from the mock turn_end event
    expect(turnEvent.tokenUsage.input).toBe(15);
    expect(turnEvent.tokenUsage.output).toBe(8);
  });

  test("observability events persisted to DB", async () => {
    toolCallCount = 0;
    const conv = await createConversation(projectId, { title: "Obs Persist" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);

    await executor.streamChat(conv.id, "Persist test", { agentConfigId });

    // Brief wait for async persistence
    await new Promise((r) => setTimeout(r, 200));

    const events = await getConversationObservability(conv.id);
    const turnSummary = events.find((e) => e.eventType === "turn_summary");
    const toolCall = events.find((e) => e.eventType === "tool_call");

    expect(turnSummary).toBeDefined();
    expect(toolCall).toBeDefined();
    expect((toolCall!.data as any).toolName).toBe("e2e-echo__echo");
    expect((toolCall!.data as any).success).toBe(true);
  });
});
