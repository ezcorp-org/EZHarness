/**
 * workingDir containment pin — setup-tools → REAL shell tool regression.
 *
 * The ez-code-factory drive-3 breach: a pipeline-dispatched sub-agent's
 * per-call shell cwd defaulted to the conversation's PROJECT root (the
 * worktree existed only as prompt prose), and the agent ran `rm -rf .ezcorp`
 * there — destroying the dispatching extension's gate repo + kept worktrees.
 *
 * This suite proves the fix at the enforcement point: when streamChat's
 * options carry `workingDir` (threaded from spawn-assignment), the REAL
 * built-in shell tool executes with that directory as its cwd — and without
 * it, the project path stays the root (no regression for normal chats).
 * Harness mirrors setup-tools-memory-tail.test.ts: stub the runtime imports,
 * run `streamChat` end-to-end, capture the Agent's tools, execute `pwd`.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

// ── DB mock (must be first, before any module that imports db/connection) ──
mockDbConnection();

// ── Capture what pi-agent-core's Agent receives ──
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

// ── Memory recall: nothing to inject — skip the embedding pipeline ──
mock.module("../db/queries/memories", () => ({
  hasMemories: async () => false,
}));

mock.module("../db/queries/knowledge-base", () => ({
  hasKBChunks: async () => false,
}));

// ── Neutral stubs for the tool-loading path (not this suite's surface) ──
mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getToolsForAgent: async () => [],
      getToolsForExtension: () => [],
    }),
  },
}));

mock.module("../runtime/task-tracking-host", () => ({
  ensureTaskTrackingWired: async () => {},
  getTaskTrackingExtensionId: async () => null,
}));

mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionIds: async () => [],
}));

mock.module("../runtime/mention-wiring", () => ({
  wireMentionedExtensions: async () => {},
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

const SUFFIX = crypto.randomUUID().slice(0, 8);
const PROJECT_DIR = `/tmp/wd-pin-project-${SUFFIX}`;
const WORKTREE_DIR = `/tmp/wd-pin-worktree-${SUFFIX}`;

let projectId: string;
let convId: string;

beforeAll(async () => {
  mkdirSync(PROJECT_DIR, { recursive: true });
  mkdirSync(WORKTREE_DIR, { recursive: true });
  await setupTestDb();
  const project = await createProject({ name: "WD Pin Test", path: PROJECT_DIR });
  projectId = project.id;
  const conv = await createConversation(projectId);
  convId = conv.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

/** Run `pwd` through the captured REAL shell tool and return its stdout. */
async function shellPwd(): Promise<string> {
  const tools: Array<{
    name: string;
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
    ) => Promise<{ content: Array<{ text: string }> }>;
  }> = capturedAgentOpts.initialState.tools;
  const shell = tools.find((t) => t.name === "shell");
  expect(shell).toBeDefined();
  const result = await shell!.execute("tc-1", { command: "pwd" }, undefined, undefined);
  return (result.content[0]!.text as string).trim();
}

describe("workingDir containment pin — real shell tool cwd", () => {
  test("options.workingDir set → shell executes IN the pinned worktree, not the project", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus, { persist: false });
    capturedAgentOpts = null;

    await executor.streamChat(convId, "run pwd", {
      projectId,
      workingDir: WORKTREE_DIR,
      permissionMode: "yolo",
    });

    expect(capturedAgentOpts).not.toBeNull();
    // realpath both sides — /tmp may be a symlink (e.g. → /private/tmp).
    expect(await shellPwd()).toBe(realpathSync(WORKTREE_DIR));
  });

  test("no workingDir → shell executes in the project path (default unchanged)", async () => {
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus, { persist: false });
    capturedAgentOpts = null;

    await executor.streamChat(convId, "run pwd", { projectId, permissionMode: "yolo" });

    expect(capturedAgentOpts).not.toBeNull();
    expect(await shellPwd()).toBe(realpathSync(PROJECT_DIR));
  });
});
