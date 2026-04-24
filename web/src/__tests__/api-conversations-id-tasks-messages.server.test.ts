/**
 * Server-handler unit tests for
 * /api/conversations/[id]/tasks/[taskId]/messages (+server.ts).
 *
 * Covers auth gate (401), ownership 404, missing-task 404, and the
 * happy path where the handler returns per-assignment message streams
 * for only the assignments that have a sub-conversation bound.
 *
 * Mocks conversations queries + task-tracking host so the test stays
 * off the WIP DB.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const getMessages = vi.fn();
const getTaskSnapshotForConversation = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  getMessages,
}));

vi.mock("$server/runtime/task-tracking-host", () => ({
  getTaskSnapshotForConversation,
}));

const { GET } = await import(
  "../routes/api/conversations/[id]/tasks/[taskId]/messages/+server.ts"
);

function makeEvent(opts: { locals?: Record<string, unknown> }) {
  return {
    url: new URL(
      "http://localhost/api/conversations/c1/tasks/t1/messages",
    ),
    locals: opts.locals ?? {},
    params: { id: "c1", taskId: "t1" },
    request: new Request(
      "http://localhost/api/conversations/c1/tasks/t1/messages",
    ),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/conversations/[id]/tasks/[taskId]/messages", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getMessages.mockReset();
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
  });

  test("returns 404 on ownership mismatch", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "other" });
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("returns 404 when task not found in snapshot", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [],
    });
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Task not found");
  });

  test("happy path: only returns streams for assignments with sub-conversations", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getTaskSnapshotForConversation.mockResolvedValue({
      conversationId: "c1",
      tasks: [
        {
          id: "t1",
          status: "active",
          assignments: [
            {
              id: "as-1",
              agentName: "A",
              subConversationId: "sub-a",
              status: "running",
            },
            {
              id: "as-2",
              agentName: "B",
              subConversationId: undefined,
              status: "assigned",
            },
          ],
          subtasks: [
            {
              id: "s1",
              assignments: [
                {
                  id: "as-3",
                  agentName: "C",
                  subConversationId: "sub-c",
                  status: "done",
                },
              ],
            },
          ],
        },
      ],
    });
    getMessages.mockImplementation(async (sid: string) => [
      { id: `m-${sid}`, role: "assistant", content: "hi" },
    ]);

    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      streams: Array<{ assignmentId: string; subConversationId: string }>;
    };
    expect(body.streams.length).toBe(2);
    const ids = body.streams.map((s) => s.assignmentId).sort();
    expect(ids).toEqual(["as-1", "as-3"]);
  });
});
