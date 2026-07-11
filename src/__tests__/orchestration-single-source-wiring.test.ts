/**
 * FU1 — single-source per-turn orchestration tool wiring.
 *
 * The registry keys extension tools NAMESPACED (`orchestration__invoke_agent`),
 * and orchestration is wire-on-first-use, so on turn 2+ it sits in
 * `conversation_extensions`. Before this fix the GENERAL conversation-extension
 * wiring in setup-tools ALSO wired orchestration's namespaced tools — a
 * `orchestration__invoke_agent` dup that BYPASSED the per-turn `agentConfigId`
 * enum allowlist that the dedicated 2d wire helper applies.
 *
 * The fix makes `wireOrchestrationToolsForTurn` (2d) the SOLE owner: the
 * general path excludes the orchestration extension, and the 2d helper wires
 * collect_agent_result unconditionally (so a follow-up turn that @mentions no
 * agent can still collect a prior background spawn) with invoke_agent enum-gated
 * on mentions.
 *
 * This suite drives `streamChat` end-to-end (mocked pi-agent captures the tool
 * list) and asserts: exactly ONE bare `invoke_agent`, ZERO `orchestration__*`
 * dups, and the collect-on-no-mention path.
 *
 * Harness mirrors executor-task-tracking-autowire.test.ts.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

let capturedAgentOpts: any = null;
const mockPrompt = mock(async () => {});
const mockSubscribe = mock((fn: (e: any) => void) => {
  queueMicrotask(() => fn({ type: "agent_end", messages: [] }));
  return () => {};
});
mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state = { error: undefined };
    constructor(opts: any) { capturedAgentOpts = opts; }
    prompt = mockPrompt;
    subscribe = mockSubscribe;
  },
}));

mock.module("../providers/router", () => ({
  resolveModel: mock(async () => ({
    provider: "anthropic", model: "claude-sonnet-4",
    piModel: { provider: "anthropic", id: "claude-sonnet-4" },
  })),
  ProviderUnavailableError: class extends Error { failedProvider = ""; failedModel = ""; suggestion = ""; },
}));
mock.module("../providers/registry", () => ({ resolveOAuthModel: mock(() => null) }));
mock.module("../providers/credentials", () => ({ getCredential: mock(async () => ({ type: "apikey", token: "k" })) }));
mock.module("../providers/shell", () => ({ createShellProvider: () => ({ run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) }) }));
mock.module("../providers/file", () => ({ createFileProvider: () => ({ read: async () => "", write: async () => {}, exists: async () => false }) }));
mock.module("../observability/collector", () => ({ startCollector: () => {} }));
mock.module("../db/queries/runs", () => ({ insertRun: async () => {}, updateRun: async () => {} }));
mock.module("../db/queries/active-runs", () => ({
  createActiveRun: async () => {}, deleteActiveRun: async () => {}, cleanupOrphanedRuns: async () => {},
  updateHeartbeat: async () => {}, updatePartialResponse: async () => {},
}));
mock.module("../memory/embeddings", () => ({ generateEmbedding: async () => new Float32Array(384) }));
mock.module("../memory/injection", () => ({
  buildSystemPromptWithMemories: async (sys: string | undefined) => ({ systemPrompt: sys ?? "", memoriesUsed: [] }),
}));
mock.module("../runtime/task-tracking-host", () => ({
  ensureTaskTrackingWired: async () => {},
  getTaskTrackingExtensionId: async () => "ext-task-tracking",
}));

const ORCH_EXT_ID = "ext-orchestration";
const OTHER_EXT_ID = "ext-other";

// Registry: orchestration's tools are keyed NAMESPACED (as the real reload
// does); a second extension provides a normal namespaced tool.
mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getToolsForAgent: async () => [],
      getToolsForExtension: (extensionId: string) => {
        if (extensionId === ORCH_EXT_ID) {
          return [
            { name: "orchestration__invoke_agent", originalName: "invoke_agent", extensionId: ORCH_EXT_ID, extensionName: "orchestration", description: "d", inputSchema: { type: "object" } },
            { name: "orchestration__collect_agent_result", originalName: "collect_agent_result", extensionId: ORCH_EXT_ID, extensionName: "orchestration", description: "d", inputSchema: { type: "object" } },
          ];
        }
        if (extensionId === OTHER_EXT_ID) {
          return [{ name: "other__tool", originalName: "tool", extensionId: OTHER_EXT_ID, extensionName: "other", description: "d", inputSchema: { type: "object" } }];
        }
        return [];
      },
    }),
  },
}));

mock.module("../extensions/tool-executor", () => ({
  ToolExecutor: class {
    setStateMediator() {} setExecutor() {} setSpawnQuota() {} setCurrentUserId() {}
    setCurrentModel() {} setCurrentProvider() {} setArgsResolver() {}
    setCurrentAgentConfigId() {} setPendingPermissionGate() {}
  },
  extensionToAgentTool: (tool: { name: string; description: string; inputSchema: unknown }) => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
    execute: async () => ({ content: [{ type: "text" as const, text: "(stub)" }], details: {} }),
  }),
}));

// Per-test knobs.
let mentionedAgents: Array<{ id: string; name: string; description: string }> = [];
mock.module("../runtime/mention-wiring", () => ({
  wireMentionedExtensions: async () => {},
  resolveMentionedAgents: async () => mentionedAgents,
  resolveMentionedTeams: async () => [],
  applyCommandExpansion: async (s: string) => s,
}));

let convExtIds: string[] = [];
mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => convExtIds,
}));

// Orchestration host: the SOLE owner. Spy the wire helper + mimic its real
// contract (collect always; invoke only when there are available agents).
const wireCalls: Array<{
  availableAgents: Array<{ id: string }>;
  teamToolScope?: unknown;
  memberOverrides?: unknown;
  parentMessageId?: unknown;
}> = [];
mock.module("../runtime/orchestration-host", () => ({
  getOrchestrationExtensionId: async () => ORCH_EXT_ID,
  ensureOrchestrationWired: async () => true,
  wireOrchestrationToolsForTurn: async (params: any) => {
    wireCalls.push({
      availableAgents: params.availableAgents,
      teamToolScope: params.teamToolScope,
      memberOverrides: params.memberOverrides,
      parentMessageId: params.parentMessageId,
    });
    const push = (name: string) =>
      params.agentTools.push({ name, label: name, description: "d", parameters: {}, execute: async () => ({ content: [] }) });
    push("collect_agent_result"); // always
    if (params.availableAgents.length > 0) push("invoke_agent"); // enum-gated
  },
}));

const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
type AgentEvents = import("../types").AgentEvents;

let projectId: string;
let convId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Single-source Test", path: "/tmp/ss-wire" });
  projectId = project.id;
  convId = (await createConversation(projectId)).id;
});
afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

function toolNames(): string[] {
  return (capturedAgentOpts?.initialState?.tools ?? []).map((t: { name: string }) => t.name);
}

describe("FU1: single-source orchestration wiring", () => {
  test("turn 2+ with an @mention: exactly ONE bare invoke_agent, ZERO namespaced orchestration dups", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });
    capturedAgentOpts = null;
    wireCalls.length = 0;
    mentionedAgents = [{ id: "a1", name: "Alpha", description: "" }];
    convExtIds = [ORCH_EXT_ID, OTHER_EXT_ID]; // orchestration persisted + a normal ext

    await exec.streamChat(convId, "@Alpha do X", { projectId });

    const names = toolNames();
    // The general convExt path wired the NON-orchestration ext...
    expect(names).toContain("other__tool");
    // ...but did NOT wire orchestration's namespaced dups.
    expect(names).not.toContain("orchestration__invoke_agent");
    expect(names).not.toContain("orchestration__collect_agent_result");
    // The 2d helper is the sole source: exactly one bare invoke_agent + collect.
    expect(names.filter((n) => n === "invoke_agent")).toHaveLength(1);
    expect(names).toContain("collect_agent_result");
    // 2d ran with the mentioned agent.
    expect(wireCalls).toHaveLength(1);
    expect(wireCalls[0]!.availableAgents.map((a) => a.id)).toEqual(["a1"]);
  });

  test("no-mention follow-up turn (orchestration persisted): collect_agent_result stays wired, invoke_agent does NOT", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });
    capturedAgentOpts = null;
    wireCalls.length = 0;
    mentionedAgents = []; // no @mention this turn
    convExtIds = [ORCH_EXT_ID, OTHER_EXT_ID];

    await exec.streamChat(convId, "is the background agent done yet?", { projectId });

    const names = toolNames();
    expect(names).toContain("other__tool");
    expect(names).not.toContain("orchestration__invoke_agent");
    expect(names).not.toContain("orchestration__collect_agent_result");
    // collect survives the no-mention turn; invoke_agent is enum-gated → absent.
    expect(names).toContain("collect_agent_result");
    expect(names).not.toContain("invoke_agent");
    // 2d ran via the persisted-but-no-mention path with an empty agent list.
    expect(wireCalls).toHaveLength(1);
    expect(wireCalls[0]!.availableAgents).toHaveLength(0);
  });

  test("no-mention follow-up threads options-carried scope (memberOverrides + parentMessageId) into the wiring; teamToolScope is not options-carried", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });
    capturedAgentOpts = null;
    wireCalls.length = 0;
    mentionedAgents = []; // no @mention this turn (send_to_agent-only follow-up)
    convExtIds = [ORCH_EXT_ID, OTHER_EXT_ID];

    // A sub-agent/nested run carries the member scope on options — it MUST reach
    // the wiring so a send_to_agent continuation in that nested context is scoped.
    const memberOverrides = new Map([["m1", { toolRestriction: "read-only" as const }]]);
    await exec.streamChat(convId, "continue the researcher", {
      projectId,
      memberOverrides,
      parentMessageId: "msg-anchor-1",
    });

    expect(wireCalls).toHaveLength(1);
    expect(wireCalls[0]!.availableAgents).toHaveLength(0);
    // The options-carried scope flowed into the follow-up wiring call.
    expect(wireCalls[0]!.memberOverrides).toEqual({ m1: { toolRestriction: "read-only" } });
    expect(wireCalls[0]!.parentMessageId).toBe("msg-anchor-1");
    // teamToolScope does NOT ride streamChat options and orchRun scratch is
    // per-turn (empty on a fresh top-level follow-up), so the wiring threading
    // alone carries NO teamToolScope here — which is exactly why the ext's
    // record-at-spawn / reuse-on-continuation is the PRIMARY defense against the
    // scope escape (see orchestration-extension.test.ts's EXPLOIT test).
    expect(wireCalls[0]!.teamToolScope).toBeUndefined();
  });

  test("no-mention turn where orchestration was NEVER used: no orchestration tools wired at all", async () => {
    const bus = new EventBus<AgentEvents>();
    const exec = new AgentExecutor(new Map(), bus, { persist: false });
    capturedAgentOpts = null;
    wireCalls.length = 0;
    mentionedAgents = [];
    convExtIds = [OTHER_EXT_ID]; // orchestration NOT wired to this conversation

    await exec.streamChat(convId, "plain follow-up", { projectId });

    const names = toolNames();
    expect(names).toContain("other__tool");
    expect(names).not.toContain("collect_agent_result");
    expect(names).not.toContain("invoke_agent");
    // 2d helper was not invoked — a plain chat doesn't get collect_agent_result.
    expect(wireCalls).toHaveLength(0);
  });
});
