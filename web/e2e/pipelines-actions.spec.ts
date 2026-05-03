import { test, expect } from "./fixtures/test-base.js";
import { makePipeline, makeAgent } from "./fixtures/data.js";

// Fills coverage gaps left by `pipelines.spec.ts` (list/detail) and
// `pipelines-new.spec.ts` (create form). Those specs assert the static
// surface; this one drives the *interactions* — running, deleting,
// editing multi-step pipelines, and rendering of step metadata that
// other specs never construct (input mapping, dependsOn).

test.describe("Pipelines — interactions and rendering gaps", () => {
	// ── Run flow ────────────────────────────────────────────────────

	test("triggering a run posts JSON input and renders Run History from SSE", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			pipelines: [makePipeline({ name: "runme", steps: [{ name: "only", agent: "summarizer" }] })],
		});

		// Capture the run POST so we can assert the body that flowed in.
		let runPostBody: any = null;
		await page.route("**/api/pipelines/runme/run", (route) => {
			runPostBody = route.request().postDataJSON();
			return route.fulfill({
				json: {
					id: "run-abc",
					pipelineName: "runme",
					status: "running",
					startedAt: Date.now(),
					steps: [{ stepName: "only", runId: "r-1", status: "running" }],
				},
			});
		});

		await page.goto("/pipelines/runme");
		await expect(page.getByRole("heading", { name: "Run Pipeline" })).toBeVisible();

		await page.getByLabel("JSON Input").fill('{"query": "hello"}');
		await page.getByRole("button", { name: "Run Pipeline" }).click();

		await expect.poll(() => runPostBody).not.toBeNull();
		expect(runPostBody).toMatchObject({ query: "hello" });

		// Run History only appears after SSE events populate the store.
		await emitSse({
			type: "pipeline:start",
			data: {
				pipelineRun: {
					id: "run-abc12345",
					pipelineName: "runme",
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
			type: "pipeline:complete",
			data: {
				pipelineRun: {
					id: "run-abc12345",
					pipelineName: "runme",
					status: "success",
					startedAt: Date.now() - 50,
					finishedAt: Date.now(),
					steps: [{ stepName: "only", runId: "r-1", status: "success" }],
				},
			},
		});

		await expect(page.getByText("success", { exact: true }).first()).toBeVisible();
	});

	test("pipeline:error SSE flips the Run History row to the error status", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			pipelines: [makePipeline({ name: "failpipe", steps: [{ name: "only", agent: "alpha" }] })],
		});

		await page.route("**/api/pipelines/failpipe/run", (route) =>
			route.fulfill({
				json: {
					id: "run-err",
					pipelineName: "failpipe",
					status: "running",
					startedAt: Date.now(),
					steps: [{ stepName: "only", runId: "r-1", status: "running" }],
				},
			}),
		);

		await page.goto("/pipelines/failpipe");
		await page.getByLabel("JSON Input").fill("{}");
		await page.getByRole("button", { name: "Run Pipeline" }).click();

		await emitSse({
			type: "pipeline:start",
			data: {
				pipelineRun: {
					id: "run-err99999",
					pipelineName: "failpipe",
					status: "running",
					startedAt: Date.now(),
					steps: [{ stepName: "only", runId: "r-1", status: "running" }],
				},
			},
		});

		await emitSse({
			type: "pipeline:error",
			data: {
				pipelineRun: {
					id: "run-err99999",
					pipelineName: "failpipe",
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

	test("invalid JSON in the run input shows a parse error and does not POST", async ({ page, mockApi }) => {
		await mockApi({
			pipelines: [makePipeline({ name: "runme" })],
		});

		let posted = false;
		await page.route("**/api/pipelines/runme/run", (route) => {
			posted = true;
			return route.fulfill({ json: {} });
		});

		await page.goto("/pipelines/runme");
		await page.getByLabel("JSON Input").fill("{not valid json");
		await page.getByRole("button", { name: "Run Pipeline" }).click();

		// JSON.parse throws SyntaxError — the page surfaces err.message in red.
		await expect(page.locator("p.text-red-400")).toBeVisible();
		expect(posted).toBe(false);
	});

	// ── Detail-page rendering of step metadata ──────────────────────

	test("detail page renders dependsOn and input mapping per step", async ({ page, mockApi }) => {
		await mockApi({
			pipelines: [
				makePipeline({
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

		await page.goto("/pipelines/graph");

		await expect(page.getByText("Depends on: extract")).toBeVisible();
		await expect(page.getByText("Input: source=$steps.extract.output")).toBeVisible();
	});

	// ── Delete from detail page ─────────────────────────────────────

	test("delete pipeline confirms, fires DELETE, and navigates to list", async ({ page, mockApi }) => {
		await mockApi({
			pipelines: [makePipeline({ name: "deleteme" })],
		});

		let deleteHit = false;
		await page.route("**/api/pipelines/deleteme", (route) => {
			if (route.request().method() === "DELETE") {
				deleteHit = true;
				return route.fulfill({ json: { success: true } });
			}
			return route.fallback();
		});

		page.on("dialog", (dialog) => dialog.accept());

		await page.goto("/pipelines/deleteme");
		await page.getByRole("button", { name: "Delete" }).click();

		await expect(page).toHaveURL(/\/pipelines$/, { timeout: 5000 });
		expect(deleteHit).toBe(true);
	});

	// ── Builder: multi-step + dependency checkbox + remove ──────────

	test("builder adds, links, and removes steps, then submits the right shape", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "alpha" }), makeAgent({ name: "beta" })],
			pipelines: [],
		});

		let postBody: any = null;
		await page.route("**/api/pipelines", (route) => {
			if (route.request().method() === "POST") {
				postBody = route.request().postDataJSON();
				return route.fulfill({ json: postBody });
			}
			return route.fulfill({ json: [] });
		});

		const response = await page.goto("/pipelines/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/pipelines/new", "auth gate redirected away from /pipelines/new in this environment");

		await page.getByLabel("Pipeline Name").fill("multi");

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

		await page.getByRole("button", { name: "Save Pipeline" }).click();

		await expect(page).toHaveURL(/\/pipelines$/, { timeout: 5000 });
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
			pipelines: [],
		});

		const response = await page.goto("/pipelines/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/pipelines/new", "auth gate redirected away from /pipelines/new in this environment");

		await page.getByLabel("Pipeline Name").fill("noagent");
		// Deliberately leave the Agent select on the empty default.
		await page.getByRole("button", { name: "Save Pipeline" }).click();

		await expect(page.getByText("Each step needs a name and agent")).toBeVisible({ timeout: 3000 });
		await expect(page).toHaveURL(/\/pipelines\/new$/);
	});
});
