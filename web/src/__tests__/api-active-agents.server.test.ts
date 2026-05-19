/**
 * Server-handler unit tests for /api/active-agents (+server.ts).
 *
 * Covers the auth gate (requireAuth throws 401) and the happy path that
 * composes executor.listActiveAgentRuns() with getConversation(). Both
 * the executor and the DB query are mocked so we stay off the runtime
 * and PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const listActiveAgentRuns = vi.fn();

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({ listActiveAgentRuns }),
}));

vi.mock("$server/db/queries/conversations", () => ({
  getConversation: vi.fn(),
}));

const { getConversation } = await import("$server/db/queries/conversations");
const { GET } = await import("../routes/api/active-agents/+server.ts");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  href?: string;
}) {
  const href = opts.href ?? "http://localhost/api/active-agents";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/active-agents", () => {
  beforeEach(() => {
    listActiveAgentRuns.mockReset();
    vi.mocked(getConversation).mockReset();
  });

  test("rejects unauthenticated request with 401", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns empty array when executor reports no active runs", async () => {
    listActiveAgentRuns.mockReturnValue([]);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  test("returns active run rows joined with conversation metadata", async () => {
    listActiveAgentRuns.mockReturnValue([
      {
        run: { id: "run-1", agentName: "a1", startedAt: 123, projectId: null },
        conversationId: "c-1",
      },
    ]);
    vi.mocked(getConversation).mockResolvedValue({
      id: "c-1",
      title: "Hello",
      parentConversationId: null,
      projectId: null,
    } as any);

    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ runId: string; conversationId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe("run-1");
    expect(body[0].conversationId).toBe("c-1");
  });

  test("filters out rows whose conversation does not match requested projectId", async () => {
    listActiveAgentRuns.mockReturnValue([
      {
        run: { id: "run-1", agentName: "a1", startedAt: 1, projectId: "p-a" },
        conversationId: "c-1",
      },
    ]);
    vi.mocked(getConversation).mockResolvedValue({
      id: "c-1",
      projectId: "p-b",
    } as any);

    const res = await GET(
      makeEvent({
        locals: { user },
        href: "http://localhost/api/active-agents?projectId=p-a",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });
});
