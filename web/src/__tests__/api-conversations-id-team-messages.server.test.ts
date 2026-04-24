/**
 * Server-handler unit tests for
 * /api/conversations/[id]/team/[agentConfigId]/messages (+server.ts).
 *
 * Covers auth (401), missing conv (404), ownership 404, missing team
 * config (404), and the empty-team happy path. Full happy path with
 * members hits many DB queries; we cover the ownership/validation
 * gates that are most likely to regress.
 *
 * Mocks conversations + agent-configs queries at the import boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const getSubConversations = vi.fn();
const getMessagesWithToolCalls = vi.fn();
const getAgentConfig = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  getSubConversations,
  getMessagesWithToolCalls,
}));

vi.mock("$server/db/queries/agent-configs", () => ({
  getAgentConfig,
}));

const { GET } = await import(
  "../routes/api/conversations/[id]/team/[agentConfigId]/messages/+server.ts"
);

function makeEvent(opts: { locals?: Record<string, unknown> }) {
  return {
    url: new URL(
      "http://localhost/api/conversations/c1/team/agent-cfg/messages",
    ),
    locals: opts.locals ?? {},
    params: { id: "c1", agentConfigId: "agent-cfg" },
    request: new Request(
      "http://localhost/api/conversations/c1/team/agent-cfg/messages",
    ),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/conversations/[id]/team/[agentConfigId]/messages", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getSubConversations.mockReset();
    getMessagesWithToolCalls.mockReset();
    getAgentConfig.mockReset();
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

  test("returns 404 when team config missing", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getAgentConfig.mockResolvedValue(null);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Team config not found");
  });

  test("happy path: empty team returns empty members + empty streams", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getAgentConfig.mockResolvedValue({
      id: "agent-cfg",
      name: "Empty Team",
      references: { members: [] },
    });

    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      team: { name: string; members: unknown[] };
      streams: unknown[];
    };
    expect(body.team.name).toBe("Empty Team");
    expect(body.team.members.length).toBe(0);
    expect(body.streams.length).toBe(0);
  });
});
