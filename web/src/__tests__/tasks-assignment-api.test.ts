import { test, expect, describe, beforeEach, mock } from "bun:test";
import type {
  TaskSnapshot,
  TrackedTask,
  TaskAssignment,
} from "../../../src/runtime/task-tracking-host";

// ── Shared state used by mocks ─────────────────────────────────────

type Conversation = {
  id: string;
  userId: string | null;
  projectId: string | null;
  model?: string;
  provider?: string;
};

let mockConv: Conversation | null = null;
let mockProject: { id: string; path: string } | null = null;
let mockAgentConfig: {
  id: string;
  name: string;
  prompt: string;
  model?: string;
  provider?: string;
  references?: { members?: { agentConfigId: string }[] } | null;
} | null = null;
let mockScopeResponse: Response | null = null;
const mockUser = {
  id: "user-1",
  email: "test@test.com",
  name: "Test",
  role: "member",
};

// Task store shared by task-tracking mocks
let taskStore: TaskSnapshot = {
  conversationId: "conv-1",
  tasks: [],
  activeTaskId: undefined,
};

// ── Mock db/query layer ─────────────────────────────────────────────
//
// Defense-in-depth: even though `$server/runtime/task-tracking-host` is
// fully mocked below (so `ensureTaskTrackingWired` never reaches the real
// `getDb()`), the audit surfaced 38 failures when the task-tracking-host
// mock was bypassed — `getDb()` throws "Database not initialized." in the
// test env. Stub the connection with a drizzle-query-chain that returns
// empty arrays so any code path that slips past the host mock still no-ops
// cleanly instead of exploding. Follows the same template used in
// `user-commands-queries.test.ts` + `mention-search-*-api.test.ts`.

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

const mockGetConversation = mock(async (_id: string) => mockConv);
const mockGetSubConversations = mock(async (_parentId: string): Promise<any[]> => []);
const mockGetMessages = mock(async (_convId: string): Promise<any[]> => []);
const mockGetMessagesWithToolCalls = mock(
  async (
    _convId: string,
  ): Promise<{ messages: any[]; subConversations: any[]; orphanedToolCalls: any[] }> => ({
    messages: [],
    subConversations: [],
    orphanedToolCalls: [],
  }),
);
const mockCreateSubConversation = mock(
  async (_projectId: string | null, opts: any) => ({
    id: "sub-conv-" + crypto.randomUUID().slice(0, 8),
    ...opts,
  }),
);

mock.module("$server/db/queries/conversations", () => ({
  getConversation: mockGetConversation,
  getSubConversations: mockGetSubConversations,
  getMessages: mockGetMessages,
  getMessagesWithToolCalls: mockGetMessagesWithToolCalls,
  createSubConversation: mockCreateSubConversation,
  // start-assignment.ts resolves the owning user before creating a sub-conv;
  // null replicates the legacy no-owner path (no userId written).
  resolveConversationOwnerUserId: mock(async () => null),
}));

const mockGetProject = mock(async (_id: string) => mockProject);
mock.module("$server/db/queries/projects", () => ({
  getProject: mockGetProject,
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

// ── Mock event bus ──────────────────────────────────────────────────

const mockBusEmit = mock((..._args: any[]) => {});
const mockBusOn = mock((_event: string, _cb: (...args: unknown[]) => unknown) => {
  // Return unsubscribe function
  return () => {};
});
const mockBus = { emit: mockBusEmit, on: mockBusOn };

const mockStreamChat = mock(async (..._args: any[]) => ({}));
// registerRunMode: startAssignment registers every cycle's run mode on the
// executor before streamChat (Wave-5 steer P4 guard) — the mock must accept it.
const mockExecutor = { streamChat: mockStreamChat, registerRunMode: () => {} };

mock.module("$lib/server/context", () => ({
  getBus: () => mockBus,
  getExecutor: () => mockExecutor,
  getCommandRegistry: () => ({
    listCommands: async () => [],
    findCommand: async () => null,
    invalidate: () => {},
  }),
}));

mock.module("$lib/server/command-resolver", () => ({
  buildCommandResolver: () => async () => null,
}));

// ── Mock task-tracking-host + task-dependencies (Phase 3 commit-5) ──
//
// The route no longer reaches into a built-in's in-memory Map. It goes
// through `getTaskSnapshotForConversation` (extension-storage read) +
// `writeTaskSnapshotForConversation` and `ensureTaskTrackingWired`.
// The blocked-prereq gate uses the extracted `task-dependencies`
// module directly.

const mockGetTaskSnapshotForConversation = mock(async (_id: string) => taskStore);
const mockWriteTaskSnapshotForConversation = mock(async (..._args: any[]) => {});
const mockEnsureTaskTrackingWired = mock(async (..._args: any[]) => {});

mock.module("$server/runtime/task-tracking-host", () => ({
  getTaskSnapshotForConversation: mockGetTaskSnapshotForConversation,
  writeTaskSnapshotForConversation: mockWriteTaskSnapshotForConversation,
  ensureTaskTrackingWired: mockEnsureTaskTrackingWired,
  getTaskTrackingExtensionId: async () => "ext-tt",
}));

// Overridable mocks for the dependency gate. Default to "not blocked" so
// existing tests pass unchanged; the 409-on-blocked test swaps the
// implementation via mockImplementation to simulate an unsatisfied prereq.
const mockIsBlocked = mock((_task: any, _store: any) => false);
const mockUnsatisfiedDeps = mock((_task: any, _store: any) => [] as Array<{ title: string }>);

mock.module("$server/runtime/task-dependencies", () => ({
  isBlocked: mockIsBlocked,
  unsatisfiedDeps: mockUnsatisfiedDeps,
  detectCycle: () => null,
}));

// Back-compat shims for the legacy assertion names. The Phase 3
// cutover route no longer calls these helpers directly — the route
// emits on the bus and writes through task-tracking-host — so the
// assertions below that reference them are kept as dead placeholders
// rather than deleted so the rest of the auth/ownership test cases
// stay intact. Tests that reference these will spy on a no-op.
const mockEmitSnapshot = mock((..._args: any[]) => {});
const mockEmitAssignmentUpdate = mock((..._args: any[]) => {});
const mockPersistToDb = mock((..._args: any[]) => {});
const mockGetTaskSnapshot = mock((_id: string) => taskStore);
const mockCompleteTaskFromAssignment = mock((..._args: any[]) => {});

// ── Mock pending-messages ──────────────────────────────────────────

const mockDequeue = mock((_subConvId: string) => undefined as any);
mock.module("$server/runtime/pending-messages", () => ({
  enqueue: mock((..._args: any[]) => {}),
  dequeue: mockDequeue,
  hasPending: mock(() => false),
}));

// ── Mock types re-export ────────────────────────────────────────────

mock.module("$server/types", () => ({ CURRENT_MODEL_SENTINEL: "__current__" }));

// ── Import handlers AFTER mocks ─────────────────────────────────────

const assignMod = await import(
  "../routes/api/conversations/[id]/tasks/[taskId]/assign/+server"
);
const startMod = await import(
  "../routes/api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/start/+server"
);
const taskMessagesMod = await import(
  "../routes/api/conversations/[id]/tasks/[taskId]/messages/+server"
);
const teamMessagesMod = await import(
  "../routes/api/conversations/[id]/team/[agentConfigId]/messages/+server"
);

const POST_assign = assignMod.POST;
const DELETE_assign = assignMod.DELETE;
const POST_start = startMod.POST;
const GET_taskMessages = taskMessagesMod.GET;
const GET_teamMessages = teamMessagesMod.GET;

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

function makeAssignEvent(
  conversationId: string,
  taskId: string,
  body: Record<string, unknown>,
) {
  return {
    request: new Request(
      `http://localhost/api/conversations/${conversationId}/tasks/${taskId}/assign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    params: { id: conversationId, taskId },
    locals: { user: mockUser },
  } as any;
}

function makeDeleteAssignEvent(
  conversationId: string,
  taskId: string,
  body: Record<string, unknown>,
) {
  return {
    request: new Request(
      `http://localhost/api/conversations/${conversationId}/tasks/${taskId}/assign`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    params: { id: conversationId, taskId },
    locals: { user: mockUser },
  } as any;
}

function makeStartEvent(
  conversationId: string,
  taskId: string,
  assignmentId: string,
) {
  return {
    request: new Request(
      `http://localhost/api/conversations/${conversationId}/tasks/${taskId}/assignments/${assignmentId}/start`,
      { method: "POST" },
    ),
    params: { id: conversationId, taskId, assignmentId },
    locals: { user: mockUser },
  } as any;
}

function makeStartEventWithBody(
  conversationId: string,
  taskId: string,
  assignmentId: string,
  body?: Record<string, unknown>,
) {
  return {
    request: new Request(
      `http://localhost/api/conversations/${conversationId}/tasks/${taskId}/assignments/${assignmentId}/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : JSON.stringify({}),
      },
    ),
    params: { id: conversationId, taskId, assignmentId },
    locals: { user: mockUser },
  } as any;
}

function makeGetMessagesEvent(conversationId: string, taskId: string) {
  return {
    request: new Request(
      `http://localhost/api/conversations/${conversationId}/tasks/${taskId}/messages`,
      { method: "GET" },
    ),
    params: { id: conversationId, taskId },
    locals: { user: mockUser },
  } as any;
}

function makeTeamMessagesEvent(conversationId: string, agentConfigId: string) {
  return {
    request: new Request(
      `http://localhost/api/conversations/${conversationId}/team/${agentConfigId}/messages`,
      { method: "GET" },
    ),
    params: { id: conversationId, agentConfigId },
    locals: { user: mockUser },
  } as any;
}

function resetMocks() {
  mockConv = { id: "conv-1", userId: "user-1", projectId: "proj-1" };
  mockProject = { id: "proj-1", path: "/tmp/fake-project" };
  mockAgentConfig = {
    id: "agent-cfg-1",
    name: "TestAgent",
    prompt: "You are a test agent",
    references: null,
  };
  mockScopeResponse = null;

  taskStore = {
    conversationId: "conv-1",
    tasks: [makeTask()],
    activeTaskId: "task-1",
  };

  // Reset implementations back to defaults (mockClear only clears call history)
  mockGetConversation.mockReset();
  mockGetConversation.mockImplementation(async (_id: string) => mockConv);
  mockGetProject.mockReset();
  mockGetProject.mockImplementation(async (_id: string) => mockProject);
  mockGetAgentConfig.mockReset();
  mockGetAgentConfig.mockImplementation(async (_id: string) => mockAgentConfig);
  mockGetSubConversations.mockReset();
  mockGetSubConversations.mockImplementation(async () => []);
  mockGetMessages.mockReset();
  mockGetMessages.mockImplementation(async () => []);
  mockGetMessagesWithToolCalls.mockReset();
  mockGetMessagesWithToolCalls.mockImplementation(async () => ({
    messages: [],
    subConversations: [],
    orphanedToolCalls: [],
  }));
  mockCreateSubConversation.mockReset();
  mockCreateSubConversation.mockImplementation(
    async (_projectId: string | null, opts: any) => ({
      id: "sub-conv-" + crypto.randomUUID().slice(0, 8),
      ...opts,
    }),
  );
  mockEmitSnapshot.mockClear();
  mockEmitAssignmentUpdate.mockClear();
  mockPersistToDb.mockClear();
  mockGetTaskSnapshot.mockReset();
  mockGetTaskSnapshot.mockImplementation((_id: string) => taskStore);
  mockCompleteTaskFromAssignment.mockClear();
  mockBusEmit.mockClear();
  mockBusOn.mockClear();
  mockStreamChat.mockClear();
  mockDequeue.mockReset();
  mockDequeue.mockImplementation(() => undefined as any);
  mockIsBlocked.mockReset();
  mockIsBlocked.mockImplementation(() => false);
  mockUnsatisfiedDeps.mockReset();
  mockUnsatisfiedDeps.mockImplementation(() => []);
}

// ── Tests: POST /assign ─────────────────────────────────────────────

describe("POST /api/conversations/[id]/tasks/[taskId]/assign", () => {
  beforeEach(resetMocks);

  test("creates assignment with correct fields", async () => {
    const res = await POST_assign(
      makeAssignEvent("conv-1", "task-1", { agentConfigId: "agent-cfg-1" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.assignment).toBeDefined();
    expect(body.assignment.id).toBeString();
    expect(body.assignment.agentName).toBe("TestAgent");
    expect(body.assignment.isTeam).toBe(false);
    expect(body.assignment.status).toBe("assigned");
    expect(body.assignment.agentConfigId).toBe("agent-cfg-1");
    expect(body.assignment.assignedAt).toBeString();
  });

  test("sets isTeam=true when config has references.members", async () => {
    mockAgentConfig = {
      id: "team-cfg-1",
      name: "TeamAgent",
      prompt: "Team prompt",
      references: { members: [{ agentConfigId: "member-1" }] },
    };

    const res = await POST_assign(
      makeAssignEvent("conv-1", "task-1", { agentConfigId: "team-cfg-1" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignment.isTeam).toBe(true);
  });

  test("assigns to subtask when subtaskId provided", async () => {
    taskStore.tasks[0].subtasks = [
      { id: "sub-1", title: "Subtask 1", completed: false, position: 0 },
    ];

    const res = await POST_assign(
      makeAssignEvent("conv-1", "task-1", {
        agentConfigId: "agent-cfg-1",
        subtaskId: "sub-1",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignment.status).toBe("assigned");

    // Assignment should be on the subtask, not the task
    expect(taskStore.tasks[0].assignments).toHaveLength(0);
    expect(taskStore.tasks[0].subtasks[0].assignments).toHaveLength(1);
    expect(taskStore.tasks[0].subtasks[0].assignments![0].id).toBe(
      body.assignment.id,
    );
  });

  test("returns 404 for missing task", async () => {
    const res = await POST_assign(
      makeAssignEvent("conv-1", "nonexistent-task", {
        agentConfigId: "agent-cfg-1",
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Task not found");
  });

  test("returns 404 for missing agent config", async () => {
    mockAgentConfig = null;

    const res = await POST_assign(
      makeAssignEvent("conv-1", "task-1", { agentConfigId: "nonexistent" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Agent config not found");
  });

  test("emits task:snapshot and task:assignment_update directly on the bus", async () => {
    const res = await POST_assign(
      makeAssignEvent("conv-1", "task-1", { agentConfigId: "agent-cfg-1" }),
    );
    expect(res.status).toBe(200);

    const calls = mockBusEmit.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain("task:snapshot");
    expect(calls).toContain("task:assignment_update");

    const assignmentCall = mockBusEmit.mock.calls.find(
      (c: any[]) => c[0] === "task:assignment_update",
    );
    expect(assignmentCall?.[1]).toMatchObject({
      conversationId: "conv-1",
      taskId: "task-1",
      assignment: expect.objectContaining({ status: "assigned", agentName: "TestAgent" }),
    });
  });

  test("returns snapshot in response", async () => {
    const res = await POST_assign(
      makeAssignEvent("conv-1", "task-1", { agentConfigId: "agent-cfg-1" }),
    );
    const body = await res.json();
    expect(body.snapshot).toBeDefined();
  });
});

// ── Tests: DELETE /assign ───────────────────────────────────────────

describe("DELETE /api/conversations/[id]/tasks/[taskId]/assign", () => {
  beforeEach(resetMocks);

  test("removes assignment in 'assigned' status", async () => {
    const assignment = makeAssignment({ id: "assign-to-remove" });
    taskStore.tasks[0].assignments = [assignment];

    const res = await DELETE_assign(
      makeDeleteAssignEvent("conv-1", "task-1", {
        assignmentId: "assign-to-remove",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(taskStore.tasks[0].assignments).toHaveLength(0);
  });

  test("returns 409 for assignment in 'running' status", async () => {
    const assignment = makeAssignment({
      id: "running-assign",
      status: "running",
    });
    taskStore.tasks[0].assignments = [assignment];

    const res = await DELETE_assign(
      makeDeleteAssignEvent("conv-1", "task-1", {
        assignmentId: "running-assign",
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("running");
  });

  test("returns 404 for missing assignment", async () => {
    taskStore.tasks[0].assignments = [];

    const res = await DELETE_assign(
      makeDeleteAssignEvent("conv-1", "task-1", {
        assignmentId: "nonexistent",
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Assignment not found");
  });

  test("removes subtask-level assignment", async () => {
    const assignment = makeAssignment({ id: "sub-assign" });
    taskStore.tasks[0].subtasks = [
      {
        id: "sub-1",
        title: "Subtask",
        completed: false,
        position: 0,
        assignments: [assignment],
      },
    ];

    const res = await DELETE_assign(
      makeDeleteAssignEvent("conv-1", "task-1", {
        assignmentId: "sub-assign",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(taskStore.tasks[0].subtasks[0].assignments).toHaveLength(0);
  });

  test("emits task:snapshot after removal", async () => {
    const assignment = makeAssignment({ id: "assign-emit" });
    taskStore.tasks[0].assignments = [assignment];

    await DELETE_assign(
      makeDeleteAssignEvent("conv-1", "task-1", {
        assignmentId: "assign-emit",
      }),
    );

    const snapshotCalls = mockBusEmit.mock.calls.filter(
      (c: any[]) => c[0] === "task:snapshot",
    );
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Tests: POST /start ──────────────────────────────────────────────

describe("POST /api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/start", () => {
  beforeEach(() => {
    resetMocks();
    // Pre-populate an assignment in "assigned" status
    const assignment = makeAssignment({ id: "assign-1" });
    taskStore.tasks[0].assignments = [assignment];
    // createSubConversation returns a stable id for assertions
    mockCreateSubConversation.mockImplementation(
      async (_projectId: string | null, opts: any) => ({
        id: "sub-conv-new",
        ...opts,
      }),
    );
  });

  test("updates assignment to 'running' with lifecycle fields", async () => {
    const res = await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.assignment.status).toBe("running");
    expect(body.assignment.startedAt).toBeString();
    expect(body.assignment.subConversationId).toBeString();
    expect(body.assignment.agentRunId).toBeString();
    expect(body.runId).toBe(body.assignment.agentRunId);
    expect(body.subConversationId).toBe(body.assignment.subConversationId);
  });

  test("calls executor.streamChat with correct params", async () => {
    await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));

    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    const [subConvId, prompt, opts] = mockStreamChat.mock.calls[0];
    expect(subConvId).toBe("sub-conv-new");
    expect(prompt).toContain("Test task");
    expect(prompt).toContain("## Your Task");
    expect(opts.agentConfigId).toBe("agent-cfg-1");
    // The system prompt is now the agent's base prompt with a "Pinned
    // Objective" block appended when the autonomy feature is on (default —
    // `global:agentAutonomyEnabled !== false`). See start-assignment.ts's
    // `resolveSystem()`: `${agentConfig.prompt}\n\n${objectiveBlock}`, where
    // `objectiveBlock` restates the task title + description so the goal is
    // re-anchored on every chat cycle. taskBody = "<title>\n\n<description>".
    expect(opts.system).toBe(
      "You are a test agent\n\n" +
        "## Pinned Objective\n" +
        "Test task\n\nA task for testing\n\n" +
        "Stay focused on this objective for the duration of this assignment.",
    );
  });

  test("passes full plan context including all tasks and assignments", async () => {
    // Set up multiple tasks to verify plan context
    const task2 = makeTask({ id: "task-2", title: "Second task", status: "pending", priority: 1, assignments: [] });
    const task3 = makeTask({
      id: "task-3", title: "Third task", status: "completed", priority: 2,
      assignments: [makeAssignment({ id: "a3", agentName: "OtherAgent", status: "completed" })],
    });
    taskStore.tasks = [
      makeTask({ assignments: [makeAssignment({ id: "assign-1" })] }),
      task2,
      task3,
    ];

    await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));

    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    const [, prompt] = mockStreamChat.mock.calls[0];
    // Should contain the primary task directive
    expect(prompt).toContain("## Your Task");
    expect(prompt).toContain("Test task");
    // Should contain full plan context section
    expect(prompt).toContain("## Full Plan Context");
    expect(prompt).toContain(">> THIS TASK");
    expect(prompt).toContain("Second task");
    expect(prompt).toContain("Third task");
    // Should show other agent assignments
    expect(prompt).toContain("@OtherAgent");
    expect(prompt).toContain("(done)");
  });

  test("includes task description in prompt when present", async () => {
    taskStore.tasks = [
      makeTask({
        description: "Detailed instructions for the task",
        assignments: [makeAssignment({ id: "assign-1" })],
      }),
    ];

    await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));

    const [, prompt] = mockStreamChat.mock.calls[0];
    expect(prompt).toContain("Detailed instructions for the task");
  });

  test("emits agent:spawn event", async () => {
    await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));

    expect(mockBusEmit).toHaveBeenCalledWith(
      "agent:spawn",
      expect.objectContaining({
        agentName: "TestAgent",
        agentConfigId: "agent-cfg-1",
        task: "Test task",
        parentConversationId: "conv-1",
      }),
    );
  });

  test("returns 409 if assignment not in 'assigned' status", async () => {
    taskStore.tasks[0].assignments[0].status = "running";

    const res = await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("running");
  });

  test("returns 404 for missing assignment", async () => {
    const res = await POST_start(
      makeStartEvent("conv-1", "task-1", "nonexistent"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Assignment not found");
  });

  test("returns 404 for missing task", async () => {
    const res = await POST_start(
      makeStartEvent("conv-1", "nonexistent-task", "assign-1"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Task not found");
  });

  test("emits task:snapshot and task:assignment_update on the bus", async () => {
    await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));

    const calls = mockBusEmit.mock.calls;
    expect(calls.some((c: any[]) => c[0] === "task:snapshot")).toBe(true);
    expect(
      calls.some(
        (c: any[]) =>
          c[0] === "task:assignment_update" &&
          c[1]?.assignment?.status === "running",
      ),
    ).toBe(true);
  });

  test("reuses existing sub-conversation for same agent", async () => {
    mockGetSubConversations.mockImplementation(async () => [
      {
        id: "existing-sub-conv",
        agentConfigId: "agent-cfg-1",
        title: "TestAgent",
      },
    ]);

    const res = await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subConversationId).toBe("existing-sub-conv");
    // Should NOT create a new sub-conversation
    expect(mockCreateSubConversation).not.toHaveBeenCalled();
  });

  // Dependency gate: the HTTP route mirrors the auto-start gate so a
  // blocked assignment can't be manually started either. Both entry points
  // (tool and HTTP) must agree or the UI + agent behavior diverge.
  describe("dependency gate", () => {
    test("returns 409 with waitingOn titles when task is blocked", async () => {
      // Force the mock to report the task as blocked with specific waitingOn.
      mockIsBlocked.mockImplementation(() => true);
      mockUnsatisfiedDeps.mockImplementation(() => [
        { title: "Build" } as any,
        { title: "Test" } as any,
      ]);

      const res = await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain("blocked");
      expect(body.waitingOn).toEqual(["Build", "Test"]);

      // Crucially: streamChat must NOT have fired.
      expect(mockStreamChat).not.toHaveBeenCalled();
    });

    test("unblocked task proceeds normally (regression guard)", async () => {
      mockIsBlocked.mockImplementation(() => false);
      const res = await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));
      expect(res.status).toBe(200);
      expect(mockStreamChat).toHaveBeenCalledTimes(1);
    });
  });
});

// ── Tests: GET /tasks/[taskId]/messages ─────────────────────────────

describe("GET /api/conversations/[id]/tasks/[taskId]/messages", () => {
  beforeEach(resetMocks);

  test("returns streams grouped by assignment", async () => {
    const assignment1 = makeAssignment({
      id: "a1",
      status: "running",
      subConversationId: "sub-conv-1",
    });
    const assignment2 = makeAssignment({
      id: "a2",
      agentName: "Agent2",
      status: "completed",
      subConversationId: "sub-conv-2",
    });
    taskStore.tasks[0].assignments = [assignment1, assignment2];

    mockGetMessagesWithToolCalls.mockImplementation(async (convId: string) => ({
      messages: convId === "sub-conv-1"
        ? [{ id: "msg-1", content: "Hello", toolCalls: [] }]
        : convId === "sub-conv-2"
          ? [{ id: "msg-2", content: "Done", toolCalls: [] }]
          : [],
      subConversations: [],
      orphanedToolCalls: [],
    }));

    const res = await GET_taskMessages(makeGetMessagesEvent("conv-1", "task-1"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.streams).toHaveLength(2);
    expect(body.streams[0].assignmentId).toBe("a1");
    expect(body.streams[0].messages).toHaveLength(1);
    expect(body.streams[0].messages[0].id).toBe("msg-1");
    expect(body.streams[1].assignmentId).toBe("a2");
    expect(body.streams[1].messages).toHaveLength(1);
  });

  test("skips assignments without subConversationId", async () => {
    const withConvo = makeAssignment({
      id: "a1",
      status: "running",
      subConversationId: "sub-conv-1",
    });
    const withoutConvo = makeAssignment({
      id: "a2",
      status: "assigned",
      // no subConversationId
    });
    taskStore.tasks[0].assignments = [withConvo, withoutConvo];

    mockGetMessagesWithToolCalls.mockImplementation(async () => ({
      messages: [{ id: "msg-1", content: "Hello", toolCalls: [] }],
      subConversations: [],
      orphanedToolCalls: [],
    }));

    const res = await GET_taskMessages(makeGetMessagesEvent("conv-1", "task-1"));
    const body = await res.json();

    expect(body.streams).toHaveLength(1);
    expect(body.streams[0].assignmentId).toBe("a1");
    // Hydrated messages should only be loaded once (for the assignment with a sub-conv).
    expect(mockGetMessagesWithToolCalls).toHaveBeenCalledTimes(1);
    expect(mockGetMessagesWithToolCalls).toHaveBeenCalledWith("sub-conv-1");
  });

  test("includes subtask-level assignment messages", async () => {
    taskStore.tasks[0].subtasks = [
      {
        id: "sub-1",
        title: "Subtask",
        completed: false,
        position: 0,
        assignments: [
          makeAssignment({
            id: "sub-assign-1",
            status: "running",
            subConversationId: "sub-conv-sub-1",
          }),
        ],
      },
    ];

    mockGetMessagesWithToolCalls.mockImplementation(async () => ({
      messages: [{ id: "msg-sub", content: "Subtask msg", toolCalls: [] }],
      subConversations: [],
      orphanedToolCalls: [],
    }));

    const res = await GET_taskMessages(makeGetMessagesEvent("conv-1", "task-1"));
    const body = await res.json();

    expect(body.streams).toHaveLength(1);
    expect(body.streams[0].assignmentId).toBe("sub-assign-1");
  });

  test("returns 404 for missing task", async () => {
    const res = await GET_taskMessages(
      makeGetMessagesEvent("conv-1", "nonexistent"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Task not found");
  });
});

// ── Tests: GET /team/[agentConfigId]/messages ───────────────────────

describe("GET /api/conversations/[id]/team/[agentConfigId]/messages", () => {
  beforeEach(() => {
    resetMocks();
    // Set up a team config with members
    mockAgentConfig = {
      id: "team-cfg-1",
      name: "TestTeam",
      prompt: "Team prompt",
      references: {
        members: [
          { agentConfigId: "member-1" },
          { agentConfigId: "member-2" },
        ],
      },
    };
  });

  test("returns team info and member streams", async () => {
    // Mock sub-conversations that exist for team members
    mockGetSubConversations.mockImplementation(async () => [
      { id: "sub-1", agentConfigId: "member-1", title: "Member1" },
      { id: "sub-2", agentConfigId: "member-2", title: "Member2" },
    ]);

    // Mock per-member agent config lookups
    const memberConfigs: Record<string, any> = {
      "team-cfg-1": mockAgentConfig,
      "member-1": { id: "member-1", name: "MemberOne", prompt: "" },
      "member-2": { id: "member-2", name: "MemberTwo", prompt: "" },
    };
    mockGetAgentConfig.mockImplementation(async (id: string) =>
      memberConfigs[id] ?? null,
    );

    // Handler uses getMessagesWithToolCalls (returns { messages, subConversations,
    // orphanedToolCalls }), then maps each message to include a toolCalls array.
    mockGetMessagesWithToolCalls.mockImplementation(async (convId: string) => {
      if (convId === "sub-1") {
        return {
          messages: [
            {
              id: "m1",
              role: "assistant",
              content: "Msg from M1",
              createdAt: new Date().toISOString(),
              toolCalls: [],
            },
          ],
          subConversations: [],
          orphanedToolCalls: [],
        };
      }
      if (convId === "sub-2") {
        return {
          messages: [
            {
              id: "m2",
              role: "assistant",
              content: "Msg from M2",
              createdAt: new Date().toISOString(),
              toolCalls: [],
            },
          ],
          subConversations: [],
          orphanedToolCalls: [],
        };
      }
      return { messages: [], subConversations: [], orphanedToolCalls: [] };
    });

    const res = await GET_teamMessages(
      makeTeamMessagesEvent("conv-1", "team-cfg-1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.team.name).toBe("TestTeam");
    // Handler resolves member display names via getAgentConfig and returns
    // { agentConfigId, agentName } objects rather than bare ids.
    expect(body.team.members).toEqual([
      { agentConfigId: "member-1", agentName: "MemberOne" },
      { agentConfigId: "member-2", agentName: "MemberTwo" },
    ]);
    expect(body.streams).toHaveLength(2);
    expect(body.streams[0].agentName).toBe("MemberOne");
    expect(body.streams[0].messages).toHaveLength(1);
    expect(body.streams[1].agentName).toBe("MemberTwo");
    expect(body.streams[1].messages).toHaveLength(1);
  });

  test("returns empty streams for members without sub-conversations", async () => {
    // No sub-conversations exist
    mockGetSubConversations.mockImplementation(async () => []);

    const memberConfigs: Record<string, any> = {
      "team-cfg-1": mockAgentConfig,
      "member-1": { id: "member-1", name: "MemberOne", prompt: "" },
      "member-2": { id: "member-2", name: "MemberTwo", prompt: "" },
    };
    mockGetAgentConfig.mockImplementation(async (id: string) =>
      memberConfigs[id] ?? null,
    );

    const res = await GET_teamMessages(
      makeTeamMessagesEvent("conv-1", "team-cfg-1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.streams).toHaveLength(2);
    expect(body.streams[0].subConversationId).toBeNull();
    expect(body.streams[0].messages).toHaveLength(0);
    expect(body.streams[1].subConversationId).toBeNull();
    expect(body.streams[1].messages).toHaveLength(0);
    // getMessages should not be called when there are no sub-conversations
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  test("returns 404 for missing team config", async () => {
    mockGetAgentConfig.mockImplementation(async () => null);

    const res = await GET_teamMessages(
      makeTeamMessagesEvent("conv-1", "nonexistent"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Team config not found");
  });

  test("returns empty when team has no members", async () => {
    mockAgentConfig = {
      id: "team-cfg-1",
      name: "EmptyTeam",
      prompt: "Team prompt",
      references: { members: [] },
    };

    const res = await GET_teamMessages(
      makeTeamMessagesEvent("conv-1", "team-cfg-1"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team.name).toBe("EmptyTeam");
    expect(body.team.members).toEqual([]);
    expect(body.streams).toEqual([]);
  });
});

// ── Tests: POST /start — __current__ model sentinel resolution ─────

describe("POST /start — __current__ model sentinel resolution", () => {
  beforeEach(() => {
    resetMocks();
    // Pre-populate an assignment in "assigned" status
    const assignment = makeAssignment({ id: "assign-1" });
    taskStore.tasks[0].assignments = [assignment];
    // createSubConversation returns a stable id for assertions
    mockCreateSubConversation.mockImplementation(
      async (_projectId: string | null, opts: any) => ({
        id: "sub-conv-new",
        ...opts,
      }),
    );
  });

  test("when config.model is __current__ and body has model, uses body model", async () => {
    mockAgentConfig = {
      id: "agent-cfg-1",
      name: "TestAgent",
      prompt: "You are a test agent",
      model: "__current__",
      provider: "__current__",
      references: null,
    };

    const res = await POST_start(
      makeStartEventWithBody("conv-1", "task-1", "assign-1", {
        model: "claude-sonnet",
        provider: "anthropic",
      }),
    );
    expect(res.status).toBe(200);

    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    const [, , opts] = mockStreamChat.mock.calls[0];
    expect(opts.model).toBe("claude-sonnet");
    expect(opts.provider).toBe("anthropic");
  });

  test("when config.model is __current__ and body has no model, falls back to conv.model", async () => {
    mockConv = {
      id: "conv-1",
      userId: "user-1",
      projectId: "proj-1",
      model: "gpt-4o",
      provider: "openai",
    };
    mockAgentConfig = {
      id: "agent-cfg-1",
      name: "TestAgent",
      prompt: "You are a test agent",
      model: "__current__",
      provider: "__current__",
      references: null,
    };

    const res = await POST_start(
      makeStartEventWithBody("conv-1", "task-1", "assign-1"),
    );
    expect(res.status).toBe(200);

    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    const [, , opts] = mockStreamChat.mock.calls[0];
    expect(opts.model).toBe("gpt-4o");
    expect(opts.provider).toBe("openai");
  });

  test("when config has specific model, it takes precedence over body", async () => {
    mockAgentConfig = {
      id: "agent-cfg-1",
      name: "TestAgent",
      prompt: "You are a test agent",
      model: "gemini-pro",
      provider: "google",
      references: null,
    };

    const res = await POST_start(
      makeStartEventWithBody("conv-1", "task-1", "assign-1", {
        model: "claude-sonnet",
        provider: "anthropic",
      }),
    );
    expect(res.status).toBe(200);

    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    const [, , opts] = mockStreamChat.mock.calls[0];
    expect(opts.model).toBe("gemini-pro");
    expect(opts.provider).toBe("google");
  });

  test("when config has null model, falls back to body model", async () => {
    mockAgentConfig = {
      id: "agent-cfg-1",
      name: "TestAgent",
      prompt: "You are a test agent",
      model: null as any,
      provider: null as any,
      references: null,
    };

    const res = await POST_start(
      makeStartEventWithBody("conv-1", "task-1", "assign-1", {
        model: "claude-sonnet",
        provider: "anthropic",
      }),
    );
    expect(res.status).toBe(200);

    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    const [, , opts] = mockStreamChat.mock.calls[0];
    expect(opts.model).toBe("claude-sonnet");
    expect(opts.provider).toBe("anthropic");
  });

  test("__current__ sentinel never appears in streamChat call", async () => {
    const cases = [
      // sentinel + body model
      {
        config: { model: "__current__", provider: "__current__" },
        body: { model: "claude-sonnet", provider: "anthropic" },
        conv: { model: "gpt-4o", provider: "openai" },
      },
      // sentinel + no body, conv fallback
      {
        config: { model: "__current__", provider: "__current__" },
        body: undefined,
        conv: { model: "gpt-4o", provider: "openai" },
      },
      // sentinel + no body + no conv model
      {
        config: { model: "__current__", provider: "__current__" },
        body: undefined,
        conv: { model: undefined, provider: undefined },
      },
    ];

    for (const c of cases) {
      resetMocks();
      const assignment = makeAssignment({ id: "assign-1" });
      taskStore.tasks[0].assignments = [assignment];
      mockCreateSubConversation.mockImplementation(
        async (_projectId: string | null, opts: any) => ({
          id: "sub-conv-new",
          ...opts,
        }),
      );

      mockConv = {
        id: "conv-1",
        userId: "user-1",
        projectId: "proj-1",
        model: c.conv.model,
        provider: c.conv.provider,
      };
      mockAgentConfig = {
        id: "agent-cfg-1",
        name: "TestAgent",
        prompt: "You are a test agent",
        model: c.config.model,
        provider: c.config.provider,
        references: null,
      };

      const event = c.body
        ? makeStartEventWithBody("conv-1", "task-1", "assign-1", c.body)
        : makeStartEventWithBody("conv-1", "task-1", "assign-1");

      const res = await POST_start(event);
      expect(res.status).toBe(200);

      expect(mockStreamChat).toHaveBeenCalledTimes(1);
      const [, , opts] = mockStreamChat.mock.calls[0];
      expect(opts.model).not.toBe("__current__");
      expect(opts.provider).not.toBe("__current__");
    }
  });
});

// ── Tests: POST /start — auto-continue with pending messages ────────

describe("POST /start — auto-continue with pending messages", () => {
  // Capture the run:complete callback registered by the handler
  let capturedRunCompleteCallback: ((...args: unknown[]) => unknown) | null = null;
  let capturedRunId: string | null = null;

  beforeEach(() => {
    resetMocks();
    capturedRunCompleteCallback = null;
    capturedRunId = null;

    const assignment = makeAssignment({ id: "assign-1" });
    taskStore.tasks[0].assignments = [assignment];
    mockCreateSubConversation.mockImplementation(
      async (_projectId: string | null, opts: any) => ({
        id: "sub-conv-new",
        ...opts,
      }),
    );

    // Capture the bus.on("run:complete") callback so we can invoke it manually
    mockBusOn.mockImplementation((event: string, cb: (...args: unknown[]) => unknown) => {
      if (event === "run:complete") {
        capturedRunCompleteCallback = cb;
      }
      return () => {};
    });
  });

  test("without pending messages: marks assignment completed on run:complete", async () => {
    mockDequeue.mockImplementation(() => undefined as any);

    const res = await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    capturedRunId = body.runId;

    expect(capturedRunCompleteCallback).not.toBeNull();

    // Simulate run:complete
    capturedRunCompleteCallback!({
      run: { id: capturedRunId, result: { output: "Done!" } },
    });

    expect(taskStore.tasks[0].assignments[0].status).toBe("completed");
    // Phase 3 commit-5: the host no longer calls
    // `completeTaskFromAssignment` — the bundled extension's
    // `task:assignment_update` subscription performs that state
    // transition. The run:complete listener's only remaining job is
    // emitting `task:assignment_update` with status="completed".
    const updateCalls = mockBusEmit.mock.calls.filter(
      (c: any[]) =>
        c[0] === "task:assignment_update" &&
        c[1]?.assignment?.status === "completed",
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("with pending message: starts new run instead of completing", async () => {
    // First dequeue returns a pending message, second returns undefined
    let dequeueCount = 0;
    mockDequeue.mockImplementation(() => {
      dequeueCount++;
      if (dequeueCount === 1) {
        return {
          messageId: "pending-msg-1",
          content: "Follow-up question",
          createdAt: "2026-01-01T00:00:00Z",
        };
      }
      return undefined as any;
    });

    const res = await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    capturedRunId = body.runId;

    // streamChat called once for initial run
    expect(mockStreamChat).toHaveBeenCalledTimes(1);

    // Simulate run:complete
    capturedRunCompleteCallback!({
      run: { id: capturedRunId, result: { output: "Done!" } },
    });

    // Assignment should NOT be completed
    expect(taskStore.tasks[0].assignments[0].status).toBe("running");

    // streamChat should be called again with the pending message
    expect(mockStreamChat).toHaveBeenCalledTimes(2);
    const [subConvId, content] = mockStreamChat.mock.calls[1];
    expect(subConvId).toBe("sub-conv-new");
    expect(content).toBe("Follow-up question");

    // agent:spawn should be emitted for the new run
    const spawnCalls = mockBusEmit.mock.calls.filter((c: any[]) => c[0] === "agent:spawn");
    expect(spawnCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("with pending message: passes pending messageId as parentMessageId", async () => {
    mockDequeue.mockImplementation(() => ({
      messageId: "pending-msg-1",
      content: "Follow-up",
      createdAt: "2026-01-01T00:00:00Z",
    }));

    const res = await POST_start(makeStartEvent("conv-1", "task-1", "assign-1"));
    capturedRunId = (await res.json()).runId;

    capturedRunCompleteCallback!({
      run: { id: capturedRunId, result: { output: "Done!" } },
    });

    // Second streamChat call should use the pending message's ID as parentMessageId
    const [, , opts] = mockStreamChat.mock.calls[1];
    expect(opts.parentMessageId).toBe("pending-msg-1");
  });
});
