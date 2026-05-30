/**
 * Phase: modes.extensionIds — runtime filter coverage.
 *
 * Verifies that when a mode has `extensionIds: string[]` populated, the
 * executor:
 *   1. Resolves each id via `ExtensionRegistry.getInstance().getToolsForExtension(id)`
 *   2. Unions the returned tool names into a single allowlist
 *   3. Feeds that allowlist through `applyToolFilters` so tools NOT in
 *      the union are stripped from `ctx.agentTools` (orchestration tools
 *      survive unconditionally)
 *   4. Falls through to the legacy toolRestriction/allowedTools path
 *      when `extensionIds` is null OR empty
 *   5. The new path supersedes a non-null `mode.toolRestriction` — so a
 *      mode that declares both `extensionIds=[…]` AND
 *      `toolRestriction='read-only'` runs the allowlist path, not the
 *      read-only filter.
 *
 * Mirrors the bootstrap pattern from executor-agent-wiring.test.ts so we
 * exercise the real executor path end-to-end (real applyToolFilters,
 * real getMode, real createMode persistence) with a per-test
 * configurable extension registry mock.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// ── DB mock (must be first) ──────────────────────────────────────────
mockDbConnection();

// ── Capture what pi-agent-core's Agent receives ──────────────────────
let capturedAgentOpts: any = null;

const mockPrompt = mock(async () => {});
const mockSubscribe = mock((fn: (e: any) => void) => {
  // Immediately emit agent_end so prompt() flow completes.
  queueMicrotask(() => fn({ type: "agent_end", messages: [] }));
  return () => {};
});

mock.module("@mariozechner/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: undefined };
    constructor(opts: any) {
      capturedAgentOpts = opts;
    }
    prompt = mockPrompt;
    subscribe = mockSubscribe;
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

mock.module("../providers/registry", () => ({
  resolveOAuthModel: mock(() => null),
}));

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

// ── Observability/runs/active-runs ───────────────────────────────────
mock.module("../observability/collector", () => ({ startCollector: () => {} }));
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

// ── Registry: per-test configurable tool sets ────────────────────────
//
// Two maps drive the registry: `agentToolsMap` controls what
// setup-tools sees as the agent's tool surface (this becomes the
// initial ctx.agentTools), `extensionToolsMap` controls what
// `getToolsForExtension(extId)` returns when the mode-extensions code
// path resolves `mode.extensionIds`. Tests reset these in
// beforeEach so isolation is per-test.
const agentToolsMap = new Map<string, Array<{ name: string; description: string; inputSchema: any }>>();
const extensionToolsMap = new Map<string, Array<{ name: string; description: string; inputSchema: any }>>();
const getToolsForExtensionCalls: string[] = [];

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getToolsForAgent: async (agentConfigId: string) =>
        agentToolsMap.get(agentConfigId) ?? [],
      getToolsForExtension: (extId: string) => {
        getToolsForExtensionCalls.push(extId);
        return extensionToolsMap.get(extId) ?? [];
      },
    }),
  },
}));

mock.module("../extensions/tool-executor", () => ({
  ToolExecutor: class {
    constructor(_reg: any, _opts: any) {}
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
  extensionToAgentTool: (def: { name: string; description?: string; inputSchema?: any }) => ({
    name: def.name,
    description: def.description ?? "",
    parameters: def.inputSchema ?? { type: "object", properties: {}, required: [] },
    execute: async () => ({
      content: [{ type: "text" as const, text: "(stub)" }],
      details: {},
    }),
  }),
}));

// Orchestration host stub — auto-wires invoke_agent only when an agent
// is mentioned. Tests below don't mention agents, so invoke_agent
// stays absent. This keeps the assertion surface simple: only the
// agentConfig's extension tools land in ctx.agentTools.
mock.module("../runtime/orchestration-host", () => ({
  ensureOrchestrationWired: async () => true,
  wireOrchestrationToolsForTurn: async () => {},
}));

// ask-user host stub — no-op for this suite.
mock.module("../runtime/ask-user-host", () => ({
  ensureAskUserWired: async () => true,
  wireAskUserToolForTurn: async () => {},
  _resetAskUserExtensionIdCache: () => {},
}));

// task-tracking host stub — no-op for this suite.
mock.module("../runtime/task-tracking-host", () => ({
  ensureTaskTrackingWired: async () => {},
}));

// ── Import after all mocks ───────────────────────────────────────────
const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { createAgentConfig } = await import("../db/queries/agent-configs");
const { createMode } = await import("../db/queries/modes");
type AgentEvents = import("../types").AgentEvents;

let projectId: string;
let topConvId: string;
let agentConfigId: string;

const TOOL_DEF = (name: string) => ({
  name,
  description: `stub ${name}`,
  inputSchema: { type: "object", properties: {}, required: [] },
});

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Mode-Ext Filter Test", path: "/tmp/mode-ext-filter" });
  projectId = project.id;

  const conv = await createConversation(projectId);
  topConvId = conv.id;

  const ac = await createAgentConfig({
    name: "ext-filter-agent",
    description: "Agent whose extension tool surface is filtered by mode.extensionIds",
    prompt: "You are a filter test agent.",
  });
  agentConfigId = ac.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(() => {
  agentToolsMap.clear();
  extensionToolsMap.clear();
  getToolsForExtensionCalls.length = 0;
  capturedAgentOpts = null;
});

function createExecutor() {
  const bus = new EventBus<AgentEvents>();
  const executor = new AgentExecutor(new Map(), bus, { persist: false });
  return { executor, bus };
}

function nameSet(tools: Array<{ name: string }>): Set<string> {
  return new Set(tools.map((t) => t.name));
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("executor mode.extensionIds → allowlist filter", () => {
  test("non-empty extensionIds: tools are filtered to the union of getToolsForExtension(extId) names", async () => {
    // Agent's extension tool surface includes three tools; the mode
    // attaches one extension that exposes only the first two. tool_c
    // must be stripped.
    agentToolsMap.set(agentConfigId, [
      TOOL_DEF("ext-x__tool_a"),
      TOOL_DEF("ext-x__tool_b"),
      TOOL_DEF("ext-y__tool_c"),
    ]);
    extensionToolsMap.set("ext-attached", [
      TOOL_DEF("ext-x__tool_a"),
      TOOL_DEF("ext-x__tool_b"),
    ]);

    const mode = await createMode({
      name: "Allowlist Mode",
      slug: "allowlist-mode-" + Date.now(),
      systemPromptInstruction: "Use only the attached extensions.",
      extensionIds: ["ext-attached"],
    });

    const { executor } = createExecutor();
    await executor.streamChat(topConvId, "do something", {
      projectId,
      agentConfigId,
      modeId: mode.id,
    });

    expect(capturedAgentOpts).not.toBeNull();
    const tools: any[] = capturedAgentOpts.initialState.tools;
    const names = nameSet(tools);

    expect(names.has("ext-x__tool_a")).toBe(true);
    expect(names.has("ext-x__tool_b")).toBe(true);
    expect(names.has("ext-y__tool_c")).toBe(false);

    // The executor MUST have called getToolsForExtension with each id
    // declared on the mode — proves the resolution loop fired.
    expect(getToolsForExtensionCalls).toContain("ext-attached");
  });

  test("union: multiple extensionIds combine into a single allowlist", async () => {
    agentToolsMap.set(agentConfigId, [
      TOOL_DEF("a_tool"),
      TOOL_DEF("b_tool"),
      TOOL_DEF("c_tool"),
      TOOL_DEF("d_tool"),
    ]);
    extensionToolsMap.set("ext-1", [TOOL_DEF("a_tool"), TOOL_DEF("b_tool")]);
    extensionToolsMap.set("ext-2", [TOOL_DEF("c_tool")]);

    const mode = await createMode({
      name: "Union Mode",
      slug: "union-mode-" + Date.now(),
      systemPromptInstruction: "Two extensions.",
      extensionIds: ["ext-1", "ext-2"],
    });

    const { executor } = createExecutor();
    await executor.streamChat(topConvId, "do something", {
      projectId,
      agentConfigId,
      modeId: mode.id,
    });

    const names = nameSet(capturedAgentOpts.initialState.tools);
    expect(names.has("a_tool")).toBe(true);
    expect(names.has("b_tool")).toBe(true);
    expect(names.has("c_tool")).toBe(true);
    // d_tool is NOT in the union and must be stripped.
    expect(names.has("d_tool")).toBe(false);
    // Deduped — wire-step (setup-tools) and filter-step (executor) each
    // resolve every modeExt id, so duplicates are expected in the call log.
    expect([...new Set(getToolsForExtensionCalls)].sort()).toEqual(["ext-1", "ext-2"]);
  });

  test("overlapping tools across extensions: deduplicated in the allowlist", async () => {
    // Two extensions that both expose the same tool name — the union
    // resolves to a single entry. Asserts the allowlist set is
    // de-duplicated (not just concatenated).
    agentToolsMap.set(agentConfigId, [TOOL_DEF("shared_tool"), TOOL_DEF("only_ext_1")]);
    extensionToolsMap.set("ext-a", [TOOL_DEF("shared_tool"), TOOL_DEF("only_ext_1")]);
    extensionToolsMap.set("ext-b", [TOOL_DEF("shared_tool")]);

    const mode = await createMode({
      name: "Overlap Mode",
      slug: "overlap-mode-" + Date.now(),
      systemPromptInstruction: "Overlap.",
      extensionIds: ["ext-a", "ext-b"],
    });

    const { executor } = createExecutor();
    await executor.streamChat(topConvId, "do something", {
      projectId,
      agentConfigId,
      modeId: mode.id,
    });

    const tools: any[] = capturedAgentOpts.initialState.tools;
    // shared_tool appears exactly once in ctx.agentTools (it was already
    // unique there), AND it survives the filter.
    const sharedCount = tools.filter((t: any) => t.name === "shared_tool").length;
    expect(sharedCount).toBe(1);
    const names = nameSet(tools);
    expect(names.has("only_ext_1")).toBe(true);
  });

  test("empty extensionIds: falls through to legacy toolRestriction path (read-only filter applies)", async () => {
    // mode.extensionIds = [] → executor takes the `else if (mode.toolRestriction)`
    // branch. With toolRestriction='read-only', non-read tools are
    // stripped. Our stub agent tools have no builtinDef entry, so under
    // read-only ALL of them get stripped (only orchestration tools
    // would survive, and we stubbed those out for this suite).
    agentToolsMap.set(agentConfigId, [
      TOOL_DEF("read_a"),
      TOOL_DEF("write_b"),
    ]);
    extensionToolsMap.set("ext-noop", [TOOL_DEF("read_a")]);

    const mode = await createMode({
      name: "Empty Ext List Mode",
      slug: "empty-ext-list-" + Date.now(),
      systemPromptInstruction: "Empty list.",
      extensionIds: [],
      toolRestriction: "read-only",
    });

    const { executor } = createExecutor();
    await executor.streamChat(topConvId, "do something", {
      projectId,
      agentConfigId,
      modeId: mode.id,
    });

    const names = nameSet(capturedAgentOpts.initialState.tools);
    // Read-only filter strips both stubs (neither is in builtinToolDefsMap as 'read').
    expect(names.has("read_a")).toBe(false);
    expect(names.has("write_b")).toBe(false);
    // The new allowlist path was NOT taken: getToolsForExtension was
    // never called for this mode.
    expect(getToolsForExtensionCalls).toEqual([]);
  });

  test("null extensionIds (legacy mode row): falls through to toolRestriction='all' (no filter)", async () => {
    // A mode created without extensionIds defaults to null. With
    // toolRestriction='all' the legacy filter is also a no-op, so all
    // tools survive.
    agentToolsMap.set(agentConfigId, [TOOL_DEF("keep_a"), TOOL_DEF("keep_b")]);

    const mode = await createMode({
      name: "Legacy Null Mode",
      slug: "legacy-null-" + Date.now(),
      systemPromptInstruction: "Null extensionIds.",
      toolRestriction: "all",
      // extensionIds intentionally omitted → persists as null
    });

    const { executor } = createExecutor();
    await executor.streamChat(topConvId, "do something", {
      projectId,
      agentConfigId,
      modeId: mode.id,
    });

    const names = nameSet(capturedAgentOpts.initialState.tools);
    expect(names.has("keep_a")).toBe(true);
    expect(names.has("keep_b")).toBe(true);
    expect(getToolsForExtensionCalls).toEqual([]);
  });

  test("non-empty extensionIds supersedes mode.toolRestriction=read-only", async () => {
    // The mode declares BOTH a read-only restriction AND an extensionIds
    // attachment. The new allowlist path must win — the legacy
    // read-only filter is skipped, and a 'write-ish' tool that's part
    // of the attached extension survives.
    agentToolsMap.set(agentConfigId, [
      TOOL_DEF("read_x"),
      TOOL_DEF("write_y"),
      TOOL_DEF("write_z"),
    ]);
    extensionToolsMap.set("ext-write-allowed", [
      TOOL_DEF("write_y"),
    ]);

    const mode = await createMode({
      name: "Supersede Mode",
      slug: "supersede-mode-" + Date.now(),
      systemPromptInstruction: "Mixed declarations.",
      extensionIds: ["ext-write-allowed"],
      toolRestriction: "read-only", // would normally strip write_y
    });

    const { executor } = createExecutor();
    await executor.streamChat(topConvId, "do something", {
      projectId,
      agentConfigId,
      modeId: mode.id,
    });

    const names = nameSet(capturedAgentOpts.initialState.tools);
    // Allowlist path picked write_y from the attached extension —
    // proves toolRestriction='read-only' was bypassed.
    expect(names.has("write_y")).toBe(true);
    // Tools NOT in the attached extension are stripped, even
    // read-category ones. The mode authors declared the surface
    // explicitly via extensionIds.
    expect(names.has("read_x")).toBe(false);
    expect(names.has("write_z")).toBe(false);
  });

  test("extensionIds with an unknown id (no tools registered): allowlist union is empty, all non-orch tools stripped", async () => {
    // Defensive: a stale extension id on the mode should not crash —
    // it just contributes an empty tool set to the union. With no
    // other extensions attached, the resulting allowlist is empty and
    // every non-orchestration tool gets filtered out.
    agentToolsMap.set(agentConfigId, [TOOL_DEF("foo"), TOOL_DEF("bar")]);
    // extensionToolsMap has no entry for 'ext-missing' → returns []

    const mode = await createMode({
      name: "Unknown Ext Mode",
      slug: "unknown-ext-" + Date.now(),
      systemPromptInstruction: "Unknown ext.",
      extensionIds: ["ext-missing"],
    });

    const { executor } = createExecutor();
    await executor.streamChat(topConvId, "do something", {
      projectId,
      agentConfigId,
      modeId: mode.id,
    });

    const names = nameSet(capturedAgentOpts.initialState.tools);
    expect(names.has("foo")).toBe(false);
    expect(names.has("bar")).toBe(false);
    // The id WAS resolved (call recorded), it just returned [].
    expect(getToolsForExtensionCalls).toContain("ext-missing");
  });

  test("no modeId option: extensionIds path is never consulted", async () => {
    // Basic sanity — without modeId the entire mode-resolve block is
    // skipped, so getToolsForExtension is never called regardless of
    // what's registered.
    agentToolsMap.set(agentConfigId, [TOOL_DEF("any_tool")]);
    extensionToolsMap.set("ext-something", [TOOL_DEF("any_tool")]);

    const { executor } = createExecutor();
    await executor.streamChat(topConvId, "do something", {
      projectId,
      agentConfigId,
      // no modeId
    });

    const names = nameSet(capturedAgentOpts.initialState.tools);
    expect(names.has("any_tool")).toBe(true);
    expect(getToolsForExtensionCalls).toEqual([]);
  });

  // Regression: filter-only is insufficient. The mode picker is useless
  // unless setup-tools also INJECTS the attached extensions' tools into
  // ctx.agentTools BEFORE the executor's allowlist filter runs. Without
  // the wire step (setup-tools.ts:2c-mode), the filter intersects with
  // tools that were never wired and the LLM ends up with only
  // orchestration tools — which is exactly the bug the user reported.
  test("wire-then-filter: mode.extensionIds tools are injected even when agent-config contributes nothing", async () => {
    // Agent config has NO extension tools. The only way mode.extensionIds
    // tools can reach ctx.agentTools is if setup-tools wires them.
    agentToolsMap.set(agentConfigId, []);
    extensionToolsMap.set("ext-mode-only", [
      TOOL_DEF("mode_tool_alpha"),
      TOOL_DEF("mode_tool_beta"),
    ]);

    const mode = await createMode({
      name: "Mode-Only Wire",
      slug: "mode-only-wire-" + Date.now(),
      systemPromptInstruction: "Tools come exclusively from the mode.",
      extensionIds: ["ext-mode-only"],
    });

    const { executor } = createExecutor();
    await executor.streamChat(topConvId, "do something", {
      projectId,
      agentConfigId,
      modeId: mode.id,
    });

    const names = nameSet(capturedAgentOpts.initialState.tools);
    expect(names.has("mode_tool_alpha")).toBe(true);
    expect(names.has("mode_tool_beta")).toBe(true);
  });
});
