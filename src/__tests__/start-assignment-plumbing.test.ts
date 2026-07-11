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

// Wave 0: owner resolution for the fresh-create branch. Per-test
// replaceable so the userId-inheritance assertions can vary the owner.
let resolveOwnerImpl: (conversationId: string) => Promise<string | null> = async () => "owner-user";

mock.module("../db/queries/conversations", () => ({
  getSubConversations: async (parentId: string) => getSubConversationsImpl(parentId),
  createSubConversation: async (projectId: string, opts: Record<string, unknown>) => {
    createSubConversationCalls.push({ projectId, ...opts });
    return createSubConversationImpl(projectId, opts as any);
  },
  resolveConversationOwnerUserId: async (conversationId: string) => resolveOwnerImpl(conversationId),
}));

// Master kill-switch (Advanced Settings → global:agentAutonomyEnabled).
// Default impl returns undefined ⇒ `!== false` ⇒ feature ENABLED, so the
// existing assertions (objective pinned, autonomous works) hold unchanged.
let getSettingImpl: (key: string) => Promise<unknown> = async () => undefined;
mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => getSettingImpl(key),
}));

// Dynamic import AFTER mocks are installed.
const {
  startAssignment,
  extractFullText,
  detectDoneSignal,
  stripSignals,
  capFullResult,
  ASSIGNMENT_RESULT_FULL_CAP,
} = await import("../runtime/start-assignment");
const { EventBus } = await import("../runtime/events");
const { enqueue, dequeue, hasPending } = await import("../runtime/pending-messages");
const { CURRENT_MODEL_SENTINEL } = await import("../types");
const { buildSchemaInstruction } = await import("../runtime/structured-output");

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

type ChildRegistration = { parentRunId: string; childRunId: string };

function makeMockExecutor(): {
  executor: AgentExecutor;
  calls: StreamChatCall[];
  childRegistrations: ChildRegistration[];
} {
  const calls: StreamChatCall[] = [];
  const childRegistrations: ChildRegistration[] = [];
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
  // Returns registerChildRunResult (default true = parent live). The
  // refusal path (false = parent already terminal) is exercised by the
  // dedicated dead-parent tests, which flip the switch per-test.
  const registerChildRun = mock((parentRunId: string, childRunId: string) => {
    childRegistrations.push({ parentRunId, childRunId });
    return registerChildRunResult;
  });
  return {
    executor: { streamChat, registerChildRun } as unknown as AgentExecutor,
    calls,
    childRegistrations,
  };
}

// Per-test switch for the mock executor's registerChildRun return value.
let registerChildRunResult = true;

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

// Goal pinning: resolveSystem() now appends this block (built from
// makeTask()'s title + description) to whatever the agent/override base
// system prompt is, on EVERY startRun() cycle.
const OBJECTIVE_BLOCK =
  "## Pinned Objective\nBuild a thing\n\ndetails\n\n" +
  "Stay focused on this objective for the duration of this assignment.";
const withObjective = (base: string) => `${base}\n\n${OBJECTIVE_BLOCK}`;

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
  getSettingImpl = async () => undefined;
  resolveOwnerImpl = async () => "owner-user";
  registerChildRunResult = true;
});

// ── 0. Sub-agent prompt — must tell the LLM not to call task_complete ─

describe("startAssignment — sub-agent task prompt guardrails", () => {
  test("injected message instructs the sub-agent NOT to call task_complete/task_fail/task_plan", async () => {
    const { executor, calls } = makeMockExecutor();
    getSubConversationsImpl = async () => [{ id: "sub-existing", agentConfigId: "cfg-test" }];

    const opts = baseOpts({ executor });
    await startAssignment(opts);

    expect(calls).toHaveLength(1);
    const msg = calls[0]!.userMessage;
    // Without this guardrail, sub-agents routinely call task_complete —
    // which only writes to their own (empty) sub-conv storage and leaves
    // the parent task stuck.
    expect(msg).toMatch(/Do NOT call task_complete/);
    expect(msg).toMatch(/task_fail/);
    expect(msg).toMatch(/task_plan/);
  });
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

  // Wave 0: fresh sub-conversations are stamped with the parent chain's
  // owner so conversation-scoped authorization (SSE filter, /api/runs
  // ownership) holds without a parent walk.
  test("userId: resolved owner is forwarded onto createSubConversation when creating fresh", async () => {
    const { executor } = makeMockExecutor();
    getSubConversationsImpl = async () => [];
    createSubConversationImpl = async () => ({ id: "sub-owned" });
    resolveOwnerImpl = async (conversationId: string) => {
      expect(conversationId).toBe("conv-parent");
      return "owner-user";
    };

    const opts = baseOpts({ executor });
    await startAssignment(opts);

    expect(createSubConversationCalls).toHaveLength(1);
    expect(createSubConversationCalls[0]?.userId).toBe("owner-user");
  });

  test("userId: ownerless parent chain → no userId key on createSubConversation opts", async () => {
    const { executor } = makeMockExecutor();
    getSubConversationsImpl = async () => [];
    createSubConversationImpl = async () => ({ id: "sub-ownerless" });
    resolveOwnerImpl = async () => null;

    const opts = baseOpts({ executor });
    await startAssignment(opts);

    expect(createSubConversationCalls).toHaveLength(1);
    expect(createSubConversationCalls[0]).not.toHaveProperty("userId");
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
    // system prompt gains the append AND the pinned objective.
    expect(streamOpts.system).toBe(withObjective("you are alice\n\nBe concise."));
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
    // system === agentConfig.prompt + pinned objective (no override append).
    expect(streamOpts.system).toBe(withObjective("you are alice"));
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

  test("run:error (string) → assignment failed with sliced preview", async () => {
    const { executor } = makeMockExecutor();
    const task = makeTask();
    const assignment = makeAssignment();
    const snapshot = makeSnapshot(task, "conv-parent");
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const opts = baseOpts({ executor, bus, task, assignment, snapshot });
    const { agentRunId } = await startAssignment(opts);

    // Non-matching id is ignored (early-return guard).
    bus.emit("run:error", {
      run: { id: "some-other-run", agentName: "alice", status: "error", startedAt: Date.now(), logs: [] },
      error: "ignored",
      conversationId: "conv-parent",
      runId: "some-other-run",
    } as AgentEvents["run:error"]);
    expect(assignment.status).toBe("running");

    const longErr = "x".repeat(500);
    bus.emit("run:error", {
      run: { id: agentRunId, agentName: "alice", status: "error", startedAt: Date.now(), logs: [] },
      error: longErr,
      conversationId: "conv-parent",
      runId: agentRunId,
    } as AgentEvents["run:error"]);

    expect(assignment.status).toBe("failed");
    expect(assignment.failedAt).toBeDefined();
    expect(assignment.resultPreview).toBe(longErr.slice(0, 200));
  });

  test("run:error (non-string) → String() fallback in preview", async () => {
    const { executor } = makeMockExecutor();
    const task = makeTask();
    const assignment = makeAssignment();
    const snapshot = makeSnapshot(task, "conv-parent");
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const opts = baseOpts({ executor, bus, task, assignment, snapshot });
    const { agentRunId } = await startAssignment(opts);

    bus.emit("run:error", {
      run: { id: agentRunId, agentName: "alice", status: "error", startedAt: Date.now(), logs: [] },
      error: { code: 500 },
      conversationId: "conv-parent",
    } as unknown as AgentEvents["run:error"]);

    expect(assignment.status).toBe("failed");
    expect(assignment.resultPreview).toBe(String({ code: 500 }).slice(0, 200));
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
        result: { success: true, output: "LATE COMPLETION" },
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

// ── 5b. parentRunId — child-run registration for cascade cancel ────
//
// When `parentRunId` is set, startAssignment must register EVERY run it
// starts (the initial task run AND each auto-continue cycle's new run) on
// the executor as a child of the parent orchestrator run, so a cancel of
// the parent cascades down. Registration must happen inside startRun (per
// cycle), not once outside — auto-continue mints fresh run ids.

describe("startAssignment — parentRunId child registration", () => {
  test("registers the initial run under the parent before streaming", async () => {
    const { executor, calls, childRegistrations } = makeMockExecutor();
    const opts = baseOpts({
      executor,
      reuseSubConversationId: "sub-reg",
      parentRunId: "parent-run-1",
    });
    const { agentRunId } = await startAssignment(opts);

    expect(childRegistrations).toEqual([
      { parentRunId: "parent-run-1", childRunId: agentRunId },
    ]);
    // The registered child id IS the run id streamChat was told to use.
    expect(calls[0]!.options.runId).toBe(agentRunId);
  });

  test("registers each auto-continue cycle's NEW run id under the same parent", async () => {
    const { executor, calls, childRegistrations } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const opts = baseOpts({
      executor,
      bus,
      reuseSubConversationId: "sub-reg-cycle",
      parentRunId: "parent-run-2",
    });
    const { agentRunId } = await startAssignment(opts);

    // Initial registration.
    expect(childRegistrations).toEqual([
      { parentRunId: "parent-run-2", childRunId: agentRunId },
    ]);

    // Queue a user message, then complete the run → auto-continue cycle
    // starts a NEW run id which must ALSO register under the parent.
    enqueue("sub-reg-cycle", {
      messageId: "m1",
      content: "keep going",
      createdAt: new Date().toISOString(),
    });
    bus.emit("run:complete", {
      run: { id: agentRunId, agentName: "alice", status: "success", startedAt: Date.now(), logs: [], result: { success: true, output: "partial" } },
      conversationId: "conv-parent",
    } as AgentEvents["run:complete"]);

    expect(calls).toHaveLength(2);
    const newRunId = calls[1]!.options.runId as string;
    expect(newRunId).not.toBe(agentRunId);
    expect(childRegistrations).toHaveLength(2);
    expect(childRegistrations[1]).toEqual({
      parentRunId: "parent-run-2",
      childRunId: newRunId,
    });
  });

  test("no parentRunId → registerChildRun never called (legacy manual-start path)", async () => {
    const { executor, childRegistrations } = makeMockExecutor();
    const opts = baseOpts({ executor, reuseSubConversationId: "sub-noreg" });
    await startAssignment(opts);
    expect(childRegistrations).toHaveLength(0);
  });

  // Validator-a1 MEDIUM fix: a Stop racing startAssignment's DB awaits can
  // terminate the parent before startRun registers — the child must NOT be
  // started (it would stream ownerless with nobody consuming the result).
  test("dead parent (registerChildRun → false): child NOT streamed, assignment failed with actionable update", async () => {
    const { executor, calls } = makeMockExecutor();
    registerChildRunResult = false;
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const updates: Array<{ resultFull?: string; assignment: { status: string; resultPreview?: string } }> = [];
    bus.on("task:assignment_update", (d) => updates.push(d as never));

    const opts = baseOpts({
      executor, bus, assignment,
      parentRunId: "run-dead-parent",
      reuseSubConversationId: "sub-dead-parent",
    });
    await startAssignment(opts);

    // No streaming started for the dead parent's child.
    expect(calls).toHaveLength(0);
    expect(assignment.status).toBe("failed");
    expect(assignment.resultPreview).toBe("Parent run ended before this agent could start");
    // Terminal update fires (releases the parent's invoke_agent gate) and
    // carries the full explanation.
    const terminal = updates.at(-1)!;
    expect(terminal.assignment.status).toBe("failed");
    expect(terminal.resultFull).toContain("child was not started");
  });
});

// ── 5c. onCycleRunIdChange — quota re-key across a cycle boundary ──
//
// CRITICAL (Phase A2 fix): a multi-cycle child mints a NEW run id per cycle.
// Without re-keying, the spawn quota keeps the stale cycle-1 id — so the slot
// is freed when cycle 1 completes (concurrent under-count) and the live run is
// un-cancellable (cancel-run's ownership gate rejects it), which is exactly
// the scenario the invoke_agent timeout reap hits. startAssignment calls
// onCycleRunIdChange at each cycle boundary so the handler re-keys its
// SpawnQuota reservation onto the live run. These wire a REAL SpawnQuota to
// prove the slot follows the live cycle with no double-free.

describe("startAssignment — onCycleRunIdChange re-keys the spawn quota", () => {
  test("cycle transition follows the live run in the quota; old released once, new owned, no double-free", async () => {
    const { createSpawnQuota } = await import("../extensions/spawn-quota");
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    // The quota subscribes run:complete at construction — BEFORE
    // startAssignment's per-run listener — so its release(old) fires FIRST on
    // a cycle boundary, exactly the order that defeats a non-order-independent
    // swap. Proving the slot still follows the live run proves order-independence.
    const quota = createSpawnQuota(bus);
    const ext = "ext-quota";

    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-quota",
      autonomousContinuation: { maxCycles: 1 },
      onCycleRunIdChange: (oldId: string, newId: string) =>
        quota.swapReservation(ext, oldId, newId),
    });
    const { agentRunId } = await startAssignment(opts);
    // Mirror the handler's post-dispatch reserve of the cycle-1 run.
    quota.reserve(ext, agentRunId);
    expect(quota._concurrentCount(ext)).toBe(1);
    expect(quota.isOwner(ext, agentRunId)).toBe(true);

    // Cycle 1: initial run completes with no sentinel → autonomous continuation
    // mints a new run. quota.release(agentRunId) fires first, THEN the
    // transition's onCycleRunIdChange swaps → the slot follows the live run.
    emitComplete(bus, agentRunId, "still working");
    expect(calls).toHaveLength(2);
    const newRunId = calls[1]!.options.runId as string;
    expect(newRunId).not.toBe(agentRunId);

    // Slot followed the live run — still exactly 1, new owned, old not.
    expect(quota._concurrentCount(ext)).toBe(1);
    expect(quota.isOwner(ext, newRunId)).toBe(true);
    expect(quota.isOwner(ext, agentRunId)).toBe(false);

    // No double-free: a duplicate terminal for the OLD run can't free the new slot.
    bus.emit("run:complete", {
      run: { id: agentRunId, agentName: "alice", status: "success", startedAt: Date.now(), logs: [] },
      conversationId: "conv-parent",
    } as AgentEvents["run:complete"]);
    expect(quota._concurrentCount(ext)).toBe(1);

    // The live run completes → cap reached → terminal (no further cycle) →
    // the slot is released exactly once.
    emitComplete(bus, newRunId, "done enough");
    expect(calls).toHaveLength(2); // no further continuation
    expect(quota._concurrentCount(ext)).toBe(0);
    quota.dispose();
  });

  test("initial run does NOT invoke onCycleRunIdChange (only cycle continuations do)", async () => {
    const swaps: Array<[string, string]> = [];
    const { executor } = makeMockExecutor();
    const opts = baseOpts({
      executor,
      reuseSubConversationId: "sub-nocb",
      onCycleRunIdChange: (o: string, n: string) => swaps.push([o, n]),
    });
    await startAssignment(opts);
    // Only the initial run started — no cycle transition, so no re-key.
    expect(swaps).toHaveLength(0);
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
    expect(streamOpts.system).toBe(withObjective("you are alice\n\nBe brief."));
    expect(streamOpts.permissionMode).toBe("ask");
    expect(streamOpts.allowedTools).toEqual(["read"]);
    expect(streamOpts.orchestrationDepth).toBe(7);
  });
});

// ── 7. Pure helpers: extractFullText / detectDoneSignal / stripSignals ─

describe("autonomous helpers — extractFullText", () => {
  test("string passthrough", () => {
    expect(extractFullText("hello")).toBe("hello");
  });
  test("{ fullText } object", () => {
    expect(extractFullText({ fullText: "deep" })).toBe("deep");
  });
  test("{ fullText } non-string → empty", () => {
    expect(extractFullText({ fullText: 42 })).toBe("");
  });
  test("null / unknown shape → empty", () => {
    expect(extractFullText(null)).toBe("");
    expect(extractFullText({ foo: 1 })).toBe("");
    expect(extractFullText(undefined)).toBe("");
  });
});

describe("autonomous helpers — detectDoneSignal", () => {
  test("TASK_DONE → done", () => {
    expect(detectDoneSignal("all set <<TASK_DONE>>")).toEqual({ kind: "done" });
  });
  test("TASK_BLOCKED with reason", () => {
    expect(detectDoneSignal("x <<TASK_BLOCKED: missing key>> y")).toEqual({
      kind: "blocked",
      reason: "missing key",
    });
  });
  test("TASK_BLOCKED without reason → empty reason", () => {
    expect(detectDoneSignal("<<TASK_BLOCKED>>")).toEqual({
      kind: "blocked",
      reason: "",
    });
  });
  test("no sentinel → null", () => {
    expect(detectDoneSignal("just working")).toBeNull();
  });
  test("done wins when both present", () => {
    expect(
      detectDoneSignal("<<TASK_BLOCKED: x>> then <<TASK_DONE>>"),
    ).toEqual({ kind: "done" });
  });
});

describe("autonomous helpers — stripSignals", () => {
  test("removes DONE and trims", () => {
    expect(stripSignals("All good <<TASK_DONE>>")).toBe("All good");
  });
  test("removes BLOCKED and trims", () => {
    expect(stripSignals("<<TASK_BLOCKED: no>> stuck")).toBe("stuck");
  });
  test("removes every occurrence", () => {
    expect(stripSignals("<<TASK_DONE>><<TASK_DONE>>")).toBe("");
  });
});

// ── 8. Goal pinning re-anchored on the user-driven auto-continue cycle ─

describe("startAssignment — goal pinning across cycles", () => {
  test("objective re-pinned in system on the pending-message auto-continue cycle", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const opts = baseOpts({ executor, bus, reuseSubConversationId: "sub-pin" });
    const { agentRunId } = await startAssignment(opts);

    // Initial cycle already carries the pinned objective.
    expect(calls[0]!.options.system).toBe(withObjective("you are alice"));

    // Queue a user message, then complete the run → auto-continue.
    enqueue("sub-pin", {
      messageId: "m1",
      content: "keep going please",
      createdAt: new Date().toISOString(),
    });
    bus.emit("run:complete", {
      run: { id: agentRunId, agentName: "alice", status: "success", startedAt: Date.now(), logs: [], result: { success: true, output: "partial" } },
      conversationId: "conv-parent",
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]!.userMessage).toBe("keep going please");
    // Objective is re-pinned on the re-prompt cycle, not just the first.
    expect(calls[1]!.options.system).toBe(withObjective("you are alice"));
  });
});

// ── 8b. Full result to the orchestrator (Wave 1) ───────────────────
//
// The `task:assignment_update` event now carries a top-level
// `resultFull` (the sub-agent's complete final text, capped) alongside
// the 200-char `resultPreview`. The panel keeps the preview; the
// orchestration extension returns `resultFull` to the orchestrator LLM.

describe("capFullResult", () => {
  test("returns undefined for empty input (no-output run omits the field)", () => {
    expect(capFullResult("")).toBeUndefined();
  });

  test("passes through text at or under the cap unchanged", () => {
    const text = "x".repeat(ASSIGNMENT_RESULT_FULL_CAP);
    expect(capFullResult(text)).toBe(text);
  });

  test("truncates over-cap text with a visible marker naming the dropped count", () => {
    const text = "y".repeat(ASSIGNMENT_RESULT_FULL_CAP + 500);
    const out = capFullResult(text)!;
    expect(out.startsWith("y".repeat(ASSIGNMENT_RESULT_FULL_CAP))).toBe(true);
    expect(out).toContain("truncated 500 more characters");
    expect(out).toContain("open the sub-conversation");
  });
});

describe("startAssignment — full result on the assignment_update event", () => {
  test("completion emits resultFull with the FULL output; preview stays 200-char", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const updates: Array<{ resultFull?: string; assignment: { resultPreview?: string } }> = [];
    bus.on("task:assignment_update", (d) => updates.push(d as never));

    const opts = baseOpts({ executor, bus, assignment, reuseSubConversationId: "sub-full" });
    const { agentRunId } = await startAssignment(opts);

    const longOutput = "Z".repeat(1000);
    emitComplete(bus, agentRunId, longOutput);

    const terminal = updates.at(-1)!;
    expect(terminal.resultFull).toBe(longOutput);
    expect(terminal.assignment.resultPreview).toBe("Z".repeat(200) + "...");
    expect(assignment.resultPreview).toBe("Z".repeat(200) + "...");
  });

  test("error path emits the full error (not just the 200-char preview) as resultFull", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const updates: Array<{ resultFull?: string }> = [];
    bus.on("task:assignment_update", (d) => updates.push(d as never));

    const opts = baseOpts({ executor, bus, assignment, reuseSubConversationId: "sub-err" });
    const { agentRunId } = await startAssignment(opts);

    const longErr = "e".repeat(500);
    bus.emit("run:error", {
      run: { id: agentRunId, agentName: "alice", status: "error", startedAt: Date.now(), logs: [] },
      error: longErr,
      conversationId: "conv-parent",
      runId: agentRunId,
    } as AgentEvents["run:error"]);

    expect(assignment.resultPreview).toBe(longErr.slice(0, 200));
    expect(updates.at(-1)!.resultFull).toBe(longErr);
  });

  test("no-output completion emits no resultFull field", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const updates: Array<{ resultFull?: string }> = [];
    bus.on("task:assignment_update", (d) => updates.push(d as never));

    const opts = baseOpts({ executor, bus, assignment, reuseSubConversationId: "sub-empty" });
    const { agentRunId } = await startAssignment(opts);

    // output is a non-previewable object → no preview, no resultFull.
    emitComplete(bus, agentRunId, { some: "object" });

    expect(updates.at(-1)!.resultFull).toBeUndefined();
  });
});

// ── 9. Autonomous self-continuation ────────────────────────────────

function emitComplete(
  bus: EventBusType<AgentEvents>,
  runId: string,
  output: unknown,
) {
  bus.emit("run:complete", {
    run: {
      id: runId, agentName: "alice", status: "success",
      startedAt: Date.now(), logs: [],
      result: { success: true, output },
    },
    conversationId: "conv-parent",
  } as AgentEvents["run:complete"]);
}

describe("startAssignment — autonomous continuation", () => {
  test("OFF by default: run:complete with no sentinel → terminal completed, no recursion", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const opts = baseOpts({ executor, bus, assignment, reuseSubConversationId: "sub-a" });
    const { agentRunId } = await startAssignment(opts);

    emitComplete(bus, agentRunId, "did the thing");

    expect(calls).toHaveLength(1); // no recursion
    expect(assignment.status).toBe("completed");
    expect(assignment.resultPreview).toBe("did the thing");
    expect(assignment.autonomousCycle).toBeUndefined();
  });

  test("ON, no sentinel, cycle < cap → re-prompts itself with the continuation prompt", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-b",
      autonomousContinuation: { maxCycles: 3 },
    });
    const { agentRunId } = await startAssignment(opts);

    emitComplete(bus, agentRunId, "still working on it");

    expect(calls).toHaveLength(2);
    expect(calls[1]!.userMessage).toMatch(/Continue working toward the Pinned Objective/);
    expect(calls[1]!.userMessage).toMatch(/<<TASK_DONE>>/);
    // Stays running; cycle metadata surfaced for the UI.
    expect(assignment.status).toBe("running");
    expect(assignment.autonomousCycle).toBe(1);
    expect(assignment.autonomousMaxCycles).toBe(3);
    // Objective re-pinned on the autonomous cycle too.
    expect(calls[1]!.options.system).toBe(withObjective("you are alice"));
  });

  test("ON, <<TASK_DONE>> → terminal completed, sentinel stripped, no recursion", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-c",
      autonomousContinuation: {},
    });
    const { agentRunId } = await startAssignment(opts);

    emitComplete(bus, agentRunId, "shipped it <<TASK_DONE>>");

    expect(calls).toHaveLength(1);
    expect(assignment.status).toBe("completed");
    expect(assignment.resultPreview).toBe("shipped it");
  });

  test("ON, <<TASK_BLOCKED: reason>> → terminal with [blocked] note", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-d",
      autonomousContinuation: { maxCycles: 5 },
    });
    const { agentRunId } = await startAssignment(opts);

    emitComplete(bus, agentRunId, "cannot proceed <<TASK_BLOCKED: missing api key>>");

    expect(assignment.status).toBe("completed");
    expect(assignment.resultPreview).toBe("[blocked] missing api key cannot proceed");
  });

  test("ON, cap reached → terminal with [stopped after N cycles] note", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-e",
      autonomousContinuation: { maxCycles: 1 },
    });
    const { agentRunId } = await startAssignment(opts);

    // Cycle 1: 0 < 1 → recurses.
    emitComplete(bus, agentRunId, "round one");
    expect(calls).toHaveLength(2);
    expect(assignment.autonomousCycle).toBe(1);

    // Cycle 2: autoCycle(1) < maxCycles(1) is false → terminal note.
    emitComplete(bus, assignment.agentRunId!, "round two");
    expect(calls).toHaveLength(2); // no further recursion
    expect(assignment.status).toBe("completed");
    expect(assignment.resultPreview).toBe("[stopped after 1 autonomous cycle] round two");
  });

  test("pending user message wins over autonomous continuation", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-f",
      autonomousContinuation: { maxCycles: 9 },
    });
    const { agentRunId } = await startAssignment(opts);

    enqueue("sub-f", {
      messageId: "u1", content: "actually do X instead",
      createdAt: new Date().toISOString(),
    });
    emitComplete(bus, agentRunId, "no sentinel here");

    expect(calls).toHaveLength(2);
    expect(calls[1]!.userMessage).toBe("actually do X instead");
    // Autonomous branch NOT taken — no cycle metadata.
    expect(assignment.autonomousCycle).toBeUndefined();
    expect(assignment.status).toBe("running");
  });

  test("interruptible: run:cancel halts the loop (subsequent run:complete is a no-op)", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-g",
      autonomousContinuation: { maxCycles: 9 },
    });
    const { agentRunId } = await startAssignment(opts);

    // Stop endpoint flips status before cancelling; run:cancel then fires.
    assignment.status = "assigned";
    bus.emit("run:cancel", {
      run: { id: agentRunId, agentName: "alice", status: "cancelled", startedAt: Date.now(), logs: [] },
      conversationId: "conv-parent",
    });
    // Listeners cleaned up → a late run:complete must not re-loop.
    emitComplete(bus, agentRunId, "late output");

    expect(calls).toHaveLength(1);
    expect(assignment.autonomousCycle).toBeUndefined();
    expect(assignment.status).toBe("assigned"); // idempotent guard held
  });
});

// ── 10. Advanced Settings master kill-switch ───────────────────────
//
// global:agentAutonomyEnabled === false reverts to pre-feature
// behavior across ALL spawn paths: no pinned objective in the system
// prompt, and autonomous self-continuation impossible even when a
// caller opted in. Gated once inside startAssignment() via getSetting.

describe("startAssignment — global:agentAutonomyEnabled kill-switch", () => {
  test("OFF: objective NOT pinned on initial cycle (system === base)", async () => {
    getSettingImpl = async () => false;
    const { executor, calls } = makeMockExecutor();
    const opts = baseOpts({ executor, reuseSubConversationId: "sub-ks1" });
    await startAssignment(opts);
    expect(calls[0]!.options.system).toBe("you are alice");
  });

  test("OFF: objective NOT pinned on the user-driven auto-continue cycle", async () => {
    getSettingImpl = async () => false;
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const opts = baseOpts({ executor, bus, reuseSubConversationId: "sub-ks2" });
    const { agentRunId } = await startAssignment(opts);

    enqueue("sub-ks2", { messageId: "m", content: "go on", createdAt: new Date().toISOString() });
    bus.emit("run:complete", {
      run: { id: agentRunId, agentName: "alice", status: "success", startedAt: Date.now(), logs: [], result: { success: true, output: "x" } },
      conversationId: "conv-parent",
    } as AgentEvents["run:complete"]);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.options.system).toBe("you are alice");
  });

  test("OFF: autonomous opt-in is suppressed → legacy terminal completion", async () => {
    getSettingImpl = async () => false;
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-ks3",
      autonomousContinuation: { maxCycles: 3 },
    });
    const { agentRunId } = await startAssignment(opts);

    emitComplete(bus, agentRunId, "no sentinel, would have looped if enabled");

    expect(calls).toHaveLength(1); // no autonomous recursion
    expect(assignment.status).toBe("completed");
    expect(assignment.autonomousCycle).toBeUndefined();
  });

  test("explicit true: behaves exactly as enabled (objective pinned)", async () => {
    getSettingImpl = async () => true;
    const { executor, calls } = makeMockExecutor();
    const opts = baseOpts({ executor, reuseSubConversationId: "sub-ks4" });
    await startAssignment(opts);
    expect(calls[0]!.options.system).toBe(withObjective("you are alice"));
  });
});

// ── 11. Structured output (Phase B1) ───────────────────────────────
//
// When `outputSchema` is set, startAssignment appends an output-format
// instruction to the FIRST message, validates the child's final output
// host-side, re-prompts (bounded) on failure, and emits the terminal
// update with `structuredResult` (valid) or `structuredResultError`
// (retries exhausted). No outputSchema → byte-identical prompt + no new
// behavior.

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
} as Record<string, unknown>;

type StructuredUpdate = {
  resultFull?: string;
  structuredResult?: unknown;
  structuredResultError?: string;
  assignment: { status: string };
};

describe("startAssignment — structured output", () => {
  test("no outputSchema → first message omits the schema instruction (byte-identical prompt)", async () => {
    const { executor: exA, calls: callsA } = makeMockExecutor();
    await startAssignment(baseOpts({ executor: exA, reuseSubConversationId: "sub-so-none" }));
    const msgNoSchema = callsA[0]!.userMessage;
    expect(msgNoSchema).not.toContain("Required Output Format");

    // Same setup WITH a schema appends EXACTLY buildSchemaInstruction(schema)
    // and nothing else — proving the no-schema prompt is unchanged.
    const { executor: exB, calls: callsB } = makeMockExecutor();
    await startAssignment(
      baseOpts({ executor: exB, reuseSubConversationId: "sub-so-with", outputSchema: SCHEMA }),
    );
    expect(callsB[0]!.userMessage).toBe(msgNoSchema + buildSchemaInstruction(SCHEMA));
  });

  test("valid first try: structuredResult on the terminal update; prompt carries the schema", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const updates: StructuredUpdate[] = [];
    bus.on("task:assignment_update", (d) => updates.push(d as never));

    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-so-1",
      outputSchema: SCHEMA,
    });
    const { agentRunId } = await startAssignment(opts);

    // First message carries the serialized schema instruction.
    expect(calls[0]!.userMessage).toContain("## Required Output Format");
    expect(calls[0]!.userMessage).toContain('"answer"');

    emitComplete(bus, agentRunId, 'All set.\n```json\n{"answer":"42"}\n```');

    expect(calls).toHaveLength(1); // no re-prompt
    const terminal = updates.at(-1)!;
    expect(terminal.structuredResult).toEqual({ answer: "42" });
    expect(terminal.structuredResultError).toBeUndefined();
    expect(assignment.status).toBe("completed");
  });

  test("JSON extraction variants (raw / fenced / trailing prose) all validate first try", async () => {
    for (const [label, output, expected] of [
      ["raw", '{"answer":"a"}', { answer: "a" }],
      ["fenced", '```json\n{"answer":"b"}\n```', { answer: "b" }],
      ["trailing prose", 'Done! {"answer":"c"} — cheers', { answer: "c" }],
    ] as const) {
      const { executor } = makeMockExecutor();
      const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
      const assignment = makeAssignment();
      const updates: StructuredUpdate[] = [];
      bus.on("task:assignment_update", (d) => updates.push(d as never));
      const opts = baseOpts({
        executor, bus, assignment,
        reuseSubConversationId: `sub-so-var-${label.replace(/\s/g, "")}`,
        outputSchema: SCHEMA,
      });
      const { agentRunId } = await startAssignment(opts);
      emitComplete(bus, agentRunId, output);
      expect(updates.at(-1)!.structuredResult).toEqual(expected);
    }
  });

  test("invalid then valid: exactly one re-prompt; new run registered under parent + quota re-key fired", async () => {
    const { executor, calls, childRegistrations } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const swaps: Array<[string, string]> = [];
    const updates: StructuredUpdate[] = [];
    bus.on("task:assignment_update", (d) => updates.push(d as never));

    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-so-2",
      parentRunId: "parent-so",
      outputSchema: SCHEMA,
      onCycleRunIdChange: (o: string, n: string) => swaps.push([o, n]),
    });
    const { agentRunId } = await startAssignment(opts);

    // Cycle 1: schema-invalid JSON (missing required "answer") → re-prompt.
    emitComplete(bus, agentRunId, '{"wrong":"shape"}');
    expect(calls).toHaveLength(2);
    const newRunId = calls[1]!.options.runId as string;
    expect(newRunId).not.toBe(agentRunId);
    // Corrective message quotes the violations + restates the schema.
    expect(calls[1]!.userMessage).toContain("did not satisfy the required output schema");
    expect(calls[1]!.userMessage).toContain("Validation errors:");
    expect(calls[1]!.userMessage).toContain('"answer"');
    // Cycle mechanics: new run registered under parent + quota re-key.
    expect(childRegistrations).toContainEqual({ parentRunId: "parent-so", childRunId: newRunId });
    expect(swaps).toContainEqual([agentRunId, newRunId]);
    // Mid-loop: still running, no terminal structured payload yet.
    expect(assignment.status).toBe("running");

    // Cycle 2: now valid → terminal with structuredResult, no further run.
    emitComplete(bus, newRunId, '{"answer":"ok"}');
    expect(calls).toHaveLength(2);
    const terminal = updates.at(-1)!;
    expect(terminal.structuredResult).toEqual({ answer: "ok" });
    expect(terminal.structuredResultError).toBeUndefined();
    expect(assignment.status).toBe("completed");
  });

  test("retries exhausted: structuredResultError on the terminal update; status still completed", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const updates: StructuredUpdate[] = [];
    bus.on("task:assignment_update", (d) => updates.push(d as never));

    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-so-3",
      outputSchema: SCHEMA,
    });
    const { agentRunId } = await startAssignment(opts);

    // Two re-prompts (MAX_SCHEMA_RETRIES = 2), then the third failure is terminal.
    emitComplete(bus, agentRunId, '{"nope":1}');
    expect(calls).toHaveLength(2);
    emitComplete(bus, assignment.agentRunId!, '{"still":"wrong"}');
    expect(calls).toHaveLength(3);
    emitComplete(bus, assignment.agentRunId!, '{"final":"miss"}');
    expect(calls).toHaveLength(3); // budget exhausted — no 4th run

    expect(assignment.status).toBe("completed");
    const terminal = updates.at(-1)!;
    expect(terminal.structuredResult).toBeUndefined();
    expect(terminal.structuredResultError).toContain("answer");
    // The raw final text still rides resultFull for salvage.
    expect(terminal.resultFull).toContain("final");
  });

  test("no JSON at all in the output → treated as a schema failure and re-prompted", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-so-nojson",
      outputSchema: SCHEMA,
    });
    const { agentRunId } = await startAssignment(opts);

    emitComplete(bus, agentRunId, "I finished but forgot to emit JSON.");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.userMessage).toContain("no JSON value found");
  });

  test("autonomous + outputSchema: autonomous loops first; schema validates the FINAL cycle output", async () => {
    const { executor, calls } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const updates: StructuredUpdate[] = [];
    bus.on("task:assignment_update", (d) => updates.push(d as never));

    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-so-auto",
      autonomousContinuation: { maxCycles: 3 },
      outputSchema: SCHEMA,
    });
    const { agentRunId } = await startAssignment(opts);

    // Cycle 1: no sentinel → autonomous continues FIRST; schema not yet checked.
    emitComplete(bus, agentRunId, "still working, no json yet");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.userMessage).toMatch(/Continue working toward the Pinned Objective/);

    // Cycle 2: DONE sentinel + schema-valid JSON → autonomous stops, schema validates.
    emitComplete(bus, assignment.agentRunId!, '<<TASK_DONE>>\n```json\n{"answer":"final"}\n```');
    expect(calls).toHaveLength(2); // no further run
    const terminal = updates.at(-1)!;
    expect(terminal.structuredResult).toEqual({ answer: "final" });
    expect(assignment.status).toBe("completed");
  });
});

// ── 12. agent:complete emission on every terminal (Phase B2) ───────
//
// startAssignment historically emitted only agent:spawn — the invoke_agent
// path never fired agent:complete, so the SSE chip / observability agent_call
// rows / extension lifecycle subscriptions never saw the terminal. Every
// terminal branch (complete / error / cancel / refused-start) now emits
// agent:complete with the LIVE cycle run id as both runId and agentRunId,
// scoped to the parent conversation.

type AgentCompleteEvt = AgentEvents["agent:complete"];

describe("startAssignment — agent:complete emission", () => {
  test("run:complete → agent:complete(success=true) with the live run id + parent scope", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const events: AgentCompleteEvt[] = [];
    bus.on("agent:complete", (d) => events.push(d as AgentCompleteEvt));

    const opts = baseOpts({ executor, bus, assignment, reuseSubConversationId: "sub-ac1" });
    const { agentRunId } = await startAssignment(opts);

    emitComplete(bus, agentRunId, "the full output");

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.success).toBe(true);
    expect(e.runId).toBe(agentRunId);
    expect(e.agentRunId).toBe(agentRunId);
    expect(e.subConversationId).toBe("sub-ac1");
    expect(e.agentName).toBe("alice");
    expect(e.agentConfigId).toBe("cfg-test");
    expect(e.parentConversationId).toBe("conv-parent");
    expect(e.resultPreview).toBe("the full output");
  });

  test("run:error → agent:complete(success=false) with the error preview", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const events: AgentCompleteEvt[] = [];
    bus.on("agent:complete", (d) => events.push(d as AgentCompleteEvt));

    const opts = baseOpts({ executor, bus, assignment, reuseSubConversationId: "sub-ac2" });
    const { agentRunId } = await startAssignment(opts);

    bus.emit("run:error", {
      run: { id: agentRunId, agentName: "alice", status: "error", startedAt: Date.now(), logs: [] },
      error: "kaboom",
      conversationId: "conv-parent",
      runId: agentRunId,
    } as AgentEvents["run:error"]);

    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.resultPreview).toBe("kaboom");
    expect(events[0]!.runId).toBe(agentRunId);
  });

  test("run:cancel → agent:complete(success=false, 'Run was cancelled')", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const events: AgentCompleteEvt[] = [];
    bus.on("agent:complete", (d) => events.push(d as AgentCompleteEvt));

    const opts = baseOpts({ executor, bus, assignment, reuseSubConversationId: "sub-ac3" });
    const { agentRunId } = await startAssignment(opts);

    bus.emit("run:cancel", {
      run: { id: agentRunId, agentName: "alice", status: "cancelled", startedAt: Date.now(), logs: [] },
      conversationId: "conv-parent",
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.resultPreview).toBe("Run was cancelled");
  });

  test("run:cancel that races the Stop pre-mutation (status !== running) emits NO agent:complete", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const events: AgentCompleteEvt[] = [];
    bus.on("agent:complete", (d) => events.push(d as AgentCompleteEvt));

    const opts = baseOpts({ executor, bus, assignment, reuseSubConversationId: "sub-ac4" });
    const { agentRunId } = await startAssignment(opts);

    // Stop endpoint flipped it to "assigned" already → cancel listener no-ops.
    assignment.status = "assigned";
    bus.emit("run:cancel", {
      run: { id: agentRunId, agentName: "alice", status: "cancelled", startedAt: Date.now(), logs: [] },
      conversationId: "conv-parent",
    });
    expect(events).toHaveLength(0);
  });

  test("live cycle run: agent:complete carries the NEW autonomous-cycle run id, not cycle 1", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const events: AgentCompleteEvt[] = [];
    bus.on("agent:complete", (d) => events.push(d as AgentCompleteEvt));

    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-ac5",
      autonomousContinuation: { maxCycles: 1 },
    });
    const { agentRunId } = await startAssignment(opts);

    // Cycle 1: no sentinel → autonomous continuation mints a new run; NOT terminal.
    emitComplete(bus, agentRunId, "cycle one");
    expect(events).toHaveLength(0);
    const cycle2RunId = assignment.agentRunId!;
    expect(cycle2RunId).not.toBe(agentRunId);

    // Cycle 2: cap reached → terminal on the LIVE cycle run.
    emitComplete(bus, cycle2RunId, "cycle two done");
    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe(cycle2RunId);
    expect(events[0]!.agentRunId).toBe(cycle2RunId);
    expect(events[0]!.success).toBe(true);
  });

  test("refused start (dead parent) → agent:complete(success=false) closes the spawned chip", async () => {
    const { executor } = makeMockExecutor();
    registerChildRunResult = false;
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const events: AgentCompleteEvt[] = [];
    bus.on("agent:complete", (d) => events.push(d as AgentCompleteEvt));

    const opts = baseOpts({
      executor, bus, assignment,
      parentRunId: "run-dead",
      reuseSubConversationId: "sub-ac6",
    });
    const { agentRunId } = await startAssignment(opts);

    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.runId).toBe(agentRunId);
    expect(events[0]!.resultPreview).toBe("Parent run ended before this agent could start");
  });
});

// ── 13. Background completion notify — parent-queue enqueue (Phase B2) ─
//
// notifyParentOnTerminal is set by the orchestration extension's background
// spawn path. On EVERY terminal it enqueues a plain, capped completion-notify
// pending message onto the PARENT conversation id so an idle orchestrator can
// react on its next turn. Absent the flag, agent:complete still fires but no
// pending message is enqueued.

function drainConvParent(): string[] {
  const drained: string[] = [];
  let m = dequeue("conv-parent");
  while (m) {
    drained.push(m.content);
    m = dequeue("conv-parent");
  }
  return drained;
}

describe("startAssignment — background completion notify", () => {
  test("notifyParentOnTerminal + success → enqueues a plain notify for the PARENT conversation", async () => {
    expect(hasPending("conv-parent")).toBe(false);
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();

    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-nfy1",
      notifyParentOnTerminal: true,
    });
    const { agentRunId } = await startAssignment(opts);

    emitComplete(bus, agentRunId, "the answer is 42");

    expect(hasPending("conv-parent")).toBe(true);
    const [content, ...rest] = drainConvParent();
    expect(rest).toHaveLength(0); // exactly one notify
    expect(content).toContain('Background agent "alice" finished (success)');
    expect(content).toContain("the answer is 42");
    expect(content).toContain("collect_agent_result");
    // Queue drained — no cross-test contamination.
    expect(hasPending("conv-parent")).toBe(false);
  });

  test("notifyParentOnTerminal + failure → notify says (failure)", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();

    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-nfy2",
      notifyParentOnTerminal: true,
    });
    const { agentRunId } = await startAssignment(opts);

    bus.emit("run:error", {
      run: { id: agentRunId, agentName: "alice", status: "error", startedAt: Date.now(), logs: [] },
      error: "it broke",
      conversationId: "conv-parent",
      runId: agentRunId,
    } as AgentEvents["run:error"]);

    const [content, ...rest] = drainConvParent();
    expect(rest).toHaveLength(0);
    expect(content).toContain('Background agent "alice" finished (failure)');
    expect(content).toContain("it broke");
    expect(hasPending("conv-parent")).toBe(false);
  });

  test("notify preview is capped so an over-long result cannot bloat the pending message", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();

    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-nfy3",
      notifyParentOnTerminal: true,
    });
    const { agentRunId } = await startAssignment(opts);

    // resultPreview is itself already ≤200 chars, but assert the notify stays
    // bounded and terminates with the collect hint regardless.
    emitComplete(bus, agentRunId, "Q".repeat(5000));

    const [content] = drainConvParent();
    expect(content).toBeDefined();
    expect(content!.length).toBeLessThan(600);
    expect(content).toContain("collect_agent_result");
    expect(hasPending("conv-parent")).toBe(false);
  });

  test("an over-cap terminal preview (long autonomous blocked reason) is clipped in the notify", async () => {
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();

    const opts = baseOpts({
      executor, bus, assignment,
      reuseSubConversationId: "sub-nfy5",
      autonomousContinuation: { maxCycles: 3 },
      notifyParentOnTerminal: true,
    });
    const { agentRunId } = await startAssignment(opts);

    // A long <<TASK_BLOCKED: reason>> makes assignment.resultPreview exceed the
    // notify's 400-char preview cap (the reason is prepended un-truncated), so
    // the notify must clip it and mark the clip with an ellipsis.
    const longReason = "R".repeat(600);
    emitComplete(bus, agentRunId, `stuck here <<TASK_BLOCKED: ${longReason}>>`);

    // Blocked terminates as completed (success), with a long preview.
    expect(assignment.status).toBe("completed");
    expect(assignment.resultPreview!.length).toBeGreaterThan(400);

    const [content] = drainConvParent();
    expect(content).toBeDefined();
    expect(content).toContain('Background agent "alice" finished (success)');
    expect(content).toContain("…"); // the clip marker
    // Bounded: 400-char preview + framing, still well under any limit.
    expect(content!.length).toBeLessThan(600);
    expect(hasPending("conv-parent")).toBe(false);
  });

  test("WITHOUT notifyParentOnTerminal → agent:complete still fires but NO pending message is enqueued", async () => {
    expect(hasPending("conv-parent")).toBe(false);
    const { executor } = makeMockExecutor();
    const bus = new EventBus<AgentEvents>() as EventBusType<AgentEvents>;
    const assignment = makeAssignment();
    const events: AgentCompleteEvt[] = [];
    bus.on("agent:complete", (d) => events.push(d as AgentCompleteEvt));

    const opts = baseOpts({ executor, bus, assignment, reuseSubConversationId: "sub-nfy4" });
    const { agentRunId } = await startAssignment(opts);

    emitComplete(bus, agentRunId, "done, no notify");

    expect(events).toHaveLength(1); // agent:complete still emitted
    expect(hasPending("conv-parent")).toBe(false); // but no parent nudge
  });
});
