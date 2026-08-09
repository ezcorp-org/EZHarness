/**
 * Bun-side coverage + behaviour test for the WORKFLOW paths of
 * `web/src/routes/api/mentions/search/+server.ts`:
 *   - the `type === "workflow"` branch, and
 *   - `mergeGlobalBangKind`, the shared helper behind the bare-`!` merge
 *     (used by BOTH the EZ-action and workflow merges).
 *
 * WHY THIS FILE IS IN `src/__tests__/` AND NOT NEXT TO ITS SIBLINGS.
 *
 * There is already a vitest suite for these paths
 * (`web/src/__tests__/api-mentions-search-workflow.server.test.ts`) and it
 * asserts more behaviour than this one does. But vitest contributes NO lcov
 * for this route: `scripts/test-coverage.sh`'s node-vitest leg carries an
 * explicit `--coverage.include` allowlist, and
 * `src/routes/api/mentions/search/+server.ts` is not on it. The route's only
 * coverage producer is the backend host pool, which runs `src/__tests__/**`
 * under `bun --coverage` — and the one host-pool file that imports this route
 * (`mentions-search-symlink-integration.test.ts`) only ever exercises
 * `type=path`, which returns long before either workflow path.
 *
 * So the workflow branch was fully TESTED and entirely UNMEASURED, and the
 * patch-coverage gate (CI-only — it needs a BASE_REF) failed on 24 changed
 * lines that had passing tests behind them. This file puts those paths in
 * front of the producer that actually emits lcov for them. It is a coverage
 * companion, not a duplicate: keep behavioural depth in the vitest suite.
 */

import { test, expect, describe, mock } from "bun:test";

// ── Mock the SvelteKit aliases the +server.ts route imports ─────────
// Must be registered BEFORE importing the route module.

let workflowFixtures: Array<{ name: string; description: string }> = [];
let ezActionFixtures: Array<{ name: string; description: string }> = [];

mock.module("$server/db/queries/projects", () => ({
  getProject: async () => null,
}));

mock.module("$server/auth/middleware", () => ({
  requireAuth: () => ({ id: "test-user", role: "admin" }),
}));

mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

mock.module("$lib/server/context", () => ({
  getExecutor: () => ({ listAgents: () => [] }),
  getCommandRegistry: () => ({ listCommands: () => [] }),
  getWorkflows: () => workflowFixtures,
}));

mock.module("$server/runtime/ez-actions/registry", () => ({
  listEzActions: () => ezActionFixtures,
}));

// Empty DB + builtin surfaces so the bare-`!` fallback's ONLY contributors
// are the two merges under test — lets the assertions count exact lengths.
mock.module("$server/db/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  }),
}));

mock.module("$server/db/schema", () => ({
  extensions: {},
  agentConfigs: {},
}));

mock.module("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  ilike: () => ({}),
}));

mock.module("$server/runtime/tools/builtin-registry", () => ({
  getBuiltInCategories: () => [],
}));

// Import AFTER mocks.
const { GET } = await import("../../web/src/routes/api/mentions/search/+server");

interface SearchResult {
  name: string;
  description: string;
  kind: string;
}

async function search(query: string): Promise<SearchResult[]> {
  const url = new URL(`http://localhost/api/mentions/search${query}`);
  const res = await GET({
    url,
    locals: {},
    request: new Request(url.toString()),
  } as never);
  expect(res.status).toBe(200);
  return res.json() as Promise<SearchResult[]>;
}

function wf(name: string, description = `${name} workflow`) {
  return { name, description };
}

// ─────────────────────────────────────────────────────────────────────
// `type=workflow` branch
// ─────────────────────────────────────────────────────────────────────

describe("GET /api/mentions/search?type=workflow", () => {
  test("empty query returns every workflow as kind=workflow", async () => {
    workflowFixtures = [wf("deploy", "ship to prod"), wf("nightly", "sweep")];
    const body = await search("?type=workflow");
    expect(body).toEqual([
      { name: "deploy", description: "ship to prod", kind: "workflow" },
      { name: "nightly", description: "sweep", kind: "workflow" },
    ]);
  });

  test("empty cache returns []", async () => {
    workflowFixtures = [];
    expect(await search("?type=workflow")).toEqual([]);
  });

  test("a query fuzzy-matches on name", async () => {
    workflowFixtures = [wf("deploy", "ship it"), wf("nightly", "sweep")];
    const body = await search("?type=workflow&q=depl");
    expect(body.map((b) => b.name)).toEqual(["deploy"]);
  });

  test("a query fuzzy-matches on description too", async () => {
    workflowFixtures = [wf("deploy", "ship it"), wf("nightly", "regression")];
    const body = await search("?type=workflow&q=regression");
    expect(body.map((b) => b.name)).toEqual(["nightly"]);
  });

  test("a query matching nothing returns [] (filter rejects every entry)", async () => {
    workflowFixtures = [wf("deploy", "ship it")];
    expect(await search("?type=workflow&q=zzzzzz")).toEqual([]);
  });

  test("ranked results are ordered best-score-first", async () => {
    // `deploy` is an exact prefix; `dxexpxlxoxy` only matches as a scattered
    // subsequence, so it must rank lower. Exercises the `.sort()` comparator.
    workflowFixtures = [wf("dxexpxlxoxy", "scattered"), wf("deploy", "exact")];
    const body = await search("?type=workflow&q=deploy");
    expect(body[0]!.name).toBe("deploy");
    expect(body).toHaveLength(2);
  });

  test("caps at MAX_RESULTS (10)", async () => {
    workflowFixtures = Array.from({ length: 25 }, (_, i) => wf(`wf-${i}`));
    expect(await search("?type=workflow")).toHaveLength(10);
  });

  test("no projectId gate — workflows are global", async () => {
    // `workflow_definitions` has no project column. feature/lesson return []
    // without a projectId; workflow must NOT.
    workflowFixtures = [wf("deploy")];
    expect(await search("?type=workflow")).toHaveLength(1);
    expect(await search("?type=workflow&projectId=whatever")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// mergeGlobalBangKind — the bare-`!` fallback
// ─────────────────────────────────────────────────────────────────────

describe("GET /api/mentions/search (bare `!`) — global-kind merges", () => {
  test("merges BOTH EZ actions and workflows, EZ first", async () => {
    ezActionFixtures = [{ name: "distill", description: "force a distill" }];
    workflowFixtures = [wf("deploy", "ship it")];
    const body = await search("");
    expect(body).toEqual([
      { name: "distill", description: "force a distill", kind: "EZ" },
      { name: "deploy", description: "ship it", kind: "workflow" },
    ]);
  });

  test("typing a kind label surfaces ALL of that kind (isKindPrefix path)", async () => {
    // No workflow name or description contains "wo" — only the kind-label
    // rule can surface them. Same rule that makes `!e` list EZ actions.
    ezActionFixtures = [];
    workflowFixtures = [wf("deploy", "ship it"), wf("nightly", "sweep")];
    for (const q of ["w", "wo", "workflow"]) {
      const body = await search(`?q=${q}`);
      expect(body.map((b) => b.name)).toEqual(["deploy", "nightly"]);
    }
  });

  test("a non-label query substring-matches on name", async () => {
    ezActionFixtures = [];
    workflowFixtures = [wf("deploy", "ship it"), wf("nightly", "sweep")];
    const body = await search("?q=deploy");
    expect(body.map((b) => b.name)).toEqual(["deploy"]);
  });

  test("a non-label query substring-matches on description", async () => {
    ezActionFixtures = [];
    workflowFixtures = [wf("deploy", "ship it"), wf("nightly", "sweep")];
    const body = await search("?q=sweep");
    expect(body.map((b) => b.name)).toEqual(["nightly"]);
  });

  test("a non-label query matching neither field drops the entry", async () => {
    ezActionFixtures = [];
    workflowFixtures = [wf("deploy", "ship it")];
    expect(await search("?q=zzzzzz")).toEqual([]);
  });

  test("the merge stops at MAX_RESULTS (the loop's break)", async () => {
    ezActionFixtures = [];
    workflowFixtures = Array.from({ length: 25 }, (_, i) => wf(`wf-${i}`));
    expect(await search("")).toHaveLength(10);
  });

  test("a full result set short-circuits the second merge without pushing", async () => {
    // EZ alone fills the budget; the workflow merge then breaks on its first
    // iteration and contributes nothing.
    ezActionFixtures = Array.from({ length: 12 }, (_, i) => ({
      name: `ez-${i}`,
      description: "ez action",
    }));
    workflowFixtures = [wf("deploy")];
    const body = await search("");
    expect(body).toHaveLength(10);
    expect(body.every((b) => b.kind === "EZ")).toBe(true);
  });

  for (const siblingType of ["agent", "ext", "team"]) {
    test(`\`!${siblingType}:\` filters both global kinds out of the merge`, async () => {
      ezActionFixtures = [{ name: "distill", description: "d" }];
      workflowFixtures = [wf("deploy")];
      const body = await search(`?type=${siblingType}`);
      expect(body.map((b) => b.kind)).not.toContain("workflow");
      expect(body.map((b) => b.kind)).not.toContain("EZ");
    });
  }
});
