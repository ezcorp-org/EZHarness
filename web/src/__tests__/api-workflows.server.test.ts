/**
 * Server-handler unit tests for /api/workflows (+server.ts).
 *
 * Covers the auth gates, the missing-field validation, and the
 * definition-time (`validateWorkflow`) rejections that run BEFORE any DB
 * side effect, plus the GET-list and POST-create success paths (the
 * in-memory registry + DB query layer are mocked).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const ctx = vi.hoisted(() => ({
  getWorkflows: vi.fn(() => [] as unknown[]),
  reloadWorkflows: vi.fn(async () => {}),
}));
const queries = vi.hoisted(() => ({
  createWorkflow: vi.fn(async (def: unknown) => def),
  getWorkflowOwnersByName: vi.fn(async () => new Map<string, string | null>()),
}));
vi.mock("$lib/server/context", () => ctx);
vi.mock("$server/db/queries/workflows", () => queries);

import { GET, POST } from "../routes/api/workflows/+server";

beforeEach(() => {
  ctx.getWorkflows.mockReset().mockReturnValue([]);
  ctx.reloadWorkflows.mockReset().mockResolvedValue(undefined);
  queries.createWorkflow.mockReset().mockImplementation(async (def: unknown) => def);
  queries.getWorkflowOwnersByName.mockReset().mockResolvedValue(new Map());
});

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : "{}";
  return {
    url: new URL("http://localhost/api/workflows"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "member" } };

describe("GET /api/workflows", () => {
  test("returns 403 when API-key scope missing 'read'", async () => {
    const res = await GET(
      makeEvent({ locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("read");
  });

  test("rejects unauthenticated callers with 401", async () => {
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

  test("returns the workflow list for an authed read-scoped caller", async () => {
    ctx.getWorkflows.mockReturnValue([{ name: "w1", description: "d", steps: [] }]);
    const res = await GET(makeEvent({ locals: { ...authedUser, apiKeyScopes: ["read"] } }));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toEqual([
      { name: "w1", description: "d", steps: [], canManage: false },
    ]);
  });

  // ── canManage ──────────────────────────────────────────────────
  // Gates the UI's Edit/Delete affordances. Getting it wrong paints
  // buttons that can only 403 (someone else's row) or 404 (a YAML or
  // extension asset, which is a file on disk with nothing to write).

  test("marks a DB workflow the caller owns as manageable", async () => {
    ctx.getWorkflows.mockReturnValue([
      { name: "mine", description: "", steps: [], source: "db" },
    ]);
    queries.getWorkflowOwnersByName.mockResolvedValue(new Map([["mine", "u1"]]));
    const res = await GET(makeEvent({ locals: authedUser }));
    const [workflow] = (await res.json()) as { canManage: boolean }[];
    expect(workflow.canManage).toBe(true);
  });

  test("marks another user's DB workflow as not manageable", async () => {
    ctx.getWorkflows.mockReturnValue([
      { name: "theirs", description: "", steps: [], source: "db" },
    ]);
    queries.getWorkflowOwnersByName.mockResolvedValue(new Map([["theirs", "u-other"]]));
    const res = await GET(makeEvent({ locals: authedUser }));
    const [workflow] = (await res.json()) as { canManage: boolean }[];
    expect(workflow.canManage).toBe(false);
  });

  test("lets an admin manage another user's DB workflow", async () => {
    ctx.getWorkflows.mockReturnValue([
      { name: "theirs", description: "", steps: [], source: "db" },
    ]);
    queries.getWorkflowOwnersByName.mockResolvedValue(new Map([["theirs", "u-other"]]));
    const res = await GET(
      makeEvent({ locals: { user: { id: "u-admin", email: "a@x", name: "a", role: "admin" } } }),
    );
    const [workflow] = (await res.json()) as { canManage: boolean }[];
    expect(workflow.canManage).toBe(true);
  });

  test("marks an unowned legacy DB row as manageable by anyone", async () => {
    ctx.getWorkflows.mockReturnValue([
      { name: "legacy", description: "", steps: [], source: "db" },
    ]);
    queries.getWorkflowOwnersByName.mockResolvedValue(new Map([["legacy", null]]));
    const res = await GET(makeEvent({ locals: authedUser }));
    const [workflow] = (await res.json()) as { canManage: boolean }[];
    expect(workflow.canManage).toBe(true);
  });

  test("never marks YAML or extension workflows as manageable", async () => {
    ctx.getWorkflows.mockReturnValue([
      { name: "demo", description: "", steps: [], source: "yaml" },
      { name: "ext:deploy", description: "", steps: [], source: "extension" },
    ]);
    const res = await GET(
      makeEvent({ locals: { user: { id: "u-admin", email: "a@x", name: "a", role: "admin" } } }),
    );
    const workflows = (await res.json()) as { canManage: boolean }[];
    expect(workflows.map((w) => w.canManage)).toEqual([false, false]);
  });

  test("skips the owner query entirely when no workflow is DB-sourced", async () => {
    // A fresh install serving only the YAML demos should not hit the DB to
    // be told every answer is false.
    ctx.getWorkflows.mockReturnValue([
      { name: "demo", description: "", steps: [], source: "yaml" },
    ]);
    await GET(makeEvent({ locals: authedUser }));
    expect(queries.getWorkflowOwnersByName).not.toHaveBeenCalled();
  });

  test("does not leak the owner's user id to the client", async () => {
    // Only the resolved boolean is serialized; the cache projection stays
    // owner-free on purpose.
    ctx.getWorkflows.mockReturnValue([
      { name: "mine", description: "", steps: [], source: "db" },
    ]);
    queries.getWorkflowOwnersByName.mockResolvedValue(new Map([["mine", "u1"]]));
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(JSON.stringify(await res.json())).not.toContain("u1");
  });
});

describe("POST /api/workflows", () => {
  test("returns 403 when API-key scope missing 'chat'", async () => {
    const res = await POST(
      makeEvent({
        locals: { ...authedUser, apiKeyScopes: ["read"] },
        body: { name: "w1", steps: [{ name: "s1", agent: "a" }] },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("chat");
  });

  test("rejects unauthenticated callers with 401", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: { name: "w1", steps: [{ name: "s1", agent: "a" }] } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 400 when the body fails the strict schema (unknown top-level field)", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { name: "w1", steps: [], bogus: true } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("name and steps required");
  });

  test("returns 400 when name is missing", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { steps: [{}] } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("name and steps required");
  });

  test("returns 400 when steps is missing", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { name: "w1" } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("name and steps required");
  });

  test("returns 400 when steps is empty array", async () => {
    const res = await POST(
      makeEvent({ locals: authedUser, body: { name: "w1", steps: [] } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("name and steps required");
  });

  test("returns 400 with the validator message for duplicate step names", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: {
          name: "w1",
          steps: [
            { name: "dup", agent: "a" },
            { name: "dup", agent: "b" },
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Duplicate step name "dup"');
  });

  test("returns 400 for a gate step missing its condition", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: { name: "w1", steps: [{ name: "g", kind: "gate" }] },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Step "g" (kind "gate") requires a "condition"');
  });

  test("returns 400 for a step combining loop and retries", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: {
          name: "w1",
          steps: [{ name: "s", agent: "a", retries: 1, loop: { maxIterations: 3 } }],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Step "s" cannot combine "loop" and "retries" (mutually exclusive)');
  });

  test("returns 400 for a loop on a gate step", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: {
          name: "w1",
          steps: [
            { name: "g", kind: "gate", condition: { ref: "$input.x", op: "truthy" }, loop: { maxIterations: 2 } },
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Step "g" (kind "gate") cannot have a "loop"');
  });

  test("returns 400 for an unknown dependsOn reference", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: { name: "w1", steps: [{ name: "s", agent: "a", dependsOn: ["ghost"] }] },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Step "s" depends on unknown step "ghost"');
  });

  test("creates a valid workflow, reloads the registry, and returns 201", async () => {
    const def = { name: "w1", steps: [{ name: "s1", agent: "a" }] };
    queries.createWorkflow.mockResolvedValue({ id: "wf-1", ...def, description: "" });
    const res = await POST(makeEvent({ locals: authedUser, body: def }));
    expect(res.status).toBe(201);
    expect(queries.createWorkflow).toHaveBeenCalledTimes(1);
    expect(ctx.reloadWorkflows).toHaveBeenCalledTimes(1);
    const created = (await res.json()) as { id?: string };
    expect(created.id).toBe("wf-1");
  });

  test("records the authoring user as created_by", async () => {
    // Without this the row is created unowned and the owner-or-admin gate
    // on run / update / delete can never engage.
    const def = { name: "w1", steps: [{ name: "s1", agent: "a" }] };
    queries.createWorkflow.mockResolvedValue({ id: "wf-1", ...def, description: "" });
    await POST(makeEvent({ locals: authedUser, body: def }));
    expect(queries.createWorkflow).toHaveBeenCalledWith(expect.objectContaining(def), "u1");
  });
});
