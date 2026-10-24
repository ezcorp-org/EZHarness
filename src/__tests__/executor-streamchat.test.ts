import { mock, test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  stubAssistantMessage,
  setupPiAiMocks,
  resetMockAgent,
} from "./helpers/mock-pi-ai";
import type { AgentEvents } from "../types";

afterAll(() => {
  resetMockAgent();
  restoreModuleMocks();
});

// ── Mocks (must precede any import that touches these modules) ──────
let fixtureProjectId: string | null = null;
let insertRunGate: Promise<void> | null = null;
let insertRunCompleted = false;

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
  insertRun: async () => { await insertRunGate; insertRunCompleted = true; },
  finalizeRunRow: async () => 1,
  updateRun: async () => {},
  insertLog: async () => {},
  listRuns: async () => [],
  getRunWithLogs: async () => null,
  toAgentRun: (r: any) => r,
}));

mock.module("../db/queries/projects", () => ({
  getProject: async (id: string) => id === fixtureProjectId
    ? { id, path: "/tmp/streamchat-test-project" }
    : undefined,
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

// WS3: records which extension manifests the tier router looked up (so a
// test can prove an extension-declared routing tier is consulted), plus the
// manifests the mock registry serves.
let routingManifestLookups: string[] = [];
const routingManifests: Record<string, { routing?: { tier: string } }> = {};
const mockRegistry = {
  getToolsForAgent: async () => [],
  getToolsForExtension: () => [],
  getManifest: (id: string) => {
    routingManifestLookups.push(id);
    return routingManifests[id];
  },
};

// Re-establish all mocks before each test to survive concurrent restoreModuleMocks()
beforeEach(() => {
  fixtureProjectId = null;
  insertRunGate = null;
  insertRunCompleted = false;
  mock.module("../db/connection", () => ({
    getDb: () => ({
      select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve([]), { limit: async () => [] }) }) }),
      insert: () => ({ values: async () => ({}) }),
      update: () => ({ set: () => ({ where: () => Object.assign(Promise.resolve({}), { returning: async () => [] }) }) }),
      delete: () => ({ where: async () => ({}) }),
    }),
    getPglite: () => null,
    getDbPath: () => ":memory:",
    initDb: async () => {},
    closeDb: async () => {},
  }));
  mock.module("../db/queries/conversations", () => ({
    getConversation: async () => ({ id: "conv-1", projectId: fixtureProjectId, parentConversationId: null }),
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
    getAgentConfigsByIds: async () => new Map(),
    getAgentConfigsByNames: async () => new Map(),
  }));
  mock.module("../db/queries/active-runs", () => ({
    createActiveRun: async () => {},
    deleteActiveRun: async () => {},
    getActiveRun: async () => null,
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
    getExtensionsByNames: async () => new Map(),
  }));
  mock.module("../extensions/registry", () => ({
    ExtensionRegistry: { getInstance: () => mockRegistry },
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
  ExtensionRegistry: { getInstance: () => mockRegistry },
}));

mock.module("../extensions/tool-executor", () => ({
  MAX_TOOL_CALLS_PER_TURN: 10,
  ToolExecutor: class {
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
  test("a failed durable insert leaves no active run and permits a retry", async () => {
    const exec = new AgentExecutor(new Map(), new EventBus<AgentEvents>(), { persist: true });
    let failInsert!: (error: Error) => void;
    insertRunGate = new Promise<void>((_resolve, reject) => { failInsert = reject; });
    const firstRunId = crypto.randomUUID();
    const first = exec.streamChat("conv-1", "Hi", { runId: firstRunId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exec.getActiveRunForConversation("conv-1")?.id).toBe(firstRunId);

    failInsert(new Error("database unavailable"));
    await expect(first).rejects.toThrow("database unavailable");
    expect(exec.getActiveRunForConversation("conv-1")).toBeUndefined();

    insertRunGate = null;
    const stopAfterRegistration = new Error("retry registered");
    let registered = false;
    await expect(exec.streamChat("conv-1", "Retry", {
      runId: crypto.randomUUID(),
      onRunRegistered: () => { registered = true; throw stopAfterRegistration; },
    })).rejects.toBe(stopAfterRegistration);
    expect(registered).toBe(true);
  });

  test("registers a run only after durable insert and in-memory ownership", async () => {
    let releaseInsert!: () => void;
    insertRunGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    const exec = new AgentExecutor(new Map(), new EventBus<AgentEvents>(), { persist: true });
    const runId = crypto.randomUUID();
    const stopAfterRegistration = new Error("registration observed");
    let acknowledged = false;
    let durableAtAck = false;
    let ownerAtAck: Promise<string | undefined> | undefined;
    let runAtAck: Promise<unknown> | undefined;
    const stream = exec.streamChat("conv-1", "Hi", {
      runId,
      onRunRegistered: () => {
        acknowledged = true;
        durableAtAck = insertRunCompleted;
        ownerAtAck = exec.getRunConversationId(runId);
        runAtAck = exec.getRun(runId);
        throw stopAfterRegistration;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(acknowledged).toBe(false);
    expect(exec.getActiveRunForConversation("conv-1")?.id).toBe(runId);
    releaseInsert();
    await expect(stream).rejects.toBe(stopAfterRegistration);
    expect(acknowledged).toBe(true);
    expect(durableAtAck).toBe(true);
    expect(await ownerAtAck).toBe("conv-1");
    expect((await (runAtAck as Promise<{ id: string }>))?.id).toBe(runId);
  });

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

  test("WS3: an extension's declared routing tier is consulted on a model-less thread", async () => {
    // A conversation with NO established model + a routing-declaring
    // extension wired in → the classifier consults the extension's manifest
    // (routing.tier) via the registry. Proves the extension-declared-tier
    // capability is wired end-to-end at the routing decision point.
    routingManifestLookups = [];
    routingManifests["ext-routing"] = { routing: { tier: "powerful" } };
    mock.module("../db/queries/conversations", () => ({
      getConversation: async () => ({
        id: "conv-routing",
        projectId: null,
        parentConversationId: null,
        extensionTools: { "ext-routing": ["tool-a"] },
      }),
      getConversationPath: async () => [],
      getLatestLeaf: async () => null,
      resolveSystemPrompt: async () => undefined,
      createConversation: async () => ({ id: "test" }),
      createMessage: async () => ({ id: "msg-1" }),
      getMessages: async () => [],
    }));
    setupPiAiMocks({ textChunks: ["routed"] });

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    // No provider/model → fresh thread → classifier runs and reads the
    // extension's declared tier.
    const run = await exec.streamChat("conv-routing", "hi", {});

    expect(run.status).toBe("success");
    expect(routingManifestLookups).toContain("ext-routing");

    setupPiAiMocks({ textChunks: ["Hello", " world"] });
  });

  test("WS3: an explicit model pin passes through (no tier classification)", async () => {
    // options.model set → the tier classifier is skipped and the pinned
    // model is honored verbatim (Level-1 passthrough / cache protection).
    setupPiAiMocks({ textChunks: ["pinned"] });

    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });

    const run = await exec.streamChat("conv-pinned", "Hi", {
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });

    expect(run.status).toBe("success");
    expect(run.provider).toBe("anthropic");
    expect((run.result?.output as any)?.fullText).toBe("pinned");

    setupPiAiMocks({ textChunks: ["Hello", " world"] });
  });

  test("streamChat handles stream error", async () => {
    // Configure Agent mock to emit error via subscriber then throw
    mock.module("@earendil-works/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
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
    mock.module("@earendil-works/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
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
    mock.module("@earendil-works/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
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
    fixtureProjectId = "proj-1";

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
    mock.module("@earendil-works/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
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
    mock.module("@earendil-works/pi-agent-core", () => ({
      Agent: class MockAgent {
        state = { error: null };
        private _subs: any[] = [];
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

// API/runtime composition. Model admission stops at the real registration hook;
// the actual native permission wrapper then uses the executor's real maps/controller.
type RuntimeView = { controllers: Map<string, AbortController>; pendingPermissions: Map<string, import("../runtime/stream-chat/host").PendingPermissionInfo>;
  runs: Map<string, import("../types").AgentRun>; activeAgents: Map<string, unknown>; runConversations: Map<string, string>; watchdog: unknown };
async function permissionLifecycleFixture() {
  const { mockServerAlias, ADMIN_USER } = await import("./helpers/mock-request");
  const { contextModule } = await import("./helpers/mock-cleanup");
  const { createStreamChatContext } = await import("../runtime/stream-chat/context");
  const { makeTestPermissionDeps } = await import("./helpers/permission-wrap-deps");
  const { withPermissionGate } = await import("../runtime/tools/permission-wrap");
  const { createEditFileTool } = await import("../runtime/tools/edit-file");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const bus = new EventBus<AgentEvents>(); const executor = new AgentExecutor(new Map(), bus, { persist: true });
  const view = executor as unknown as RuntimeView;
  mockServerAlias();
  mock.module("$lib/server/context", () => contextModule({ getExecutor: () => executor, getBus: () => bus }));
  mock.module("$lib/server/conversation-ownership", () => ({ resolveRootConversationForOwnership: async () => ({ conv: { id: "conv-1", userId: ADMIN_USER.id } }) }));
  const api = await import("../../web/src/routes/api/conversations/[id]/active-run/+server");
  const { handleToolPermission } = await import("../routes/tool-permission");
  const root = await mkdtemp(join(tmpdir(), "ezh-cancel-native-"));
  const contexts: import("../runtime/stream-chat/context").StreamChatContext[] = [];
  async function start(id: string, callId: string) {
    const stop = new Error("fixture stops before model at registered run");
    await expect(executor.streamChat("conv-1", "fixture", { runId: id, onRunRegistered() { throw stop; } })).rejects.toBe(stop);
    const ctx = createStreamChatContext(view.runs.get(id)!, view.controllers.get(id)!, undefined); contexts.push(ctx);
    const fixture = makeTestPermissionDeps({ runId: id, conversationId: "conv-1", requestedMode: "ask", userId: ADMIN_USER.id });
    fixture.deps.ctx = ctx;
    Object.assign(fixture.deps.host, { bus, persist: true, pendingPermissions: view.pendingPermissions, controllers: view.controllers,
      activeAgents: view.activeAgents, runConversations: view.runConversations, runs: view.runs, watchdog: view.watchdog });
    fixture.deps.watchdog = fixture.deps.host.watchdog;
    const tool = withPermissionGate(createEditFileTool(root), fixture.deps);
    const pending = tool.execute(callId, { path: id + ".txt", new_string: id }, undefined);
    await new Promise(resolve => setTimeout(resolve, 0));
    return { ctx, host: fixture.deps.host, pending };
  }
  const locals = { user: ADMIN_USER, authMethod: "session" };
  const event = () => ({ params: { id: "conv-1" }, locals, request: new Request("http://fixture/api/conversations/conv-1/active-run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cancel" }) }) });
  const answer = (id: string, approved: boolean) => handleToolPermission(new Request("http://fixture/permission", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved }) }), id, ADMIN_USER, locals);
  const hydrate = async () => (await api.GET(event() as never)).json() as Promise<{ runId: string; pendingPermissions: Array<{ toolCallId: string }> }>;
  const cleanup = async () => {
    const { abortPendingApprovalsForScope } = await import("../runtime/tools/permissions"); abortPendingApprovalsForScope("conv-1");
    executor.destroy(); await rm(root, { recursive: true, force: true });
  };
  return { executor, api, start, event, answer, hydrate, root, cleanup };
}

test("DENY of cancelled old gate cannot clear the new run or its gate", async () => {
  const fixture = await permissionLifecycleFixture();
  try {
    const old = await fixture.start("old-deny", "old-deny-call");
    const response = await fixture.api.POST(fixture.event() as never); expect((await response.json()).cancelled).toBe(true);
    const current = await fixture.start("new-deny", "new-deny-call");
    expect((await fixture.answer("old-deny-call", false)).status).toBe(200); await old.pending;
    const { finalizeCleanup } = await import("../runtime/stream-chat/finalize"); await finalizeCleanup(old.ctx, old.host);
    const active = await fixture.hydrate(); expect(active.runId).toBe("new-deny");
    expect(active.pendingPermissions.map(p => p.toolCallId)).toEqual(["new-deny-call"]);
    expect((await fixture.executor.getRun("old-deny"))?.status).toBe("cancelled");
    expect((await fixture.executor.getRun("new-deny"))?.status).toBe("running");
    expect(await Bun.file(fixture.root + "/old-deny.txt").exists()).toBe(false);
    await fixture.answer("new-deny-call", false); await current.pending;
  } finally { await fixture.cleanup(); }
});

test("cancel API revokes an old native gate before a new run and late approval", async () => {
  const fixture = await permissionLifecycleFixture();
  try {
    const old = await fixture.start("old-cancel", "old-cancel-call");
    await fixture.api.POST(fixture.event() as never);
    const { getPendingApproval } = await import("../runtime/tools/permissions");
    expect(getPendingApproval("old-cancel-call")).toBe(false);
    const current = await fixture.start("new-cancel", "new-cancel-call");
    expect(getPendingApproval("new-cancel-call")).toBe(true);
    const active = await fixture.hydrate(); expect(active.runId).toBe("new-cancel");
    expect(active.pendingPermissions.map(p => p.toolCallId)).toEqual(["new-cancel-call"]);
    await fixture.answer("old-cancel-call", true); await old.pending;
    expect(await Bun.file(fixture.root + "/old-cancel.txt").exists()).toBe(false);
    await fixture.answer("new-cancel-call", false); await current.pending;
  } finally { await fixture.cleanup(); }
});

test("late approval after cancel cannot execute the old native file write", async () => {
  const fixture = await permissionLifecycleFixture();
  try {
    const old = await fixture.start("old-late", "old-late-call");
    await fixture.api.POST(fixture.event() as never);
    const current = await fixture.start("new-late", "new-late-call");
    expect((await fixture.answer("old-late-call", true)).status).toBe(200); await old.pending;
    expect(await Bun.file(fixture.root + "/old-late.txt").exists()).toBe(false);
    expect((await fixture.hydrate()).runId).toBe("new-late");
    await fixture.answer("new-late-call", false); await current.pending;
  } finally { await fixture.cleanup(); }
});

test("approval immediately followed by cancellation cannot race into a native write", async () => {
  const fixture = await permissionLifecycleFixture();
  try {
    const old = await fixture.start("old-race", "old-race-call");
    const { resolvePermission } = await import("../runtime/tools/permissions");
    resolvePermission("old-race-call", true); fixture.executor.cancelRun("old-race");
    await expect(old.pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await Bun.file(fixture.root + "/old-race.txt").exists()).toBe(false);
  } finally { await fixture.cleanup(); }
});
