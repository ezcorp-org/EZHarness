/**
 * Caller-executed tools through the REAL executor path.
 *
 * The two suites either side of this one pin the pieces: the wire builds the
 * defs (`caller-tools-host.test.ts`) and the filter honours `preservedTools`
 * (`caller-tool-scope.test.ts`). Neither can catch the failure that actually
 * ships, which is a wiring one:
 *
 *   - `setup-tools.ts` §2b does `ctx.agentTools = extTools.map(...)` — an
 *     ASSIGNMENT that discards everything pushed before it. A caller wire
 *     placed above that line registers tools that silently never exist.
 *   - The executor is the SOLE populator of `preservedTools`. If it stops
 *     injecting them, every declared tool vanishes under any mode, and each
 *     unit suite still passes.
 *
 * So this drives `streamChat` end to end against a real DB and a mock Agent,
 * and asserts on the tool array pi-agent-core is actually handed.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// ── DB mock (must be first) ──────────────────────────────────────────
mockDbConnection();

// ── Capture what pi-agent-core's Agent receives ──────────────────────
let capturedAgentOpts: { initialState: { tools: Array<{ name: string }> } } | null = null;

mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: undefined };
    constructor(opts: { initialState: { tools: Array<{ name: string }> } }) {
      capturedAgentOpts = opts;
    }
    prompt = mock(async () => {});
    subscribe = mock((fn: (e: { type: string; messages: unknown[] }) => void) => {
      queueMicrotask(() => fn({ type: "agent_end", messages: [] }));
      return () => {};
    });
  },
}));

// ── Provider mocks ───────────────────────────────────────────────────
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
  createFileProvider: () => ({
    read: async () => "",
    write: async () => {},
    exists: async () => false,
  }),
}));

// ── Observability / runs ─────────────────────────────────────────────
mock.module("../observability/collector", () => ({ startCollector: () => {} }));
mock.module("../db/queries/runs", () => ({ insertRun: async () => {}, updateRun: async () => {} }));
mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => {},
  deleteActiveRun: async () => {},
  cleanupOrphanedRuns: async () => {},
  updateHeartbeat: async () => {},
  updatePartialResponse: async () => {},
}));

// ── Memory injection (skip embeddings) ───────────────────────────────
mock.module("../memory/embeddings", () => ({
  generateEmbedding: async () => new Float32Array(384),
}));
mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async (sys: string | undefined) => ({
    systemPrompt: sys ?? "",
    memoriesUsed: [],
  }),
}));

// ── Host wires this suite does not exercise ──────────────────────────
mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getToolsForAgent: async () => [],
      getToolsForExtension: () => [],
    }),
  },
}));
mock.module("../runtime/orchestration-host", () => ({
  ensureOrchestrationWired: async () => true,
  wireOrchestrationToolsForTurn: async () => {},
}));
mock.module("../runtime/ask-user-host", () => ({
  ensureAskUserWired: async () => false,
  wireAskUserToolForTurn: async () => {},
  _resetAskUserExtensionIdCache: () => {},
}));
mock.module("../runtime/task-tracking-host", () => ({ ensureTaskTrackingWired: async () => {} }));

// ── Import after all mocks ───────────────────────────────────────────
const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { createProject } = await import("../db/queries/projects");
const { createConversation, updateConversation } = await import("../db/queries/conversations");
const { createUser } = await import("../db/queries/users");
const { createMode } = await import("../db/queries/modes");
const { mergeConversationMetadata } = await import("../db/queries/conversation-metadata");
type AgentEvents = import("../types").AgentEvents;

const OPEN_APP = {
  name: "open_app",
  description: "Open a native application",
  parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
};

let projectId: string;
let userId: string;
let readOnlyModeId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Caller Scope", path: "/tmp/caller-scope" });
  projectId = project.id;
  const user = await createUser({
    email: `caller-scope-${Date.now()}@x`,
    name: "Caller Owner",
    passwordHash: "x",
  });
  userId = user.id;
  const mode = await createMode({
    name: "Read Only",
    slug: `caller-read-only-${Date.now()}`,
    systemPromptInstruction: "Look, don't touch.",
    toolRestriction: "read-only",
  });
  readOnlyModeId = mode.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(() => {
  capturedAgentOpts = null;
});

async function conversationWithCallerTools(
  opts: { declare?: boolean; extensionTools?: Record<string, string[]> } = {},
): Promise<string> {
  const conv = await createConversation(projectId, { userId });
  if (opts.declare !== false) {
    await mergeConversationMetadata(conv.id, { callerTools: [OPEN_APP] });
  }
  if (opts.extensionTools) {
    await updateConversation(conv.id, { extensionTools: opts.extensionTools });
  }
  return conv.id;
}

async function toolNames(convId: string, modeId?: string): Promise<string[]> {
  const executor = new AgentExecutor(new Map(), new EventBus<AgentEvents>(), { persist: false });
  await executor.streamChat(convId, "do something", {
    projectId,
    ...(modeId ? { modeId } : {}),
  });
  if (!capturedAgentOpts) throw new Error("the mock Agent was never constructed");
  return capturedAgentOpts.initialState.tools.map((t) => t.name);
}

describe("a declared caller tool reaches the model", () => {
  test("it is wired AFTER the assignment in §2b that would have discarded it", async () => {
    const names = await toolNames(await conversationWithCallerTools());
    expect(names).toContain("_caller__open_app");
    // Sanity: the project built-ins are there too, so this is the real wire
    // order rather than an empty-toolset accident.
    expect(names).toContain("shell");
  });

  test("a conversation that declared nothing gets nothing", async () => {
    const names = await toolNames(await conversationWithCallerTools({ declare: false }));
    expect(names.some((n) => n.startsWith("_caller__"))).toBe(false);
  });
});

describe("preservation under a mode that cannot name it", () => {
  test("read-only strips `shell` but keeps the declared caller tool", async () => {
    const names = await toolNames(await conversationWithCallerTools(), readOnlyModeId);
    // The mode is doing its job…
    expect(names).not.toContain("shell");
    expect(names).toContain("readFile");
    // …and the caller's declaration survives it, which is the point: a mode
    // names its surface with extensionIds/allowedTools, and no mode can name
    // a tool that belongs to no extension.
    expect(names).toContain("_caller__open_app");
  });
});

describe("revocation outranks preservation", () => {
  test("the conversation's caller toggle set to OFF removes it under any mode", async () => {
    const convId = await conversationWithCallerTools({ extensionTools: { caller: [] } });
    const names = await toolNames(convId, readOnlyModeId);
    expect(names).not.toContain("_caller__open_app");
  });

  test("a toggle that names it keeps it", async () => {
    const convId = await conversationWithCallerTools({
      extensionTools: { caller: ["open_app"] },
    });
    expect(await toolNames(convId, readOnlyModeId)).toContain("_caller__open_app");
  });
});
