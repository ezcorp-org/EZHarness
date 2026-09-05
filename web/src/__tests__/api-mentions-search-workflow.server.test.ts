/**
 * Vitest server-handler tests for the `type=workflow` branch of
 * `/api/mentions/search/+server.ts`.
 *
 * The branch reads the merged in-memory workflow cache via
 * `$lib/server/workflow-access::listVisibleWorkflows` (extension + YAML + DB, in that
 * precedence order), fuzzy-ranks on name OR description, and returns at
 * most MAX_RESULTS=10 entries shaped `{ name, description, kind:
 * "workflow" }`.
 *
 * Pattern mirrors `api-mentions-search-feature.server.test.ts` and
 * `api-mentions-search-EZ.server.test.ts`. Runs under
 * `bun run test:component` (vitest), NOT `bun test`.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const mockGetWorkflows = vi.fn();
const mockListVisibleWorkflows = vi.fn();
const mockGetProject = vi.fn();

vi.mock("$lib/server/workflow-access", () => ({ listVisibleWorkflows: mockListVisibleWorkflows }));

vi.mock("$server/db/queries/projects", () => ({
  getProject: mockGetProject,
}));

vi.mock("$lib/server/context", () => ({
  // The handler statically imports all three; only getWorkflows matters
  // to this branch.
  getExecutor: () => ({ listAgents: () => [] }),
  getCommandRegistry: () => ({ listCommands: async () => [] }),
  getWorkflows: mockGetWorkflows,
}));

// Stubs for the no-colon `!` fallback path, so the merge tests below can
// count workflow entries without DB / builtin noise.
vi.mock("$server/db/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  }),
}));
vi.mock("$server/runtime/tools/builtin-registry", () => ({
  getBuiltInCategories: () => [],
}));
vi.mock("$server/runtime/ez-actions/registry", () => ({
  listEzActions: () => [],
}));

const { GET } = await import("../routes/api/mentions/search/+server");

function makeEvent(opts: { href: string; locals?: Record<string, unknown> }) {
  const href = opts.href;
  return makeRequestEvent(href, {
    locals: opts.locals ?? {},
    request: { method: "GET" },
  });
}

const USER = { id: "u1", email: "u@x", name: "u", role: "user" };

/** Minimal WorkflowDefinition shape the route reads (name + description). */
function wf(name: string, description = `${name} workflow`) {
  return { name, description, steps: [] };
}

async function search(query: string) {
  const res = await GET(
    makeEvent({
      href: `http://localhost/api/mentions/search${query}`,
      locals: { user: USER },
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Array<Record<string, unknown>>;
}

describe("GET /api/mentions/search?type=workflow", () => {
  beforeEach(() => {
    mockGetWorkflows.mockReset();
    mockListVisibleWorkflows.mockReset().mockImplementation(async () => mockGetWorkflows());
    mockGetProject.mockReset();
  });

  test.each(["?type=workflow", "?q=workflow"])("%s returns only the caller-authorized workflow snapshot", async query => {
    const visible = wf("approved:visible", "Approved workflow");
    mockGetWorkflows.mockReturnValue([visible, wf("private:secret", "Another owner's private instructions")]);
    mockListVisibleWorkflows.mockResolvedValue([visible]);
    const body = await search(`${query}&projectId=project-one`);
    expect(body.filter(result => result.kind === "workflow")).toEqual([{ name: visible.name, description: visible.description, kind: "workflow" }]);
    expect(mockListVisibleWorkflows).toHaveBeenCalledExactlyOnceWith(USER, "project-one");
    expect(mockGetWorkflows).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("private:secret");
  });

  test("empty query → every workflow, shaped {name, description, kind}", async () => {
    mockGetWorkflows.mockReturnValue([
      wf("deploy", "Build, test and ship to prod"),
      wf("nightly", "Run the nightly regression sweep"),
    ]);

    const body = await search("?type=workflow");

    expect(body).toEqual([
      {
        name: "deploy",
        description: "Build, test and ship to prod",
        kind: "workflow",
      },
      {
        name: "nightly",
        description: "Run the nightly regression sweep",
        kind: "workflow",
      },
    ]);
  });

  test("empty cache → []", async () => {
    mockGetWorkflows.mockReturnValue([]);
    expect(await search("?type=workflow")).toEqual([]);
  });

  test("does NOT leak `steps` (or anything else) onto the wire", async () => {
    mockGetWorkflows.mockReturnValue([
      { name: "deploy", description: "d", steps: [{ name: "s1" }], inputSchema: {} },
    ]);
    const body = await search("?type=workflow");
    expect(Object.keys(body[0]!).sort()).toEqual([
      "description",
      "kind",
      "name",
    ]);
  });

  test("fuzzy-matches on name", async () => {
    mockGetWorkflows.mockReturnValue([
      wf("deploy", "ship it"),
      wf("nightly", "regression sweep"),
    ]);
    const body = await search("?type=workflow&q=depl");
    expect(body.map((b) => b.name)).toEqual(["deploy"]);
  });

  test("fuzzy-matches on description too", async () => {
    mockGetWorkflows.mockReturnValue([
      wf("deploy", "ship it"),
      wf("nightly", "regression sweep"),
    ]);
    const body = await search("?type=workflow&q=regression");
    expect(body.map((b) => b.name)).toEqual(["nightly"]);
  });

  test("query matching nothing → []", async () => {
    mockGetWorkflows.mockReturnValue([wf("deploy", "ship it")]);
    expect(await search("?type=workflow&q=zzzzzz")).toEqual([]);
  });

  test("caps at MAX_RESULTS (10)", async () => {
    mockGetWorkflows.mockReturnValue(
      Array.from({ length: 25 }, (_, i) => wf(`wf-${i}`)),
    );
    const body = await search("?type=workflow");
    expect(body).toHaveLength(10);
  });

  test("extension-namespaced names survive intact", async () => {
    // Extension workflows are namespaced `<ext>:<name>` and go first in
    // the merged cache. The route must not split or rewrite them — the
    // composer inserts the name verbatim into `![workflow:<name>]`.
    mockGetWorkflows.mockReturnValue([wf("deployer:release", "from an ext")]);
    const body = await search("?type=workflow&q=deployer");
    expect(body[0]!.name).toBe("deployer:release");
  });

  // ── The no-project-gate contract ──────────────────────────────────
  test("returns results with NO projectId — workflows are global", async () => {
    mockGetWorkflows.mockReturnValue([wf("deploy")]);
    const body = await search("?type=workflow");
    expect(body).toHaveLength(1);
    // A project lookup here would be the first step toward a gate that
    // nothing downstream enforces.
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  test("passing a projectId changes nothing (not project-scoped)", async () => {
    mockGetWorkflows.mockReturnValue([wf("deploy")]);
    const withProject = await search("?type=workflow&projectId=p1");
    mockGetWorkflows.mockReturnValue([wf("deploy")]);
    const without = await search("?type=workflow");
    expect(withProject).toEqual(without);
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  test("an unknown projectId still returns workflows (unlike feature/lesson)", async () => {
    mockGetProject.mockResolvedValue(undefined);
    mockGetWorkflows.mockReturnValue([wf("deploy")]);
    const body = await search("?type=workflow&projectId=nope");
    expect(body.map((b) => b.name)).toEqual(["deploy"]);
  });
});

describe("GET /api/mentions/search (no type param) — workflows in the `!` merge", () => {
  beforeEach(() => {
    mockGetWorkflows.mockReset();
    mockGetProject.mockReset();
  });

  test("bare `!` (no query) → workflows appear in the merged response", async () => {
    mockGetWorkflows.mockReturnValue([wf("deploy", "ship it")]);
    const body = await search("");
    expect(body).toEqual([
      { name: "deploy", description: "ship it", kind: "workflow" },
    ]);
  });

  test("typing the kind label (`!w` / `!work`) surfaces ALL workflows", async () => {
    // Same rule the EZ merge uses: typing a kind's name means "show me
    // this kind's stuff", even when no workflow's name or description
    // contains that substring.
    for (const q of ["w", "wo", "workflow"]) {
      mockGetWorkflows.mockReturnValue([
        wf("deploy", "ship it"),
        wf("nightly", "regression sweep"),
      ]);
      const body = await search(`?q=${q}`);
      expect(body.map((b) => b.name)).toEqual(["deploy", "nightly"]);
    }
  });

  test("a non-label query still substring-matches name and description", async () => {
    mockGetWorkflows.mockReturnValue([
      wf("deploy", "ship it"),
      wf("nightly", "regression sweep"),
    ]);
    const byName = await search("?q=deploy");
    expect(byName.map((b) => b.name)).toEqual(["deploy"]);

    mockGetWorkflows.mockReturnValue([
      wf("deploy", "ship it"),
      wf("nightly", "regression sweep"),
    ]);
    const byDescription = await search("?q=regression");
    expect(byDescription.map((b) => b.name)).toEqual(["nightly"]);
  });

  test("the merge respects MAX_RESULTS", async () => {
    mockGetWorkflows.mockReturnValue(
      Array.from({ length: 25 }, (_, i) => wf(`wf-${i}`)),
    );
    const body = await search("");
    expect(body).toHaveLength(10);
  });

  for (const siblingType of ["agent", "ext", "team"]) {
    test(`\`!${siblingType}:\` filters workflows OUT of the merge`, async () => {
      mockGetWorkflows.mockReturnValue([wf("deploy")]);
      const body = await search(`?type=${siblingType}`);
      expect(body.map((b) => b.kind)).not.toContain("workflow");
    });
  }
});
