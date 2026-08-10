/**
 * Server-handler unit tests for /api/workflows/[name]/fork — the
 * platform's ONE copy verb, reached from the detail page's Duplicate.
 *
 * The properties worth pinning: a copy never widens the original, it is
 * always owned by the caller, it absorbs the global name-uniqueness
 * collision instead of surfacing it, and — the part that used to be
 * silent — the tier it lands on is either the author's explicit choice
 * (gated by the shared assignment rule) or `private`, never an invisible
 * `project`.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const ctx = vi.hoisted(() => ({
  getCachedWorkflows: vi.fn(() => [] as unknown[]),
  reloadWorkflows: vi.fn(async () => {}),
}));
const queries = vi.hoisted(() => ({
  createWorkflow: vi.fn(async (def: Record<string, unknown>) => ({ id: "new-1", ...def })),
  listWorkflows: vi.fn(async () => [] as Array<{ name: string }>),
  WorkflowNameConflictError: class extends Error {
    constructor(readonly workflowName: string) {
      super(`A workflow named "${workflowName}" already exists`);
    }
  },
}));
const versions = vi.hoisted(() => ({
  ensureWorkflowVersion: vi.fn(async () => ({ version: { version: 1 }, minted: true })),
}));
// `callerFor` resolves the caller's project memberships once per request,
// so the read/run ladder can answer a project-SCOPED row. The entries here
// never reach that branch, but the resolve still happens and would
// otherwise hit a real `getDb()`.
const projectMembers = vi.hoisted(() => ({
  listProjectIdsForUser: vi.fn(async () => [] as string[]),
}));
vi.mock("$lib/server/context", () => ctx);
vi.mock("$server/db/queries/workflows", () => queries);
vi.mock("$server/db/queries/workflow-versions", () => versions);
vi.mock("$server/db/queries/project-members", () => projectMembers);

import { POST } from "../routes/api/workflows/[name]/fork/+server";

const SOURCE = {
  name: "ez-factory:docs-factory",
  description: "shipped by an extension",
  steps: [{ name: "s1", agent: "writer" }],
};

function extensionEntry(definition = SOURCE) {
  return {
    definition,
    source: "extension",
    id: null,
    projectId: null,
    userId: null,
    visibility: "system",
    forkedFrom: null,
  };
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

function makeEvent(opts: { name?: string; body?: unknown; locals?: Record<string, unknown> }) {
  const name = opts.name ?? SOURCE.name;
  return {
    url: new URL(`http://localhost/api/workflows/${name}/fork`),
    locals: opts.locals ?? {},
    params: { name },
    request: new Request(`http://localhost/api/workflows/${name}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body ?? {}),
    }),
  } as never;
}

beforeEach(() => {
  ctx.getCachedWorkflows.mockReset().mockReturnValue([extensionEntry()]);
  ctx.reloadWorkflows.mockReset().mockResolvedValue(undefined);
  queries.createWorkflow.mockReset().mockImplementation(async (def: Record<string, unknown>) => ({
    id: "new-1",
    ...def,
  }));
  queries.listWorkflows.mockReset().mockResolvedValue([]);
  versions.ensureWorkflowVersion
    .mockReset()
    .mockResolvedValue({ version: { version: 1 }, minted: true });
});

describe("POST /api/workflows/[name]/fork", () => {
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
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });

  test("returns 400 for a body carrying unknown fields", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { bogus: true } }));
    expect(res.status).toBe(400);
  });

  test("a fork of <ext>:<name> takes the BARE name", async () => {
    // `WORKFLOW_NAME_RE` excludes ':' and the loader rejects a declared
    // name containing it, so a fork cannot keep its source name.
    const res = await POST(makeEvent({ locals: authedUser, body: { projectId: "proj-1" } }));
    expect(res.status).toBe(201);
    expect((await res.json()) as { name?: string }).toMatchObject({
      name: "docs-factory",
      forkedFrom: "ez-factory:docs-factory",
    });
  });

  test("a copy with no named tier lands PRIVATE, owned by the caller", async () => {
    // The behaviour this whole change exists for. It used to be
    // `visibility: "project"`, unconditionally — which the read/run ladder
    // resolves to "any-authenticated-principal", i.e. every account on the
    // instance. Copying a workflow to tinker with published it.
    await POST(makeEvent({ locals: authedUser, body: { projectId: "proj-1" } }));
    expect(queries.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: "docs-factory", steps: SOURCE.steps }),
      {
        visibility: "private",
        projectId: "proj-1",
        userId: "u1",
        forkedFrom: "ez-factory:docs-factory",
      },
    );
  });

  test("the tier that LANDED rides back in the response, not the one asked for", async () => {
    const res = await POST(makeEvent({ locals: authedUser }));
    expect((await res.json()) as { visibility?: string }).toMatchObject({ visibility: "private" });
  });

  test("an author who names `project` gets `project` — the default is a default, not a ceiling", async () => {
    await POST(makeEvent({ locals: authedUser, body: { visibility: "project" } }));
    expect(queries.createWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ visibility: "project" }),
    );
  });

  test("a non-admin naming `system` is refused by the SHARED assignment rule", async () => {
    // Not a rule this route owns: `denyVisibilityOr` is the same call
    // `POST /api/workflows` makes, so the two cannot disagree about who
    // may dress a row up as a first-party asset.
    const res = await POST(makeEvent({ locals: authedUser, body: { visibility: "system" } }));
    expect(res.status).toBe(403);
    expect(queries.createWorkflow).not.toHaveBeenCalled();
  });

  test("an admin naming `system` is allowed through the same rule", async () => {
    const res = await POST(
      makeEvent({
        locals: { user: { id: "a1", email: "a@x", name: "a", role: "admin" } },
        body: { visibility: "system" },
      }),
    );
    expect(res.status).toBe(201);
    expect(queries.createWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ visibility: "system" }),
    );
  });

  test("a tier is refused only AFTER the read resolve, so it is never an existence oracle", async () => {
    // A 403 on the assignment rule must not be reachable for a workflow
    // the caller cannot see — that would separate "exists, and you may not
    // assign system" from "no such name".
    ctx.getCachedWorkflows.mockReturnValue([
      { ...extensionEntry(), source: "db", visibility: "private", userId: "someone-else" },
    ]);
    const res = await POST(makeEvent({ locals: authedUser, body: { visibility: "system" } }));
    expect(res.status).toBe(404);
  });

  test("an author-supplied name is used instead of the source's", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { name: "docs-factory-copy" } }));
    expect(res.status).toBe(201);
    expect((await res.json()) as { name?: string }).toMatchObject({ name: "docs-factory-copy" });
  });

  test("a blank name falls back to the source rather than 400-ing", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { name: "   " } }));
    expect((await res.json()) as { name?: string }).toMatchObject({ name: "docs-factory" });
  });

  test("an author-supplied name that is TAKEN is suffixed like any other", async () => {
    queries.listWorkflows.mockResolvedValue([{ name: "docs-factory-copy" }]);
    const res = await POST(makeEvent({ locals: authedUser, body: { name: "docs-factory-copy" } }));
    expect((await res.json()) as { name?: string }).toMatchObject({ name: "docs-factory-copy-2" });
  });

  test("a name the grammar can never accept is a 400, not a mystifying 409", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { name: "Bad Name!" } }));
    expect(res.status).toBe(400);
    expect(queries.createWorkflow).not.toHaveBeenCalled();
  });

  test("a non-string name is rejected by the body schema", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { name: 7 } }));
    expect(res.status).toBe(400);
  });

  test("an unknown visibility literal is rejected by the body schema", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { visibility: "public" } }));
    expect(res.status).toBe(400);
  });

  test("auto-suffixes on collision and reports the FINAL name", async () => {
    queries.listWorkflows.mockResolvedValue([{ name: "docs-factory" }]);
    const res = await POST(makeEvent({ locals: authedUser }));
    expect((await res.json()) as { name?: string }).toMatchObject({ name: "docs-factory-2" });
  });

  test("forking a private workflow the caller cannot read is a 404", async () => {
    ctx.getCachedWorkflows.mockReturnValue([
      { ...extensionEntry(), source: "db", visibility: "private", userId: "someone-else" },
    ]);
    const res = await POST(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(404);
    expect(queries.createWorkflow).not.toHaveBeenCalled();
  });

  test("a concurrent create that wins the name is a 409, not a 500", async () => {
    queries.createWorkflow.mockRejectedValue(new queries.WorkflowNameConflictError("docs-factory"));
    const res = await POST(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(409);
  });

  test("an unrelated create failure is re-thrown, never mislabelled a 409", async () => {
    queries.createWorkflow.mockRejectedValue(new Error("connection terminated"));
    await expect(POST(makeEvent({ locals: authedUser }))).rejects.toThrow("connection terminated");
  });

  test("an exhausted suffix space is a 409", async () => {
    queries.listWorkflows.mockResolvedValue(
      [{ name: "docs-factory" }].concat(
        Array.from({ length: 999 }, (_, i) => ({ name: `docs-factory-${i + 2}` })),
      ),
    );
    const res = await POST(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(409);
  });

  test("a fork with no project lands unscoped rather than failing", async () => {
    await POST(makeEvent({ locals: authedUser }));
    expect(queries.createWorkflow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ projectId: null }),
    );
  });

  test("the source's inputSchema and defaultModel are carried across", async () => {
    ctx.getCachedWorkflows.mockReturnValue([
      extensionEntry({
        ...SOURCE,
        inputSchema: { topic: { type: "string" } },
        defaultModel: { model: "claude-opus-5" },
      } as never),
    ]);
    await POST(makeEvent({ locals: authedUser }));
    expect(queries.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        inputSchema: { topic: { type: "string" } },
        defaultModel: { model: "claude-opus-5" },
      }),
      expect.anything(),
    );
  });

  test("the fork gets its own version 1 and the cache is reloaded", async () => {
    await POST(makeEvent({ locals: authedUser }));
    expect(versions.ensureWorkflowVersion).toHaveBeenCalledTimes(1);
    expect(ctx.reloadWorkflows).toHaveBeenCalledTimes(1);
  });
});
