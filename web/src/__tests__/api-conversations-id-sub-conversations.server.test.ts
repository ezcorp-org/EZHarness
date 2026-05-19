/**
 * Server-handler unit tests for
 * /api/conversations/[id]/sub-conversations (+server.ts).
 *
 * Covers auth (401), ownership mismatch 404, missing-parent 404, and
 * the happy path returning the sub-conversation list. Mocks
 * `$server/db/queries/conversations` at the import boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const getSubConversations = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  getSubConversations,
}));

const { GET } = await import(
  "../routes/api/conversations/[id]/sub-conversations/+server.ts"
);

function makeEvent(opts: { locals?: Record<string, unknown> }) {
  return {
    url: new URL("http://localhost/api/conversations/c1/sub-conversations"),
    locals: opts.locals ?? {},
    params: { id: "c1" },
    request: new Request(
      "http://localhost/api/conversations/c1/sub-conversations",
    ),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/conversations/[id]/sub-conversations", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getSubConversations.mockReset();
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

  test("returns 404 when parent conversation missing", async () => {
    getConversation.mockResolvedValue(null);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("returns 404 when non-owner non-admin attempts list", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "other" });
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("happy path: returns sub-conversation list for owner", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getSubConversations.mockResolvedValue([
      { id: "sub-1", parentConversationId: "c1" },
    ]);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.length).toBe(1);
    expect(body[0]!.id).toBe("sub-1");
  });

  test("admin can list sub-conversations on unowned (null userId) row", async () => {
    const admin = { ...user, role: "admin" };
    getConversation.mockResolvedValue({ id: "c1", userId: null });
    getSubConversations.mockResolvedValue([]);
    const res = await GET(makeEvent({ locals: { user: admin } }));
    expect(res.status).toBe(200);
  });
});
