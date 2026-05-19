/**
 * Server-handler unit tests for /api/agents/[name]/test-conversations
 * (+server.ts).
 *
 * Covers GET/DELETE auth gate (401), missing-agent 404 via
 * getAgentConfigByName, and the happy paths with mocked DB queries.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/agent-configs", () => ({
  getAgentConfigByName: vi.fn(),
}));

vi.mock("$server/db/queries/conversations", () => ({
  getTestConversations: vi.fn(),
  deleteTestConversations: vi.fn(),
}));

const { getAgentConfigByName } = await import(
  "$server/db/queries/agent-configs"
);
const { getTestConversations, deleteTestConversations } = await import(
  "$server/db/queries/conversations"
);
const { GET, DELETE } = await import(
  "../routes/api/agents/[name]/test-conversations/+server.ts"
);

function makeEvent(opts: {
  name?: string;
  locals?: Record<string, unknown>;
}) {
  const name = opts.name ?? "test-agent";
  const href = `http://localhost/api/agents/${name}/test-conversations`;
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: { name },
    request: new Request(href),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

async function expectThrown(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  let res: Response | undefined;
  try {
    res = await fn();
    if (!res || res.status !== status) expect.fail("expected thrown Response");
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  expect(res!.status).toBe(status);
  return res!;
}

describe("GET /api/agents/[name]/test-conversations", () => {
  beforeEach(() => {
    vi.mocked(getAgentConfigByName).mockReset();
    vi.mocked(getTestConversations).mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    await expectThrown(() => GET(makeEvent({ locals: {} })), 401);
  });

  test("returns 404 when agent-config not found", async () => {
    vi.mocked(getAgentConfigByName).mockResolvedValue(undefined);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Agent not found");
  });

  test("returns list of test conversations on happy path", async () => {
    vi.mocked(getAgentConfigByName).mockResolvedValue({
      id: "cfg-1",
      name: "test-agent",
    } as any);
    vi.mocked(getTestConversations).mockResolvedValue([
      { id: "c-1", title: "t1" },
      { id: "c-2", title: "t2" },
    ] as any);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body).toHaveLength(2);
    expect(getTestConversations).toHaveBeenCalledWith("cfg-1");
  });
});

describe("DELETE /api/agents/[name]/test-conversations", () => {
  beforeEach(() => {
    vi.mocked(getAgentConfigByName).mockReset();
    vi.mocked(deleteTestConversations).mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    await expectThrown(() => DELETE(makeEvent({ locals: {} })), 401);
  });

  test("returns 404 when agent-config not found", async () => {
    vi.mocked(getAgentConfigByName).mockResolvedValue(undefined);
    const res = await DELETE(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Agent not found");
  });

  test("returns deleted count on happy path", async () => {
    vi.mocked(getAgentConfigByName).mockResolvedValue({
      id: "cfg-1",
      name: "test-agent",
    } as any);
    vi.mocked(deleteTestConversations).mockResolvedValue(3 as any);
    const res = await DELETE(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number };
    expect(body.deleted).toBe(3);
    expect(deleteTestConversations).toHaveBeenCalledWith("cfg-1");
  });
});
