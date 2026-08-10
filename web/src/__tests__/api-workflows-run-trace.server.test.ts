/**
 * Server-handler unit tests for the two run-read routes:
 *   GET /api/workflows/runs
 *   GET /api/workflows/runs/[id]
 *
 * Boundary-only by design — ownership scoping and the payload shape live
 * behind `workflow-run-trace`, which has its own DB-backed suite. What is
 * verifiable HERE, and only here, is what the routes themselves decide:
 * the scope gate, the query-parameter validation, and the identity they
 * forward.
 *
 * The admin flag is the sharpest of those. It is derived in the route, so
 * a handler that hard-coded `isAdmin: true` would pass every test in the
 * trace module's suite and quietly hand every member every other user's
 * `resolved_input`.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectThrownResponse } from "./helpers/server-route-test-utils";

const trace = vi.hoisted(() => ({
  getWorkflowRunTrace: vi.fn(),
  listWorkflowRunsForCaller: vi.fn(),
}));
// Spread the REAL module and override only the two DB-backed readers. The
// constants (`RUN_PAGE_MAX`, `RUN_STATUS_FILTERS`) come through untouched,
// so this double cannot drift from the vocabulary the route validates
// against — a re-declared copy here would let the route accept a status
// the real surface rejects, and the test would still pass.
vi.mock("$server/runtime/workflow-run-trace", async (importActual) => ({
  ...(await importActual<typeof import("$server/runtime/workflow-run-trace")>()),
  getWorkflowRunTrace: trace.getWorkflowRunTrace,
  listWorkflowRunsForCaller: trace.listWorkflowRunsForCaller,
}));

const { GET: LIST } = await import("../routes/api/workflows/runs/+server");
const { GET: ONE } = await import("../routes/api/workflows/runs/[id]/+server");

const SAMPLE_TRACE = {
  run: { id: "r1", workflowName: "nightly", status: "success" },
  steps: [{ stepName: "draft", model: "claude-opus-5", inputTokens: 10, iterationRows: [] }],
  totals: { inputTokens: 10, outputTokens: 2, durationMs: 5, steps: 1 },
};

beforeEach(() => {
  trace.getWorkflowRunTrace.mockReset().mockResolvedValue(SAMPLE_TRACE);
  trace.listWorkflowRunsForCaller.mockReset().mockResolvedValue({ runs: [] });
});

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };
const authedAdmin = { user: { id: "a1", email: "a@x", name: "a", role: "admin" } };

function listEvent(query = "", locals: Record<string, unknown> = authedUser) {
  const url = new URL(`http://localhost/api/workflows/runs${query}`);
  return { url, locals, params: {}, request: new Request(url) } as never;
}

function oneEvent(id = "r1", locals: Record<string, unknown> = authedUser) {
  const url = new URL(`http://localhost/api/workflows/runs/${id}`);
  return { url, locals, params: { id }, request: new Request(url) } as never;
}

describe("gates", () => {
  test.each([
    ["list", () => LIST(listEvent("", { ...authedUser, apiKeyScopes: ["chat"] }))],
    ["one", () => ONE(oneEvent("r1", { ...authedUser, apiKeyScopes: ["chat"] }))],
  ])("%s: 403 when the API key lacks 'read'", async (_label, call) => {
    const res = await call();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { required?: string }).required).toBe("read");
    // Refused BEFORE any read happened.
    expect(trace.getWorkflowRunTrace).not.toHaveBeenCalled();
    expect(trace.listWorkflowRunsForCaller).not.toHaveBeenCalled();
  });

  test.each([
    ["list", () => LIST(listEvent("", {}))],
    ["one", () => ONE(oneEvent("r1", {}))],
  ])("%s: 401 when unauthenticated, and nothing is read", async (_label, call) => {
    await expectThrownResponse(call, 401);
    expect(trace.getWorkflowRunTrace).not.toHaveBeenCalled();
    expect(trace.listWorkflowRunsForCaller).not.toHaveBeenCalled();
  });
});

describe("GET /api/workflows/runs/[id]", () => {
  test("forwards the caller's id and a FALSE admin flag for a member", async () => {
    await ONE(oneEvent("r9", authedUser));
    expect(trace.getWorkflowRunTrace).toHaveBeenCalledWith("r9", {
      userId: "u1",
      isAdmin: false,
    });
  });

  test("derives isAdmin from the role", async () => {
    await ONE(oneEvent("r9", authedAdmin));
    expect(trace.getWorkflowRunTrace).toHaveBeenCalledWith("r9", {
      userId: "a1",
      isAdmin: true,
    });
  });

  test("returns the trace BODY, not merely a 200", async () => {
    const res = await ONE(oneEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof SAMPLE_TRACE;
    expect(body.run.id).toBe("r1");
    expect(body.steps[0]!.model).toBe("claude-opus-5");
    expect(body.totals.inputTokens).toBe(10);
  });

  test("an unreadable run is 404 with a message that reveals nothing", async () => {
    // Not 403. A 403 would confirm the run exists, and the trace module
    // returns `undefined` for both "absent" and "not yours" precisely so
    // this route cannot tell them apart even by accident.
    trace.getWorkflowRunTrace.mockResolvedValue(undefined);
    const res = await ONE(oneEvent("someone-elses-run"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
    expect(body.error).not.toContain("someone-elses-run");
    expect(body.error).not.toMatch(/permission|forbidden|allowed/i);
  });
});

describe("GET /api/workflows/runs — query validation", () => {
  test("forwards the caller's identity, admin flag derived", async () => {
    await LIST(listEvent("", authedAdmin));
    expect(trace.listWorkflowRunsForCaller).toHaveBeenCalledWith(
      {},
      { userId: "a1", isAdmin: true },
    );
  });

  test("passes every supported filter through", async () => {
    await LIST(
      listEvent(
        "?workflowName=nightly&status=error&projectId=p1" +
          "&since=2026-01-01T00:00:00.000Z&until=2026-02-01T00:00:00.000Z&limit=25",
      ),
    );
    expect(trace.listWorkflowRunsForCaller).toHaveBeenCalledWith(
      {
        workflowName: "nightly",
        status: "error",
        projectId: "p1",
        since: new Date("2026-01-01T00:00:00.000Z"),
        until: new Date("2026-02-01T00:00:00.000Z"),
        limit: 25,
      },
      { userId: "u1", isAdmin: false },
    );
  });

  test("returns the page BODY including its cursor", async () => {
    trace.listWorkflowRunsForCaller.mockResolvedValue({
      runs: [{ id: "r1", workflowName: "nightly", status: "success" }],
      nextCursor: { startedAt: "2026-01-01T00:00:00.000Z", id: "r1" },
    });
    const res = await LIST(listEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[]; nextCursor?: { id: string } };
    expect(body.runs).toHaveLength(1);
    expect(body.nextCursor?.id).toBe("r1");
  });

  test("rejects an unknown status rather than ignoring it", async () => {
    // Silently dropping it would widen the result set past what the
    // caller asked for, which is the wrong direction to be wrong in.
    const res = await LIST(listEvent("?status=definitely-not-a-status"));
    expect(res.status).toBe(400);
    expect(trace.listWorkflowRunsForCaller).not.toHaveBeenCalled();
  });

  test.each([["since"], ["until"], ["cursorStartedAt"]])(
    "rejects an unparseable %s",
    async (field) => {
      const res = await LIST(listEvent(`?${field}=not-a-date`));
      expect(res.status).toBe(400);
      expect(trace.listWorkflowRunsForCaller).not.toHaveBeenCalled();
    },
  );

  test.each([["0"], ["201"], ["-5"], ["1.5"], ["abc"]])(
    "rejects limit=%s",
    async (limit) => {
      const res = await LIST(listEvent(`?limit=${limit}`));
      expect(res.status).toBe(400);
      expect(trace.listWorkflowRunsForCaller).not.toHaveBeenCalled();
    },
  );

  test("accepts a complete cursor", async () => {
    await LIST(listEvent("?cursorStartedAt=2026-01-01T00:00:00.000Z&cursorId=r7"));
    expect(trace.listWorkflowRunsForCaller).toHaveBeenCalledWith(
      { cursor: { startedAt: new Date("2026-01-01T00:00:00.000Z"), id: "r7" } },
      { userId: "u1", isAdmin: false },
    );
  });

  test.each([
    ["?cursorStartedAt=2026-01-01T00:00:00.000Z", "without cursorId"],
    ["?cursorId=r7", "without cursorStartedAt"],
  ])("rejects a half cursor %s (%s)", async (query) => {
    // Half a cursor cannot disambiguate two runs that started in the same
    // millisecond, so honouring it would silently drop or repeat one.
    const res = await LIST(listEvent(query));
    expect(res.status).toBe(400);
    expect(trace.listWorkflowRunsForCaller).not.toHaveBeenCalled();
  });
});
