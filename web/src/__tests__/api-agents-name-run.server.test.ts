/**
 * Server-handler unit tests for /api/agents/[name]/run (+server.ts).
 *
 * Handler drives `executor.runAgent(name, input, projectId?)` — we mock
 * the executor and the token-budget quota to avoid touching runtime
 * or PGlite. Covers the auth gate (401), daily-budget gate (429),
 * projectId UUID validation (400), unknown-agent rejection (400), and
 * the happy-path (200). The actual streaming path is out of scope.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const runAgent = vi.fn();

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
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: { name },
    request: new Request(href, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("POST /api/agents/[name]/run", () => {
  beforeEach(() => {
    runAgent.mockReset();
    vi.mocked(checkTokenBudget).mockReset();
    vi.mocked(checkTokenBudget).mockResolvedValue({ allowed: true } as any);
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
    expect(runAgent).toHaveBeenCalledWith(
      "test-agent",
      { foo: "bar" },
      projectId,
    );
  });
});
