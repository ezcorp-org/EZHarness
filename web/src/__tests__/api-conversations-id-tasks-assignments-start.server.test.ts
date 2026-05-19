/**
 * Server-handler unit tests for
 * /api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/start
 * (+server.ts).
 *
 * Covers auth (401), missing conv (404), ownership 404, missing task
 * (404), missing assignment (404), 409 when assignment is not in
 * "assigned" status, and the dependency-blocked 409 path.
 *
 * The runtime `startAssignment` helper is mocked so we test the
 * handler's gating without spawning a real sub-agent.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const getAgentConfig = vi.fn();
const getTaskSnapshotForConversation = vi.fn();
const writeTaskSnapshotForConversation = vi.fn(async () => undefined);
const ensureTaskTrackingWired = vi.fn(async () => undefined);
const startAssignment = vi.fn(async () => ({
  subConversationId: "sub-x",
  agentRunId: "run-x",
}));

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
  getExecutor: () => ({}),
  getBus: () => ({ emit: vi.fn() }),
}));

vi.mock("$server/runtime/start-assignment", () => ({
  startAssignment,
}));

const { POST } = await import(
  "../routes/api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/start/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  return {
    url: new URL(
      "http://localhost/api/conversations/c1/tasks/t1/assignments/as1/start",
    ),
    locals: opts.locals ?? {},
    params: { id: "c1", taskId: "t1", assignmentId: "as1" },
    request: new Request(
      "http://localhost/api/conversations/c1/tasks/t1/assignments/as1/start",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : "{}",
      },
    ),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("POST /api/conversations/[id]/tasks/[taskId]/assignments/[assignmentId]/start", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getAgentConfig.mockReset();
    getTaskSnapshotForConversation.mockReset();
    startAssignment.mockClear();
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

  test("returns 404 when task not found", async () => {
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

  test("returns 404 when assignment not found", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        { id: "t1", status: "pending", assignments: [], subtasks: [] },
      ],
    });
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Assignment not found");
  });

  test("returns 409 when assignment status is not 'assigned'", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "active",
          assignments: [
            { id: "as1", status: "running", agentConfigId: "a1" },
          ],
          subtasks: [],
        },
      ],
    });
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('"running"');
  });

  test("returns 409 when task is blocked on unsatisfied prerequisites", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t0",
          title: "Prereq",
          status: "pending",
          assignments: [],
          subtasks: [],
        },
        {
          id: "t1",
          title: "Child",
          status: "pending",
          dependsOn: ["t0"],
          assignments: [
            { id: "as1", status: "assigned", agentConfigId: "a1" },
          ],
          subtasks: [],
        },
      ],
    });
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error?: string;
      waitingOn?: string[];
    };
    expect(body.error).toContain("blocked");
    expect(Array.isArray(body.waitingOn)).toBe(true);
  });

  test("returns 404 when agent config not found (after dep gate passes)", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "pending",
          assignments: [
            { id: "as1", status: "assigned", agentConfigId: "a1" },
          ],
          subtasks: [],
        },
      ],
    });
    getAgentConfig.mockResolvedValue(null);
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Agent config not found");
  });
});
