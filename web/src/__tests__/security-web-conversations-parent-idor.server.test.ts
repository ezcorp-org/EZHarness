/**
 * IDOR regressions for POST /api/conversations/+server.ts — the two
 * caller-supplied ids this handler resolves before it inserts.
 *
 * `parentConversationId`: pre-fix the create handler forwarded it straight
 * to createConversation without verifying the caller owned the referenced
 * parent — letting member B graft a conversation (with B-controlled title /
 * last-message preview) into member A's tree. The fix requires the caller
 * to own the parent (root walk) before insert; otherwise fail-closed 404.
 *
 * `modeId`: the handler validated it and then built the create opts WITHOUT
 * it, so naming another user's private mode was a no-op. Persisting it (the
 * point of that fix) makes the id live, so the same fail-closed 404 applies.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/conversations", () => ({
  createConversation: vi.fn(),
  listConversations: vi.fn(),
  searchConversations: vi.fn(),
}));
vi.mock("$server/db/queries/agent-configs", () => ({
  getAgentConfig: vi.fn(),
}));
vi.mock("$server/db/queries/modes", () => ({
  getVisibleMode: vi.fn(),
}));
vi.mock("$lib/server/conversation-ownership", () => ({
  resolveRootConversationForOwnership: vi.fn(),
}));

const { createConversation } = await import("$server/db/queries/conversations");
const { getVisibleMode } = await import("$server/db/queries/modes");
const { resolveRootConversationForOwnership } = await import(
  "$lib/server/conversation-ownership"
);
const { POST } = await import("../routes/api/conversations/+server");

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const PARENT_ID = "00000000-0000-4000-8000-0000000000aa";
const user = { id: "u-b", email: "b@x", name: "b", role: "member" };

function makeEvent(body: unknown, locals: Record<string, unknown> = { user }) {
  return makeRequestEvent("http://localhost/api/conversations", {
    locals,
    request: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  });
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

describe("IDOR: POST /api/conversations modeId ownership", () => {
  // Sibling of the parent guard above, and newly load-bearing: this route
  // validated `modeId` and then dropped it, so naming another user's private
  // mode was inert. Now that the create PERSISTS it, the create could adopt a
  // mode the caller cannot even list.
  //
  // The visibility RULE itself (builtin / own / orphaned / foreign) belongs to
  // `getVisibleMode` and is pinned against a real database in
  // `src/__tests__/modes.test.ts`. What is asserted HERE is the route's half:
  // that it asks with the CALLER's id, and what it does with each answer.
  const MODE_ID = "00000000-0000-4000-8000-00000000aaaa";

  beforeEach(() => {
    vi.mocked(createConversation).mockReset();
    vi.mocked(getVisibleMode).mockReset();
    vi.mocked(resolveRootConversationForOwnership).mockReset();
  });

  test("a mode the caller cannot see → 404 and no conversation is created", async () => {
    vi.mocked(getVisibleMode).mockResolvedValue(null);

    const res = await POST(makeEvent({ projectId: PROJECT_ID, modeId: MODE_ID }));
    expect(res.status).toBe(404);
    // 404, not 403 — the endpoint must not answer "this mode id exists".
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Mode not found");
    expect(vi.mocked(createConversation)).not.toHaveBeenCalled();
    // Asked on behalf of the CALLER. A regression that passed a constant, or
    // the owner of the mode, would still return null here and look fine.
    expect(vi.mocked(getVisibleMode)).toHaveBeenCalledWith(MODE_ID, user.id);
  });

  test("a visible mode is accepted and forwarded to the create", async () => {
    vi.mocked(getVisibleMode).mockResolvedValue({
      id: MODE_ID,
      slug: "mine",
      name: "Mine",
      builtin: false,
      userId: user.id,
    } as any);
    vi.mocked(createConversation).mockResolvedValue({ id: "c-new" } as any);

    const res = await POST(makeEvent({ projectId: PROJECT_ID, modeId: MODE_ID }));
    expect(res.status).toBe(201);
    expect(vi.mocked(createConversation).mock.calls[0]![1]!.modeId).toBe(MODE_ID);
    expect(vi.mocked(getVisibleMode)).toHaveBeenCalledWith(MODE_ID, user.id);
  });

  test("no modeId → the mode gate is never consulted", async () => {
    vi.mocked(createConversation).mockResolvedValue({ id: "c-new" } as any);

    const res = await POST(makeEvent({ projectId: PROJECT_ID }));
    expect(res.status).toBe(201);
    expect(vi.mocked(getVisibleMode)).not.toHaveBeenCalled();
  });
});
