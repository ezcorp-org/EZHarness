/**
 * Server-handler unit tests for
 * /api/conversations/[id]/team/[agentConfigId]/messages (+server.ts).
 *
 * Covers auth (401), missing conv (404), ownership 404, missing team
 * config (404), the empty-team happy path, and the member-stream
 * assembly (orchestrator vs. parent sub-conversations, name fallbacks).
 *
 * Mocks conversations + agent-configs queries at the import boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

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
  return makeRequestEvent("http://localhost/api/conversations/c1/team/agent-cfg/messages", {
    locals: opts.locals ?? {},
    params: { id: "c1", agentConfigId: "agent-cfg" },
  });
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

  const msg = (id: string, toolName?: string) => ({
    id,
    role: "assistant",
    content: `content ${id}`,
    createdAt: "2026-10-13T00:00:00Z",
    toolCalls: toolName
      ? [{ id: `tc-${id}`, toolName, input: { q: 1 }, outputSummary: "ok", success: true, durationMs: 5, status: "done", extra: "dropped" }]
      : [],
  });

  test("assembles member streams from orchestrator and parent sub-conversations", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    const configs: Record<string, { name: string; references?: unknown }> = {
      "agent-cfg": { name: "Squad", references: { members: [{ agentConfigId: "m1" }, { agentConfigId: "m2" }, { agentConfigId: "m3" }, { agentConfigId: "m4" }] } },
      m1: { name: "Planner" },
      m3: { name: "Idle" },
    };
    getAgentConfig.mockImplementation(async (id: string) => configs[id] ?? null);
    getSubConversations.mockImplementation(async (parentId: string) =>
      parentId === "c1"
        ? [
            { id: "orch", agentConfigId: "agent-cfg", title: "Orchestrator" },
            // A direct child of the parent for m1 loses to the orchestrator's child.
            { id: "m1-direct", agentConfigId: "m1", title: "stale" },
            { id: "m2-direct", agentConfigId: "m2", title: "Coder thread" },
            { id: "loose", agentConfigId: null, title: "no agent" },
          ]
        : [{ id: "m1-sub", agentConfigId: "m1", title: "Planner thread" }],
    );
    getMessagesWithToolCalls.mockImplementation(async (convId: string) => ({
      messages: [msg(`${convId}-a`, convId === "m1-sub" ? "read_file" : undefined)],
    }));

    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.team).toEqual({
      name: "Squad",
      members: [
        { agentConfigId: "m1", agentName: "Planner" },
        { agentConfigId: "m2", agentName: "Unknown" },
        { agentConfigId: "m3", agentName: "Idle" },
        { agentConfigId: "m4", agentName: "Unknown" },
      ],
    });
    expect(body.orchestrator).toEqual({
      agentConfigId: "agent-cfg",
      agentName: "Squad (orchestrator)",
      subConversationId: "orch",
      messages: [{ id: "orch-a", role: "assistant", content: "content orch-a", createdAt: "2026-10-13T00:00:00Z", toolCalls: [] }],
    });
    const [m1, m2, m3, m4] = body.streams;
    expect(m1.subConversationId).toBe("m1-sub");
    expect(m1.agentName).toBe("Planner");
    expect(m1.messages[0].toolCalls).toEqual([
      { id: "tc-m1-sub-a", toolName: "read_file", input: { q: 1 }, outputSummary: "ok", success: true, durationMs: 5, status: "done" },
    ]);
    // No config: the stream name falls back to the sub-conversation title.
    expect(m2).toMatchObject({ subConversationId: "m2-direct", agentName: "Coder thread" });
    // No sub-conversation: an empty stream keeps the configured name.
    expect(m3).toEqual({ agentConfigId: "m3", agentName: "Idle", subConversationId: null, messages: [] });
    expect(m4).toEqual({ agentConfigId: "m4", agentName: "Unknown", subConversationId: null, messages: [] });
  });

  test("without an orchestrator conversation, members resolve from the parent only", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getAgentConfig.mockImplementation(async (id: string) =>
      id === "agent-cfg" ? { name: "Squad", references: { members: [{ agentConfigId: "m1" }] } } : null,
    );
    getSubConversations.mockResolvedValue([{ id: "m1-direct", agentConfigId: "m1", title: null }]);
    getMessagesWithToolCalls.mockResolvedValue({ messages: [] });

    const res = await GET(makeEvent({ locals: { user } }));
    const body = await res.json();

    expect(body.orchestrator).toBeNull();
    expect(getSubConversations).toHaveBeenCalledTimes(1);
    expect(body.streams).toEqual([
      { agentConfigId: "m1", agentName: "Unknown", subConversationId: "m1-direct", messages: [] },
    ]);
  });
});
