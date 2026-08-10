/**
 * Server-handler unit tests for the two operator-control routes:
 *   POST /api/workflows/runs/[id]/resume
 *   POST /api/workflows/runs/[id]/cancel
 *
 * The routes are boundary-only by design — ownership, run state and the
 * consent guard all live behind `workflow-run-control`, which has its own
 * DB-backed suite. What is verifiable HERE, and only here, is the mapping:
 * every typed refusal code reaches HTTP as the right status, and the
 * handler forwards the caller's identity rather than inventing one.
 *
 * The admin flag is the sharpest of those: it is derived in the route, so
 * a route that hard-coded `isAdmin: true` would pass every test in the
 * control module's suite and quietly hand every member admin reach.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectThrownResponse, makeRequestEvent } from "./helpers/server-route-test-utils";

const ctl = vi.hoisted(() => ({
  resumeParkedRun: vi.fn(),
  cancelParkedRun: vi.fn(),
}));
vi.mock("$server/runtime/workflow-run-control", () => ({
  resumeParkedRun: ctl.resumeParkedRun,
  cancelParkedRun: ctl.cancelParkedRun,
}));

const { POST: RESUME } = await import("../routes/api/workflows/runs/[id]/resume/+server");
const { POST: CANCEL } = await import("../routes/api/workflows/runs/[id]/cancel/+server");

beforeEach(() => {
  ctl.resumeParkedRun.mockReset().mockResolvedValue({ ok: true, run: { id: "r1" } });
  ctl.cancelParkedRun.mockReset().mockResolvedValue({ ok: true, cancelled: true });
});

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };
const authedAdmin = { user: { id: "a1", email: "a@x", name: "a", role: "admin" } };

function makeEvent(kind: "resume" | "cancel", opts: { id?: string; locals?: Record<string, unknown> }) {
  const id = opts.id ?? "r1";
  return makeRequestEvent(`http://localhost/api/workflows/runs/${id}/${kind}`, {
    locals: opts.locals ?? {},
    params: { id },
    request: { method: "POST" },
  });
}

describe.each([
  ["resume", RESUME, () => ctl.resumeParkedRun] as const,
  ["cancel", CANCEL, () => ctl.cancelParkedRun] as const,
])("POST /api/workflows/runs/[id]/%s — gates", (kind, handler, spy) => {
  test("403 when the API key lacks 'chat'", async () => {
    const res = await handler(
      makeEvent(kind as "resume" | "cancel", {
        locals: { ...authedUser, apiKeyScopes: ["read"] },
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { required?: string }).required).toBe("chat");
    // Refused BEFORE any control logic ran — a scope check that let the
    // action happen and then reported 403 would be no check at all.
    expect(spy()).not.toHaveBeenCalled();
  });

  test("401 when unauthenticated, and nothing is attempted", async () => {
    await expectThrownResponse(() => handler(makeEvent(kind as "resume" | "cancel", {})), 401);
    expect(spy()).not.toHaveBeenCalled();
  });

  test("forwards the caller's id and a FALSE admin flag for a normal member", async () => {
    await handler(makeEvent(kind as "resume" | "cancel", { locals: authedUser }));
    expect(spy()).toHaveBeenCalledWith("r1", { userId: "u1", isAdmin: false });
  });

  test("derives isAdmin from the role, so an admin gets admin reach", async () => {
    await handler(makeEvent(kind as "resume" | "cancel", { locals: authedAdmin }));
    expect(spy()).toHaveBeenCalledWith("r1", { userId: "a1", isAdmin: true });
  });
});

describe("POST /api/workflows/runs/[id]/resume — refusal mapping", () => {
  test.each([
    ["not-found", 404],
    ["forbidden", 403],
    ["not-resumable", 409],
    ["run-unavailable", 409],
    // The run did not continue: 409, never a 200 carrying a dead run.
    ["resume-failed", 409],
  ])("%s maps to %i", async (code, status) => {
    ctl.resumeParkedRun.mockResolvedValue({ ok: false, code, message: `refused: ${code}` });
    const res = await RESUME(makeEvent("resume", { locals: authedUser }));
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error?: string }).error).toBe(`refused: ${code}`);
  });

  test("an unmapped code degrades to 400 rather than reporting success", async () => {
    ctl.resumeParkedRun.mockResolvedValue({ ok: false, code: "brand-new", message: "nope" });
    expect((await RESUME(makeEvent("resume", { locals: authedUser }))).status).toBe(400);
  });

  test("success returns the run", async () => {
    ctl.resumeParkedRun.mockResolvedValue({ ok: true, run: { id: "r1", status: "success" } });
    const res = await RESUME(makeEvent("resume", { locals: authedUser }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { run?: { id: string } }).toMatchObject({ run: { id: "r1" } });
  });
});

describe("POST /api/workflows/runs/[id]/cancel — refusal mapping", () => {
  test.each([
    ["not-found", 404],
    ["forbidden", 403],
    // A double-cancel is a clean 409, not an overwrite of whatever really
    // finished the run.
    ["already-terminal", 409],
  ])("%s maps to %i", async (code, status) => {
    ctl.cancelParkedRun.mockResolvedValue({ ok: false, code, message: `refused: ${code}` });
    const res = await CANCEL(makeEvent("cancel", { locals: authedUser }));
    expect(res.status).toBe(status);
  });

  test("success reports the cancellation", async () => {
    const res = await CANCEL(makeEvent("cancel", { locals: authedUser }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { cancelled?: boolean }).toEqual({ cancelled: true });
  });
});
