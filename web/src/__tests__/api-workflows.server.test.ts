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
  // Provenance-carrying cache — the list route filters it by the same
  // ladder the single-workflow routes use.
  getCachedWorkflows: vi.fn(() => [] as unknown[]),
  reloadWorkflows: vi.fn(async () => {}),
}));
const queries = vi.hoisted(() => ({
  createWorkflow: vi.fn(async (def: unknown) => def),
  WorkflowNameConflictError: class extends Error {
    constructor(readonly workflowName: string) {
      super(`A workflow named "${workflowName}" already exists`);
    }
  },
}));
const versions = vi.hoisted(() => ({
  ensureWorkflowVersion: vi.fn(async () => ({ version: { version: 1 }, minted: true })),
}));
vi.mock("$lib/server/context", () => ctx);
vi.mock("$server/db/queries/workflows", () => queries);
vi.mock("$server/db/queries/workflow-versions", () => versions);

import { GET, POST } from "../routes/api/workflows/+server";

/** A `system` cache entry — what every row created through POST is. */
function systemEntry(name: string) {
  return {
    definition: { name, description: "", steps: [] },
    source: "db",
    id: `id-${name}`,
    projectId: null,
    userId: null,
    visibility: "system",
    forkedFrom: null,
  };
}

/** A YAML- or extension-shipped cache entry: an ownerless file on disk,
 *  `system` because it ships with the INSTALL and never a row. */
function assetEntry(name: string, source: "yaml" | "extension") {
  return { ...systemEntry(name), source, id: null };
}

beforeEach(() => {
  ctx.getCachedWorkflows.mockReset().mockReturnValue([]);
  ctx.reloadWorkflows.mockReset().mockResolvedValue(undefined);
  queries.createWorkflow.mockReset().mockImplementation(async (def: unknown) => def);
  versions.ensureWorkflowVersion.mockReset().mockResolvedValue({ version: { version: 1 }, minted: true });
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
    ctx.getCachedWorkflows.mockReturnValue([systemEntry("w1")]);
    const res = await GET(makeEvent({ locals: { ...authedUser, apiKeyScopes: ["read"] } }));
    expect(res.status).toBe(200);
    // Same definition fields as before, plus additive provenance.
    expect((await res.json()) as unknown[]).toMatchObject([
      { name: "w1", description: "", steps: [], visibility: "system", canEdit: false },
    ]);
  });

  test("the list is filtered by the ladder — a private workflow the caller does not own is absent", async () => {
    // The documented behaviour change: a read-scoped key with no project
    // sees system workflows only. Shorter array, same shape.
    ctx.getCachedWorkflows.mockReturnValue([
      systemEntry("shared"),
      { ...systemEntry("secret"), visibility: "private", userId: "someone-else" },
    ]);
    const res = await GET(makeEvent({ locals: { ...authedUser, apiKeyScopes: ["read"] } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Array<{ name: string }>).map((w) => w.name)).toEqual(["shared"]);
  });

  // ── canEdit ────────────────────────────────────────────────────
  // Gates the UI's Edit/Delete affordances. Getting it wrong paints
  // buttons that can only 403 (someone else's row) or 404 (a YAML or
  // extension asset, which is a file on disk with nothing to write).
  //
  // It is the LADDER's own `edit` answer, stamped per entry by `toWire` —
  // not a second predicate over an owner column, which is what this used
  // to be. One rule means the button and the endpoint cannot disagree.

  test("marks a DB workflow the caller owns as editable", async () => {
    ctx.getCachedWorkflows.mockReturnValue([
      { ...systemEntry("mine"), visibility: "private", userId: "u1" },
    ]);
    const res = await GET(makeEvent({ locals: authedUser }));
    const [workflow] = (await res.json()) as { canEdit: boolean }[];
    expect(workflow.canEdit).toBe(true);
  });

  test("marks another user's DB workflow as not editable", async () => {
    // `system` so the caller can still SEE it — an invisible row would
    // prove nothing about the flag.
    ctx.getCachedWorkflows.mockReturnValue([{ ...systemEntry("theirs"), userId: "u-other" }]);
    const res = await GET(makeEvent({ locals: authedUser }));
    const [workflow] = (await res.json()) as { canEdit: boolean }[];
    expect(workflow.canEdit).toBe(false);
  });

  test("lets an admin edit another user's DB workflow", async () => {
    ctx.getCachedWorkflows.mockReturnValue([{ ...systemEntry("theirs"), userId: "u-other" }]);
    const res = await GET(
      makeEvent({ locals: { user: { id: "u-admin", email: "a@x", name: "a", role: "admin" } } }),
    );
    const [workflow] = (await res.json()) as { canEdit: boolean }[];
    expect(workflow.canEdit).toBe(true);
  });

  test("a legacy system row is admin-only to edit, though anyone may run it", async () => {
    // The deliberate tightening: every row that existed before the ladder
    // is `system`, and `system` is admin-only to EDIT. The previous rule
    // read an unowned row as editable by anyone, which is the behaviour
    // this replaces.
    ctx.getCachedWorkflows.mockReturnValue([systemEntry("legacy")]);
    const res = await GET(makeEvent({ locals: authedUser }));
    const [workflow] = (await res.json()) as { canEdit: boolean }[];
    expect(workflow.canEdit).toBe(false);
  });

  test("never marks YAML or extension workflows as editable", async () => {
    ctx.getCachedWorkflows.mockReturnValue([
      assetEntry("demo", "yaml"),
      assetEntry("ext:deploy", "extension"),
    ]);
    const res = await GET(
      makeEvent({ locals: { user: { id: "u-admin", email: "a@x", name: "a", role: "admin" } } }),
    );
    const workflows = (await res.json()) as { canEdit: boolean }[];
    expect(workflows.map((w) => w.canEdit)).toEqual([false, false]);
  });

  test("resolves the flag with no DB query at all", async () => {
    // The previous implementation needed one owner lookup per page. The
    // ladder answers off the cache entry already in hand, so the list
    // route is now query-free.
    ctx.getCachedWorkflows.mockReturnValue([systemEntry("a"), assetEntry("demo", "yaml")]);
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(2);
  });

  test("never reveals the owner of a workflow the caller may not see", async () => {
    // An unreadable row is dropped whole, so nothing about it — owner
    // included — reaches the caller.
    ctx.getCachedWorkflows.mockReturnValue([
      { ...systemEntry("secret"), visibility: "private", userId: "u-other" },
    ]);
    const res = await GET(makeEvent({ locals: authedUser }));
    const body = await res.json();
    expect(body).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("u-other");
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

  test("returns 400 for a model override on a non-agent step", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: {
          name: "w1",
          steps: [{ name: "t", kind: "transform", output: { a: "x" }, model: { model: "m" } }],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('cannot specify a "model" override');
  });

  test("returns 400 for an out-of-range temperature on a step model", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: { name: "w1", steps: [{ name: "s", agent: "a", model: { temperature: 9 } }] },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain('Step "s" model "temperature" must be between 0 and 2');
  });

  test("returns 400 for a malformed definition-level defaultModel", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: {
          name: "w1",
          defaultModel: { model: "" },
          steps: [{ name: "s", agent: "a" }],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Workflow "defaultModel" "model" must be a non-empty string');
  });

  test("persists per-step and definition-level model bindings", async () => {
    // The boundary schema must not strip them: a binding accepted by the
    // route and dropped before the DB would be a silently ignored knob.
    const def = {
      name: "w1",
      defaultModel: { model: "claude-haiku-4-5-20251001" },
      steps: [{ name: "s1", agent: "a", model: { model: "claude-opus-5", effort: "high" } }],
    };
    queries.createWorkflow.mockResolvedValue({ id: "wf-1", ...def, description: "" });
    const res = await POST(makeEvent({ locals: authedUser, body: def }));
    expect(res.status).toBe(201);
    expect(queries.createWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      defaultModel: { model: "claude-haiku-4-5-20251001" },
      steps: [expect.objectContaining({ model: { model: "claude-opus-5", effort: "high" } })],
    }));
  });

  test("accepts every step kind the executor dispatches, and their control-flow fields", async () => {
    // The `kind` enum is the ONE place the boundary schema is not loose, so
    // it is the one place a kind added server-side becomes uncreatable
    // through the API — silently, with a generic "name and steps required".
    // It was already short by `approval` before C7 added `workflow`.
    const def = {
      name: "w1",
      steps: [
        { name: "t", kind: "transform", output: { v: "$input.v" } },
        {
          name: "ask",
          kind: "approval",
          prompt: "Ship it?",
          choices: ["yes", "no"],
          dependsOn: ["t"],
        },
        {
          name: "nest",
          kind: "workflow",
          workflow: "verify-suite",
          when: { ref: "$input.v", op: "truthy" },
          skipDependents: false,
          dependsOn: ["ask"],
        },
      ],
    };
    queries.createWorkflow.mockResolvedValue({ id: "wf-1", ...def, description: "" });
    const res = await POST(makeEvent({ locals: authedUser, body: def }));
    expect(res.status).toBe(201);
    // And the control-flow fields survive to the DB — a field the route
    // accepted and then stripped would be a silently ignored knob.
    expect(queries.createWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      steps: expect.arrayContaining([
        expect.objectContaining({
          kind: "workflow",
          workflow: "verify-suite",
          when: { ref: "$input.v", op: "truthy" },
          skipDependents: false,
        }),
      ]),
    }));
  });

  test("a bad skipDependents gets the VALIDATOR's message, not the generic boundary one", async () => {
    // Pinning a decision that is easy to get backwards. Declaring
    // `skipDependents: z.boolean()` in the boundary schema would reject this
    // one step earlier — and hand the author "name and steps required",
    // which names neither the step nor the field. Leaving it `unknown` lets
    // the shared validator answer, exactly as `condition` / `loop` / `model`
    // already do.
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: { name: "w1", steps: [{ name: "s", agent: "a", skipDependents: "false" }] },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Step "s" "skipDependents" must be a boolean');
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

  test("mints version 1 for a newly created workflow", async () => {
    const def = { name: "w1", steps: [{ name: "s1", agent: "a" }] };
    queries.createWorkflow.mockResolvedValue({ id: "wf-1", ...def, description: "" });
    await POST(makeEvent({ locals: authedUser, body: def }));
    expect(versions.ensureWorkflowVersion).toHaveBeenCalledTimes(1);
  });

  test("an unrelated create failure is re-thrown, never mislabelled a 409", async () => {
    // Swallowing a dead connection into "name already exists" would tell
    // the user to rename a workflow whose name was never the problem.
    const def = { name: "w1", steps: [{ name: "s1", agent: "a" }] };
    queries.createWorkflow.mockRejectedValue(new Error("connection terminated"));
    await expect(POST(makeEvent({ locals: authedUser, body: def }))).rejects.toThrow(
      "connection terminated",
    );
  });

  test("returns 409 — not 500 — when the name is already taken", async () => {
    // `name` is globally unique on purpose: ownership authorizes a
    // workflow, it never namespaces one. A duplicate is therefore an
    // ordinary, expected outcome and gets an ordinary status.
    const def = { name: "taken", steps: [{ name: "s1", agent: "a" }] };
    queries.createWorkflow.mockRejectedValue(new queries.WorkflowNameConflictError("taken"));
    const res = await POST(makeEvent({ locals: authedUser, body: def }));
    expect(res.status).toBe(409);
    expect((await res.json()) as { name?: string }).toMatchObject({ name: "taken" });
    expect(ctx.reloadWorkflows).not.toHaveBeenCalled();
  });

  test("does NOT stamp the caller as the row's owner", async () => {
    // Replaces upstream's "records the authoring user as created_by",
    // which asserted the opposite. The two rules cannot both hold, and
    // this one is deliberate: a workflow created through this route is
    // `system`, exactly as every row created before C6 was. Ownership
    // arrives through fork (which sets a project) or the admin claim
    // action — never as a silent side effect of an ordinary create.
    //
    // Upstream wanted the stamp so the author could Edit and Delete their
    // own rows. The ladder already grants that: `edit` on a `system`
    // workflow is open to any `chat`-scoped caller, which is who just
    // created it.
    const def = { name: "w1", steps: [{ name: "s1", agent: "a" }] };
    queries.createWorkflow.mockResolvedValue({ id: "wf-1", ...def, description: "" });
    await POST(makeEvent({ locals: authedUser, body: def }));
    expect(queries.createWorkflow).toHaveBeenCalledTimes(1);
    // One argument only — no owner threaded in behind the definition.
    expect(queries.createWorkflow.mock.calls[0]).toHaveLength(1);
    expect(queries.createWorkflow).toHaveBeenCalledWith(expect.objectContaining(def));
  });
});
