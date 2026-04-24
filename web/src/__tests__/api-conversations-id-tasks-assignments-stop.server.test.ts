/**
 * Server-handler unit tests for
 * /api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/stop
 * (+server.ts).
 *
 * Covers auth (401), missing conv (404), ownership 404, missing task
 * (404), missing assignment (404), 409 when assignment is not in
 * "running" status, and happy path — the executor is mocked so
 * cancelRun doesn't touch the real runtime.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const getTaskSnapshotForConversation = vi.fn();
const writeTaskSnapshotForConversation = vi.fn(async () => undefined);
const ensureTaskTrackingWired = vi.fn(async () => undefined);
const cancelRun = vi.fn(() => true);
const busEmit = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
}));

vi.mock("$server/runtime/task-tracking-host", () => ({
  getTaskSnapshotForConversation,
  writeTaskSnapshotForConversation,
  ensureTaskTrackingWired,
}));

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({ cancelRun }),
  getBus: () => ({ emit: busEmit }),
}));

const { POST } = await import(
  "../routes/api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/stop/+server.ts"
);

function makeEvent(opts: { locals?: Record<string, unknown> }) {
  return {
    url: new URL(
      "http://localhost/api/conversations/c1/tasks/t1/assignments/as1/stop",
    ),
    locals: opts.locals ?? {},
    params: { id: "c1", taskId: "t1", assignmentId: "as1" },
    request: new Request(
      "http://localhost/api/conversations/c1/tasks/t1/assignments/as1/stop",
      { method: "POST" },
    ),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("POST /api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/stop", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getTaskSnapshotForConversation.mockReset();
    cancelRun.mockReset();
    cancelRun.mockReturnValue(true);
    busEmit.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({}));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 404 when conversation missing", async () => {
    getConversation.mockResolvedValue(null);
    const res = await POST(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("returns 404 on ownership mismatch", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "other" });
    const res = await POST(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("returns 404 when task not found", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [],
    });
    const res = await POST(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Task not found");
  });

  test("returns 404 when assignment not found", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        { id: "t1", status: "active", assignments: [], subtasks: [] },
      ],
    });
    const res = await POST(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Assignment not found");
  });

  test("returns 409 when assignment is not in 'running' status", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "active",
          assignments: [{ id: "as1", status: "assigned" }],
          subtasks: [],
        },
      ],
    });
    const res = await POST(makeEvent({ locals: { user } }));
    expect(res.status).toBe(409);
  });

  test("happy path: cancels in-flight run and resets assignment", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "active",
          assignments: [
            {
              id: "as1",
              status: "running",
              agentRunId: "run-xyz",
              subConversationId: "sub-1",
              startedAt: "2026-01-01T00:00:00Z",
            },
          ],
          subtasks: [],
        },
      ],
    });
    const res = await POST(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stopped: boolean;
      cancelled: boolean;
      assignment: { status: string; subConversationId?: string };
    };
    expect(body.stopped).toBe(true);
    expect(body.cancelled).toBe(true);
    expect(body.assignment.status).toBe("assigned");
    // subConversationId preserved for resume
    expect(body.assignment.subConversationId).toBe("sub-1");
    expect(cancelRun).toHaveBeenCalledWith("run-xyz");
  });
});
