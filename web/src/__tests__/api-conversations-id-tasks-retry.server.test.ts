import { taskSnapshotPort, taskAssignmentPort } from "./helpers/task-state-port";
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
  return makeRequestEvent("http://localhost/api/conversations/c1/tasks/t1/retry", {
    locals: opts.locals ?? {},
    params: { id: "c1", taskId: "t1" },
    request: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : "{}",
      },
  });
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

  // ── Boundary 2: per-API-key mode lock + autopilot refusal ─────────────
  //
  // This route auto-spawns the assignment, so it STARTS A RUN and had no mode
  // check anywhere on the path. A key minted `--locked-mode` reached it — the
  // mint guard read the key's reach off a `routeAllowlist` it did not have and
  // passed vacuously — and spawned an agent the lock was supposed to prevent.
  //
  // What the lock buys HERE, stated so nobody reads more into it: it gates
  // WHICH conversations the key may spawn from. The spawned agent still runs
  // under its own agent config, because `startAssignment` takes neither a mode
  // nor a Boundary-3 option bag. That residual is identical for an unlocked
  // policied key, so the lock remains a strict narrowing.
  describe("Boundary 2 — per-API-key mode lock", () => {
    const MODE = "mode-locked";
    /** A FRESH snapshot per test: the handler resets the task in place
     *  (`task.status = "pending"`), so a shared literal would leave every
     *  arm after the first one hitting the 409 "not failed" guard. */
    const failedTask = () => ({
      conversationId: "c1",
      tasks: [{ id: "t1", status: "failed", assignments: [], subtasks: [] }],
    });
    const policied = (policy: Record<string, unknown>) => ({
      user,
      apiKeyScopes: ["chat"],
      apiKeyToolPolicy: policy,
    });
    const post = (locals: Record<string, unknown>) =>
      POST(makeEvent({ locals, body: {} }));

    beforeEach(() => {
      getTaskSnapshotForConversation.mockImplementation(async () => failedTask());
    });

    test("a conversation under a DIFFERENT mode is 403 lockedModeId", async () => {
      getConversation.mockResolvedValue({ id: "c1", userId: "u1", modeId: "mode-other" });
      const res = await post(policied({ lockedModeId: MODE }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ field: "lockedModeId" });
      // Refused before the snapshot is read, so a rejected key never mutates
      // task state and learns nothing about it.
      expect(getTaskSnapshotForConversation).not.toHaveBeenCalled();
    });

    test("a conversation with NO mode BRICKS a locked key (fail-closed)", async () => {
      getConversation.mockResolvedValue({ id: "c1", userId: "u1", modeId: null });
      const res = await post(policied({ lockedModeId: MODE }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ field: "lockedModeId" });
    });

    test("a policied key may not retry a task on a goal-armed conversation", async () => {
      getConversation.mockResolvedValue({
        id: "c1",
        userId: "u1",
        modeId: MODE,
        metadata: { goal: { condition: "ship it" } },
      });
      const res = await post(policied({ lockedModeId: MODE }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ field: "goal" });
    });

    test("an in-policy retry is allowed", async () => {
      getConversation.mockResolvedValue({ id: "c1", userId: "u1", modeId: MODE });
      expect((await post(policied({ lockedModeId: MODE }))).status).toBe(200);
    });

    test("an UNPOLICIED key is unchanged by a null mode", async () => {
      getConversation.mockResolvedValue({ id: "c1", userId: "u1", modeId: null });
      expect((await post({ user, apiKeyScopes: ["chat"] })).status).toBe(200);
    });

    test("a COOKIE SESSION is unchanged by a null mode", async () => {
      getConversation.mockResolvedValue({ id: "c1", userId: "u1", modeId: null });
      expect((await post({ user })).status).toBe(200);
    });
  });
});
