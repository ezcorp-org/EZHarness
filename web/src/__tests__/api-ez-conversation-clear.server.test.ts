/**
 * Phase 48 follow-up — DELETE /api/ez/conversation/messages
 *
 * "Clear conversation" handler for the Ez panel. The schema enforces one
 * Ez conversation per user, so this endpoint deletes every message on the
 * user's Ez conversation row while leaving the row itself in place — the
 * panel's existing SSE subscription and locked mode keep working
 * under the same conversation id.
 *
 * Mocks `getOrCreateEzConversation` and `deleteAllMessagesForConversation`
 * at the import boundary so vitest doesn't need PGlite. Other users'
 * messages are verified to be untouched implicitly: the handler only
 * passes the requesting user's resolved conversation id into the delete,
 * and the per-user `getOrCreateEzConversation` lookup guarantees that
 * conversation belongs to the caller (covered by the sibling integration
 * test `src/__tests__/ez-conversation-lookup.test.ts`).
 *
 * Covered:
 *   - 401 when unauthenticated (delegated to requireAuth)
 *   - DELETE wipes messages for the requesting user's Ez conversation,
 *     returns the same conversation id, and reports the deleted count
 *   - The conversation lookup is called with the authenticated user's id
 *     (ensuring no other user's row can be referenced)
 *   - DB failure paths (lookup vs delete) surface as 500 with descriptive
 *     errors, NOT crashes
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/conversations", () => ({
  getOrCreateEzConversation: vi.fn(),
  deleteAllMessagesForConversation: vi.fn(),
}));

const { getOrCreateEzConversation, deleteAllMessagesForConversation } = await import(
  "$server/db/queries/conversations"
);
const { DELETE } = await import("../routes/api/ez/conversation/messages/+server");

function makeEvent(opts: { locals?: Record<string, unknown> }) {
  return {
    url: new URL("http://localhost/api/ez/conversation/messages"),
    locals: opts.locals ?? {},
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    request: new Request("http://localhost/api/ez/conversation/messages", { method: "DELETE" }),
    params: {},
  } as any;
}

const user = { id: "u1", email: "u@x", name: "U", role: "member" };
const otherUser = { id: "u2", email: "v@x", name: "V", role: "member" };
const ezConvU1 = {
  id: "ez-conv-u1",
  userId: "u1",
  kind: "ez",
  modeId: "builtin-ez",
  title: "Ez",
  projectId: "global",
  createdAt: new Date("2026-04-01T00:00:00Z"),
  updatedAt: new Date("2026-04-02T00:00:00Z"),
};
const ezConvU2 = {
  ...ezConvU1,
  id: "ez-conv-u2",
  userId: "u2",
};

describe("DELETE /api/ez/conversation/messages", () => {
  beforeEach(() => {
    vi.mocked(getOrCreateEzConversation).mockReset();
    vi.mocked(deleteAllMessagesForConversation).mockReset();
  });

  test("unauthenticated → 401, no DB calls", async () => {
    const res = (await DELETE(makeEvent({}))) as Response;
    expect(res.status).toBe(401);
    expect(vi.mocked(getOrCreateEzConversation)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteAllMessagesForConversation)).not.toHaveBeenCalled();
  });

  test("happy path: clears messages, returns same conversationId + deleted count", async () => {
    vi.mocked(getOrCreateEzConversation).mockResolvedValue(ezConvU1 as any);
    // 3 messages were seeded — the delete helper returns the wipe count.
    vi.mocked(deleteAllMessagesForConversation).mockResolvedValue(3);

    const res = (await DELETE(makeEvent({ locals: { user } }))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; conversationId: string; deletedCount: number };
    expect(body.ok).toBe(true);
    // Same conversation id — the row is preserved, only messages emptied.
    expect(body.conversationId).toBe("ez-conv-u1");
    expect(body.deletedCount).toBe(3);

    // Conversation resolved by user.id (NOT by any client-supplied id), so
    // a caller cannot target another user's Ez conversation.
    expect(vi.mocked(getOrCreateEzConversation)).toHaveBeenCalledWith("u1");
    expect(vi.mocked(deleteAllMessagesForConversation)).toHaveBeenCalledWith("ez-conv-u1");
  });

  test("isolation: a different user resolves their own Ez conversation, not someone else's", async () => {
    // First request is u1 — resolves to ezConvU1.
    vi.mocked(getOrCreateEzConversation).mockImplementation(async (uid: string) => {
      if (uid === "u1") return ezConvU1 as any;
      if (uid === "u2") return ezConvU2 as any;
      throw new Error("unknown user");
    });
    vi.mocked(deleteAllMessagesForConversation).mockResolvedValue(0);

    const resA = (await DELETE(makeEvent({ locals: { user } }))) as Response;
    const bodyA = (await resA.json()) as { conversationId: string };
    expect(bodyA.conversationId).toBe("ez-conv-u1");
    expect(vi.mocked(deleteAllMessagesForConversation)).toHaveBeenLastCalledWith("ez-conv-u1");

    const resB = (await DELETE(makeEvent({ locals: { user: otherUser } }))) as Response;
    const bodyB = (await resB.json()) as { conversationId: string };
    expect(bodyB.conversationId).toBe("ez-conv-u2");
    expect(vi.mocked(deleteAllMessagesForConversation)).toHaveBeenLastCalledWith("ez-conv-u2");

    // The two calls touched different conversation ids — no cross-user
    // contamination is possible at this boundary.
    expect(bodyA.conversationId).not.toBe(bodyB.conversationId);
  });

  test("conversation lookup failure → 500 with actionable error, no delete attempted", async () => {
    vi.mocked(getOrCreateEzConversation).mockRejectedValue(new Error("DB down"));
    const res = (await DELETE(makeEvent({ locals: { user } }))) as Response;
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Ez conversation/i);
    expect(vi.mocked(deleteAllMessagesForConversation)).not.toHaveBeenCalled();
  });

  test("delete failure → 500, conversation id was resolved first", async () => {
    vi.mocked(getOrCreateEzConversation).mockResolvedValue(ezConvU1 as any);
    vi.mocked(deleteAllMessagesForConversation).mockRejectedValue(new Error("delete failed"));
    const res = (await DELETE(makeEvent({ locals: { user } }))) as Response;
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/clear/i);
    expect(vi.mocked(getOrCreateEzConversation)).toHaveBeenCalledWith("u1");
  });

  test("happy path with zero messages: deletedCount=0, still 200", async () => {
    // First-time clear on a brand-new Ez conversation that has no
    // messages yet should still be a success — the UI shouldn't have to
    // distinguish "had nothing to clear" from "cleared".
    vi.mocked(getOrCreateEzConversation).mockResolvedValue(ezConvU1 as any);
    vi.mocked(deleteAllMessagesForConversation).mockResolvedValue(0);

    const res = (await DELETE(makeEvent({ locals: { user } }))) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; deletedCount: number };
    expect(body.ok).toBe(true);
    expect(body.deletedCount).toBe(0);
  });
});
