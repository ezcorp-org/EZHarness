import { test, expect } from "./fixtures/test-base.js";
import { makeWorkflow, makeAgent } from "./fixtures/data.js";

// Fills coverage gaps left by `workflows.spec.ts` (list/detail) and
// `workflows-new.spec.ts` (create form). Those specs assert the static
// surface; this one drives the *interactions* — running, deleting,
// editing multi-step workflows, and rendering of step metadata that
// other specs never construct (input mapping, dependsOn, loop iterations).

test.describe("Workflows — interactions and rendering gaps", () => {
	// ── Run flow ────────────────────────────────────────────────────

	test("triggering a run posts JSON input and renders Run History from SSE", async ({ page, mockApi, emitSse }) => {
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

	test("workflow:error SSE flips the Run History row to the error status", async ({ page, mockApi, emitSse }) => {
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
				},
			},
		});

		// The status badge uses statusColor.error → text-red-400. Both the
		// run-level badge and the step-level status share that class.
		const errorStatus = page.locator(".text-red-400", { hasText: "error" });
		await expect(errorStatus.first()).toBeVisible();
	});

	test("a looped step's iteration count renders in Run History", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			workflows: [makeWorkflow({ name: "loopy", steps: [{ name: "count", agent: "alpha" }] })],
		});
		await page.route("**/api/workflows/loopy/run", (route) =>
			route.fulfill({
				json: { id: "run-loop", workflowName: "loopy", status: "running", startedAt: Date.now(), steps: [] },
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

	test("invalid JSON in the run input shows a parse error and does not POST", async ({ page, mockApi }) => {
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

	test("delete workflow confirms inline (two-step), fires DELETE, and navigates to list", async ({ page, mockApi }) => {
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

	// ── Builder: multi-step + dependency checkbox + remove ──────────

	test("builder adds, links, and removes steps, then submits the right shape", async ({ page, mockApi }) => {
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
		test.skip(finalUrl !== "/workflows/new", "auth gate redirected away from /workflows/new in this environment");

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
		expect(postBody.steps[1]).toMatchObject({ name: "step-2", agent: "beta", dependsOn: ["step-1"] });
	});

	// ── Builder: per-step validation ────────────────────────────────

	test("builder validation rejects a step without an agent selected", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "alpha" })],
			workflows: [],
		});

		const response = await page.goto("/workflows/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/workflows/new", "auth gate redirected away from /workflows/new in this environment");

		await page.getByLabel("Workflow Name").fill("noagent");
		// Deliberately leave the Agent select on the empty default.
		await page.getByRole("button", { name: "Save Workflow" }).click();

		await expect(page.getByText('Step "step-1" (agent) needs an agent')).toBeVisible({ timeout: 3000 });
		await expect(page).toHaveURL(/\/workflows\/new$/);
	});
});
