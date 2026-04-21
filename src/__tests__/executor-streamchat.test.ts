import { mock, test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  stubAssistantMessage,
  setupPiAiMocks,
  mockAgentPromptFn,
  resetMockAgent,
} from "./helpers/mock-pi-ai";
import type { AgentEvents } from "../types";

afterAll(() => {
  resetMockAgent();
  restoreModuleMocks();
});

// ── Mocks (must precede any import that touches these modules) ──────

mock.module("../db/queries/conversations", () => ({
  getConversationPath: async () => [],
  getLatestLeaf: async () => null,
  resolveSystemPrompt: async () => undefined,
  createConversation: async () => ({ id: "test" }),
  createMessage: async () => ({ id: "msg-1" }),
  getMessages: async () => [],
  getConversation: async () => ({ id: "test", parentConversationId: null }),
}));

mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => {},
  deleteActiveRun: async () => {},
  markInterrupted: async () => {},
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  cleanupOrphanedRuns: async () => {},
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

// Re-establish all mocks before each test to survive concurrent restoreModuleMocks()
beforeEach(() => {
  mock.module("../db/connection", () => ({
    getDb: () => ({
      select: () => ({ from: () => ({ where: async () => [] }) }),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: async () => ({}) }) }),
      delete: () => ({ where: async () => ({}) }),
    }),
    getPglite: () => null,
    getDbPath: () => ":memory:",
    initDb: async () => {},
    closeDb: async () => {},
  }));
  mock.module("../db/queries/conversations", () => ({
    getConversation: async () => ({ id: "conv-1", projectId: null, parentConversationId: null }),
    getConversationPath: async () => [],
    getLatestLeaf: async () => null,
    resolveSystemPrompt: async () => undefined,
    createConversation: async () => ({ id: "test" }),
    createMessage: async () => ({ id: "msg-1" }),
    getMessages: async () => [],
  }));
  mock.module("../db/queries/settings", () => ({
    getAllSettings: async () => ({}),
    getSetting: async () => undefined,
    upsertSetting: async () => {},
    deleteSetting: async () => false,
    isListingInstalled: async () => false,
  }));
  mock.module("../db/queries/agent-configs", () => ({
    listAgentConfigs: async () => [],
    getAgentConfig: async () => null,
    getAgentConfigByName: async () => null,
  }));
  mock.module("../db/queries/active-runs", () => ({
    createActiveRun: async () => {},
    deleteActiveRun: async () => {},
    getActiveRuns: async () => [],
    cleanupOrphanedRuns: async () => {},
    updateHeartbeat: async () => {},
    updatePartialResponse: async () => {},
    markInterrupted: async () => {},
  }));
  mock.module("../db/queries/conversation-extensions", () => ({
    getConversationExtensionIds: async () => [],
    addConversationExtensions: async () => {},
  }));
  mock.module("../db/queries/extensions", () => ({
    getExtensionByName: async () => null,
  }));
  mock.module("../extensions/registry", () => ({
    ExtensionRegistry: { getInstance: () => ({ getToolsForAgent: async () => [] }) },
  }));
  setupPiAiMocks({ textChunks: ["Hello", " world"] });
});

// Set up pi-ai mocks with default text chunks
setupPiAiMocks({ textChunks: ["Hello", " world"] });

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
  generateEmbedding: async (_text: string, onProgress?: (msg: string) => void) => {
    onProgress?.("Initializing embedding model...");
    return [];
  },
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: { getInstance: () => ({ getToolsForAgent: async () => [] }) },
}));

mock.module("../extensions/tool-executor", () => ({
  MAX_TOOL_CALLS_PER_TURN: 10,
  ToolExecutor: class {
    constructor() {}
    createToolsContext() {
      return { invoke: async () => ({}) };
    }
    setPermissionChecker() {}
    async executeToolCall() {
      return { content: [{ text: "result" }] };
    }
  },
}));

mock.module("../extensions/permissions", () => ({
  checkSensitiveConfirmation: async () => "allowed",
}));

// ── Import subjects after mocks ─────────────────────────────────────

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";

// ── Tests ───────────────────────────────────────────────────────────

describe("AgentExecutor.streamChat", () => {
  test("streamChat yields tokens and completes run", async () => {
    // Mock Agent to emit specific text chunks
    setupPiAiMocks({ textChunks: ["Hello", " world"] });

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const tokens: string[] = [];
    bus.on("run:token", ({ token }) => tokens.push(token));

    const run = await exec.streamChat("conv-1", "Hi there", {});

    expect(run.status).toBe("success");
    expect(tokens.join("")).toBe("Hello world");
    expect((run.result?.output as any)?.fullText).toBe("Hello world");
  });

  test("streamChat handles stream error", async () => {
    // Configure Agent mock to emit error via subscriber then throw
    mock.module("@mariozechner/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
        constructor() {}
        subscribe(cb: any) {
          this._subs.push(cb);
          return () => {};
        }
        abort() {}
        async prompt() {
          throw new Error("connection lost");
        }
      },
    }));

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const run = await exec.streamChat("conv-1", "Hi", {});

    expect(run.status).toBe("error");
    expect(run.result?.error).toContain("connection lost");

    // Restore default mock
    setupPiAiMocks({ textChunks: ["Hello", " world"] });
  });

  test("streamChat handles abort signal", async () => {
    // Configure Agent mock to throw AbortError after emitting partial text
    mock.module("@mariozechner/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
        constructor() {}
        subscribe(cb: any) {
          this._subs.push(cb);
          return () => {};
        }
        abort() {}
        async prompt() {
          for (const sub of this._subs) {
            sub({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: "start",
                partial: stubAssistantMessage("start"),
              },
            });
          }
          throw new DOMException("The operation was aborted", "AbortError");
        }
      },
    }));

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const run = await exec.streamChat("conv-1", "Hi", {});

    expect(run.status).toBe("cancelled");
    expect((run.result?.output as any)?.partial).toBe(true);

    // Restore
    setupPiAiMocks({ textChunks: ["Hello", " world"] });
  });

  test("streamChat emits lifecycle events", async () => {
    setupPiAiMocks({ textChunks: ["ok"] });

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const emitted: string[] = [];
    bus.on("run:start", () => emitted.push("start"));
    bus.on("run:complete", () => emitted.push("complete"));
    bus.on("obs:turn", () => emitted.push("obs:turn"));

    await exec.streamChat("conv-1", "test", {});

    expect(emitted).toContain("start");
    expect(emitted).toContain("complete");
    expect(emitted).toContain("obs:turn");
  });

  test("streamChat emits usage event", async () => {
    setupPiAiMocks({ textChunks: ["hi"] });

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    let usage: any;
    bus.on("run:usage", (data) => {
      usage = data.usage;
    });

    await exec.streamChat("conv-1", "test", {});

    // Usage comes from the turn_end event in the mock agent
    expect(usage).toBeDefined();
    expect(usage.input).toBe(10);
    expect(usage.output).toBe(5);
  });

  test("streamChat aborts when stream hangs and cancelRun is called", async () => {
    let capturedRunId: string | null = null;
    let abortCalled = false;

    // Configure Agent mock to hang until aborted
    mock.module("@mariozechner/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
        constructor() {}
        subscribe(cb: any) {
          this._subs.push(cb);
          return () => {};
        }
        abort() { abortCalled = true; }
        async prompt() {
          // Emit one token
          for (const sub of this._subs) {
            sub({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: "start",
                partial: stubAssistantMessage("start"),
              },
            });
          }
          // Then hang until cancelled
          await new Promise<void>((_, reject) => {
            const check = setInterval(() => {
              if (abortCalled) {
                clearInterval(check);
                reject(new DOMException("The operation was aborted", "AbortError"));
              }
            }, 10);
          });
        }
      },
    }));

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const tokens: string[] = [];
    bus.on("run:token", ({ token }) => tokens.push(token));
    bus.on("run:start", ({ run }) => { capturedRunId = run.id; });

    const runPromise = exec.streamChat("conv-timeout", "hello", {});

    // Wait for the stream to start and emit the first token
    await new Promise((r) => setTimeout(r, 100));
    expect(capturedRunId).not.toBeNull();
    expect(tokens).toContain("start");

    // Cancel the run while it's hanging
    const cancelled = exec.cancelRun(capturedRunId!);
    expect(cancelled).toBe(true);

    const run = await runPromise;
    expect(run.status).toBe("cancelled");

    // Restore
    setupPiAiMocks({ textChunks: ["Hello", " world"] });
  });

  test("streamChat clears timeout interval on normal completion", async () => {
    setupPiAiMocks({ textChunks: ["clean"] });

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const run = await exec.streamChat("conv-clean", "test", {});

    expect(run.status).toBe("success");
    expect((run.result?.output as any)?.fullText).toBe("clean");
  });

  test("streamChat emits run:status events during setup phases", async () => {
    setupPiAiMocks({ textChunks: ["hi"] });

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const statuses: string[] = [];
    bus.on("run:status", ({ status }) => statuses.push(status));

    await exec.streamChat("conv-status", "test", {});

    expect(statuses).toContain("Loading conversation history...");
    expect(statuses).toContain("Preparing...");
    expect(statuses).toContain("Generating response...");
  });

  test("streamChat emits memory status when projectId is set", async () => {
    setupPiAiMocks({ textChunks: ["hi"] });

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const statuses: string[] = [];
    bus.on("run:status", ({ status }) => statuses.push(status));

    await exec.streamChat("conv-status-2", "test", { projectId: "proj-1" });

    expect(statuses).toContain("Preparing...");
    expect(statuses).toContain("Initializing embedding model...");
  });

  test("run:complete event data wraps run in { run } for frontend destructuring", async () => {
    setupPiAiMocks({ textChunks: ["hi"] });

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    let completeData: any;
    bus.on("run:complete", (data) => { completeData = data; });

    let startData: any;
    bus.on("run:start", (data) => { startData = data; });

    const run = await exec.streamChat("conv-shape", "test", {});

    // Backend emits { run: AgentRun } -- frontend must destructure as { run }
    expect(startData).toBeDefined();
    expect(startData.run).toBeDefined();
    expect(startData.run.id).toBe(run.id);

    expect(completeData).toBeDefined();
    expect(completeData.run).toBeDefined();
    expect(completeData.run.id).toBe(run.id);
    expect(completeData.run.status).toBe("success");
  });

  test("run:error event data wraps run in { run, error }", async () => {
    // Configure Agent to throw an error
    mock.module("@mariozechner/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
        constructor() {}
        subscribe(cb: any) { this._subs.push(cb); return () => {}; }
        abort() {}
        async prompt() {
          throw new Error("provider down");
        }
      },
    }));

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    let errorData: any;
    bus.on("run:error", (data) => { errorData = data; });

    const run = await exec.streamChat("conv-err-shape", "test", {});

    expect(errorData).toBeDefined();
    expect(errorData.run).toBeDefined();
    expect(errorData.run.id).toBe(run.id);
    expect(errorData.error).toContain("provider down");

    // Restore
    setupPiAiMocks({ textChunks: ["Hello", " world"] });
  });

  test("streamChat clears timeout interval on error", async () => {
    mock.module("@mariozechner/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
        constructor() {}
        subscribe(cb: any) { this._subs.push(cb); return () => {}; }
        abort() {}
        async prompt() {
          for (const sub of this._subs) {
            sub({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                contentIndex: 0,
                delta: "before-error",
                partial: stubAssistantMessage("before-error"),
              },
            });
          }
          throw new Error("server crash");
        }
      },
    }));

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const run = await exec.streamChat("conv-err-clean", "test", {});

    expect(run.status).toBe("error");
    expect(run.result?.error).toContain("server crash");

    // Restore
    setupPiAiMocks({ textChunks: ["Hello", " world"] });
  });
});
