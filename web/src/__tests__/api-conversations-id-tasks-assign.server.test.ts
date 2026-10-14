import { taskSnapshotPort, taskAssignmentPort } from "./helpers/task-state-port";
/**
 * Server-handler unit tests for
 * /api/conversations/[id]/tasks/[taskId]/assign (+server.ts).
 *
 * Covers POST/DELETE auth gates (401), ownership 404, missing-task
 * 404, agent-config 404, required-body-field validation (400), subtask
 * and team assignment, removal (task + subtask level), and the 409
 * "cannot remove running assignment" path on DELETE.
 *
 * Mocks conversations queries, agent-configs queries, task-tracking
 * host, and the bus so the test stays off the WIP DB.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const getConversation = vi.fn();
const getAgentConfig = vi.fn();
const getTaskSnapshotForConversation = vi.fn();
const writeTaskSnapshotForConversation = vi.fn(taskSnapshotPort);
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
  writeTaskAssignmentForConversation: taskAssignmentPort,
  ensureTaskTrackingWired,
}));

vi.mock("$lib/server/context", () => ({
  getBus: () => ({ emit: busEmit }),
}));

const { POST, DELETE } = await import(
  "../routes/api/conversations/[id]/tasks/[taskId]/assign/+server.ts"
);

function makeEvent(opts: {
  method?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const method = opts.method ?? "POST";
  return makeRequestEvent("http://localhost/api/conversations/c1/tasks/t1/assign", {
    locals: opts.locals ?? {},
    params: { id: "c1", taskId: "t1" },
    request: {
        method,
        headers: { "content-type": "application/json" },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : "{}",
      },
  });
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("POST /api/conversations/[id]/tasks/[taskId]/assign", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getAgentConfig.mockReset();
    getTaskSnapshotForConversation.mockReset();
    busEmit.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: { agentConfigId: "a1" } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 404 when conversation missing", async () => {
    getConversation.mockResolvedValue(null);
    const res = await POST(
      makeEvent({ locals: { user }, body: { agentConfigId: "a1" } }),
    );
    expect(res.status).toBe(404);
  });

  test("returns 404 on ownership mismatch", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "other" });
    const res = await POST(
      makeEvent({ locals: { user }, body: { agentConfigId: "a1" } }),
    );
    expect(res.status).toBe(404);
  });

  test("rejects 400 when agentConfigId missing", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    const res = await POST(
      makeEvent({ locals: { user }, body: {} }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("agentConfigId is required");
  });

  test("returns 404 when task not present in snapshot", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [],
    });
    const res = await POST(
      makeEvent({ locals: { user }, body: { agentConfigId: "a1" } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Task not found");
  });

  test("returns 404 when agent config does not exist", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          title: "T",
          status: "pending",
          assignments: [],
          subtasks: [],
        },
      ],
    });
    getAgentConfig.mockResolvedValue(null);
    const res = await POST(
      makeEvent({ locals: { user }, body: { agentConfigId: "a1" } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Agent config not found");
  });

  test("happy path: assigns agent to task and returns assignment + snapshot", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          title: "T",
          status: "pending",
          assignments: [],
          subtasks: [],
        },
      ],
    });
    getAgentConfig.mockResolvedValue({
      id: "a1",
      name: "My Agent",
      references: null,
    });

    const res = await POST(
      makeEvent({ locals: { user }, body: { agentConfigId: "a1" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      assignment: { agentName: string; status: string };
    };
    expect(body.assignment.agentName).toBe("My Agent");
    expect(body.assignment.status).toBe("assigned");
    expect(busEmit).toHaveBeenCalled();
  });

  const taskWithSubtask = () => ({
    conversationId: "c1",
    tasks: [
      {
        id: "t1",
        status: "pending",
        assignments: [],
        subtasks: [{ id: "st-1" }],
      },
    ],
  });

  test("assigns a team to a subtask", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue(taskWithSubtask());
    getAgentConfig.mockResolvedValue({
      id: "team-1",
      name: "Squad",
      references: { members: [{ agentConfigId: "m1" }] },
    });

    const res = await POST(
      makeEvent({ locals: { user }, body: { agentConfigId: "team-1", subtaskId: "st-1" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      assignment: { id: string; isTeam: boolean };
      snapshot: { tasks: { assignments: unknown[]; subtasks: { assignments: { id: string }[] }[] }[] };
    };
    expect(body.assignment.isTeam).toBe(true);
    const [task] = body.snapshot.tasks;
    expect(task!.assignments).toEqual([]);
    expect(task!.subtasks[0]!.assignments.map((a) => a.id)).toEqual([body.assignment.id]);
  });

  test("returns 404 for an unknown subtask", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue(taskWithSubtask());
    getAgentConfig.mockResolvedValue({ id: "a1", name: "A", references: null });

    const res = await POST(
      makeEvent({ locals: { user }, body: { agentConfigId: "a1", subtaskId: "nope" } }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe("Subtask not found");
  });
});

describe("DELETE /api/conversations/[id]/tasks/[taskId]/assign", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getTaskSnapshotForConversation.mockReset();
    busEmit.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await DELETE(
        makeEvent({ method: "DELETE", body: { assignmentId: "as1" } }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 400 when assignmentId missing", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    const res = await DELETE(
      makeEvent({ method: "DELETE", locals: { user }, body: {} }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("assignmentId is required");
  });

  test("returns 409 when assignment is not in 'assigned' status", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "active",
          assignments: [{ id: "as1", status: "running" }],
          subtasks: [],
        },
      ],
    });
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: { user },
        body: { assignmentId: "as1" },
      }),
    );
    expect(res.status).toBe(409);
  });

  test("returns 404 when assignment id does not match any", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "active",
          assignments: [],
          subtasks: [],
        },
      ],
    });
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: { user },
        body: { assignmentId: "missing" },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Assignment not found");
  });

  const del = (assignmentId: string) =>
    DELETE(makeEvent({ method: "DELETE", locals: { user }, body: { assignmentId } }));

  test("removes an assigned task-level assignment", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    const snapshot = {
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "pending",
          assignments: [{ id: "as1", status: "assigned" }, { id: "as2", status: "assigned" }],
          subtasks: [],
        },
      ],
    };
    getTaskSnapshotForConversation.mockResolvedValue(snapshot);

    const res = await del("as1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(snapshot.tasks[0]!.assignments.map((a) => a.id)).toEqual(["as2"]);
    expect(busEmit).toHaveBeenCalledWith("task:snapshot", expect.objectContaining({ conversationId: "c1" }));
  });

  test("removes a subtask assignment, and refuses a running one", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    const snapshot = {
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "active",
          assignments: [],
          subtasks: [
            { id: "st-0" },
            {
              id: "st-1",
              assignments: [
                { id: "sub-run", status: "running" },
                { id: "sub-as", status: "assigned" },
              ],
            },
          ],
        },
      ],
    };
    getTaskSnapshotForConversation.mockResolvedValue(snapshot);

    const refused = await del("sub-run");
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error?: string }).error).toBe(
      'Cannot remove assignment in "running" status',
    );

    const res = await del("sub-as");
    expect(res.status).toBe(200);
    expect(snapshot.tasks[0]!.subtasks[1]!.assignments!.map((a) => a.id)).toEqual(["sub-run"]);
  });
});
