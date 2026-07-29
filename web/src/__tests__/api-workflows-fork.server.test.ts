/**
 * Server-handler unit tests for /api/workflows/[name]/fork.
 *
 * The properties worth pinning: a fork never widens the original, it
 * always lands as a project-scoped row owned by the caller, and it
 * absorbs the global name-uniqueness collision instead of surfacing it.
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
vi.mock("$lib/server/context", () => ctx);
vi.mock("$server/db/queries/workflows", () => queries);
vi.mock("$server/db/queries/workflow-versions", () => versions);

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
  versions.ensureWorkflowVersion.mockReset().mockResolvedValue({ version: { version: 1 }, minted: true });
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

  test("the new row is project-scoped and owned by the caller, never widening the source", async () => {
    await POST(makeEvent({ locals: authedUser, body: { projectId: "proj-1" } }));
    expect(queries.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ name: "docs-factory", steps: SOURCE.steps }),
      {
        visibility: "project",
        projectId: "proj-1",
        userId: "u1",
        forkedFrom: "ez-factory:docs-factory",
      },
    );
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
