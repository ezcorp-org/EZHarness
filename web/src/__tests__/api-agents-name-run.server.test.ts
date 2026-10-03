/**
 * Server-handler unit tests for /api/agents/[name]/run (+server.ts).
 *
 * Handler drives `executor.runAgent(name, input, projectId?)` — we mock
 * the executor and the token-budget quota to avoid touching runtime
 * or PGlite. Covers the auth gate (401), daily-budget gate (429),
 * UUID and Incus project validation, project membership and API scopes,
 * unknown-agent rejection (400), and the happy-path (200). The actual streaming path is out of scope.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const runAgent = vi.fn();

const getProjectMembership = vi.fn(async () => ({ role: "member" }));
vi.mock("$server/db/queries/project-members", () => ({ getProjectMembership }));
beforeEach(() => { getProjectMembership.mockReset(); getProjectMembership.mockResolvedValue({ role: "member" }); });

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({ runAgent }),
}));

vi.mock("$lib/server/security/resource-quotas", () => ({
  checkTokenBudget: vi.fn(),
}));

const { checkTokenBudget } = await import(
  "$lib/server/security/resource-quotas"
);
const { POST } = await import("../routes/api/agents/[name]/run/+server.ts");

function makeEvent(opts: {
  name?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const name = opts.name ?? "test-agent";
  const href = `http://localhost/api/agents/${name}/run`;
  return makeRequestEvent(href, {
    locals: opts.locals ?? {},
    params: { name },
    request: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  });
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("POST /api/agents/[name]/run", () => {
  beforeEach(() => {
    runAgent.mockReset();
    vi.mocked(checkTokenBudget).mockReset();
    vi.mocked(checkTokenBudget).mockResolvedValue({ allowed: true } as any);
  });

  test("refuses a foreign Incus project before starting an agent", async () => {
    const projectId = `incus-project-${"a".repeat(48)}`;
    getProjectMembership.mockResolvedValueOnce(undefined as any);
    const result = await POST(makeEvent({ locals: { user }, body: { projectId } }));
    expect(result.status).toBe(403);
    expect(getProjectMembership).toHaveBeenCalledWith(user.id, projectId);
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("refuses a key without chat scope before budget or agent work", async () => {
    const result = await POST(makeEvent({ locals: { user, apiKeyScopes: ["read"] }, body: {} }));
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "Insufficient scope", required: "chat" });
    expect(checkTokenBudget).not.toHaveBeenCalled();
    expect(getProjectMembership).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  test("runs an Incus project only after membership approval and preserves the initiating owner", async () => {
    const projectId = `incus-project-${"b".repeat(48)}`;
    runAgent.mockResolvedValueOnce({ id: "incus-run" });
    const result = await POST(makeEvent({ locals: { user }, body: { projectId, task: "Inspect guest" } }));
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ id: "incus-run" });
    expect(getProjectMembership).toHaveBeenCalledWith(user.id, projectId);
    expect(runAgent).toHaveBeenCalledWith("test-agent", { task: "Inspect guest" }, projectId, user.id);
    expect(getProjectMembership.mock.invocationCallOrder[0]).toBeLessThan(runAgent.mock.invocationCallOrder[0]!);
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ locals: {}, body: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 429 when daily token budget is exceeded", async () => {
    vi.mocked(checkTokenBudget).mockResolvedValue({
      allowed: false,
      resetsAt: "2026-04-24T00:00:00Z",
    } as any);
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error?: string;
      resetsAt?: string;
    };
    expect(body.error).toBe("Daily token budget exceeded");
    expect(body.resetsAt).toBe("2026-04-24T00:00:00Z");
  });

  test("rejects 400 when projectId is not a valid UUID", async () => {
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { projectId: "not-a-uuid" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Validation failed");
  });

  test("returns 400 with executor error message when agent is unknown", async () => {
    runAgent.mockRejectedValue(new Error("Agent not found: test-agent"));
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Agent not found: test-agent");
  });

  test("happy path: passes input + projectId to executor and returns run JSON", async () => {
    runAgent.mockResolvedValue({ id: "run-1", agentName: "test-agent" });
    const projectId = "11111111-1111-4111-8111-111111111111";
    const res = await POST(
      makeEvent({
        locals: { user },
        body: { projectId, foo: "bar" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("run-1");
    // Run-ownership: the initiating user's id is threaded so they can later
    // read/cancel their own agent run via /api/runs/[id] (else it inserts
    // user_id=NULL and is admin-only / fail-closed).
    expect(runAgent).toHaveBeenCalledWith(
      "test-agent",
      { foo: "bar" },
      projectId,
      user.id,
    );
  });
});
