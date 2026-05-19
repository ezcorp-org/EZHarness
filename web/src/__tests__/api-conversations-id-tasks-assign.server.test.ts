/**
 * Server-handler unit tests for
 * /api/conversations/[id]/tasks/[taskId]/assign (+server.ts).
 *
 * Covers POST/DELETE auth gates (401), ownership 404, missing-task
 * 404, agent-config 404, required-body-field validation (400), and
 * the 409 "cannot remove running assignment" path on DELETE.
 *
 * Mocks conversations queries, agent-configs queries, task-tracking
 * host, and the bus so the test stays off the WIP DB.
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
  return {
    url: new URL(
      "http://localhost/api/conversations/c1/tasks/t1/assign",
    ),
    locals: opts.locals ?? {},
    params: { id: "c1", taskId: "t1" },
    request: new Request(
      "http://localhost/api/conversations/c1/tasks/t1/assign",
      {
        method,
        headers: { "content-type": "application/json" },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : "{}",
      },
    ),
  } as any;
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
});
