import { mock, test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  setupPiAiMocks,
  resetMockAgent,
} from "./helpers/mock-pi-ai";
import type { AgentEvents } from "../types";

afterAll(() => {
  resetMockAgent();
  restoreModuleMocks();
});

// ── Mocks (must precede imports) ────────────────────────────────────

mock.module("../db/queries/conversations", () => ({
  getConversationPath: async () => [],
  getLatestLeaf: async () => null,
  resolveSystemPrompt: async () => undefined,
  createConversation: async () => ({ id: "test" }),
  createMessage: async () => ({ id: "msg-1" }),
  getMessages: async () => [],
  getConversation: async () => ({ id: "test", parentConversationId: null }),
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

mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => {},
  deleteActiveRun: async () => {},
  markInterrupted: async () => {},
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
  cleanupOrphanedRuns: async () => {},
}));

mock.module("../observability/collector", () => ({
  startCollector: () => () => {},
}));

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
  buildSystemPromptWithMemories: async () => { throw new Error("not available"); },
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
  ToolExecutor: class {
    createToolsContext() { return { invoke: async () => ({}) }; }
    setPermissionChecker() {}
    async executeToolCall() { return { content: [{ text: "result" }] }; }
  },
}));

mock.module("../extensions/permissions", () => ({
  checkSensitiveConfirmation: async () => "allowed",
}));

// Re-establish mocks before each test in case a concurrent test file's
// restoreModuleMocks() overwrites our mocks during parallel execution.
beforeEach(() => {
  // Restore pristine globals that may have been replaced by other test files
  if ((globalThis as any).__pristineFetch) globalThis.fetch = (globalThis as any).__pristineFetch;
  if ((globalThis as any).__pristineWebSocket) globalThis.WebSocket = (globalThis as any).__pristineWebSocket;
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
    getConversation: async () => null,
    getConversationPath: async () => [],
    getLatestLeaf: async () => null,
    resolveSystemPrompt: async () => undefined,
    createConversation: async () => ({ id: "test" }),
    createMessage: async () => ({ id: "msg-1" }),
    getMessages: async () => [],
  }));
  mock.module("../db/queries/runs", () => ({
    insertRun: async () => {},
    updateRun: async () => {},
    insertLog: async () => {},
    listRuns: async () => [],
    getRunWithLogs: async () => null,
    toAgentRun: (r: any) => r,
  }));
  mock.module("../db/queries/settings", () => ({
    getAllSettings: async () => ({}),
    getSetting: async () => undefined,
    upsertSetting: async () => {},
    deleteSetting: async () => false,
    isListingInstalled: async () => false,
  }));
  mock.module("../db/queries/projects", () => ({
    getProject: async () => undefined,
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
  mock.module("../extensions/tool-executor", () => ({
    MAX_TOOL_CALLS_PER_TURN: 10,
    ToolExecutor: class {
      createToolsContext() { return { invoke: async () => ({}) }; }
      setPermissionChecker() {}
      async executeToolCall() { return { content: [{ text: "result" }] }; }
    },
  }));
  mock.module("../extensions/permissions", () => ({
    checkSensitiveConfirmation: async () => "allowed",
  }));
  mock.module("../observability/collector", () => ({
    startCollector: () => () => {},
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
    buildSystemPromptWithMemories: async () => { throw new Error("not available"); },
  }));
  mock.module("../memory/retrieval", () => ({
    searchKBChunksForQuery: async () => [],
  }));
  mock.module("../memory/embeddings", () => ({
    generateEmbedding: async () => [],
  }));
  setupPiAiMocks({ textChunks: ["Hello", " world"] });
});

// ── Import subjects after mocks ─────────────────────────────────────

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";

// ── Helpers: simulate the hooks.server.ts WS forwarding + frontend store ──

const BUS_EVENTS = ["run:start", "run:status", "run:log", "run:complete", "run:error", "run:cancel", "run:token", "run:usage"] as const;

/** Start a real Bun WebSocket server with EventBus forwarding (like hooks.server.ts dev mode) */
function startWsRelay(bus: EventBus<AgentEvents>) {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response("WS only", { status: 400 });
    },
    websocket: {
      open(ws) { ws.subscribe("events"); },
      message() {},
      close(ws) { ws.unsubscribe("events"); },
    },
  });

  const unsubs: (() => void)[] = [];
  for (const event of BUS_EVENTS) {
    unsubs.push(bus.on(event, (data: unknown) => {
      server.publish("events", JSON.stringify({ type: event, data }));
    }));
  }

  return {
    server,
    stop() {
      for (const u of unsubs) u();
      server.stop(true);
    },
  };
}

/** Collect all WS messages until a predicate is met or timeout */
function collectWsMessages(
  url: string,
  until: (msgs: any[]) => boolean,
  timeoutMs = 5000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const messages: any[] = [];
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out after ${timeoutMs}ms. Got ${messages.length} messages: ${JSON.stringify(messages.map(m => m.type))}`));
    }, timeoutMs);

    ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data as string);
      messages.push(parsed);
      if (until(messages)) {
        clearTimeout(timer);
        ws.close();
        resolve(messages);
      }
    };

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error"));
    };
  });
}

// ── Tests ───────────────────────────────────────────────────────────

describe("WebSocket event flow (end-to-end)", () => {
  test("successful chat: WS client receives run:start, run:status, run:token, run:complete with correct shapes", async () => {
    const bus = new EventBus<AgentEvents>();
    const relay = startWsRelay(bus);
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    try {
      // Start collecting WS messages, wait for run:complete
      const msgsPromise = collectWsMessages(
        `ws://localhost:${relay.server.port}`,
        (msgs) => msgs.some((m) => m.type === "run:complete"),
      );

      // Small delay for WS client to connect
      await new Promise((r) => setTimeout(r, 100));

      // Run streamChat
      await exec.streamChat("conv-ws-1", "Hi there", {});

      const msgs = await msgsPromise;

      // Verify we got the expected event types
      const types = msgs.map((m: any) => m.type);
      expect(types).toContain("run:start");
      expect(types).toContain("run:status");
      expect(types).toContain("run:token");
      expect(types).toContain("run:complete");

      // Verify run:start shape: { run: { id } }
      const startMsg = msgs.find((m: any) => m.type === "run:start");
      expect(startMsg.data.run).toBeDefined();
      expect(startMsg.data.run.id).toBeTypeOf("string");

      // Verify run:complete shape: { run: { id, status } }
      const completeMsg = msgs.find((m: any) => m.type === "run:complete");
      expect(completeMsg.data.run).toBeDefined();
      expect(completeMsg.data.run.id).toBeTypeOf("string");
      expect(completeMsg.data.run.status).toBe("success");

      // Verify run:token shape: { runId, token }
      const tokenMsgs = msgs.filter((m: any) => m.type === "run:token");
      expect(tokenMsgs.length).toBeGreaterThanOrEqual(1);
      expect(tokenMsgs[0].data.runId).toBeTypeOf("string");
      expect(tokenMsgs[0].data.token).toBeTypeOf("string");

      // Verify run:status shape: { runId, status }
      const statusMsgs = msgs.filter((m: any) => m.type === "run:status");
      expect(statusMsgs.length).toBeGreaterThanOrEqual(1);
      expect(statusMsgs[0].data.runId).toBeTypeOf("string");
      expect(statusMsgs[0].data.status).toBeTypeOf("string");

      // Verify run IDs are consistent across events
      const runId = startMsg.data.run.id;
      expect(completeMsg.data.run.id).toBe(runId);
      for (const t of tokenMsgs) expect(t.data.runId).toBe(runId);
      for (const s of statusMsgs) expect(s.data.runId).toBe(runId);
    } finally {
      relay.stop();
    }
  });

  test("error chat: WS client receives run:error with { run: { id, status }, error }", async () => {
    // Configure Agent mock to throw error
    mock.module("@mariozechner/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
        subscribe(cb: any) { this._subs.push(cb); return () => {}; }
        abort() {}
        async prompt() {
          throw new Error("API key invalid");
        }
      },
    }));

    const bus = new EventBus<AgentEvents>();
    const relay = startWsRelay(bus);
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    try {
      const msgsPromise = collectWsMessages(
        `ws://localhost:${relay.server.port}`,
        (msgs) => msgs.some((m) => m.type === "run:error"),
      );

      await new Promise((r) => setTimeout(r, 100));
      await exec.streamChat("conv-ws-err", "Hi", {});
      const msgs = await msgsPromise;

      const errorMsg = msgs.find((m: any) => m.type === "run:error");
      expect(errorMsg.data.run).toBeDefined();
      expect(errorMsg.data.run.id).toBeTypeOf("string");
      expect(errorMsg.data.run.status).toBe("error");
      expect(errorMsg.data.error).toContain("API key invalid");
    } finally {
      relay.stop();
      // Restore default mock
      setupPiAiMocks({ textChunks: ["Hello", " world"] });
    }
  });

  test("frontend store simulation: stopStreaming fires on run:complete", async () => {
    setupPiAiMocks({ textChunks: ["Hi"] });

    const bus = new EventBus<AgentEvents>();
    const relay = startWsRelay(bus);
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    try {
      const msgsPromise = collectWsMessages(
        `ws://localhost:${relay.server.port}`,
        (msgs) => msgs.some((m) => m.type === "run:complete"),
      );

      await new Promise((r) => setTimeout(r, 100));
      const run = await exec.streamChat("conv-ws-store", "test", {});
      const msgs = await msgsPromise;

      // Simulate what the frontend store does with these events
      const streamingMessages: Record<string, string> = {};
      const streamingStatus: Record<string, string> = {};
      let stopStreamingCalled = false;

      // Simulate startStreaming (called after API response)
      streamingMessages[run.id] = "";

      for (const msg of msgs) {
        switch (msg.type) {
          case "run:token": {
            const { runId, token } = msg.data;
            streamingMessages[runId] = (streamingMessages[runId] ?? "") + token;
            break;
          }
          case "run:status": {
            const { runId, status } = msg.data;
            streamingStatus[runId] = status;
            break;
          }
          case "run:complete":
          case "run:error":
          case "run:cancel": {
            // THE FIX: destructure { run } from data, not data as Run
            const { run: updated } = msg.data as { run: { id: string } };
            if (streamingMessages[updated.id] !== undefined) {
              // stopStreaming equivalent
              delete streamingMessages[updated.id];
              delete streamingStatus[updated.id];
              stopStreamingCalled = true;
            }
            break;
          }
        }
      }

      expect(stopStreamingCalled).toBe(true);
      expect(streamingMessages[run.id]).toBeUndefined(); // cleaned up

      // Verify the OLD (broken) code would NOT have worked
      const completeMsg = msgs.find((m: any) => m.type === "run:complete");
      const brokenId = (completeMsg.data as any).id; // old code did: event.data.id
      expect(brokenId).toBeUndefined(); // confirms the old code was broken
    } finally {
      relay.stop();
    }
  });

  test("HMR simulation: old listeners are cleaned up, new ones work", async () => {
    const bus = new EventBus<AgentEvents>();

    // First "HMR load" -- start relay, register listeners
    const relay1 = startWsRelay(bus);
    // Stop relay1 (simulates HMR stopping old WS server)
    relay1.stop();

    // Second "HMR load" -- start new relay on different port
    const relay2 = startWsRelay(bus);

    try {
      // Connect to the NEW relay
      const msgsPromise = collectWsMessages(
        `ws://localhost:${relay2.server.port}`,
        (msgs) => msgs.some((m) => m.type === "run:token"),
      );

      await new Promise((r) => setTimeout(r, 100));

      // Emit an event -- should reach relay2 only (relay1 listeners were cleaned up)
      bus.emit("run:token", { runId: "test-1", token: "works" });

      const msgs = await msgsPromise;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].data.token).toBe("works");
    } finally {
      relay2.stop();
    }
  });

  test("EventBus error isolation: dead listener does not block live one", async () => {
    const bus = new EventBus<AgentEvents>();

    // Register a listener that throws (simulates dead WS server)
    bus.on("run:token", () => {
      throw new Error("dead server");
    });

    // Register the live relay after the dead one
    const relay = startWsRelay(bus);

    try {
      const msgsPromise = collectWsMessages(
        `ws://localhost:${relay.server.port}`,
        (msgs) => msgs.length >= 1,
      );

      await new Promise((r) => setTimeout(r, 100));

      // This should NOT throw despite the dead listener
      bus.emit("run:token", { runId: "test-2", token: "survived" });

      const msgs = await msgsPromise;
      expect(msgs).toHaveLength(1);
      expect(msgs[0].data.token).toBe("survived");
    } finally {
      relay.stop();
    }
  });
});
