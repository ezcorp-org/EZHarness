/**
 * C2 — a just-installed extension must be callable in the SAME turn.
 *
 * `setupTools` runs exactly once per run and pi-agent COPIES the tool
 * array at construction, so an extension the model installed mid-turn was
 * absent from that run's tool list and could not be invoked — even though
 * `install_draft` tells the model the extension lands enabled "so it can
 * be tested immediately".
 *
 * The executor now hangs a `prepareNextTurnWithContext` hook off every
 * agent it builds. Between agentic-loop iterations the hook asks
 * `ctx.refreshExtensionTools` for in-scope extension tools that are
 * missing from the live list, re-applies the run's scope narrowings, and
 * returns an updated turn context.
 *
 * The mock Agent below stands in for pi's loop: its `prompt()` fires the
 * turn boundary the same way `agent-loop.ts` does
 * (`config.prepareNextTurn?.(nextTurnContext)`), so the wiring — not just
 * the closure — is under test.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

// ── pi-agent-core: a loop stand-in that drives the turn boundary ─────

interface TurnUpdate { context: { tools?: Array<{ name: string }> } }

let capturedAgentOpts: { initialState: { tools: Array<{ name: string }> } } | null = null;
/** Runs at the simulated turn boundary — tests use it to "install". */
let onTurnBoundary: (() => void) | null = null;
/** Whatever the executor's hook returned at that boundary. */
let turnUpdate: TurnUpdate | undefined | "not-called" = "not-called";
/** When set, the boundary passes this malformed context instead. */
let malformedTurnContext = false;

mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: undefined };
    prepareNextTurnWithContext?: (c: unknown) => Promise<TurnUpdate | undefined>;
    private readonly tools: Array<{ name: string }>;
    constructor(opts: { initialState: { tools: Array<{ name: string }> } }) {
      capturedAgentOpts = opts;
      this.tools = opts.initialState.tools;
    }
    subscribe(fn: (e: { type: string; messages: unknown[] }) => void) {
      queueMicrotask(() => fn({ type: "agent_end", messages: [] }));
      return () => {};
    }
    abort() {}
    async prompt() {
      onTurnBoundary?.();
      const turnContext = malformedTurnContext
        ? { context: null, message: {}, toolResults: [], newMessages: [] }
        : {
            context: { systemPrompt: "", messages: [], tools: this.tools },
            message: {},
            toolResults: [],
            newMessages: [],
          };
      turnUpdate = await this.prepareNextTurnWithContext?.(turnContext);
    }
  },
}));

// ── Provider / infra mocks ───────────────────────────────────────────

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
mock.module("../providers/registry", () => ({ resolveOAuthModel: mock(() => null) }));
mock.module("../providers/credentials", () => ({
  getCredential: mock(async () => ({ type: "apikey", token: "test-key" })),
}));
mock.module("../providers/shell", () => ({
  createShellProvider: () => ({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
}));
mock.module("../providers/file", () => ({
  createFileProvider: () => ({ read: async () => "", write: async () => {}, exists: async () => false }),
}));
mock.module("../observability/collector", () => ({ startCollector: () => {} }));
mock.module("../db/queries/runs", () => ({ insertRun: async () => {}, updateRun: async () => {} }));
mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => {},
  deleteActiveRun: async () => {},
  cleanupOrphanedRuns: async () => {},
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
}));
mock.module("../memory/embeddings", () => ({ generateEmbedding: async () => new Float32Array(384) }));
mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async (sys: string | undefined) => ({
    systemPrompt: sys ?? "",
    memoriesUsed: [],
  }),
}));

// ── Registry stub with a live `generation` counter ───────────────────

interface StubToolDef { name: string; description: string; inputSchema: Record<string, unknown> }

const agentToolsMap = new Map<string, StubToolDef[]>();
const extensionToolsMap = new Map<string, StubToolDef[]>();
let registryGeneration = 0;

const registryStub = {
  get generation() { return registryGeneration; },
  getToolsForAgent: async (agentConfigId: string) => agentToolsMap.get(agentConfigId) ?? [],
  getToolsForExtension: (extId: string) => extensionToolsMap.get(extId) ?? [],
};

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: { getInstance: () => registryStub },
}));

mock.module("../extensions/tool-executor", () => ({
  ToolExecutor: class {
    setStateMediator() {}
    setExecutor() {}
    setSpawnQuota() {}
    setArgsResolver() {}
    setCurrentUserId() {}
    setCurrentModel() {}
    setCurrentProvider() {}
    setCurrentAgentConfigId() {}
    setPendingPermissionGate() {}
  },
  extensionToAgentTool: (def: { name: string; description?: string; inputSchema?: unknown }) => ({
    name: def.name,
    description: def.description ?? "",
    parameters: def.inputSchema ?? { type: "object", properties: {}, required: [] },
    execute: async () => ({ content: [{ type: "text" as const, text: "(stub)" }], details: {} }),
  }),
}));

// ── Conversation wiring: mutable so a test can "install" mid-run ─────

let convExtensionIds: string[] = [];
let convExtensionIdsThrows = false;

mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => {
    if (convExtensionIdsThrows) throw new Error("conversation_extensions read failed");
    return convExtensionIds;
  },
  addConversationExtensions: async () => {},
  getConversationExtensionEffectiveGrants: async () => null,
}));

mock.module("../runtime/orchestration-host", () => ({
  ensureOrchestrationWired: async () => true,
  wireOrchestrationToolsForTurn: async () => {},
  getOrchestrationExtensionId: async () => null,
}));
mock.module("../runtime/ask-user-host", () => ({
  ensureAskUserWired: async () => true,
  wireAskUserToolForTurn: async () => {},
  _resetAskUserExtensionIdCache: () => {},
}));
mock.module("../runtime/task-tracking-host", () => ({ ensureTaskTrackingWired: async () => {} }));

// ── Import after all mocks ───────────────────────────────────────────

const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { createAgentConfig } = await import("../db/queries/agent-configs");
const { createMode } = await import("../db/queries/modes");
type AgentEvents = import("../types").AgentEvents;

const TOOL_DEF = (name: string): StubToolDef => ({
  name,
  description: `stub ${name}`,
  inputSchema: { type: "object", properties: {}, required: [] },
});

const INSTALLED_EXT_ID = "ext-installed-mid-run";
const NEW_TOOL = "brand-new__do_the_thing";

let projectId: string;
let convId: string;
let agentConfigId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Mid-run reassembly", path: "/tmp/midrun-reassembly" });
  projectId = project.id;
  convId = (await createConversation(projectId)).id;
  agentConfigId = (await createAgentConfig({
    name: "reassembly-agent",
    description: "Agent whose toolset is re-assembled mid-run",
    prompt: "You are a re-assembly test agent.",
  })).id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(() => {
  agentToolsMap.clear();
  extensionToolsMap.clear();
  convExtensionIds = [];
  convExtensionIdsThrows = false;
  registryGeneration = 0;
  capturedAgentOpts = null;
  onTurnBoundary = null;
  turnUpdate = "not-called";
  malformedTurnContext = false;
});

function createExecutor() {
  const bus = new EventBus<AgentEvents>();
  return new AgentExecutor(new Map(), bus, { persist: false });
}

/** Stand in for an install landing during the turn: the extension is now
 *  registered AND wired to this conversation, and the registry reloaded. */
function installMidRun(): void {
  extensionToolsMap.set(INSTALLED_EXT_ID, [TOOL_DEF(NEW_TOOL)]);
  convExtensionIds = [INSTALLED_EXT_ID];
  registryGeneration++;
}

describe("mid-run toolset re-assembly", () => {
  test("an extension installed during the turn becomes callable in that turn", async () => {
    agentToolsMap.set(agentConfigId, [TOOL_DEF("existing__tool")]);
    onTurnBoundary = installMidRun;

    await createExecutor().streamChat(convId, "build me an extension and try it", {
      projectId,
      agentConfigId,
    });

    // The run STARTED without the new tool…
    const initialNames = (capturedAgentOpts?.initialState.tools ?? []).map((t) => t.name);
    expect(initialNames).toContain("existing__tool");
    expect(initialNames).not.toContain(NEW_TOOL);

    // …and the next loop iteration got it.
    expect(turnUpdate).not.toBe("not-called");
    const nextNames = ((turnUpdate as TurnUpdate).context.tools ?? []).map((t) => t.name);
    expect(nextNames).toContain(NEW_TOOL);
    // Existing tools survive — the model may already have called one.
    expect(nextNames).toContain("existing__tool");
  });

  test("no registry change ⇒ the turn context is left untouched", async () => {
    agentToolsMap.set(agentConfigId, [TOOL_DEF("existing__tool")]);
    // No install: `onTurnBoundary` stays null, generation never moves.

    await createExecutor().streamChat(convId, "just answer", { projectId, agentConfigId });

    // `undefined` means "keep the current context" to pi's loop, which is
    // what keeps the cached system+tools prefix byte-stable.
    expect(turnUpdate).toBeUndefined();
  });

  test("a mode allowlist still bounds what an install can add", async () => {
    agentToolsMap.set(agentConfigId, [TOOL_DEF("allowed__tool"), TOOL_DEF("denied__tool")]);
    extensionToolsMap.set("ext-attached", [TOOL_DEF("allowed__tool")]);
    const mode = await createMode({
      name: "Allowlist Mode",
      slug: `reassembly-allowlist-${Date.now()}`,
      systemPromptInstruction: "Only the attached extension.",
      extensionIds: ["ext-attached"],
    });
    onTurnBoundary = installMidRun;

    await createExecutor().streamChat(convId, "install and call it", {
      projectId,
      agentConfigId,
      modeId: mode.id,
    });

    // The run's allowlist was computed before the install, so the new tool
    // is outside it — re-assembly must not widen the mode's surface.
    expect(turnUpdate).toBeUndefined();
    const initialNames = (capturedAgentOpts?.initialState.tools ?? []).map((t) => t.name);
    expect(initialNames).toContain("allowed__tool");
    expect(initialNames).not.toContain("denied__tool");
  });

  test("a failing wiring lookup leaves the toolset alone", async () => {
    agentToolsMap.set(agentConfigId, [TOOL_DEF("existing__tool")]);
    onTurnBoundary = () => {
      installMidRun();
      convExtensionIdsThrows = true;
    };

    await createExecutor().streamChat(convId, "install and call it", { projectId, agentConfigId });

    expect(turnUpdate).toBeUndefined();
  });

  test("a malformed turn context is swallowed, not thrown at pi's loop", async () => {
    agentToolsMap.set(agentConfigId, [TOOL_DEF("existing__tool")]);
    malformedTurnContext = true;
    onTurnBoundary = installMidRun;

    // pi's contract: `prepareNextTurn` must not reject. If it did, the
    // whole run would die here instead of returning a normal result.
    const run = await createExecutor().streamChat(convId, "install and call it", {
      projectId,
      agentConfigId,
    });

    expect(run.status).not.toBe("error");
    expect(turnUpdate).toBeUndefined();
  });
});
