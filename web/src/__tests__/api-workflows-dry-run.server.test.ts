/**
 * Server-handler unit tests for /api/workflows/[name]/dry-run.
 *
 * The route is thin on purpose — the structural "cannot dispatch"
 * guarantees live in `src/runtime/workflow-dry-run.ts` and are covered
 * there. What this file pins is the boundary: authorization is asked as
 * `run` (not `read`), an unsaved draft is dry-runnable, and a draft that
 * could not be SAVED cannot be dry-run either.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const ctx = vi.hoisted(() => ({
  getCachedWorkflows: vi.fn(() => [] as unknown[]),
}));
const dry = vi.hoisted(() => ({
  dryRunWorkflow: vi.fn(async () => ({ status: "success", steps: [], stubbed: [] })),
}));
vi.mock("$lib/server/context", () => ctx);
vi.mock("$server/runtime/workflow-dry-run", () => dry);

import { POST } from "../routes/api/workflows/[name]/dry-run/+server";

const DEF = { name: "w1", description: "", steps: [{ name: "s1", agent: "a" }] };

function entry(overrides: Record<string, unknown> = {}) {
  return {
    definition: DEF,
    source: "db",
    id: "wf-1",
    projectId: null,
    userId: null,
    visibility: "system",
    forkedFrom: null,
    ...overrides,
  };
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

function makeEvent(opts: { body?: unknown; locals?: Record<string, unknown> }) {
  return {
    url: new URL("http://localhost/api/workflows/w1/dry-run"),
    locals: opts.locals ?? {},
    params: { name: "w1" },
    request: new Request("http://localhost/api/workflows/w1/dry-run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body ?? {}),
    }),
  } as never;
}

beforeEach(() => {
  ctx.getCachedWorkflows.mockReset().mockReturnValue([entry()]);
  dry.dryRunWorkflow.mockReset().mockResolvedValue({ status: "success", steps: [], stubbed: [] });
});

describe("POST /api/workflows/[name]/dry-run", () => {
  test("returns 403 when API-key scope missing 'chat'", async () => {
    const res = await POST(makeEvent({ locals: { ...authedUser, apiKeyScopes: ["read"] } }));
    expect(res.status).toBe(403);
  });

  test("throws 401 when unauthenticated", async () => {
    let thrown: unknown;
    try {
      await POST(makeEvent({ locals: {} }));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Response).status).toBe(401);
  });

  test("returns 400 for a body carrying unknown fields", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { bogus: 1 } }));
    expect(res.status).toBe(400);
  });

  test("dry-runs the SAVED definition when no draft is supplied", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { input: { topic: "x" } } }));
    expect(res.status).toBe(200);
    expect(dry.dryRunWorkflow).toHaveBeenCalledWith(DEF, { topic: "x" });
  });

  test("dry-runs the UNSAVED draft when one is supplied", async () => {
    // Requiring a save first would make the feature useless for the
    // edit-check-edit loop it exists to serve.
    const draft = { name: "w1", description: "", steps: [{ name: "s2", kind: "transform", output: { a: "b" } }] };
    await POST(makeEvent({ locals: authedUser, body: { definition: draft } }));
    expect(dry.dryRunWorkflow).toHaveBeenCalledWith(expect.objectContaining({ steps: draft.steps }), {});
  });

  test("a draft with no name inherits the route's name rather than failing validation", async () => {
    await POST(
      makeEvent({
        locals: authedUser,
        body: { definition: { steps: [{ name: "s", kind: "transform", output: { a: "b" } }] } },
      }),
    );
    expect(dry.dryRunWorkflow).toHaveBeenCalledWith(expect.objectContaining({ name: "w1" }), {});
  });

  test("a draft that could not be SAVED cannot be dry-run either", async () => {
    // Otherwise the editor would report a green dry run for a graph the
    // save then rejects.
    const res = await POST(
      makeEvent({ locals: authedUser, body: { definition: { steps: [{ name: "g", kind: "gate" }] } } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error?: string }).toMatchObject({
      error: 'Step "g" (kind "gate") requires a "condition"',
    });
    expect(dry.dryRunWorkflow).not.toHaveBeenCalled();
  });

  test("a workflow the caller may not RUN is a 404, and never simulates", async () => {
    // Authorized for `run`, not `read` — a dry run executes the caller's
    // graph logic, so the run rung is the right gate (and the one C3
    // will narrow).
    ctx.getCachedWorkflows.mockReturnValue([entry({ visibility: "private", userId: "someone-else" })]);
    const res = await POST(makeEvent({ locals: authedUser, body: {} }));
    expect(res.status).toBe(404);
    expect(dry.dryRunWorkflow).not.toHaveBeenCalled();
  });

  test("a draft does not bypass authorization", async () => {
    ctx.getCachedWorkflows.mockReturnValue([entry({ visibility: "private", userId: "someone-else" })]);
    const res = await POST(
      makeEvent({ locals: authedUser, body: { definition: { name: "w1", steps: [] } } }),
    );
    expect(res.status).toBe(404);
    expect(dry.dryRunWorkflow).not.toHaveBeenCalled();
  });

  test("returns the harness report verbatim", async () => {
    dry.dryRunWorkflow.mockResolvedValue({
      status: "success",
      steps: [{ name: "s1", kind: "agent", mode: "stubbed", status: "success" }],
      stubbed: ["s1"],
    });
    const res = await POST(makeEvent({ locals: authedUser, body: {} }));
    expect((await res.json()) as { stubbed?: string[] }).toMatchObject({ stubbed: ["s1"] });
  });
});
