/**
 * Server-handler unit tests for
 * /api/conversations/[id]/active-run (+server.ts).
 *
 * Covers:
 *  - GET/POST auth gate (requireAuth throws 401 Response)
 *  - POST action validation (400 "Unknown action")
 *  - POST no-active-run fallback (404 "No active run")
 *  - POST happy path (cancel memory run)
 *  - GET no-active-run (returns { runId: null })
 *
 * Mocks the runtime executor + bus + active-runs queries at the module
 * boundary — the handler is WIP-adjacent so we never exercise the real
 * query implementations.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const cancelRun = vi.fn();
const getActiveRunForConversation = vi.fn();
const getPendingPermissions = vi.fn(() => []);
const busEmit = vi.fn();

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({
    cancelRun,
    getActiveRunForConversation,
    getPendingPermissions,
  }),
  getBus: () => ({ emit: busEmit }),
}));

vi.mock("$server/db/queries/active-runs", () => ({
  getActiveRun: vi.fn(),
  markInterrupted: vi.fn(),
}));

const { getActiveRun, markInterrupted } = await import(
  "$server/db/queries/active-runs"
);
const { GET, POST } = await import(
  "../routes/api/conversations/[id]/active-run/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: string;
}) {
  const method = opts.method ?? "GET";
  return {
    url: new URL("http://localhost/api/conversations/c1/active-run"),
    locals: opts.locals ?? {},
    params: { id: "c1" },
    request: new Request("http://localhost/api/conversations/c1/active-run", {
      method,
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/conversations/[id]/active-run", () => {
  beforeEach(() => {
    cancelRun.mockReset();
    getActiveRunForConversation.mockReset();
    vi.mocked(getActiveRun).mockReset();
    vi.mocked(markInterrupted).mockReset();
    busEmit.mockReset();
    getPendingPermissions.mockReset();
    getPendingPermissions.mockReturnValue([]);
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

  test("returns { runId: null } when no in-memory or DB run exists", async () => {
    getActiveRunForConversation.mockReturnValue(null);
    vi.mocked(getActiveRun).mockResolvedValue(null as any);

    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: null };
    expect(body.runId).toBeNull();
  });
});

describe("POST /api/conversations/[id]/active-run", () => {
  beforeEach(() => {
    cancelRun.mockReset();
    getActiveRunForConversation.mockReset();
    vi.mocked(getActiveRun).mockReset();
    vi.mocked(markInterrupted).mockReset();
    busEmit.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ method: "POST", body: { action: "cancel" } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 400 on unknown action", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { action: "bogus" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Unknown action");
  });

  test("returns 404 when no in-memory or DB run exists", async () => {
    getActiveRunForConversation.mockReturnValue(null);
    vi.mocked(getActiveRun).mockResolvedValue(null as any);

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { action: "cancel" },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("No active run");
  });

  test("happy path: memory run present → cancels and reports path=memory", async () => {
    getActiveRunForConversation.mockReturnValue({ id: "run-1", startedAt: Date.now() });
    cancelRun.mockReturnValue(true);

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { action: "cancel" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelled: boolean; path: string };
    expect(body.cancelled).toBe(true);
    expect(body.path).toBe("memory");
    expect(cancelRun).toHaveBeenCalledWith("run-1");
  });
});
