/**
 * Server-handler unit tests for
 * /api/conversations/[id]/tasks (+server.ts).
 *
 * Covers auth (401), missing conv (404), ownership mismatch (404), and
 * happy path — both the snapshot-present and snapshot-missing shapes.
 *
 * Mocks `$server/db/queries/conversations` + the task-tracking-host
 * bridge so we never touch the bundled extension or PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const getTaskSnapshotForConversation = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
}));

vi.mock("$server/runtime/task-tracking-host", () => ({
  getTaskSnapshotForConversation,
}));

const { GET } = await import(
  "../routes/api/conversations/[id]/tasks/+server.ts"
);

function makeEvent(opts: { locals?: Record<string, unknown> }) {
  return {
    url: new URL("http://localhost/api/conversations/c1/tasks"),
    locals: opts.locals ?? {},
    params: { id: "c1" },
    request: new Request("http://localhost/api/conversations/c1/tasks"),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/conversations/[id]/tasks", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getTaskSnapshotForConversation.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({}));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 404 when conversation missing", async () => {
    getConversation.mockResolvedValue(null);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("returns 404 on ownership mismatch", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "other" });
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("happy path with snapshot: returns persisted tasks", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [{ id: "t1", title: "Do thing", status: "pending" }],
      activeTaskId: "t1",
    });
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversationId: string;
      tasks: Array<{ id: string }>;
      activeTaskId?: string;
    };
    expect(body.tasks.length).toBe(1);
    expect(body.tasks[0]!.id).toBe("t1");
    expect(body.activeTaskId).toBe("t1");
  });

  test("happy path without snapshot: returns empty default", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue(undefined);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversationId: string;
      tasks: unknown[];
    };
    expect(body.conversationId).toBe("c1");
    expect(body.tasks.length).toBe(0);
  });

  test("happy path: swallows snapshot lookup failure and returns empty", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockRejectedValue(new Error("boom"));
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[] };
    expect(body.tasks.length).toBe(0);
  });
});
