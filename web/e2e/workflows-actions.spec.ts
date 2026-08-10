import { test, expect } from "./fixtures/test-base.js";
import { makeWorkflow, makeAgent } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

// Fills coverage gaps left by `workflows.spec.ts` (list/detail) and
// `workflows-new.spec.ts` (create form). Those specs assert the static
// surface; this one drives the *interactions* — running, deleting,
// editing multi-step workflows, and rendering of step metadata that
// other specs never construct (input mapping, dependsOn, loop iterations).

test.describe("Workflows — interactions and rendering gaps", () => {
  // ── Run flow ────────────────────────────────────────────────────

  test("triggering a run posts JSON input and renders Run History from SSE", async ({
    page,
    mockApi,
    emitSse,
  }) => {
    await mockApi({
      workflows: [makeWorkflow({ name: "runme", steps: [{ name: "only", agent: "summarizer" }] })],
    });

    // Capture the run POST so we can assert the body that flowed in.
    let runPostBody: any = null;
    await page.route("**/api/workflows/runme/run", (route) => {
      runPostBody = route.request().postDataJSON();
      return route.fulfill({
        json: {
          id: "run-abc",
          workflowName: "runme",
          status: "running",
          startedAt: Date.now(),
          steps: [{ stepName: "only", runId: "r-1", status: "running" }],
        },
      });
    });

    await page.goto("/workflows/runme");
    await expect(page.getByRole("heading", { name: "Run Workflow" })).toBeVisible();

    await page.getByLabel("JSON Input").fill('{"query": "hello"}');
    await page.getByRole("button", { name: "Run Workflow" }).click();

    await expect.poll(() => runPostBody).not.toBeNull();
    expect(runPostBody).toMatchObject({ query: "hello" });

    // Run History only appears after SSE events populate the store.
    await emitSse({
      type: "workflow:start",
      data: {
        workflowRun: {
          id: "run-abc12345",
          workflowName: "runme",
          status: "running",
          startedAt: Date.now(),
          steps: [{ stepName: "only", runId: "r-1", status: "running" }],
        },
      },
    });

    const history = page.getByRole("heading", { name: "Run History" });
    await expect(history).toBeVisible();
    await expect(page.getByText("run-abc1", { exact: false })).toBeVisible();
    await expect(page.getByText("running", { exact: true }).first()).toBeVisible();

    // Completion event flips status to success.
    await emitSse({
      type: "workflow:complete",
      data: {
        workflowRun: {
          id: "run-abc12345",
          workflowName: "runme",
          status: "success",
          startedAt: Date.now() - 50,
          finishedAt: Date.now(),
          steps: [{ stepName: "only", runId: "r-1", status: "success" }],
        },
      },
    });

    await expect(page.getByText("success", { exact: true }).first()).toBeVisible();
  });

  test("workflow:error SSE flips the Run History row to the error status", async ({
    page,
    mockApi,
    emitSse,
  }) => {
    await mockApi({
      workflows: [makeWorkflow({ name: "failflow", steps: [{ name: "only", agent: "alpha" }] })],
    });

    await page.route("**/api/workflows/failflow/run", (route) =>
      route.fulfill({
        json: {
          id: "run-err",
          workflowName: "failflow",
          status: "running",
          startedAt: Date.now(),
          steps: [{ stepName: "only", runId: "r-1", status: "running" }],
        },
      }),
    );

    await page.goto("/workflows/failflow");
    await page.getByLabel("JSON Input").fill("{}");
    await page.getByRole("button", { name: "Run Workflow" }).click();

    await emitSse({
      type: "workflow:start",
      data: {
        workflowRun: {
          id: "run-err99999",
          workflowName: "failflow",
          status: "running",
          startedAt: Date.now(),
          steps: [{ stepName: "only", runId: "r-1", status: "running" }],
        },
      },
    });

    await emitSse({
      type: "workflow:error",
      data: {
        workflowRun: {
          id: "run-err99999",
          workflowName: "failflow",
          status: "error",
          startedAt: Date.now() - 50,
          finishedAt: Date.now(),
          steps: [{ stepName: "only", runId: "r-1", status: "error" }],
          result: {
            success: false,
            output: null,
            error: 'Step "only" exhausted 3 iterations without meeting its until-condition',
          },
        },
      },
    });

    // The status badge uses statusColor.error → text-red-400. Both the
    // run-level badge and the step-level status share that class.
    const errorStatus = page.locator(".text-red-400", { hasText: "error" });
    await expect(errorStatus.first()).toBeVisible();

    // Loud failure: the run's error MESSAGE renders on the detail page,
    // not just the red status pill.
    await expect(page.getByTestId("run-error")).toHaveText(
      'Step "only" exhausted 3 iterations without meeting its until-condition',
    );
  });

  test("a looped step's iteration count renders in Run History", async ({
    page,
    mockApi,
    emitSse,
  }) => {
    await mockApi({
      workflows: [makeWorkflow({ name: "loopy", steps: [{ name: "count", agent: "alpha" }] })],
    });
    await page.route("**/api/workflows/loopy/run", (route) =>
      route.fulfill({
        json: {
          id: "run-loop",
          workflowName: "loopy",
          status: "running",
          startedAt: Date.now(),
          steps: [],
        },
      }),
    );

    await page.goto("/workflows/loopy");
    await page.getByLabel("JSON Input").fill("{}");
    await page.getByRole("button", { name: "Run Workflow" }).click();

    // Register the run via start before the terminal event updates it.
    await emitSse({
      type: "workflow:start",
      data: {
        workflowRun: {
          id: "run-loop123",
          workflowName: "loopy",
          status: "running",
          startedAt: Date.now(),
          steps: [],
        },
      },
    });
    await emitSse({
      type: "workflow:complete",
      data: {
        workflowRun: {
          id: "run-loop123",
          workflowName: "loopy",
          status: "success",
          startedAt: Date.now() - 50,
          finishedAt: Date.now(),
          steps: [{ stepName: "count", runId: "", status: "success", iterations: 3 }],
        },
      },
    });

    await expect(page.getByText("(3 iterations)")).toBeVisible();
  });

  test("invalid JSON in the run input shows a parse error and does not POST", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      workflows: [makeWorkflow({ name: "runme" })],
    });

    let posted = false;
    await page.route("**/api/workflows/runme/run", (route) => {
      posted = true;
      return route.fulfill({ json: {} });
    });

    await page.goto("/workflows/runme");
    await page.getByLabel("JSON Input").fill("{not valid json");
    await page.getByRole("button", { name: "Run Workflow" }).click();

    // JSON.parse throws SyntaxError — the page surfaces err.message in red.
    await expect(page.locator("p.text-red-400")).toBeVisible();
    expect(posted).toBe(false);
  });

  // ── Detail-page rendering of step metadata ──────────────────────

  test("detail page renders dependsOn and input mapping per step", async ({ page, mockApi }) => {
    await mockApi({
      workflows: [
        makeWorkflow({
          name: "graph",
          steps: [
            { name: "extract", agent: "extractor" },
            {
              name: "transform",
              agent: "transformer",
              input: { source: "$steps.extract.output" },
              dependsOn: ["extract"],
            },
          ],
        }),
      ],
    });

    await page.goto("/workflows/graph");

    await expect(page.getByText("Depends on: extract")).toBeVisible();
    await expect(page.getByText("Input: source=$steps.extract.output")).toBeVisible();
  });

  // ── Delete from detail page ─────────────────────────────────────

  test("delete workflow confirms inline (two-step), fires DELETE, and navigates to list", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      workflows: [makeWorkflow({ name: "deleteme" })],
    });

    let deleteHit = false;
    await page.route("**/api/workflows/deleteme", (route) => {
      if (route.request().method() === "DELETE") {
        deleteHit = true;
        return route.fulfill({ json: { success: true } });
      }
      return route.fallback();
    });

    await page.goto("/workflows/deleteme");
    // First click arms the inline confirm (no native dialog — see PR #112).
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("button", { name: "Confirm delete?" })).toBeVisible();
    // Second click performs the delete.
    await page.getByRole("button", { name: "Confirm delete?" }).click();

    await expect(page).toHaveURL(/\/workflows$/, { timeout: 5000 });
    expect(deleteHit).toBe(true);
  });

  test("a failed DELETE surfaces an error message and stays on the page", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      workflows: [makeWorkflow({ name: "sticky" })],
    });

    await page.route("**/api/workflows/sticky", (route) => {
      if (route.request().method() === "DELETE") {
        return route.fulfill({ status: 500, json: { error: "boom" } });
      }
      return route.fallback();
    });

    await page.goto("/workflows/sticky");
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Confirm delete?" }).click();

    await expect(page.getByTestId("delete-error")).toBeVisible();
    await expect(page).toHaveURL(/\/workflows\/sticky$/);
  });

  // ── Builder: multi-step + dependency checkbox + remove ──────────

  test("builder adds, links, and removes steps, then submits the right shape", async ({
    page,
    mockApi,
  }) => {
    await mockApi({
      agents: [makeAgent({ name: "alpha" }), makeAgent({ name: "beta" })],
      workflows: [],
    });

    let postBody: any = null;
    await page.route("**/api/workflows", (route) => {
      if (route.request().method() === "POST") {
        postBody = route.request().postDataJSON();
        return route.fulfill({ json: postBody });
      }
      return route.fulfill({ json: [] });
    });

    const response = await page.goto("/workflows/new");
    const finalUrl = response ? new URL(response.url()).pathname : "";
    test.skip(
      finalUrl !== "/workflows/new",
      "auth gate redirected away from /workflows/new in this environment",
    );

    await page.getByLabel("Workflow Name").fill("multi");

    // Step 1 — keep default name "step-1", pick an agent.
    await page.getByLabel("Agent").first().selectOption("alpha");

    // Add step 2.
    await page.getByRole("button", { name: "+ Add Step" }).click();
    await page.getByLabel("Agent").nth(1).selectOption("beta");

    // Step 2 should now have a "Depends On" checkbox for step-1 (the
    // only other step). Toggle it on.
    await page.getByRole("checkbox", { name: "step-1" }).check();

    // Add a third step, then remove it — proves the remove path
    // also strips dependsOn references (covered by removeStep()).
    await page.getByRole("button", { name: "+ Add Step" }).click();
    await page.locator("button", { hasText: "Remove" }).nth(2).click();

    await page.getByRole("button", { name: "Save Workflow" }).click();

    await expect(page).toHaveURL(/\/workflows$/, { timeout: 5000 });
    expect(postBody).not.toBeNull();
    expect(postBody.name).toBe("multi");
    expect(postBody.steps).toHaveLength(2);
    expect(postBody.steps[0]).toMatchObject({ name: "step-1", agent: "alpha" });
    expect(postBody.steps[1]).toMatchObject({
      name: "step-2",
      agent: "beta",
      dependsOn: ["step-1"],
    });
  });

  // ── Builder: per-step validation ────────────────────────────────

  test("builder validation rejects a step without an agent selected", async ({ page, mockApi }) => {
    await mockApi({
      agents: [makeAgent({ name: "alpha" })],
      workflows: [],
    });

    const response = await page.goto("/workflows/new");
    const finalUrl = response ? new URL(response.url()).pathname : "";
    test.skip(
      finalUrl !== "/workflows/new",
      "auth gate redirected away from /workflows/new in this environment",
    );

    await page.getByLabel("Workflow Name").fill("noagent");
    // Deliberately leave the Agent select on the empty default.
    await page.getByRole("button", { name: "Save Workflow" }).click();

    await expect(page.getByText('Step "step-1" (agent) needs an agent')).toBeVisible({
      timeout: 3000,
    });
    await expect(page).toHaveURL(/\/workflows\/new$/);
  });
});

// ── Inline editing, duplicate, and the canEdit gate ────────────────
//
// Editing lives ON the detail page rather than a separate route: authoring
// is a fix→save→run loop (refs resolve strictly and throw on a miss), so
// each lap must not cost two navigations or discard the typed JSON input.

test.describe("Workflows — inline editing", () => {
  const editable = makeWorkflow({
    name: "editme",
    description: "before",
    steps: [{ name: "fetch", agent: "alpha", input: { q: "$input.query" } }] as never,
  });

  async function gotoDetail(page: Page, name: string) {
    const response = await page.goto(`/workflows/${name}`);
    const finalUrl = response ? new URL(response.url()).pathname : "";
    test.skip(
      !finalUrl.startsWith("/workflows/"),
      "auth gate redirected away from the workflow detail page in this environment",
    );
  }

  test("Edit swaps the step list for the builder in place and PUTs the edited definition", async ({
    page,
    mockApi,
  }) => {
    await mockApi({ workflows: [editable], agents: [makeAgent({ name: "alpha" })] });

    let putBody: any = null;
    let putUrl = "";
    await page.route("**/api/workflows/editme", (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      putUrl = route.request().url();
      putBody = route.request().postDataJSON();
      return route.fulfill({ json: putBody });
    });

    await gotoDetail(page, "editme");
    // Read-only view first.
    await expect(page.getByTestId("workflow-steps-view")).toBeVisible();

    await page.getByTestId("workflow-edit").click();

    // The builder replaced the step list, prefilled from the stored steps.
    // (Targeted by test id, not the "Steps" heading — the builder renders
    // a heading by that name too.)
    await expect(page.getByTestId("workflow-steps-view")).toBeHidden();
    await expect(page.getByLabel("Workflow Name")).toHaveValue("editme");
    await expect(page.getByLabel("Step Name")).toHaveValue("fetch");
    // The input mapping survived the record→pairs inflation.
    await expect(page.getByPlaceholder("$input.x or $prev.output")).toHaveValue("$input.query");

    // Change an input ref — the canonical reason to edit at all.
    await page.getByPlaceholder("$input.x or $prev.output").fill("$input.topic");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect.poll(() => putBody).not.toBeNull();
    expect(putUrl).toContain("/api/workflows/editme");
    expect(putBody.steps[0].input).toEqual({ q: "$input.topic" });
    // Provenance fields are server-derived and the body schema is strict —
    // sending them back would 400.
    expect(putBody).not.toHaveProperty("canEdit");
    expect(putBody).not.toHaveProperty("source");
  });

  test("the Run panel is hidden while editing and returns on cancel", async ({ page, mockApi }) => {
    // Run posts the SAVED definition; leaving it live beside unsaved edits
    // invites running the old graph and misreading the result.
    await mockApi({ workflows: [editable], agents: [makeAgent({ name: "alpha" })] });
    await gotoDetail(page, "editme");

    await expect(page.getByRole("heading", { name: "Run Workflow" })).toBeVisible();
    await page.getByTestId("workflow-edit").click();
    await expect(page.getByRole("heading", { name: "Run Workflow" })).toBeHidden();

    await page.getByTestId("workflow-builder-cancel").click();
    await expect(page.getByRole("heading", { name: "Run Workflow" })).toBeVisible();
    await expect(page.getByTestId("workflow-steps-view")).toBeVisible();
    await expect(page.getByLabel("Workflow Name")).toBeHidden();
  });

  test("renaming on save navigates to the new name", async ({ page, mockApi }) => {
    // The page is keyed by name, so staying put would render "not found"
    // for the name that was just freed.
    await mockApi({ workflows: [editable], agents: [makeAgent({ name: "alpha" })] });
    await page.route("**/api/workflows/editme", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ json: route.request().postDataJSON() })
        : route.fallback(),
    );

    await gotoDetail(page, "editme");
    await page.getByTestId("workflow-edit").click();
    await page.getByLabel("Workflow Name").fill("renamed");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page).toHaveURL(/\/workflows\/renamed$/, { timeout: 5000 });
  });

  test("a failed save surfaces the error and keeps the editor open", async ({ page, mockApi }) => {
    await mockApi({ workflows: [editable], agents: [makeAgent({ name: "alpha" })] });
    await page.route("**/api/workflows/editme", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({
            status: 403,
            json: { error: "Only the workflow's owner or an admin can update it" },
          })
        : route.fallback(),
    );

    await gotoDetail(page, "editme");
    await page.getByTestId("workflow-edit").click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByTestId("workflow-edit-error")).toBeVisible({ timeout: 5000 });
    // Still editing — the user's changes are not thrown away on failure.
    await expect(page.getByLabel("Workflow Name")).toBeVisible();
  });

  test("Edit and Delete are hidden on a workflow the caller cannot manage", async ({
    page,
    mockApi,
  }) => {
    // A YAML demo is a file on disk: PUT/DELETE 404. Painting the buttons
    // would only teach the user to discover that by clicking.
    await mockApi({
      workflows: [makeWorkflow({ name: "demo-mixed", source: "yaml", canEdit: false })],
      agents: [makeAgent({ name: "alpha" })],
    });
    await gotoDetail(page, "demo-mixed");

    await expect(page.getByRole("heading", { name: "demo-mixed" })).toBeVisible();
    await expect(page.getByTestId("workflow-edit")).toHaveCount(0);
    await expect(page.getByTestId("workflow-delete")).toHaveCount(0);
    // Duplicate stays — it is the only productive action on a read-only demo.
    await expect(page.getByTestId("workflow-duplicate")).toBeVisible();
  });

  test("Duplicate copies a read-only demo into a workflow of your own", async ({
    page,
    mockApi,
  }) => {
    // This used to navigate to `/workflows/new?from=demo-mixed` and prefill
    // the create form — the client-side half of the two copy affordances.
    // The single verb keeps the escape hatch (a YAML demo is copyable) and
    // keeps the deciding (name + audience before the write), but the copy
    // is now made server-side, where `forked_from` provenance and the
    // global name-collision rule live.
    await mockApi({
      workflows: [
        makeWorkflow({
          name: "demo-mixed",
          source: "yaml",
          canEdit: false,
          description: "shipped demo",
          steps: [
            {
              name: "compose",
              kind: "transform",
              output: { headline: "Report on {{$input.topic}}" },
            },
            {
              name: "gate-it",
              kind: "gate",
              dependsOn: ["compose"],
              condition: { ref: "$steps.compose.output.headline", op: "contains", value: "Report" },
            },
          ] as never,
        }),
      ],
      agents: [makeAgent({ name: "alpha" })],
    });

    let postBody: any = null;
    await page.route("**/api/workflows/demo-mixed/fork", (route) => {
      postBody = route.request().postDataJSON();
      return route.fulfill({
        status: 201,
        json: {
          name: "demo-mixed-copy",
          id: "wf-copy",
          forkedFrom: "demo-mixed",
          visibility: "private",
        },
      });
    });

    await gotoDetail(page, "demo-mixed");
    await page.getByTestId("workflow-duplicate").click();

    // Still on the detail page — the click asks, it does not write.
    await expect(page).toHaveURL(/\/workflows\/demo-mixed$/);
    await expect(page.getByTestId("duplicate-name")).toHaveValue("demo-mixed-copy");

    await page.getByTestId("duplicate-confirm").click();
    await expect.poll(() => postBody).not.toBeNull();
    expect(postBody.name).toBe("demo-mixed-copy");
    expect(postBody.visibility).toBe("private");
    await expect(page).toHaveURL(/\/workflows\/demo-mixed-copy\/edit$/, { timeout: 5000 });
  });
});
