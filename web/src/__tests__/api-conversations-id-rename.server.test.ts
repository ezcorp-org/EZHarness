/**
 * Server-handler tests for PUT /api/conversations/[id] focused on the
 * title-rename path used by the chat-header double-click affordance.
 *
 * Covers: 401 when unauthenticated, 404 when conversation missing,
 * 404 when non-owner non-admin, 4xx validation when title exceeds the
 * 500-char schema cap, and the happy-path round-trip that returns the
 * updated Conversation row.
 *
 * Mocks `$server/db/queries/conversations` and `$server/db/queries/projects`
 * so the test doesn't touch a real DB.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const updateConversation = vi.fn();
const deleteConversation = vi.fn();
const getProject = vi.fn();
const deleteForConversation = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  updateConversation,
  deleteConversation,
}));

vi.mock("$server/db/queries/projects", () => ({
  getProject,
}));

vi.mock("$server/chat/attachments/storage", () => ({
  deleteForConversation,
}));

const { PUT } = await import("../routes/api/conversations/[id]/+server.ts");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const href = "http://localhost/api/conversations/c1";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: { id: "c1" },
    request: new Request(href, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("PUT /api/conversations/[id] (title rename)", () => {
  beforeEach(() => {
    getConversation.mockReset();
    updateConversation.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await PUT(makeEvent({ body: { title: "Renamed" } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    expect(updateConversation).not.toHaveBeenCalled();
  });

  test("returns 404 when conversation does not exist", async () => {
    getConversation.mockResolvedValue(null);
    const res = await PUT(makeEvent({ locals: { user }, body: { title: "Renamed" } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
    expect(updateConversation).not.toHaveBeenCalled();
  });

  test("returns 404 when non-owner non-admin attempts rename", async () => {
    getConversation.mockResolvedValue({
      id: "c1",
      userId: "someone-else",
      title: "Old",
    });
    const res = await PUT(makeEvent({ locals: { user }, body: { title: "Renamed" } }));
    expect(res.status).toBe(404);
    expect(updateConversation).not.toHaveBeenCalled();
  });

  test("returns validation error when title exceeds 500 chars", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: user.id, title: "Old" });
    const res = await PUT(
      makeEvent({ locals: { user }, body: { title: "a".repeat(501) } }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(updateConversation).not.toHaveBeenCalled();
  });

  test("happy path: owner renames, returns updated conversation", async () => {
    getConversation.mockResolvedValue({
      id: "c1",
      userId: user.id,
      title: "Old",
      projectId: "p1",
    });
    updateConversation.mockResolvedValue({
      id: "c1",
      userId: user.id,
      title: "Renamed",
      projectId: "p1",
    });
    const res = await PUT(
      makeEvent({ locals: { user }, body: { title: "Renamed" } }),
    );
    expect(res.status).toBe(200);
    expect(updateConversation).toHaveBeenCalledTimes(1);
    expect(updateConversation).toHaveBeenCalledWith("c1", { title: "Renamed" });
    const body = (await res.json()) as { id: string; title: string };
    expect(body).toMatchObject({ id: "c1", title: "Renamed" });
  });

  test("returns 404 when updateConversation reports a missing row post-check", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: user.id, title: "Old" });
    updateConversation.mockResolvedValue(null);
    const res = await PUT(
      makeEvent({ locals: { user }, body: { title: "Renamed" } }),
    );
    expect(res.status).toBe(404);
  });

  test("admin (non-owner) can rename someone else's conversation", async () => {
    const admin = { ...user, id: "admin-1", role: "admin" };
    getConversation.mockResolvedValue({
      id: "c1",
      userId: "someone-else",
      title: "Old",
    });
    updateConversation.mockResolvedValue({
      id: "c1",
      userId: "someone-else",
      title: "Renamed",
    });
    const res = await PUT(
      makeEvent({ locals: { user: admin }, body: { title: "Renamed" } }),
    );
    expect(res.status).toBe(200);
    expect(updateConversation).toHaveBeenCalledWith("c1", { title: "Renamed" });
  });
});
