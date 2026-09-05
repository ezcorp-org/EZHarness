/**
 * tool-call-persist-losses defect 1 — patch-coverage gap fix.
 *
 * setup-tools.ts's scratchpad auto-wire block (the S7-gated branch that
 * fires when the bundled `scratchpad` extension is installed, enabled, and
 * storage-granted) is ONE of the SIX call sites that used to thread `run.id`
 * through `extensionToAgentTool` as a `messageId` "placeholder" — a value
 * that is never a real `messages.id`, so every such insert violated
 * `tool_calls.message_id`'s FK and was silently dropped. Every other call
 * site got exercised by an existing test after the fix (orchestration-host,
 * ask-user, the other three setup-tools.ts sites); THIS one — the success
 * branch of the scratchpad auto-wire — was not, because every existing
 * setup-tools/executor test runs against a registry mock that returns no
 * scratchpad tools, so the branch's `for` loop never iterates and the push
 * line never runs.
 *
 * This test drives a real `AgentExecutor.streamChat()` turn against a REAL
 * scratchpad extension row (enabled + storage granted) so the S7 gate
 * genuinely passes, and asserts the ACTUAL behavior the fix is about: the
 * wired tool dispatches with `messageId: null`, not `run.id`.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mockDbConnection();

// ── Capture what pi-agent-core's Agent receives ──
let capturedAgentOpts: { initialState: { tools: Array<{ name: string }> } } | null = null;

mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: undefined };
    constructor(opts: any) {
      capturedAgentOpts = opts;
    }
    prompt = mock(async () => {});
    subscribe = mock((fn: (e: unknown) => void) => {
      queueMicrotask(() => fn({ type: "agent_end", messages: [] }));
      return () => {};
    });
  },
}));

mock.module("../providers/router", () => ({
  resolveModel: async () => ({
    provider: "anthropic",
    model: "claude-sonnet-4",
    piModel: { provider: "anthropic", id: "claude-sonnet-4" },
  }),
  ProviderUnavailableError: class extends Error {
    failedProvider = "";
    failedModel = "";
    suggestion = "";
  },
}));
mock.module("../providers/registry", () => ({ resolveOAuthModel: () => null }));
mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
}));
mock.module("../providers/shell", () => ({
  createShellProvider: () => ({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }),
}));
mock.module("../providers/file", () => ({
  createFileProvider: () => ({ read: async () => "", write: async () => {}, exists: async () => false }),
}));
mock.module("../observability/collector", () => ({ startCollector: () => () => {} }));
mock.module("../db/queries/runs", () => ({ insertRun: async () => {}, updateRun: async () => {}, insertLog: async () => {} }));
mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => ({}),
  deleteActiveRun: async () => true,
  cleanupOrphanedRuns: async () => 0,
  updateHeartbeat: async () => ({}),
  updatePartialResponse: async () => ({}),
}));
mock.module("../memory/embeddings", () => ({ generateEmbedding: async () => new Float32Array(384) }));
mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async (sys: string | undefined) => ({ systemPrompt: sys ?? "", memoriesUsed: [] }),
}));
mock.module("../runtime/orchestration-host", () => ({
  ensureOrchestrationWired: async () => true,
  wireOrchestrationToolsForTurn: async () => {},
  // setup-tools.ts's 2c block destructures this alongside the two above at
  // several call sites (agentConfigId-orchestration wiring, the no-mention
  // collect_agent_result gate) — an undefined export there throws, and that
  // throw is swallowed by setup-tools.ts's own silent `catch { /* Dynamic
  // tool wiring failure is non-fatal */ }`, skipping the REST of the 2c
  // block (including the scratchpad auto-wire this file targets) with zero
  // trace. No orchestration extension is installed in this test, so `null`
  // matches the real not-installed behavior.
  getOrchestrationExtensionId: async () => null,
}));
mock.module("../runtime/ask-user-host", () => ({
  ensureAskUserWired: async () => true,
  wireAskUserToolForTurn: async () => {},
  _resetAskUserExtensionIdCache: () => {},
}));

// Registry mock: only the scratchpad extension (by id, resolved at
// beforeAll time below) reports tools — every other extensionId (e.g. the
// generic conversation-extensions wiring loop, which runs BEFORE the
// scratchpad block adds scratchpad to conversation_extensions and so never
// sees it anyway) gets an empty list, keeping this test isolated to the one
// call site under test.
let scratchpadExtensionId = "";
mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getToolsForAgent: async () => [],
      getToolsForExtension: (extId: string) =>
        extId === scratchpadExtensionId
          ? [{
              name: "scratchpad__scratchpad_write",
              originalName: "scratchpad_write",
              description: "Write a scratchpad note",
              inputSchema: { type: "object", properties: {} },
            }]
          : [],
    }),
  },
}));

// Capture-bag for extensionToAgentTool calls — this is the actual assertion
// surface: does the scratchpad auto-wire pass messageId: null (fixed) or
// run.id (the defect)?
interface CapturedCall { name: string; conversationId: string; messageId: string | null }
const capturedExtToolCalls: CapturedCall[] = [];

mock.module("../extensions/tool-executor", () => ({
  ToolExecutor: class {
    setPendingPermissionGate() {}
    setStateMediator() {}
    setExecutor() {}
    setSpawnQuota() {}
    setArgsResolver() {}
    setCurrentUserId() {}
    setCurrentModel() {}
    setCurrentProvider() {}
    setCurrentAgentConfigId() {}
  },
  extensionToAgentTool: (
    extTool: { name: string },
    _toolExecutor: unknown,
    conversationId: string,
    messageId: string | null,
  ) => {
    capturedExtToolCalls.push({ name: extTool.name, conversationId, messageId });
    return { name: extTool.name, label: extTool.name, description: "stub", parameters: {}, execute: async () => ({ content: [] }) };
  },
}));

// ── Import after all mocks ──
const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { addConversationExtensions } = await import("../db/queries/conversation-extensions");
const { createAgentConfig } = await import("../db/queries/agent-configs");
const { extensions } = await import("../db/schema");
type AgentEvents = import("../types").AgentEvents;

const agentName = "scratchpad-autowire-test-agent";
let projectId: string;
let conversationId: string;

beforeAll(async () => {
  await setupTestDb();

  const project = await createProject({ name: "Scratchpad Autowire Test", path: "/tmp/scratchpad-autowire-test" });
  projectId = project.id;
  const conv = await createConversation(projectId);
  conversationId = conv.id;

  // Real, enabled, storage-granted scratchpad row — the exact S7 gate the
  // production code checks via getExtensionByName (unmocked: real DB read).
  const inserted = await getTestDb()
    .insert(extensions)
    .values({
      id: `scratchpad-${crypto.randomUUID().slice(0, 8)}`,
      name: "scratchpad",
      version: "0.0.0",
      description: "test",
      manifest: { name: "scratchpad", version: "0.0.0" } as any,
      source: "test",
      installPath: "/",
      enabled: true,
      grantedPermissions: { storage: true } as any,
    })
    .returning({ id: extensions.id });
  scratchpadExtensionId = inserted[0]!.id;

  // The whole "2c mentioned/conversation extensions" region setup-tools.ts
  // nests the scratchpad auto-wire block inside is gated on
  // `getConversationExtensionIds(conversationId).length > 0` — a brand new
  // conversation with NO extension wired yet never reaches it at all. The
  // scratchpad S7 gate is evaluated independently via getExtensionByName,
  // so any already-wired extension satisfies the outer gate; wire an
  // unrelated one (the registry mock above returns [] for any id but
  // scratchpad's, so this contributes no tools of its own).
  const other = await getTestDb()
    .insert(extensions)
    .values({
      id: `other-ext-${crypto.randomUUID().slice(0, 8)}`,
      name: `other-ext-${crypto.randomUUID().slice(0, 8)}`,
      version: "0.0.0",
      description: "test",
      manifest: { name: "other", version: "0.0.0" } as any,
      source: "test",
      installPath: "/",
      enabled: true,
    })
    .returning({ id: extensions.id });
  await addConversationExtensions(conversationId, [{ extensionId: other[0]!.id }]);

  // The scratchpad auto-wire sits inside setup-tools.ts's 2d orchestration
  // block, itself gated on `allAvailableAgents.length > 0` — resolved from
  // `![agent:name]` mentions in the user message. Without a mentioned (and
  // resolvable, i.e. real) agent config, that whole block — including
  // scratchpad — never runs at all. This has nothing to do with S7 itself;
  // it is simply the turn shape that reaches that code.
  await createAgentConfig({
    name: agentName,
    description: "An agent for the scratchpad-autowire coverage test",
    prompt: "You are a test agent.",
  });
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("scratchpad auto-wire (S7) — extensionToAgentTool messageId", () => {
  test("wires scratchpad__scratchpad_write and dispatches it with messageId: null, not run.id", async () => {
    capturedAgentOpts = null;
    capturedExtToolCalls.length = 0;

    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus, { persist: false });
    // `![agent:name]` mention: the only thing that gets setup-tools.ts's 2d
    // block (and, nested inside it, the scratchpad auto-wire) to run at all
    // — see the beforeAll comment above.
    const run = await executor.streamChat(conversationId, `![agent:${agentName}] help me`, { projectId });

    expect(run.status).toBe("success");
    expect(capturedAgentOpts).not.toBeNull();

    // The tool actually made it into the turn's toolset — proves the S7
    // gate passed and the `for` loop body (setup-tools.ts's scratchpad
    // push, including the line under test) executed, not just the
    // surrounding try/catch.
    const tools = capturedAgentOpts!.initialState.tools;
    expect(tools.find((t) => t.name === "scratchpad__scratchpad_write")).toBeDefined();

    // The actual regression assertion: extensionToAgentTool was called for
    // this wire with messageId === null. Before the fix this call site
    // passed `run.id` (a string) here — which is never a real message id
    // and always violated tool_calls.message_id's FK — so a non-null value
    // here is exactly the defect re-appearing.
    const call = capturedExtToolCalls.find((c) => c.name === "scratchpad__scratchpad_write");
    expect(call).toBeDefined();
    expect(call!.conversationId).toBe(conversationId);
    expect(call!.messageId).toBeNull();
  });
});
