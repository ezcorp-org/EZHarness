/**
 * IDOR regression for POST /api/conversations/+server.ts.
 *
 * Pre-fix the create handler forwarded body.parentConversationId straight
 * to createConversation without verifying the caller owned the referenced
 * parent — letting member B graft a conversation (with B-controlled title /
 * last-message preview) into member A's tree. The fix requires the caller
 * to own the parent (root walk) before insert; otherwise fail-closed 404.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/conversations", () => ({
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  searchConversations: vi.fn(),
}));
vi.mock("$server/db/queries/agent-configs", () => ({
  getAgentConfig: vi.fn(),
}));
vi.mock("$server/db/queries/modes", () => ({
  getMode: vi.fn(),
}));
vi.mock("$lib/server/conversation-ownership", () => ({
  resolveRootConversationForOwnership: vi.fn(),
}));

const { createConversation } = await import("$server/db/queries/conversations");
const { resolveRootConversationForOwnership } = await import(
  "$lib/server/conversation-ownership"
);
const { POST } = await import("../routes/api/conversations/+server");

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const PARENT_ID = "00000000-0000-4000-8000-0000000000aa";
const user = { id: "u-b", email: "b@x", name: "b", role: "member" };

function makeEvent(body: unknown, locals: Record<string, unknown> = { user }) {
  return {
    url: new URL("http://localhost/api/conversations"),
    locals,
    request: new Request("http://localhost/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as any;
}

describe("IDOR: POST /api/conversations parentConversationId ownership", () => {
  beforeEach(() => {
    vi.mocked(createConversation).mockReset();
    vi.mocked(resolveRootConversationForOwnership).mockReset();
  });

  test("parent not owned by caller → 404 and no conversation is created", async () => {
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue(null);

    const res = await POST(
      makeEvent({ projectId: PROJECT_ID, parentConversationId: PARENT_ID }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Parent conversation not found");
    expect(vi.mocked(resolveRootConversationForOwnership)).toHaveBeenCalledWith(
      PARENT_ID,
      user,
    );
    expect(vi.mocked(createConversation)).not.toHaveBeenCalled();
  });

  test("parent owned by caller → 201 and parentConversationId is forwarded", async () => {
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue({
      conv: {},
      root: {},
    } as any);
    vi.mocked(createConversation).mockResolvedValue({ id: "c-new" } as any);

    const res = await POST(
      makeEvent({ projectId: PROJECT_ID, parentConversationId: PARENT_ID }),
    );
    expect(res.status).toBe(201);
    const calledOpts = vi.mocked(createConversation).mock.calls[0]![1]!;
    expect(calledOpts.parentConversationId).toBe(PARENT_ID);
    expect(calledOpts.userId).toBe(user.id);
  });

  test("no parentConversationId → ownership check skipped, 201", async () => {
    vi.mocked(createConversation).mockResolvedValue({ id: "c-new" } as any);

    const res = await POST(makeEvent({ projectId: PROJECT_ID }));
    expect(res.status).toBe(201);
    expect(vi.mocked(resolveRootConversationForOwnership)).not.toHaveBeenCalled();
  });
});
