/**
 * Server-handler unit tests for
 * /api/conversations/[id]/clone-turns (+server.ts).
 *
 * Covers auth gate (401), 404 on missing source conv, 404 on
 * ownership mismatch, Zod validation (400), domain-error mapping
 * (400 "do not belong"), and happy path (201 + new conversation).
 *
 * Mocks `$server/db/queries/conversations` so we don't touch the WIP
 * query module or PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const cloneTurnsIntoNewConversation = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  cloneTurnsIntoNewConversation,
}));

const { POST } = await import(
  "../routes/api/conversations/[id]/clone-turns/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  id?: string;
}) {
  const id = opts.id ?? "c1";
  return {
    url: new URL(`http://localhost/api/conversations/${id}/clone-turns`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/conversations/${id}/clone-turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const MID = "11111111-1111-4111-8111-111111111111";

describe("POST /api/conversations/[id]/clone-turns", () => {
  beforeEach(() => {
    getConversation.mockReset();
    cloneTurnsIntoNewConversation.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: { messageIds: [MID] } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 404 when source conversation does not exist", async () => {
    getConversation.mockResolvedValue(null);
    const res = await POST(
      makeEvent({ locals: { user }, body: { messageIds: [MID] } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("returns 404 when non-owner non-admin attempts clone", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "someone-else" });
    const res = await POST(
      makeEvent({ locals: { user }, body: { messageIds: [MID] } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("rejects 400 on schema validation failure (empty messageIds)", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    const res = await POST(
      makeEvent({ locals: { user }, body: { messageIds: [] } }),
    );
    expect(res.status).toBe(400);
  });

  test("rejects 400 when messageId is not a uuid", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    const res = await POST(
      makeEvent({ locals: { user }, body: { messageIds: ["not-a-uuid"] } }),
    );
    expect(res.status).toBe(400);
  });

  test("maps 'do not belong' error to 400", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    cloneTurnsIntoNewConversation.mockRejectedValue(
      new Error("messages do not belong to this conversation"),
    );
    const res = await POST(
      makeEvent({ locals: { user }, body: { messageIds: [MID] } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("do not belong");
  });

  test("happy path: returns 201 with new conversation", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    cloneTurnsIntoNewConversation.mockResolvedValue({
      conversation: { id: "c-new", title: "Branch" },
    });
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { messageIds: [MID], title: "Branch" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id).toBe("c-new");
    expect(body.title).toBe("Branch");
  });
});
