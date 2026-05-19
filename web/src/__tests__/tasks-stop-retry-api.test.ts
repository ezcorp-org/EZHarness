import { test, expect, describe, beforeEach, mock } from "bun:test";
import type {
  TaskSnapshot,
  TaskStatus,
  TrackedTask,
  TaskAssignment,
} from "../../../src/runtime/task-tracking-host";

// ── Shared state used by mocks ─────────────────────────────────────
//
// Template: tasks-assignment-api.test.ts. Same mock surface (auth/scope,
// conversations/agent-configs queries, context (bus + executor),
// task-tracking-host, pending-messages) plus a dynamic-import stub for
// `$server/runtime/start-assignment` that the /retry route uses for
// auto-spawn.

type Conversation = {
  id: string;
  userId: string | null;
  projectId: string | null;
  model?: string;
  provider?: string;
};

let mockConv: Conversation | null = null;
let mockAgentConfig: {
  id: string;
  name: string;
  prompt: string;
  model?: string;
  provider?: string;
  references?: { members?: { agentConfigId: string }[] } | null;
} | null = null;
let mockScopeResponse: Response | null = null;
let mockUser = {
  id: "user-1",
  email: "test@test.com",
  name: "Test",
  role: "member",
};

// Task store shared by task-tracking mocks. The stop/retry routes call
// `getTaskSnapshotForConversation` (read) + `writeTaskSnapshotForConversation`
// (write). The write mock just no-ops — the routes mutate in place and the
// assertions read back from `taskStore`.
let taskStore: TaskSnapshot = {
  conversationId: "conv-1",
  tasks: [],
  activeTaskId: undefined,
};

// ── Defense-in-depth DB stub (mirrors tasks-assignment-api.test.ts) ─

const dbStub = {
  select: () => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve([]) }),
    }),
  }),
  insert: () => ({
    values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
  }),
  update: () => ({
    set: () => ({ where: () => Promise.resolve() }),
  }),
  delete: () => ({ where: () => Promise.resolve() }),
};

mock.module("$server/db/connection", () => ({
  getDb: () => dbStub,
}));

// ── Mock db/query layer ─────────────────────────────────────────────

const mockGetConversation = mock(async (_id: string) => mockConv);

mock.module("$server/db/queries/conversations", () => ({
  getConversation: mockGetConversation,
  getSubConversations: mock(async (): Promise<any[]> => []),
  getMessages: mock(async (): Promise<any[]> => []),
  createSubConversation: mock(async (_projectId: string | null, opts: any) => ({
    id: "sub-conv-new",
    ...opts,
  })),
}));

const mockGetAgentConfig = mock(async (_id: string) => mockAgentConfig);
mock.module("$server/db/queries/agent-configs", () => ({
  getAgentConfig: mockGetAgentConfig,
}));

// ── Mock auth + scope middleware ────────────────────────────────────

mock.module("$server/auth/middleware", () => ({
  requireAuth: (locals: any) => locals?.user ?? mockUser,
}));

mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => mockScopeResponse,
}));

// ── Mock event bus + executor ──────────────────────────────────────

const mockBusEmit = mock((..._args: any[]) => {});
const mockBusOn = mock((_event: string, _cb: (...args: unknown[]) => unknown) => () => {});
const mockBus = { emit: mockBusEmit, on: mockBusOn };

const mockCancelRun = mock((_runId: string) => true);
const mockStreamChat = mock(async (..._args: any[]) => ({}));
const mockExecutor = { cancelRun: mockCancelRun, streamChat: mockStreamChat };

mock.module("$lib/server/context", () => ({
  getBus: () => mockBus,
  getExecutor: () => mockExecutor,
  getCommandRegistry: () => ({
    listCommands: async () => [],
    findCommand: async () => null,
    invalidate: () => {},
  }),
}));

// ── Mock task-tracking-host ────────────────────────────────────────

const mockGetTaskSnapshotForConversation = mock(async (_id: string) => taskStore);
const mockWriteTaskSnapshotForConversation = mock(async (..._args: any[]) => {});
const mockEnsureTaskTrackingWired = mock(async (..._args: any[]) => {});

mock.module("$server/runtime/task-tracking-host", () => ({
  getTaskSnapshotForConversation: mockGetTaskSnapshotForConversation,
  writeTaskSnapshotForConversation: mockWriteTaskSnapshotForConversation,
  ensureTaskTrackingWired: mockEnsureTaskTrackingWired,
  getTaskTrackingExtensionId: async () => "ext-tt",
}));

// ── Mock start-assignment (dynamic import from /retry auto-spawn) ──

const mockStartAssignment = mock(async (_opts: any) => ({
  subConversationId: "sc-1",
  agentRunId: "run-1",
}));

mock.module("$server/runtime/start-assignment", () => ({
  startAssignment: mockStartAssignment,
}));

// ── Mock pending-messages (imported transitively) ──────────────────

mock.module("$server/runtime/pending-messages", () => ({
  enqueue: mock((..._args: any[]) => {}),
  dequeue: mock(() => undefined as any),
  hasPending: mock(() => false),
}));

mock.module("$server/types", () => ({ CURRENT_MODEL_SENTINEL: "__current__" }));

// ── Import handlers AFTER mocks ────────────────────────────────────

const stopMod = await import(
  "../routes/api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/stop/+server"
);
const retryMod = await import(
  "../routes/api/conversations/[id]/tasks/[taskId]/retry/+server"
);

const POST_stop = stopMod.POST;
const POST_retry = retryMod.POST;

// ── Helpers ─────────────────────────────────────────────────────────

function makeTask(overrides: Partial<TrackedTask> = {}): TrackedTask {
  return {
    id: "task-1",
    title: "Test task",
    description: "A task for testing",
    status: "active",
    assignments: [],
    subtasks: [],
    priority: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeAssignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
  return {
    id: "assign-1",
    agentConfigId: "agent-cfg-1",
    agentName: "TestAgent",
    isTeam: false,
    status: "assigned",
    assignedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeStopEvent(
  conversationId: string,
  taskId: string,
  assignmentId: string,
) {
  return {
    request: new Request(
      `http://localhost/api/conversations/${conversationId}/tasks/${taskId}/assignments/${assignmentId}/stop`,
      { method: "POST" },
    ),
    params: { id: conversationId, taskId, assignmentId },
    locals: { user: mockUser },
  } as any;
}

function makeRetryEvent(
  conversationId: string,
  taskId: string,
  body?: Record<string, unknown>,
) {
  return {
    request: new Request(
      `http://localhost/api/conversations/${conversationId}/tasks/${taskId}/retry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : JSON.stringify({}),
      },
    ),
    params: { id: conversationId, taskId },
    locals: { user: mockUser },
  } as any;
}

function resetMocks() {
  mockConv = { id: "conv-1", userId: "user-1", projectId: "proj-1" };
  mockAgentConfig = {
    id: "agent-cfg-1",
    name: "TestAgent",
    prompt: "You are a test agent",
    references: null,
  };
  mockScopeResponse = null;
  mockUser = {
    id: "user-1",
    email: "test@test.com",
    name: "Test",
    role: "member",
  };

  taskStore = {
    conversationId: "conv-1",
    tasks: [makeTask()],
    activeTaskId: "task-1",
  };

  mockGetConversation.mockReset();
  mockGetConversation.mockImplementation(async (_id: string) => mockConv);
  mockGetAgentConfig.mockReset();
  mockGetAgentConfig.mockImplementation(async (_id: string) => mockAgentConfig);
  mockGetTaskSnapshotForConversation.mockReset();
  mockGetTaskSnapshotForConversation.mockImplementation(async () => taskStore);
  mockWriteTaskSnapshotForConversation.mockClear();
  mockEnsureTaskTrackingWired.mockClear();
  mockBusEmit.mockClear();
  mockBusOn.mockClear();
  mockCancelRun.mockReset();
  mockCancelRun.mockImplementation(() => true);
  mockStreamChat.mockClear();
  mockStartAssignment.mockReset();
  mockStartAssignment.mockImplementation(async () => ({
    subConversationId: "sc-1",
    agentRunId: "run-1",
  }));
}

// ──────────────────────────────────────────────────────────────────────
// Tests: POST /api/conversations/[id]/tasks/[taskId]/assignments/
//          [assignmentId]/stop
// ──────────────────────────────────────────────────────────────────────

describe("POST /api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/stop", () => {
  beforeEach(resetMocks);

  test("returns 409 when assignment.status !== 'running'", async () => {
    // Default factory creates an "assigned" assignment.
    const assignment = makeAssignment({ id: "assign-1", status: "assigned" });
    taskStore.tasks[0].assignments = [assignment];

    const res = await POST_stop(makeStopEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("expected \"running\"");
    // Must not have attempted to cancel.
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  test("returns 404 when conversation not found", async () => {
    mockGetConversation.mockImplementation(async () => null);

    const res = await POST_stop(makeStopEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  test("returns 404 when task not found", async () => {
    const res = await POST_stop(
      makeStopEvent("conv-1", "nonexistent-task", "assign-1"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Task not found");
  });

  test("returns 404 when assignment not found (task + subtask-level fallback)", async () => {
    // Task exists but carries no matching assignment at either level.
    taskStore.tasks[0].assignments = [];
    taskStore.tasks[0].subtasks = [
      {
        id: "sub-1",
        title: "Subtask",
        completed: false,
        position: 0,
        assignments: [],
      },
    ];

    const res = await POST_stop(
      makeStopEvent("conv-1", "task-1", "nonexistent-assignment"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Assignment not found");
  });

  test("happy path: calls executor.cancelRun, resets state, preserves subConversationId, emits snapshot + assignment_update", async () => {
    const assignment = makeAssignment({
      id: "assign-1",
      status: "running",
      agentRunId: "run-abc",
      subConversationId: "sub-conv-preserved",
      startedAt: new Date().toISOString(),
    });
    taskStore.tasks[0].assignments = [assignment];
    // Keep task active so the "any running" gate is the only thing flipping it.
    taskStore.tasks[0].status = "active";
    taskStore.activeTaskId = "task-1";

    const res = await POST_stop(makeStopEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Response shape per the route source.
    expect(body.stopped).toBe(true);
    expect(body.cancelled).toBe(true);
    expect(body.assignment).toBeDefined();
    expect(body.assignment.status).toBe("assigned");
    expect(body.assignment.subConversationId).toBe("sub-conv-preserved");
    expect(body.assignment.agentRunId).toBeUndefined();
    expect(body.assignment.startedAt).toBeUndefined();

    // executor.cancelRun called with the prior agentRunId.
    expect(mockCancelRun).toHaveBeenCalledTimes(1);
    expect(mockCancelRun).toHaveBeenCalledWith("run-abc");

    // Snapshot persisted.
    expect(mockWriteTaskSnapshotForConversation).toHaveBeenCalledTimes(1);

    // Bus emitted both events.
    const busEvents = mockBusEmit.mock.calls.map((c: any[]) => c[0]);
    expect(busEvents).toContain("task:snapshot");
    expect(busEvents).toContain("task:assignment_update");
    const assignmentCall = mockBusEmit.mock.calls.find(
      (c: any[]) => c[0] === "task:assignment_update",
    );
    expect(assignmentCall?.[1]).toMatchObject({
      conversationId: "conv-1",
      taskId: "task-1",
      assignment: expect.objectContaining({ status: "assigned" }),
    });
  });

  test("task falls back to 'pending' when no other assignment is running", async () => {
    const assignment = makeAssignment({
      id: "assign-1",
      status: "running",
      agentRunId: "run-only",
    });
    taskStore.tasks[0].assignments = [assignment];
    // Cast through the union so TS doesn't narrow the property to the
    // literal "active" — POST_stop will later mutate it back to "pending".
    taskStore.tasks[0].status = "active" as TaskStatus;
    taskStore.activeTaskId = "task-1";

    const res = await POST_stop(makeStopEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(200);

    // Task flipped to pending, activeTaskId cleared.
    expect(taskStore.tasks[0].status).toBe("pending");
    expect(taskStore.activeTaskId).toBeUndefined();

    // Snapshot write received the updated state.
    expect(mockWriteTaskSnapshotForConversation).toHaveBeenCalledTimes(1);
    const [, writtenPayload] = mockWriteTaskSnapshotForConversation.mock.calls[0];
    expect(writtenPayload.tasks[0].status).toBe("pending");
    expect(writtenPayload.activeTaskId).toBeUndefined();
  });

  test("does NOT flip task to 'pending' when a sibling assignment is still running", async () => {
    const stopping = makeAssignment({
      id: "assign-1",
      status: "running",
      agentRunId: "run-1",
    });
    const sibling = makeAssignment({
      id: "assign-2",
      status: "running",
      agentRunId: "run-2",
    });
    taskStore.tasks[0].assignments = [stopping, sibling];
    taskStore.tasks[0].status = "active";
    taskStore.activeTaskId = "task-1";

    const res = await POST_stop(makeStopEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(200);

    // Sibling still running — task stays active.
    expect(taskStore.tasks[0].status).toBe("active");
    expect(taskStore.activeTaskId).toBe("task-1");
  });

  test("cancelRun returning false doesn't block state reset", async () => {
    mockCancelRun.mockImplementation(() => false);
    const assignment = makeAssignment({
      id: "assign-1",
      status: "running",
      agentRunId: "run-gone",
      subConversationId: "sub-conv-preserved",
    });
    taskStore.tasks[0].assignments = [assignment];

    const res = await POST_stop(makeStopEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // cancelled reflects executor's false, but state still reset.
    expect(body.cancelled).toBe(false);
    expect(body.stopped).toBe(true);
    expect(body.assignment.status).toBe("assigned");
    expect(body.assignment.subConversationId).toBe("sub-conv-preserved");
    expect(mockWriteTaskSnapshotForConversation).toHaveBeenCalledTimes(1);
  });

  test("sec-H3b: rejects (404) when user doesn't own the conversation", async () => {
    mockConv = {
      id: "conv-1",
      userId: "someone-else",
      projectId: "proj-1",
    };
    mockGetConversation.mockImplementation(async () => mockConv);

    const assignment = makeAssignment({
      id: "assign-1",
      status: "running",
      agentRunId: "run-abc",
    });
    taskStore.tasks[0].assignments = [assignment];

    const res = await POST_stop(makeStopEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
    // Ownership check fails BEFORE any side effects.
    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(mockWriteTaskSnapshotForConversation).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Tests: POST /api/conversations/[id]/tasks/[taskId]/retry
// ──────────────────────────────────────────────────────────────────────

describe("POST /api/conversations/[id]/tasks/[taskId]/retry", () => {
  beforeEach(resetMocks);

  test("returns 409 when task.status !== 'failed'", async () => {
    taskStore.tasks[0].status = "pending";

    const res = await POST_retry(makeRetryEvent("conv-1", "task-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("expected \"failed\"");
    expect(mockStartAssignment).not.toHaveBeenCalled();
  });

  test("returns 404 when task not found", async () => {
    const res = await POST_retry(makeRetryEvent("conv-1", "nonexistent-task"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Task not found");
  });

  test("resets task + failed assignments (top-level and subtask)", async () => {
    const now = new Date().toISOString();
    const topFailed = makeAssignment({
      id: "a-top",
      status: "failed",
      failedAt: now,
      completedAt: now,
      resultPreview: "boom",
    });
    const subFailed = makeAssignment({
      id: "a-sub",
      status: "failed",
      failedAt: now,
      completedAt: now,
      resultPreview: "boom too",
    });
    taskStore.tasks[0] = makeTask({
      status: "failed",
      failedAt: now,
      failureReason: "agent bailed",
      completedAt: now,
      completionSummary: "should be gone",
      assignments: [topFailed],
      subtasks: [
        {
          id: "sub-1",
          title: "Subtask",
          completed: false,
          position: 0,
          assignments: [subFailed],
        },
      ],
    } as any);

    const res = await POST_retry(makeRetryEvent("conv-1", "task-1"));
    expect(res.status).toBe(200);

    // Task state cleared.
    const task = taskStore.tasks[0];
    expect(task.status).toBe("pending");
    expect(task.failedAt).toBeUndefined();
    expect(task.failureReason).toBeUndefined();
    expect(task.completedAt).toBeUndefined();

    // Both assignments reset.
    expect(task.assignments[0].status).toBe("assigned");
    expect(task.assignments[0].failedAt).toBeUndefined();
    expect(task.assignments[0].completedAt).toBeUndefined();
    expect(task.assignments[0].resultPreview).toBeUndefined();

    expect(task.subtasks[0].assignments![0].status).toBe("assigned");
    expect(task.subtasks[0].assignments![0].failedAt).toBeUndefined();
    expect(task.subtasks[0].assignments![0].completedAt).toBeUndefined();
    expect(task.subtasks[0].assignments![0].resultPreview).toBeUndefined();
  });

  test("auto-spawns when exactly 1 assignment was reset", async () => {
    const failed = makeAssignment({
      id: "a-only",
      status: "failed",
      failedAt: new Date().toISOString(),
    });
    taskStore.tasks[0] = makeTask({
      status: "failed",
      assignments: [failed],
    } as any);

    const res = await POST_retry(makeRetryEvent("conv-1", "task-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockStartAssignment).toHaveBeenCalledTimes(1);
    const opts = mockStartAssignment.mock.calls[0][0] as any;
    expect(opts.conversationId).toBe("conv-1");
    expect(opts.taskId).toBe("task-1");
    // The reset assignment is the one handed to startAssignment.
    expect(opts.assignment.id).toBe("a-only");
    expect(opts.assignment.status).toBe("assigned");
    expect(opts.agentConfig.id).toBe("agent-cfg-1");

    // Response carries the spawn details.
    expect(body.spawned).toBeDefined();
    expect(body.spawned.assignmentId).toBe("a-only");
    expect(body.spawned.runId).toBe("run-1");
    expect(body.spawned.subConversationId).toBe("sc-1");
    expect(body.resetAssignmentIds).toEqual(["a-only"]);
  });

  test("does NOT auto-spawn when multiple assignments reset", async () => {
    const f1 = makeAssignment({ id: "a1", status: "failed" });
    const f2 = makeAssignment({
      id: "a2",
      agentConfigId: "agent-cfg-2",
      status: "failed",
    });
    taskStore.tasks[0] = makeTask({
      status: "failed",
      assignments: [f1, f2],
    } as any);

    const res = await POST_retry(makeRetryEvent("conv-1", "task-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockStartAssignment).not.toHaveBeenCalled();
    expect(body.spawned).toBeNull();
    expect(body.resetAssignmentIds).toEqual(["a1", "a2"]);
  });

  test("does NOT auto-spawn when zero assignments were failed", async () => {
    // Task is in 'failed' but its only assignment is 'assigned' (edge case).
    const alreadyAssigned = makeAssignment({ id: "a-clean", status: "assigned" });
    taskStore.tasks[0] = makeTask({
      status: "failed",
      assignments: [alreadyAssigned],
    } as any);

    const res = await POST_retry(makeRetryEvent("conv-1", "task-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockStartAssignment).not.toHaveBeenCalled();
    expect(body.resetAssignmentIds).toEqual([]);
    expect(body.spawned).toBeNull();
  });

  test("resetAssignments emits task:assignment_update for each", async () => {
    const f1 = makeAssignment({ id: "a1", status: "failed" });
    const f2 = makeAssignment({
      id: "a2",
      agentConfigId: "agent-cfg-2",
      status: "failed",
    });
    const f3 = makeAssignment({
      id: "a3",
      agentConfigId: "agent-cfg-3",
      status: "failed",
    });
    taskStore.tasks[0] = makeTask({
      status: "failed",
      assignments: [f1, f2, f3],
    } as any);

    await POST_retry(makeRetryEvent("conv-1", "task-1"));

    const assignmentUpdates = mockBusEmit.mock.calls.filter(
      (c: any[]) => c[0] === "task:assignment_update",
    );
    expect(assignmentUpdates).toHaveLength(3);
    const ids = assignmentUpdates.map((c: any[]) => c[1].assignment.id).sort();
    expect(ids).toEqual(["a1", "a2", "a3"]);
    // Snapshot fired at least once too.
    const snapshotCalls = mockBusEmit.mock.calls.filter(
      (c: any[]) => c[0] === "task:snapshot",
    );
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("sec-H3b: rejects (404) when user doesn't own the conversation", async () => {
    mockConv = {
      id: "conv-1",
      userId: "someone-else",
      projectId: "proj-1",
    };
    mockGetConversation.mockImplementation(async () => mockConv);

    taskStore.tasks[0] = makeTask({
      status: "failed",
      assignments: [makeAssignment({ id: "a1", status: "failed" })],
    } as any);

    const res = await POST_retry(makeRetryEvent("conv-1", "task-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
    // Ownership check fails BEFORE any side effects.
    expect(mockStartAssignment).not.toHaveBeenCalled();
    expect(mockWriteTaskSnapshotForConversation).not.toHaveBeenCalled();
    // Task was not mutated.
    expect(taskStore.tasks[0].status).toBe("failed");
  });
});
