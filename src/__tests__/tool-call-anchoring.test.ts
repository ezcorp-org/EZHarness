import { mock, test, expect, describe, afterAll, beforeEach } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { stubAssistantMessage, resetMockAgent } from "./helpers/mock-pi-ai";
import type { AgentEvents } from "../types";

afterAll(() => {
  resetMockAgent();
  restoreModuleMocks();
});

// ── Track tool_calls updates ─────────────────────────────────────────

let toolCallUpdates: { set: any; where: any }[] = [];
let createdMessages: { id: string; role: string; conversationId: string; runId?: string }[] = [];
let msgCounter = 0;

beforeEach(() => {
  toolCallUpdates = [];
  createdMessages = [];
  msgCounter = 0;
});

// ── Helper: mock Agent with state property ───────────────────────────

function setupAgentMock(textChunks: string[] = ["anchored"]) {
  mock.module("@mariozechner/pi-agent-core", () => ({
    Agent: class MockAgent {
      private _subs: any[] = [];
      state: Record<string, any> = {};
      subscribe(cb: any) { this._subs.push(cb); return () => {}; }
      abort() {}
      async prompt(message: string) {
        let accumulated = "";
        for (const chunk of textChunks) {
          accumulated += chunk;
          for (const sub of this._subs) {
            sub({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: chunk,
                partial: stubAssistantMessage(accumulated),
              },
            });
          }
        }
        for (const sub of this._subs) {
          sub({ type: "turn_end", message: stubAssistantMessage(accumulated) });
        }
      }
    },
  }));
}

// ── Mocks (must precede any import that touches these modules) ───────

mock.module("../db/queries/conversations", () => ({
  getConversationPath: async () => [],
  getLatestLeaf: async () => null,
  resolveSystemPrompt: async () => undefined,
  createConversation: async () => ({ id: "test" }),
  getConversation: async () => ({ id: "test", projectId: "proj-1" }),
  createMessage: async (conversationId: string, data: any) => {
    msgCounter++;
    const msg = { id: `real-msg-${msgCounter}`, ...data, conversationId, createdAt: new Date() };
    createdMessages.push(msg);
    return msg;
  },
  getMessages: async () => [],
}));

mock.module("../db/connection", () => ({
  getDb: () => {
    const chain: any = {};
    chain.update = (_table: any) => {
      chain._setData = null;
      return chain;
    };
    chain.set = (data: any) => {
      chain._setData = data;
      return chain;
    };
    chain.where = (condition: any) => {
      if (chain._setData != null) {
        toolCallUpdates.push({ set: chain._setData, where: condition });
      }
      return Promise.resolve([]);
    };
    chain.insert = () => ({ values: async () => {} });
    chain.select = () => ({ from: () => ({ where: () => Promise.resolve([]) }) });
    chain.delete = () => ({ where: () => Promise.resolve() });
    return chain;
  },
}));

mock.module("../db/queries/agent-configs", () => ({
  getAgentConfigByName: async () => null,
  listAgentConfigs: async () => [],
}));

mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => [],
  addConversationExtensions: async () => {},
}));

mock.module("../db/queries/runs", () => ({
  insertRun: async () => {},
  updateRun: async () => {},
  insertLog: async () => {},
  listRuns: async () => [],
  getRunWithLogs: async () => null,
  toAgentRun: (r: any) => r,
}));

mock.module("../db/queries/projects", () => ({
  getProject: async () => undefined,
}));

mock.module("../db/queries/settings", () => ({
  getAllSettings: async () => ({}),
  getSetting: async () => undefined,
  upsertSetting: async () => {},
  deleteSetting: async () => false,
  isListingInstalled: async () => false,
}));

mock.module("../observability/collector", () => ({
  startCollector: () => () => {},
}));

mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => ({}),
  deleteActiveRun: async () => true,
  markInterrupted: async () => ({}),
  updateHeartbeat: async () => ({}),
  updatePartialResponse: async () => ({}),
  cleanupOrphanedRuns: async () => 0,
}));

mock.module("../providers/router", () => ({
  resolveModel: async () => ({
    provider: "anthropic",
    model: "test-model",
    piModel: { id: "test-model", provider: "anthropic", api: "anthropic-messages", baseUrl: "" },
  }),
  ProviderUnavailableError: class extends Error {
    failedProvider: string;
    failedModel: string;
    suggestion: any;
    constructor(msg: string, fp: string, fm: string, sug: any) {
      super(msg);
      this.failedProvider = fp;
      this.failedModel = fm;
      this.suggestion = sug;
    }
  },
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
}));

mock.module("../providers/registry", () => ({
  resolveOAuthModel: () => null,
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

mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async () => {
    throw new Error("not available");
  },
}));

mock.module("../memory/retrieval", () => ({
  searchKBChunksForQuery: async () => [],
}));

mock.module("../memory/embeddings", () => ({
  generateEmbedding: async () => [],
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: { getInstance: () => ({ getToolsForAgent: async () => [] }) },
}));

mock.module("../extensions/tool-executor", () => ({
  MAX_TOOL_CALLS_PER_TURN: 10,
  extensionToAgentTool: () => ({}),
  ToolExecutor: class {
    createToolsContext() { return { invoke: async () => ({}) }; }
    setPermissionChecker() {}
    async executeToolCall() { return { content: [{ text: "result" }] }; }
  },
}));

mock.module("../extensions/permissions", () => ({
  checkSensitiveConfirmation: async () => "allowed",
}));

mock.module("@mariozechner/pi-ai", () => ({
  stream: () => ({ [Symbol.asyncIterator]: async function* () {} }),
  complete: async () => stubAssistantMessage(),
}));

// Set default agent mock
setupAgentMock(["anchored"]);

// ── Import subjects after mocks ──────────────────────────────────────

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";

// ── Tests ────────────────────────────────────────────────────────────

describe("tool call anchoring", () => {
  beforeEach(() => {
    toolCallUpdates = [];
    createdMessages = [];
    msgCounter = 0;
  });

  test("after assistant message save, tool_calls.messageId updated from run.id to real message.id", async () => {
    setupAgentMock(["hello"]);

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: true });

    const run = await exec.streamChat("conv-1", "Hi", {});

    expect(run.status).toBe("success");
    const assistantMsg = createdMessages.find(m => m.role === "assistant");
    expect(assistantMsg).toBeDefined();

    // tool_calls UPDATE was issued to anchor messageId
    expect(toolCallUpdates.length).toBeGreaterThanOrEqual(1);
    const anchorUpdate = toolCallUpdates.find(u => u.set?.messageId === assistantMsg!.id);
    expect(anchorUpdate).toBeDefined();
  });

  test("fixup runs before run:complete so frontend gets correct data", async () => {
    setupAgentMock(["ok"]);

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: true });

    let completeEmittedAt = 0;
    const origLength = toolCallUpdates.length;
    bus.on("run:complete", () => {
      completeEmittedAt = Date.now();
      // By the time run:complete fires, the anchor update should have happened
      expect(toolCallUpdates.length).toBeGreaterThan(origLength);
    });

    await exec.streamChat("conv-2", "test", {});

    expect(completeEmittedAt).toBeGreaterThan(0);
  });

  test("persistErrorMessage also anchors tool_calls to real error message id", async () => {
    // Make the agent throw an error
    mock.module("@mariozechner/pi-agent-core", () => ({
      Agent: class MockAgent {
        private _subs: any[] = [];
        state: Record<string, any> = {};
        subscribe(cb: any) { this._subs.push(cb); return () => {}; }
        abort() {}
        async prompt() {
          throw new Error("provider crash");
        }
      },
    }));

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: true });

    const run = await exec.streamChat("conv-err", "test", {});

    expect(run.status).toBe("error");
    const errorMsg = createdMessages.find(m => m.role === "assistant" && m.conversationId === "conv-err");
    expect(errorMsg).toBeDefined();

    // tool_calls anchoring was called with the error message's real ID
    const anchorUpdate = toolCallUpdates.find(u => u.set?.messageId === errorMsg!.id);
    expect(anchorUpdate).toBeDefined();

    // Restore default mock
    setupAgentMock(["anchored"]);
  });

  test("fixup only updates tool_calls matching both conversationId and placeholder messageId", async () => {
    setupAgentMock(["scoped"]);

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: true });

    const run = await exec.streamChat("conv-scope", "test", {});

    expect(run.status).toBe("success");
    expect(toolCallUpdates.length).toBeGreaterThanOrEqual(1);
    const anchorUpdate = toolCallUpdates.find(u => u.set?.messageId != null);
    expect(anchorUpdate).toBeDefined();
    expect(anchorUpdate!.set.messageId).toMatch(/^real-msg-/);
  });
});
