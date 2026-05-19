/**
 * Server-handler unit tests for
 * /api/conversations/[id]/tasks/[taskId]/retry (+server.ts).
 *
 * Covers auth (401), missing conv (404), ownership 404, missing task
 * (404), 409 when task not in "failed" state, and the zero-assignment
 * reset path that returns snapshot + resetAssignmentIds without
 * auto-spawning.
 *
 * Runtime imports (executor, bus, start-assignment) are mocked so
 * the handler's decision-making is exercised without touching the
 * real runtime.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const getAgentConfig = vi.fn();
const getTaskSnapshotForConversation = vi.fn();
const writeTaskSnapshotForConversation = vi.fn(async () => undefined);
const ensureTaskTrackingWired = vi.fn(async () => undefined);
const busEmit = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
}));

vi.mock("$server/db/queries/agent-configs", () => ({
  getAgentConfig,
}));

vi.mock("$server/runtime/task-tracking-host", () => ({
  getTaskSnapshotForConversation,
  writeTaskSnapshotForConversation,
  ensureTaskTrackingWired,
}));

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({ cancelRun: vi.fn() }),
  getBus: () => ({ emit: busEmit }),
}));

vi.mock("$server/runtime/start-assignment", () => ({
  startAssignment: vi.fn(async () => ({
    subConversationId: "sub-new",
    agentRunId: "run-new",
  })),
}));

const { POST } = await import(
  "../routes/api/conversations/[id]/tasks/[taskId]/retry/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  return {
    url: new URL(
      "http://localhost/api/conversations/c1/tasks/t1/retry",
    ),
    locals: opts.locals ?? {},
    params: { id: "c1", taskId: "t1" },
    request: new Request(
      "http://localhost/api/conversations/c1/tasks/t1/retry",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : "{}",
      },
    ),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("POST /api/conversations/[id]/tasks/[taskId]/retry", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getAgentConfig.mockReset();
    getTaskSnapshotForConversation.mockReset();
    busEmit.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 404 when conversation missing", async () => {
    getConversation.mockResolvedValue(null);
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(404);
  });

  test("returns 404 on ownership mismatch", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "other" });
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(404);
  });

  test("returns 404 when task not present", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [],
    });
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Task not found");
  });

  test("returns 409 when task is not in 'failed' state", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "pending",
          assignments: [],
          subtasks: [],
        },
      ],
    });
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('"pending"');
  });

  test("happy path with 0 failed assignments: resets task, does NOT spawn", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "failed",
          failedAt: "2026-01-01T00:00:00Z",
          failureReason: "boom",
          assignments: [],
          subtasks: [],
        },
      ],
    });
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resetAssignmentIds: string[];
      spawned: unknown;
    };
    expect(body.resetAssignmentIds.length).toBe(0);
    expect(body.spawned).toBeNull();
  });

  test("happy path with 2 failed assignments: resets but does not auto-spawn", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "failed",
          assignments: [
            { id: "as-1", status: "failed", agentConfigId: "a1" },
            { id: "as-2", status: "failed", agentConfigId: "a2" },
          ],
          subtasks: [],
        },
      ],
    });
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resetAssignmentIds: string[];
      spawned: unknown;
    };
    expect(body.resetAssignmentIds.sort()).toEqual(["as-1", "as-2"]);
    expect(body.spawned).toBeNull();
  });
});
