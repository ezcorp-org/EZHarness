/**
 * Server-handler unit tests for the two remaining workflow routes:
 * the admin claim action and the version-history read.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const ctx = vi.hoisted(() => ({
  getCachedWorkflows: vi.fn(() => [] as unknown[]),
  reloadWorkflows: vi.fn(async () => {}),
}));
const queries = vi.hoisted(() => ({
  getWorkflowByName: vi.fn(async () => undefined as Record<string, unknown> | undefined),
  claimWorkflow: vi.fn(async () => undefined as Record<string, unknown> | undefined),
}));
const versions = vi.hoisted(() => ({
  listWorkflowVersions: vi.fn(async () => [] as unknown[]),
}));
const audit = vi.hoisted(() => ({ insertAuditEntry: vi.fn(async () => "audit-1") }));
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
vi.mock("$server/db/queries/audit-log", () => audit);
vi.mock("$server/db/queries/project-members", () => projectMembers);

import { POST as CLAIM } from "../routes/api/workflows/[name]/claim/+server";
import { GET as VERSIONS } from "../routes/api/workflows/[name]/versions/+server";

const admin = { user: { id: "admin-1", email: "a@x", name: "A", role: "admin" } };
const member = { user: { id: "u1", email: "u@x", name: "u", role: "member" } };

function entry(overrides: Record<string, unknown> = {}) {
  return {
    definition: { name: "w1", description: "", steps: [] },
    source: "db",
    id: "wf-1",
    projectId: null,
    userId: null,
    visibility: "system",
    forkedFrom: null,
    ...overrides,
  };
}

function makeEvent(opts: { body?: unknown; locals?: Record<string, unknown>; method?: string }) {
  return {
    url: new URL("http://localhost/api/workflows/w1/claim"),
    locals: opts.locals ?? {},
    params: { name: "w1" },
    request: new Request("http://localhost/api/workflows/w1/claim", {
      method: opts.method ?? "POST",
      headers: { "content-type": "application/json" },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
  } as never;
}

beforeEach(() => {
  ctx.getCachedWorkflows.mockReset().mockReturnValue([entry()]);
  ctx.reloadWorkflows.mockReset().mockResolvedValue(undefined);
  queries.getWorkflowByName.mockReset().mockResolvedValue(undefined);
  queries.claimWorkflow.mockReset().mockResolvedValue(undefined);
  versions.listWorkflowVersions.mockReset().mockResolvedValue([]);
  audit.insertAuditEntry.mockReset().mockResolvedValue("audit-1");
});

describe("POST /api/workflows/[name]/claim", () => {
  test("a non-admin is refused, on the ROLE axis", async () => {
    // A cookie session carries no apiKeyScopes, so `requireScope("admin")`
    // alone would let any member through — the role gate is what actually
    // holds here.
    const res = await CLAIM(makeEvent({ locals: member, body: { userId: "u1" } }));
    expect(res.status).toBe(403);
    expect(queries.claimWorkflow).not.toHaveBeenCalled();
  });

  test("an admin-role key without the admin SCOPE is refused", async () => {
    const res = await CLAIM(
      makeEvent({ locals: { ...admin, apiKeyScopes: ["chat"] }, body: { userId: "u1" } }),
    );
    expect(res.status).toBe(403);
    expect(queries.claimWorkflow).not.toHaveBeenCalled();
  });

  test("returns 400 when userId is missing", async () => {
    const res = await CLAIM(makeEvent({ locals: admin, body: {} }));
    expect(res.status).toBe(400);
  });

  test("returns 404 when the workflow is not a DB row", async () => {
    queries.getWorkflowByName.mockResolvedValue(undefined);
    const res = await CLAIM(makeEvent({ locals: admin, body: { userId: "u1" } }));
    expect(res.status).toBe(404);
  });

  test("returns 404 when the claim itself resolves to nothing", async () => {
    queries.getWorkflowByName.mockResolvedValue({ id: "wf-1", name: "w1" });
    queries.claimWorkflow.mockResolvedValue(undefined);
    const res = await CLAIM(makeEvent({ locals: admin, body: { userId: "u1" } }));
    expect(res.status).toBe(404);
  });

  test("an admin assigns an explicit owner, and the move is audited with its BEFORE values", async () => {
    // Ownership is STATED, never inferred from run history — guessing it
    // is how you hand someone's workflow to the wrong person. The audit
    // row records what it was, so a mistaken claim can be undone.
    queries.getWorkflowByName.mockResolvedValue({
      id: "wf-1",
      name: "w1",
      visibility: "system",
      userId: null,
      projectId: null,
    });
    queries.claimWorkflow.mockResolvedValue({ id: "wf-1", visibility: "project", userId: "u1" });

    const res = await CLAIM(makeEvent({ locals: admin, body: { userId: "u1", projectId: "proj-1" } }));
    expect(res.status).toBe(200);
    expect(queries.claimWorkflow).toHaveBeenCalledWith("wf-1", "u1", "proj-1");
    expect(audit.insertAuditEntry).toHaveBeenCalledWith(
      "admin-1",
      "workflow.claim",
      "wf-1",
      expect.objectContaining({
        workflowName: "w1",
        previousVisibility: "system",
        previousUserId: null,
        newUserId: "u1",
        newProjectId: "proj-1",
      }),
    );
    expect(ctx.reloadWorkflows).toHaveBeenCalledTimes(1);
  });

  test("an omitted projectId claims the workflow without a project", async () => {
    queries.getWorkflowByName.mockResolvedValue({ id: "wf-1", name: "w1", visibility: "system" });
    queries.claimWorkflow.mockResolvedValue({ id: "wf-1" });
    await CLAIM(makeEvent({ locals: admin, body: { userId: "u1" } }));
    expect(queries.claimWorkflow).toHaveBeenCalledWith("wf-1", "u1", null);
  });
});

describe("GET /api/workflows/[name]/versions", () => {
  test("returns 403 when API-key scope missing 'read'", async () => {
    const res = await VERSIONS(makeEvent({ locals: { ...member, apiKeyScopes: ["chat"] } }));
    expect(res.status).toBe(403);
  });

  test("throws 401 when unauthenticated", async () => {
    let thrown: unknown;
    try {
      await VERSIONS(makeEvent({ locals: {} }));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Response).status).toBe(401);
  });

  test("history is gated by the same ladder — an unauthorized read is a 404", async () => {
    // History is as sensitive as the definition it describes, and a list
    // that confirmed existence would rebuild the oracle the 404 closes.
    ctx.getCachedWorkflows.mockReturnValue([entry({ visibility: "private", userId: "someone-else" })]);
    const res = await VERSIONS(makeEvent({ locals: member }));
    expect(res.status).toBe(404);
    expect(versions.listWorkflowVersions).not.toHaveBeenCalled();
  });

  test("a YAML/extension workflow has no versions — an empty list, not a 404", async () => {
    ctx.getCachedWorkflows.mockReturnValue([entry({ source: "yaml", id: null })]);
    queries.getWorkflowByName.mockResolvedValue(undefined);
    const res = await VERSIONS(makeEvent({ locals: member }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("projects each version without its full steps blob", async () => {
    // A history panel renders labels; shipping every snapshot's graph
    // would grow the response without bound as a workflow is edited.
    queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
    versions.listWorkflowVersions.mockResolvedValue([
      {
        id: "v1",
        version: 1,
        name: "w1",
        description: "d",
        stepsHash: "abc123",
        steps: [{ name: "s1" }, { name: "s2" }],
        createdByUserId: "u1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    const res = await VERSIONS(makeEvent({ locals: member }));
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body[0]).toMatchObject({ version: 1, stepCount: 2, stepsHash: "abc123" });
    expect(body[0]).not.toHaveProperty("steps");
  });
});
