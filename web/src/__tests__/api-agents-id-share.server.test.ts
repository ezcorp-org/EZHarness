/**
 * Server-handler unit tests for /api/agents/[id]/share/+server.ts.
 *
 * Covers the auth gate (401) plus — now with mocked DB + audit-log
 * queries — the ownership 404, the POST validation gates (invalid
 * permission value, missing teamIds/userIds), the POST happy path, the
 * DELETE validation gate (missing teamId/userId), and the DELETE
 * happy path.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/agent-configs", () => ({
  getAgentConfig: vi.fn(),
}));
vi.mock("$server/db/queries/agent-shares", () => ({
  shareAgent: vi.fn(async () => undefined),
  shareAgentWithUser: vi.fn(async () => undefined),
  unshareAgent: vi.fn(),
  unshareAgentFromUser: vi.fn(),
  getAgentShares: vi.fn(async () => []),
}));
vi.mock("$server/db/queries/teams", () => ({
  getTeamMembership: vi.fn(),
  // Handler now uses the batched form. Default impl walks each input
  // id and dispatches to the per-id mock so existing test setups that
  // call `vi.mocked(getTeamMembership).mockResolvedValue(...)` keep
  // working without any test-body changes.
  getTeamMembershipsByTeams: vi.fn(async (userId: string, teamIds: string[]) => {
    const mod = await import("$server/db/queries/teams");
    const result = new Map<string, unknown>();
    for (const id of teamIds) {
      const v = await (mod.getTeamMembership as any)(userId, id);
      result.set(id, v ?? null);
    }
    return result;
  }),
}));
vi.mock("$server/db/queries/users", () => ({
  getUserById: vi.fn(),
  getUsersByIds: vi.fn(async (ids: string[]) => {
    const mod = await import("$server/db/queries/users");
    const result = new Map<string, unknown>();
    for (const id of ids) {
      const v = await (mod.getUserById as any)(id);
      result.set(id, v ?? null);
    }
    return result;
  }),
}));
vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { getAgentConfig } = await import("$server/db/queries/agent-configs");
const { shareAgent, unshareAgent, getAgentShares } = await import(
  "$server/db/queries/agent-shares"
);
const { getTeamMembership } = await import("$server/db/queries/teams");
const { GET, POST, DELETE } = await import(
  "../routes/api/agents/[id]/share/+server"
);

function makeEvent(opts: {
  id?: string;
  body?: unknown;
  locals?: Record<string, unknown>;
}) {
  const id = opts.id ?? "agent-1";
  return {
    url: new URL(`http://localhost/api/agents/${id}/share`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/agents/${id}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const ownerUser = { id: "u1", email: "u@x", name: "u", role: "user" };
const ownedAgent = { id: "agent-1", name: "my-agent", userId: "u1" };

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

describe("GET /api/agents/[id]/share", () => {
  beforeEach(() => {
    vi.mocked(getAgentConfig).mockReset();
    vi.mocked(getAgentShares).mockReset();
    vi.mocked(getAgentShares).mockResolvedValue([] as any);
  });

  test("rejects 401 when no auth", async () => {
    await expectThrown(() => GET(makeEvent({})), 401);
  });

  test("returns 404 when agent is missing", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(undefined);
    const res = await GET(makeEvent({ locals: { user: ownerUser } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Agent not found");
  });

  test("returns 404 when caller is not owner nor admin", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue({
      ...ownedAgent,
      userId: "someone-else",
    } as any);
    const res = await GET(makeEvent({ locals: { user: ownerUser } }));
    expect(res.status).toBe(404);
  });

  test("returns shares list on happy path", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(ownedAgent as any);
    vi.mocked(getAgentShares).mockResolvedValue([
      { teamId: "t-1", permission: "read" },
    ] as any);
    const res = await GET(makeEvent({ locals: { user: ownerUser } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shares: unknown[] };
    expect(body.shares).toHaveLength(1);
  });
});

describe("POST /api/agents/[id]/share", () => {
  beforeEach(() => {
    vi.mocked(getAgentConfig).mockReset();
    vi.mocked(shareAgent).mockReset();
    vi.mocked(getTeamMembership).mockReset();
  });

  test("rejects 401 when no auth", async () => {
    await expectThrown(
      () => POST(makeEvent({ body: { teamIds: ["t1"], permission: "read" } })),
      401,
    );
  });

  test("returns 400 when permission is not 'read' or 'edit'", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(ownedAgent as any);
    const res = await POST(
      makeEvent({
        locals: { user: ownerUser },
        body: { teamIds: ["t1"], permission: "admin" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("permission must be 'read' or 'edit'");
  });

  test("returns 400 when neither teamIds nor userIds array provided", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(ownedAgent as any);
    const res = await POST(
      makeEvent({ locals: { user: ownerUser }, body: { permission: "read" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("teamIds or userIds array is required");
  });

  test("returns 403 when non-admin lacks team membership", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(ownedAgent as any);
    vi.mocked(getTeamMembership).mockResolvedValue(null as any);
    const res = await POST(
      makeEvent({
        locals: { user: ownerUser },
        body: { teamIds: ["t1"], permission: "read" },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Insufficient permissions for team t1");
  });

  test("shares with team on happy path", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(ownedAgent as any);
    vi.mocked(getTeamMembership).mockResolvedValue({
      userId: "u1",
      teamId: "t1",
      role: "editor",
    } as any);
    const res = await POST(
      makeEvent({
        locals: { user: ownerUser },
        body: { teamIds: ["t1"], permission: "edit" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(shareAgent).toHaveBeenCalledWith("agent-1", "t1", "u1", "edit");
  });
});

describe("DELETE /api/agents/[id]/share", () => {
  beforeEach(() => {
    vi.mocked(getAgentConfig).mockReset();
    vi.mocked(unshareAgent).mockReset();
  });

  test("rejects 401 when no auth", async () => {
    await expectThrown(
      () => DELETE(makeEvent({ body: { teamId: "t1" } })),
      401,
    );
  });

  test("returns 400 when neither teamId nor userId provided", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(ownedAgent as any);
    const res = await DELETE(
      makeEvent({ locals: { user: ownerUser }, body: {} }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("teamId or userId is required");
  });

  test("unshares from team on happy path and reports removed=true", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(ownedAgent as any);
    vi.mocked(unshareAgent).mockResolvedValue(true as any);
    const res = await DELETE(
      makeEvent({
        locals: { user: ownerUser },
        body: { teamId: "t1" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; removed: boolean };
    expect(body.ok).toBe(true);
    expect(body.removed).toBe(true);
    expect(unshareAgent).toHaveBeenCalledWith("agent-1", "t1");
  });

  test("returns removed=false when unshare reports no rows removed", async () => {
    vi.mocked(getAgentConfig).mockResolvedValue(ownedAgent as any);
    vi.mocked(unshareAgent).mockResolvedValue(false as any);
    const res = await DELETE(
      makeEvent({
        locals: { user: ownerUser },
        body: { teamId: "t1" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean };
    expect(body.removed).toBe(false);
  });
});
