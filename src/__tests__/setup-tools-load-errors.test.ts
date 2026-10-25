/**
 * setup-tools load-error visibility.
 *
 * Each tool-wiring step of a turn is non-fatal: when it throws, the turn still
 * starts without that step's tools. Those catches used to be empty, so a
 * native-module load failure (sharp cannot load libstdc++ on a NixOS host)
 * dropped every built-in tool with no trace of the cause. This suite forces
 * each step to throw and proves two things: the turn still starts (the Agent
 * is built), and the cause is logged once through the setup logger.
 * Harness mirrors setup-tools-working-dir.test.ts.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdirSync } from "node:fs";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// ── DB mock (must be first, before any module that imports db/connection) ──
mockDbConnection();

const LOAD_ERROR = 'Could not load the "sharp" module using the linux-x64 runtime';

/** Which wiring step throws in the current test. */
const fail = {
  builtin: false,
  agentExtensions: false,
  mentioned: false,
  subAgents: false,
  agentRefs: false,
  memory: false,
  taskAwaiting: false,
  taskWire: false,
};

let capturedAgentOpts: any = null;

mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: undefined };
    constructor(opts: any) {
      capturedAgentOpts = opts;
    }
    prompt = mock(async () => {});
    subscribe = mock((fn: (e: any) => void) => {
      queueMicrotask(() => fn({ type: "agent_end", messages: [] }));
      return () => {};
    });
  },
}));

mock.module("../providers/router", () => ({
  resolveModel: mock(async () => ({
    provider: "anthropic",
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

// ── Memory recall: only the memory test has data; its embedding import fails ──
mock.module("../db/queries/memories", () => ({
  hasMemories: async () => fail.memory,
}));

mock.module("../db/queries/knowledge-base", () => ({
  hasKBChunks: async () => false,
}));

mock.module("../memory/embeddings", () => ({
  generateEmbedding: async () => {
    throw new Error(LOAD_ERROR);
  },
}));

// ── The built-in tool definitions: the real ones, or a load failure ──
// Snapshot the real exports first: mock.module patches the live module in
// place, so a call through the namespace would reach the mock itself.
const realTools = { ...(await import("../runtime/tools")) };
mock.module("../runtime/tools", () => ({
  ...realTools,
  getBuiltinToolDefs: (...args: Parameters<typeof realTools.getBuiltinToolDefs>) => {
    if (fail.builtin) throw new Error(LOAD_ERROR);
    return realTools.getBuiltinToolDefs(...args);
  },
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getToolsForAgent: async () => {
        if (fail.agentExtensions) throw new Error(LOAD_ERROR);
        return [];
      },
      getToolsForExtension: () => [],
    }),
  },
}));

const realAgentConfigs = { ...(await import("../db/queries/agent-configs")) };
mock.module("../db/queries/agent-configs", () => ({
  ...realAgentConfigs,
  getAgentConfig: async (...args: Parameters<typeof realAgentConfigs.getAgentConfig>) => {
    if (fail.agentRefs) throw new Error(LOAD_ERROR);
    return realAgentConfigs.getAgentConfig(...args);
  },
  getAgentConfigsByIds: async (...args: Parameters<typeof realAgentConfigs.getAgentConfigsByIds>) => {
    if (fail.subAgents) throw new Error(LOAD_ERROR);
    return realAgentConfigs.getAgentConfigsByIds(...args);
  },
}));

const { markAwaitingApproval } = await import("../extensions/bundled-extension-state");
mock.module("../runtime/task-tracking-host", () => ({
  ensureTaskTrackingWired: async () => {
    if (fail.taskAwaiting) throw markAwaitingApproval(new Error("task-tracking is staged and awaits administrator approval"), "task-tracking");
    if (fail.taskWire) throw new Error(LOAD_ERROR);
  },
  getTaskTrackingExtensionId: async () => null,
}));

mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => [],
}));

mock.module("../runtime/mention-wiring", () => ({
  wireMentionedExtensions: async () => {
    if (fail.mentioned) throw new Error(LOAD_ERROR);
  },
  resolveMentionedAgents: async () => [],
  resolveMentionedTeams: async () => [],
  applyCommandExpansion: async (s: string) => s,
}));

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

const PROJECT_DIR = `/tmp/setup-load-errors-${crypto.randomUUID().slice(0, 8)}`;

let projectId: string;
let convId: string;

/** Setup-logger warnings (stderr) and info lines (stdout) written while a test runs. */
let warnings: Array<{ msg: string; error?: string }> = [];
let infos: string[] = [];
let spies: Array<ReturnType<typeof spyOn>> = [];

/** Pass a stream through, and record the setup logger's lines of `level` into `sink`. */
function captureSetupLog(stream: NodeJS.WriteStream, level: string, sink: (entry: { msg: string; error?: string }) => void) {
  const write = stream.write.bind(stream);
  return spyOn(stream, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.includes('"subsystem":"executor.streamChat.setup"')) continue;
      const entry = JSON.parse(line) as { level: string; msg: string; error?: string };
      if (entry.level === level) sink({ msg: entry.msg, error: entry.error });
    }
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof stream.write);
}

beforeAll(async () => {
  mkdirSync(PROJECT_DIR, { recursive: true });
  await setupTestDb();
  const project = await createProject({ name: "Load Error Test", path: PROJECT_DIR });
  projectId = project.id;
  convId = (await createConversation(projectId)).id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(() => {
  for (const key of Object.keys(fail) as Array<keyof typeof fail>) fail[key] = false;
  capturedAgentOpts = null;
  warnings = [];
  infos = [];
  spies = [
    captureSetupLog(process.stderr, "warn", (entry) => warnings.push(entry)),
    captureSetupLog(process.stdout, "info", (entry) => infos.push(entry.msg)),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

async function runTurn(options: Record<string, unknown> = {}): Promise<string[]> {
  const executor = new AgentExecutor(new Map(), new EventBus<AgentEvents>(), { persist: false });
  await executor.streamChat(convId, "hello", { projectId, permissionMode: "yolo", ...options });
  // The turn still starts: the Agent was built.
  expect(capturedAgentOpts).not.toBeNull();
  return (capturedAgentOpts.initialState.tools as Array<{ name: string }>).map((t) => t.name);
}

/** The one warning whose cause is the planted load error. */
function loadErrorWarnings(): Array<{ msg: string; error?: string }> {
  return warnings.filter((w) => w.error?.includes(LOAD_ERROR));
}

describe("setup-tools logs the cause of a non-fatal wiring failure", () => {
  test("control: no failure → built-in tools wired, no load-error warning", async () => {
    const tools = await runTurn();
    expect(tools).toContain("shell");
    expect(loadErrorWarnings()).toEqual([]);
  });

  test("built-in tool load fails → turn starts without built-in tools, cause logged", async () => {
    fail.builtin = true;
    const tools = await runTurn();
    expect(tools).not.toContain("shell");
    expect(loadErrorWarnings()).toEqual([
      { msg: "Built-in tool loading failed — built-in tools unavailable this turn", error: `Error: ${LOAD_ERROR}` },
    ]);
  });

  test("agent-config extension tools fail → cause logged", async () => {
    fail.agentExtensions = true;
    await runTurn({ agentConfigId: crypto.randomUUID() });
    expect(loadErrorWarnings()).toEqual([
      { msg: "Agent-config extension tools wire failed — those tools unavailable this turn", error: `Error: ${LOAD_ERROR}` },
    ]);
  });

  test("mentioned-extension wire fails → cause logged", async () => {
    fail.mentioned = true;
    await runTurn();
    expect(loadErrorWarnings()).toEqual([
      { msg: "Mentioned/conversation extension wire failed — those tools unavailable this turn", error: `Error: ${LOAD_ERROR}` },
    ]);
  });

  test("sub-agent member wire fails → cause logged", async () => {
    fail.subAgents = true;
    await runTurn({ subAgentMembers: [{ agentConfigId: crypto.randomUUID() }] });
    expect(loadErrorWarnings()).toEqual([
      { msg: "Sub-agent member wire failed — sub-agents unavailable this turn", error: `Error: ${LOAD_ERROR}` },
    ]);
  });

  test("agent config reference wire fails → cause logged", async () => {
    fail.agentRefs = true;
    await runTurn({ agentConfigId: crypto.randomUUID() });
    expect(loadErrorWarnings()).toContainEqual({
      msg: "Agent config reference wire failed — referenced agents unavailable this turn",
      error: `Error: ${LOAD_ERROR}`,
    });
  });

  test("memory embedding load fails → turn starts, cause logged", async () => {
    fail.memory = true;
    await runTurn();
    const logged = loadErrorWarnings();
    expect(logged.map((w) => w.msg)).toEqual(["Memory/KB injection failed — memory unavailable this turn"]);
    // A host where sharp itself cannot load (NixOS without libstdc++) fails
    // inside the real module before the mock answers; either way the logged
    // cause is the sharp load error.
    expect(logged[0]!.error!.startsWith(`Error: ${LOAD_ERROR}`)).toBe(true);
  });

  test("task-tracking staged, awaiting approval → no per-turn warning, one info line", async () => {
    fail.taskAwaiting = true;
    await runTurn();
    await runTurn();
    expect(warnings.filter((w) => w.msg.startsWith("Task-tracking wire failed"))).toEqual([]);
    expect(infos.filter((m) => m === "task-tracking is staged and awaits administrator approval")).toHaveLength(1);
  });

  test("a genuine task-tracking wire failure still warns with its cause", async () => {
    fail.taskWire = true;
    await runTurn();
    expect(loadErrorWarnings()).toEqual([
      { msg: "Task-tracking wire failed — task tools unavailable this turn", error: `Error: ${LOAD_ERROR}` },
    ]);
  });
});


