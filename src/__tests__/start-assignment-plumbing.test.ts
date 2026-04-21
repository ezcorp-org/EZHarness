/**
 * Phase 4 §5.1a — start-assignment.ts → streamChat plumbing coverage.
 *
 * The audit bar requires a test that proves each of the 5 new
 * StartAssignmentOpts fields (reuseSubConversationId, parentMessageId,
 * overrides, teamToolScope, orchestrationDepth) is actually received
 * by `executor.streamChat`. Prior coverage mocked startAssignment at
 * the spawn-assignment-handler boundary — these tests exercise
 * start-assignment.ts directly with a mocked streamChat so the
 * cross-module plumbing is proven end-to-end.
 *
 * Scope is deliberately narrow: DB-touching helpers
 * (`createSubConversation`, `getSubConversations`) are mocked so the
 * test doesn't need a real PGlite. The test asserts on the 3rd arg
 * to streamChat (the options bundle).
 */

import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// ── Shared mocks: DB queries + pending-messages are out of scope ────

// Per-test replaceable — the createSubConversation / getSubConversations
// behaviors vary per case (reuse vs. fresh). Start with no pre-existing
// sub-conversations and a fresh-minted id; individual tests override via
// closures on these module-local refs.
let getSubConversationsImpl: (parentId: string) => Promise<Array<{ id: string; agentConfigId: string | null }>>
  = async () => [];
let createSubConversationImpl: (
  projectId: string,
  opts: {
    parentConversationId: string;
    parentMessageId?: string;
    agentConfigId?: string;
    systemPrompt?: string;
    title?: string;
  },
) => Promise<{ id: string }> = async () => ({ id: "sub-fresh-created" });

// Record the opts seen by createSubConversation so parentMessageId
// plumbing through the fresh-create branch is asserted from the test.
let createSubConversationCalls: Array<Record<string, unknown>> = [];

mock.module("../db/queries/conversations", () => ({
  getSubConversations: async (parentId: string) => getSubConversationsImpl(parentId),
  createSubConversation: async (projectId: string, opts: Record<string, unknown>) => {
    createSubConversationCalls.push({ projectId, ...opts });
    return createSubConversationImpl(projectId, opts as any);
  },
}));

// Dynamic import AFTER mocks are installed.
const { startAssignment } = await import("../runtime/start-assignment");
const { EventBus } = await import("../runtime/events");
const { CURRENT_MODEL_SENTINEL } = await import("../types");

import type { AgentExecutor } from "../runtime/executor";
import type { EventBus as EventBusType } from "../runtime/events";
import type { AgentEvents, TeamMemberOverrides, TeamToolScope } from "../types";
import type {
  TaskAssignment,
  TrackedTask,
  TaskSnapshot,
} from "../runtime/task-tracking-host";

// ── Fixtures ───────────────────────────────────────────────────────

type StreamChatCall = {
  conversationId: string;
  userMessage: string;
  options: Record<string, unknown>;
};

function makeMockExecutor(): { executor: AgentExecutor; calls: StreamChatCall[] } {
  const calls: StreamChatCall[] = [];
  const streamChat = mock(
    async (
      conversationId: string,
      userMessage: string,
      options: Record<string, unknown>,
    ) => {
      calls.push({ conversationId, userMessage, options });
      // Return a benign AgentRun-shaped object. startAssignment fires
      // streamChat but doesn't await it — we attach a .catch in the
      // function so a rejected promise would emit run:error; a resolved
      // promise is fine and cleanup listeners remain registered harmlessly.
      return {
        id: options.runId ?? crypto.randomUUID(),
        agentName: "chat",
        status: "success",
        startedAt: Date.now(),
        logs: [],
      };
    },
  );
  return {
    executor: { streamChat } as unknown as AgentExecutor,
    calls,
  };
}

function makeAssignment(agentConfigId = "cfg-test"): TaskAssignment {
  return {
    id: "assign-1",
    agentConfigId,
    agentName: "alice",
    isTeam: false,
    status: "assigned",
    assignedAt: new Date().toISOString(),
  };
}

function makeTask(): TrackedTask {
  return {
    id: "task-1",
    title: "Build a thing",
    description: "details",
    status: "pending",
    assignments: [],
    subtasks: [],
    priority: 0,
    createdAt: new Date().toISOString(),
  };
}

function makeSnapshot(task: TrackedTask, conversationId: string): TaskSnapshot {
  return { conversationId, tasks: [task], activeTaskId: task.id };
}

function baseOpts(overrides: Partial<Parameters<typeof startAssignment>[0]> = {}) {
  const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
  const task = overrides.task ?? makeTask();
  const assignment = overrides.assignment ?? makeAssignment();
  const snapshot = overrides.snapshot ?? makeSnapshot(task, "conv-parent");
  return {
    executor: overrides.executor ?? makeMockExecutor().executor,
    bus,
    conversationId: "conv-parent",
    taskId: task.id,
    assignment,
    task,
    snapshot,
    projectId: "proj-1",
    agentConfig: overrides.agentConfig ?? {
      id: "cfg-test",
      name: "alice",
      prompt: "you are alice",
    },
    ...overrides,
  };
}

// ── Reset module-local state between tests ─────────────────────────

beforeEach(() => {
  getSubConversationsImpl = async () => [];
  createSubConversationImpl = async () => ({ id: "sub-fresh-created" });
  createSubConversationCalls = [];
});

// ── 1. reuseSubConversationId — honored verbatim, skips DB lookup ──

describe("startAssignment — reuseSubConversationId plumbing", () => {
  test("honors reuseSubConversationId and skips the by-agentConfigId lookup", async () => {
    const { executor, calls } = makeMockExecutor();
    // If startAssignment ever hit getSubConversations with a
    // reuseSubConversationId set, this would throw and fail the test.
    let subLookupHit = false;
    getSubConversationsImpl = async () => {
      subLookupHit = true;
      return [];
    };

    const opts = baseOpts({ executor, reuseSubConversationId: "sub-preresolved" });
    const result = await startAssignment(opts);

    expect(result.subConversationId).toBe("sub-preresolved");
    expect(subLookupHit).toBe(false);
    // streamChat was invoked against the pre-resolved id.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.conversationId).toBe("sub-preresolved");
  });

  test("without reuseSubConversationId, legacy by-agentConfigId lookup still fires", async () => {
    const { executor, calls } = makeMockExecutor();
    let subLookupHit = false;
    getSubConversationsImpl = async (parentId) => {
      subLookupHit = true;
      expect(parentId).toBe("conv-parent");
      return [{ id: "sub-existing", agentConfigId: "cfg-test" }];
    };

    const opts = baseOpts({ executor });
    const result = await startAssignment(opts);

    expect(subLookupHit).toBe(true);
    // Reused existing sub by agentConfigId match.
    expect(result.subConversationId).toBe("sub-existing");
    expect(calls[0]?.conversationId).toBe("sub-existing");
  });
});

// ── 2. parentMessageId — threaded to createSubConversation on fresh
//    create (NOT to streamChat's options — runParentMessageId is a
//    separate parameter on startRun for auto-continue).

describe("startAssignment — parentMessageId plumbing", () => {
  test("parentMessageId: forwarded onto createSubConversation when creating fresh", async () => {
    const { executor } = makeMockExecutor();
    // Force the fresh-create branch (no existing sub, no reuse id).
    getSubConversationsImpl = async () => [];
    createSubConversationImpl = async () => ({ id: "sub-new" });

    const opts = baseOpts({ executor, parentMessageId: "msg-anchor-xyz" });
    await startAssignment(opts);

    expect(createSubConversationCalls).toHaveLength(1);
    expect(createSubConversationCalls[0]?.parentMessageId).toBe("msg-anchor-xyz");
  });

  test("parentMessageId: absent → no parentMessageId key on createSubConversation opts", async () => {
    const { executor } = makeMockExecutor();
    getSubConversationsImpl = async () => [];
    createSubConversationImpl = async () => ({ id: "sub-new-2" });

    const opts = baseOpts({ executor });
    await startAssignment(opts);

    expect(createSubConversationCalls).toHaveLength(1);
    expect(createSubConversationCalls[0]).not.toHaveProperty("parentMessageId");
  });
});

// ── 3. overrides — cascade into streamChat options ─────────────────

describe("startAssignment — overrides plumbing", () => {
  test("model/provider/systemPromptAppend/permissionMode/modeId all cascade", async () => {
    const { executor, calls } = makeMockExecutor();
    const overrides: TeamMemberOverrides = {
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      systemPromptAppend: "Be concise.",
      permissionMode: "yolo",
      modeId: "mode-fast",
    };

    const opts = baseOpts({ executor, overrides });
    await startAssignment(opts);

    expect(calls).toHaveLength(1);
    const streamOpts = calls[0]!.options;
    expect(streamOpts.model).toBe("claude-3-5-sonnet");
    expect(streamOpts.provider).toBe("anthropic");
    // system prompt gains the append.
    expect(streamOpts.system).toBe("you are alice\n\nBe concise.");
    expect(streamOpts.permissionMode).toBe("yolo");
    expect(streamOpts.modeId).toBe("mode-fast");
  });

  test("overrides.toolRestriction/allowedTools/deniedTools cascade when NO teamToolScope is active", async () => {
    const { executor, calls } = makeMockExecutor();
    const overrides: TeamMemberOverrides = {
      toolRestriction: "read-only",
      allowedTools: ["bash", "read"],
      deniedTools: ["write"],
    };

    const opts = baseOpts({ executor, overrides });
    await startAssignment(opts);

    const streamOpts = calls[0]!.options;
    expect(streamOpts.toolRestriction).toBe("read-only");
    expect(streamOpts.allowedTools).toEqual(["bash", "read"]);
    expect(streamOpts.deniedTools).toEqual(["write"]);
  });

  test("overrides.model === CURRENT_MODEL_SENTINEL → falls back to parentModel", async () => {
    const { executor, calls } = makeMockExecutor();
    const opts = baseOpts({
      executor,
      overrides: { model: CURRENT_MODEL_SENTINEL, provider: CURRENT_MODEL_SENTINEL },
      parentModel: "fallback-model",
      parentProvider: "fallback-provider",
    });
    await startAssignment(opts);
    const streamOpts = calls[0]!.options;
    expect(streamOpts.model).toBe("fallback-model");
    expect(streamOpts.provider).toBe("fallback-provider");
  });

  test("no overrides → streamChat options omit override-specific keys", async () => {
    const { executor, calls } = makeMockExecutor();
    const opts = baseOpts({ executor });
    await startAssignment(opts);
    const streamOpts = calls[0]!.options;
    expect(streamOpts).not.toHaveProperty("permissionMode");
    expect(streamOpts).not.toHaveProperty("modeId");
    expect(streamOpts).not.toHaveProperty("toolRestriction");
    expect(streamOpts).not.toHaveProperty("allowedTools");
    expect(streamOpts).not.toHaveProperty("deniedTools");
    // system === agentConfig.prompt verbatim (no append).
    expect(streamOpts.system).toBe("you are alice");
  });
});

// ── 4. teamToolScope — wins over overrides' tool lists when active ─

describe("startAssignment — teamToolScope plumbing", () => {
  test("teamToolScope with allowedTools → forwarded; overrides' tool lists suppressed", async () => {
    const { executor, calls } = makeMockExecutor();
    const teamToolScope: TeamToolScope = { allowedTools: ["read", "grep"] };
    const overrides: TeamMemberOverrides = {
      toolRestriction: "read-only",
      allowedTools: ["bash"],
      deniedTools: ["write"],
    };

    const opts = baseOpts({ executor, overrides, teamToolScope });
    await startAssignment(opts);

    const streamOpts = calls[0]!.options;
    // Scope wins.
    expect(streamOpts.allowedTools).toEqual(["read", "grep"]);
    // Overrides' tool keys NOT applied when scope is active.
    expect(streamOpts).not.toHaveProperty("toolRestriction");
    expect(streamOpts).not.toHaveProperty("deniedTools");
  });

  test("teamToolScope with deniedTools only → forwarded", async () => {
    const { executor, calls } = makeMockExecutor();
    const teamToolScope: TeamToolScope = { deniedTools: ["bash"] };

    const opts = baseOpts({ executor, teamToolScope });
    await startAssignment(opts);

    const streamOpts = calls[0]!.options;
    expect(streamOpts.deniedTools).toEqual(["bash"]);
    // allowedTools not set because teamToolScope had no allowedTools.
    expect(streamOpts).not.toHaveProperty("allowedTools");
  });

  test("teamToolScope with BOTH lists empty → treated as inactive; falls back to overrides' lists", async () => {
    const { executor, calls } = makeMockExecutor();
    // Both lists empty → teamScopeActive = false → overrides' lists win.
    const teamToolScope: TeamToolScope = { allowedTools: [], deniedTools: [] };
    const overrides: TeamMemberOverrides = { allowedTools: ["bash"] };

    const opts = baseOpts({ executor, overrides, teamToolScope });
    await startAssignment(opts);

    const streamOpts = calls[0]!.options;
    expect(streamOpts.allowedTools).toEqual(["bash"]);
  });

  test("teamToolScope absent → overrides' tool lists take effect", async () => {
    const { executor, calls } = makeMockExecutor();
    const overrides: TeamMemberOverrides = {
      allowedTools: ["read"],
      deniedTools: ["write"],
    };

    const opts = baseOpts({ executor, overrides });
    await startAssignment(opts);

    const streamOpts = calls[0]!.options;
    expect(streamOpts.allowedTools).toEqual(["read"]);
    expect(streamOpts.deniedTools).toEqual(["write"]);
  });
});

// ── 5. orchestrationDepth — passed verbatim as typeof === "number" ─

describe("startAssignment — orchestrationDepth plumbing", () => {
  test("orchestrationDepth: numeric value forwarded onto streamChat options", async () => {
    const { executor, calls } = makeMockExecutor();
    const opts = baseOpts({ executor, orchestrationDepth: 3 });
    await startAssignment(opts);
    expect(calls[0]!.options.orchestrationDepth).toBe(3);
  });

  test("orchestrationDepth: zero (falsy but valid) still forwarded", async () => {
    const { executor, calls } = makeMockExecutor();
    const opts = baseOpts({ executor, orchestrationDepth: 0 });
    await startAssignment(opts);
    // The `typeof === "number"` gate must admit 0.
    expect(calls[0]!.options.orchestrationDepth).toBe(0);
  });

  test("orchestrationDepth: absent → key omitted from streamChat options", async () => {
    const { executor, calls } = makeMockExecutor();
    const opts = baseOpts({ executor });
    await startAssignment(opts);
    expect(calls[0]!.options).not.toHaveProperty("orchestrationDepth");
  });
});

// ── run:cancel + streamPromise.catch fallback ──────────────────────
//
// startAssignment wires `run:complete` / `run:error` / `run:cancel`
// listeners and a `streamPromise.catch` fallback on the background
// executor.streamChat promise. These tests drive the listeners directly
// via the shared EventBus + a rejecting streamChat to prove:
//   - run:cancel → assignment transitions to "failed" with the
//     "Run was cancelled" preview;
//   - the cancel listener is idempotent with the Stop endpoint's
//     pre-cancel mutation to "assigned" (does NOT clobber);
//   - cleanup() unsubscribes on cancel (subsequent events are no-op);
//   - streamPromise rejection is caught and recorded as "failed".

describe("startAssignment lifecycle — run:cancel + streamPromise.catch", () => {
  test("marks assignment failed when run:cancel fires mid-run", async () => {
    const { executor } = makeMockExecutor();
    const task = makeTask();
    const assignment = makeAssignment();
    const snapshot = makeSnapshot(task, "conv-parent");
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;

    // Collect emitted task events so we can assert the cancel path
    // re-emits snapshot + assignment_update.
    const taskSnapshots: unknown[] = [];
    const assignmentUpdates: unknown[] = [];
    bus.on("task:snapshot", (d) => taskSnapshots.push(d));
    bus.on("task:assignment_update", (d) => assignmentUpdates.push(d));

    const opts = baseOpts({ executor, bus, task, assignment, snapshot });
    const { agentRunId } = await startAssignment(opts);

    // Reset counters established during the startAssignment happy-path
    // emits so we only assert on the cancel-driven deltas.
    const priorSnapshots = taskSnapshots.length;
    const priorAssignUpdates = assignmentUpdates.length;

    // Simulate the cancel signal (e.g. executor.cancelRun or abort).
    bus.emit("run:cancel", {
      run: {
        id: agentRunId,
        agentName: "alice",
        status: "cancelled",
        startedAt: Date.now(),
        logs: [],
      },
      conversationId: "conv-parent",
    });

    expect(assignment.status).toBe("failed");
    expect(assignment.resultPreview).toBe("Run was cancelled");
    expect(assignment.failedAt).toBeDefined();
    // Bus emits fired for the cancel transition.
    expect(taskSnapshots.length).toBe(priorSnapshots + 1);
    expect(assignmentUpdates.length).toBe(priorAssignUpdates + 1);
  });

  test("idempotent: run:cancel no-op when assignment.status !== 'running'", async () => {
    const { executor } = makeMockExecutor();
    const task = makeTask();
    const assignment = makeAssignment();
    const snapshot = makeSnapshot(task, "conv-parent");
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;

    const opts = baseOpts({ executor, bus, task, assignment, snapshot });
    const { agentRunId } = await startAssignment(opts);

    // Simulate the Stop endpoint's pre-cancel mutation: flip to
    // "assigned" BEFORE the run:cancel event lands.
    assignment.status = "assigned";
    const priorFailedAt = assignment.failedAt;

    bus.emit("run:cancel", {
      run: {
        id: agentRunId,
        agentName: "alice",
        status: "cancelled",
        startedAt: Date.now(),
        logs: [],
      },
      conversationId: "conv-parent",
    });

    // The listener saw status !== "running" and left the assignment alone.
    expect(assignment.status).toBe("assigned");
    expect(assignment.failedAt).toBe(priorFailedAt);
    expect(assignment.resultPreview).not.toBe("Run was cancelled");
  });

  test("unsubscribes on cancel — subsequent run:complete does not mutate", async () => {
    const { executor } = makeMockExecutor();
    const task = makeTask();
    const assignment = makeAssignment();
    const snapshot = makeSnapshot(task, "conv-parent");
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;

    const opts = baseOpts({ executor, bus, task, assignment, snapshot });
    const { agentRunId } = await startAssignment(opts);

    // Fire cancel first → cleanup() should unsubscribe both listeners.
    bus.emit("run:cancel", {
      run: {
        id: agentRunId,
        agentName: "alice",
        status: "cancelled",
        startedAt: Date.now(),
        logs: [],
      },
      conversationId: "conv-parent",
    });
    expect(assignment.status).toBe("failed");
    expect(assignment.resultPreview).toBe("Run was cancelled");

    // Snapshot post-cancel state then emit run:complete. The listener
    // for run:complete should already be unsubscribed, so the
    // completion-path mutation (which would overwrite resultPreview /
    // status → "completed") must NOT fire.
    const cancelledSnapshot = { ...assignment };
    bus.emit("run:complete", {
      run: {
        id: agentRunId,
        agentName: "alice",
        status: "success",
        startedAt: Date.now(),
        logs: [],
        result: { output: "LATE COMPLETION" },
      },
      conversationId: "conv-parent",
    });
    expect(assignment.status).toBe(cancelledSnapshot.status);
    expect(assignment.resultPreview).toBe(cancelledSnapshot.resultPreview);
    expect(assignment.completedAt).toBeUndefined();
  });

  test("streamPromise rejection fallback records failure", async () => {
    // Custom mock executor whose streamChat rejects.
    const calls: StreamChatCall[] = [];
    const streamChat = mock(
      async (
        conversationId: string,
        userMessage: string,
        options: Record<string, unknown>,
      ) => {
        calls.push({ conversationId, userMessage, options });
        throw new Error("stream boom");
      },
    );
    const executor = { streamChat } as unknown as AgentExecutor;
    const task = makeTask();
    const assignment = makeAssignment();
    const snapshot = makeSnapshot(task, "conv-parent");
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;

    const opts = baseOpts({ executor, bus, task, assignment, snapshot });
    await startAssignment(opts);
    // The .catch handler is attached inside startAssignment but not
    // awaited. Flush the microtask queue so the rejection lands before
    // we assert on state.
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(assignment.status).toBe("failed");
    expect(assignment.resultPreview).toContain("stream boom");
    expect(assignment.failedAt).toBeDefined();
  });
});

// ── 6. Combined: all 5 fields together across the boundary ─────────

describe("startAssignment — combined plumbing (all 5 new fields together)", () => {
  test("all 5 new fields round-trip across the startAssignment → streamChat boundary", async () => {
    const { executor, calls } = makeMockExecutor();
    // Force the reuse path so parentMessageId is NOT used for
    // createSubConversation — instead, we validate that the reuse id
    // is honored verbatim while overrides/teamToolScope/depth still
    // cascade onto streamChat.
    const overrides: TeamMemberOverrides = {
      model: "claude-3-5-sonnet",
      systemPromptAppend: "Be brief.",
      permissionMode: "ask",
    };
    const teamToolScope: TeamToolScope = { allowedTools: ["read"] };

    const opts = baseOpts({
      executor,
      reuseSubConversationId: "sub-reuse-combined",
      // parentMessageId is a no-op on the reuse path but must not break anything.
      parentMessageId: "msg-combined",
      overrides,
      teamToolScope,
      orchestrationDepth: 7,
    });
    const result = await startAssignment(opts);

    expect(result.subConversationId).toBe("sub-reuse-combined");
    expect(createSubConversationCalls).toHaveLength(0); // reuse path

    const streamOpts = calls[0]!.options;
    expect(streamOpts.model).toBe("claude-3-5-sonnet");
    expect(streamOpts.system).toBe("you are alice\n\nBe brief.");
    expect(streamOpts.permissionMode).toBe("ask");
    expect(streamOpts.allowedTools).toEqual(["read"]);
    expect(streamOpts.orchestrationDepth).toBe(7);
  });
});
