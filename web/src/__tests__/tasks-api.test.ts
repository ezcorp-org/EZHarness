import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { TaskSnapshot } from "../../../src/runtime/task-tracking-host";

// ── Mock db/query layer ─────────────────────────────────────────────

type Conversation = { id: string; userId: string | null; projectId: string | null };

let mockConv: Conversation | null = null;
const mockGetConversation = mock(async (_id: string) => mockConv);

mock.module("$server/db/queries/conversations", () => ({
  getConversation: mockGetConversation,
}));

// ── Mock task-tracking-host (the route's new Phase 3 data access) ──

let snapshotStore = new Map<string, TaskSnapshot>();
const mockGetTaskSnapshotForConversation = mock(async (id: string) => {
  return snapshotStore.get(id);
});

mock.module("$server/runtime/task-tracking-host", () => ({
  getTaskSnapshotForConversation: mockGetTaskSnapshotForConversation,
  getTaskTrackingExtensionId: async () => "ext-tt",
}));

// ── Mock auth + scope middleware ────────────────────────────────────

const mockUser: { id: string; email: string; name: string; role: string } = {
  id: "user-1", email: "test@test.com", name: "Test", role: "member",
};
mock.module("$server/auth/middleware", () => ({
  requireAuth: (locals: any) => locals?.user ?? mockUser,
}));

let mockScopeResponse: Response | null = null;
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => mockScopeResponse,
}));

// Import handler AFTER all mocks are installed.
const { GET } = await import("../routes/api/conversations/[id]/tasks/+server");

// ── Test helpers ────────────────────────────────────────────────────

function makeEvent(conversationId: string, opts: { user?: typeof mockUser } = {}) {
  return {
    request: new Request(`http://localhost/api/conversations/${conversationId}/tasks`, {
      method: "GET",
    }),
    params: { id: conversationId },
    locals: { user: opts.user ?? mockUser },
  } as any;
}

function _snap(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    conversationId: "conv-1",
    tasks: [],
    activeTaskId: undefined,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("GET /api/conversations/[id]/tasks", () => {
  beforeEach(() => {
    mockConv = { id: "conv-1", userId: "user-1", projectId: "proj-1" };
    snapshotStore = new Map();
    mockScopeResponse = null;
    mockGetConversation.mockClear();
    mockGetTaskSnapshotForConversation.mockClear();
    mockGetTaskSnapshotForConversation.mockImplementation(async (id: string) => snapshotStore.get(id));
  });

  test("returns empty snapshot when extension has no stored row", async () => {
    const res = await GET(makeEvent("conv-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ conversationId: "conv-1", tasks: [], activeTaskId: undefined });
  });

  test("empty snapshot path still verifies conversation ownership", async () => {
    await GET(makeEvent("conv-1"));
    expect(mockGetConversation).toHaveBeenCalledWith("conv-1");
  });

  test("returns persisted snapshot from extension storage", async () => {
    const persisted: TaskSnapshot = {
      conversationId: "conv-1",
      tasks: [
        {
          id: "task-a",
          title: "Stored",
          description: "",
          status: "active",
          assignments: [],
          subtasks: [],
          priority: 0,
          createdAt: new Date().toISOString(),
        } as any,
      ],
      activeTaskId: "task-a",
    };
    snapshotStore.set("conv-1", persisted);

    const res = await GET(makeEvent("conv-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe("task-a");
    expect(body.activeTaskId).toBe("task-a");
    expect(mockGetTaskSnapshotForConversation).toHaveBeenCalledWith("conv-1");
  });

  test("returns empty snapshot when the read throws", async () => {
    mockGetTaskSnapshotForConversation.mockImplementation(async () => {
      throw new Error("DB connection error");
    });

    const res = await GET(makeEvent("conv-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ conversationId: "conv-1", tasks: [], activeTaskId: undefined });
  });

  // --- Ownership / 404 ---

  test("returns 404 for unknown conversation", async () => {
    mockConv = null;
    const res = await GET(makeEvent("missing"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  test("returns 404 when conversation belongs to another user", async () => {
    mockConv = { id: "conv-1", userId: "user-2", projectId: "proj-1" };
    const res = await GET(makeEvent("conv-1"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
  });

  // updated for sec-H3: fail-closed on null owner
  test("returns 404 for non-admin on null-owner conversation (fail-closed)", async () => {
    mockConv = { id: "conv-1", userId: null, projectId: "proj-1" };
    const res = await GET(makeEvent("conv-1"));
    expect(res.status).toBe(404);
  });

  // updated for sec-H3: fail-closed on null owner
  test("admins can access null-owner conversation", async () => {
    mockConv = { id: "conv-1", userId: null, projectId: "proj-1" };
    const admin = { id: "admin-1", email: "a@a.com", name: "Admin", role: "admin" };
    const res = await GET(makeEvent("conv-1", { user: admin }));
    expect(res.status).toBe(200);
  });

  // --- Auth scope ---

  test("returns scope error when requireScope denies", async () => {
    mockScopeResponse = Response.json(
      { error: "Insufficient scope", required: "read" },
      { status: 403 },
    );

    const res = await GET(makeEvent("conv-1"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("read");
    expect(mockGetConversation).not.toHaveBeenCalled();
  });
});
