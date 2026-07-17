import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeWorkflow, makeAgent } from "./fixtures/data.js";

// Drives the two deterministic demo workflows (demo-deterministic and
// demo-loop-counter) through the real UI. The definitions mirror the shipped
// src/agents/*.workflow.yaml; the run itself is served via the mocked run
// endpoint + SSE (the same transport the app uses), so this asserts the
// browser-only surface: per-step status rendering and the loop iteration
// count. The UI rename + new step-form fields are a frontend-visual change,
// so the final test is `@evidence`-tagged and captures screenshots.

const demoDeterministic = makeWorkflow({
	name: "demo-deterministic",
	description: "Zero-LLM reshape + gate + publish; identical input ⇒ identical output.",
	steps: [
		{ name: "compose", kind: "transform", output: { headline: "Report on {{$input.topic}}" } },
		{ name: "assert-composed", kind: "gate", dependsOn: ["compose"], condition: { ref: "$steps.compose.output.headline", op: "contains", value: "Report on" } },
		{ name: "publish", kind: "transform", dependsOn: ["assert-composed"], output: { headline: "$steps.compose.output.headline" } },
	] as any,
});

const demoLoopCounter = makeWorkflow({
	name: "demo-loop-counter",
	description: "A transform loop that counts to 3 via $loop.iteration / $loop.last.",
	steps: [
		{
			name: "count",
			kind: "transform",
			output: { n: "$loop.iteration", previous: "$loop.last.output.n" },
			loop: { maxIterations: 5, onExhausted: "fail" },
		},
	] as any,
});

test.describe("Workflow demos — run through the UI", () => {
	test("demo-deterministic reports per-step success in Run History", async ({ page, mockApi, emitSse }) => {
		await mockApi({ workflows: [demoDeterministic] });
		await page.route("**/api/workflows/demo-deterministic/run", (route) =>
			route.fulfill({
				json: { id: "wr-det", workflowName: "demo-deterministic", status: "running", startedAt: Date.now(), steps: [] },
			}),
		);

		await page.goto("/workflows/demo-deterministic");
		await page.getByLabel("JSON Input").fill('{"topic": "workflows"}');
		await page.getByRole("button", { name: "Run Workflow" }).click();

		// Real executor emits start (registers the run) before the terminal
		// event updates it — mirror that order so the run is in the store.
		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: "wr-det-9999",
					workflowName: "demo-deterministic",
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
					id: "wr-det-9999",
					workflowName: "demo-deterministic",
					status: "success",
					startedAt: Date.now() - 20,
					finishedAt: Date.now(),
					steps: [
						{ stepName: "compose", runId: "", status: "success" },
						{ stepName: "assert-composed", runId: "", status: "success" },
						{ stepName: "publish", runId: "", status: "success" },
					],
				},
			},
		});

		await expect(page.getByRole("heading", { name: "Run History" })).toBeVisible();
		// All three steps plus the run itself render "success".
		await expect(page.getByText("success", { exact: true })).toHaveCount(4);
	});

	test("demo-loop-counter reports iterations: 3 for its looped step", async ({ page, mockApi, emitSse }) => {
		await mockApi({ workflows: [demoLoopCounter] });
		await page.route("**/api/workflows/demo-loop-counter/run", (route) =>
			route.fulfill({
				json: { id: "wr-loop", workflowName: "demo-loop-counter", status: "running", startedAt: Date.now(), steps: [] },
			}),
		);

		await page.goto("/workflows/demo-loop-counter");
		await page.getByLabel("JSON Input").fill("{}");
		await page.getByRole("button", { name: "Run Workflow" }).click();

		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: "wr-loop-777",
					workflowName: "demo-loop-counter",
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
					id: "wr-loop-777",
					workflowName: "demo-loop-counter",
					status: "success",
					startedAt: Date.now() - 30,
					finishedAt: Date.now(),
					steps: [{ stepName: "count", runId: "", status: "success", iterations: 3 }],
				},
			},
		});

		await expect(page.getByRole("heading", { name: "Run History" })).toBeVisible();
		await expect(page.getByText("(3 iterations)")).toBeVisible();
		await expect(page.getByText("count", { exact: false }).first()).toBeVisible();
	});

	test("workflows list, builder, and a completed loop run render correctly @evidence", async ({ page, mockApi, emitSse }, testInfo) => {
		// 1) List view with both demos.
		await mockApi({
			workflows: [demoDeterministic, demoLoopCounter],
			agents: [makeAgent({ name: "summarizer" })],
		});
		await page.goto("/workflows");
		await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
		await expect(page.getByText("demo-loop-counter")).toBeVisible();
		await captureEvidence(page, testInfo, "workflows-list");

		// 2) Builder (New Workflow) with the new step-kind fields. Assert we
		//    actually landed on the builder (rather than silently skipping the
		//    evidence capture when the route redirects elsewhere).
		const newResp = await page.goto("/workflows/new");
		expect(newResp ? new URL(newResp.url()).pathname : "").toBe("/workflows/new");
		await expect(page.getByRole("heading", { name: "New Workflow" })).toBeVisible();
		await expect(page.getByLabel("Kind")).toBeVisible();
		await captureEvidence(page, testInfo, "workflows-new-builder");

		// 3) Run-detail view with a completed loop run (per-step status + iterations).
		await page.route("**/api/workflows/demo-loop-counter/run", (route) =>
			route.fulfill({
				json: { id: "wr-ev", workflowName: "demo-loop-counter", status: "running", startedAt: Date.now(), steps: [] },
			}),
		);
		await page.goto("/workflows/demo-loop-counter");
		await page.getByLabel("JSON Input").fill("{}");
		await page.getByRole("button", { name: "Run Workflow" }).click();
		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: "wr-ev-42",
					workflowName: "demo-loop-counter",
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
					id: "wr-ev-42",
					workflowName: "demo-loop-counter",
					status: "success",
					startedAt: Date.now() - 30,
					finishedAt: Date.now(),
					steps: [{ stepName: "count", runId: "", status: "success", iterations: 3 }],
				},
			},
		});
		await expect(page.getByText("(3 iterations)")).toBeVisible();
		await captureEvidence(page, testInfo, "workflows-run-detail");

		// 4) Failed run: the loud error MESSAGE (until-exhaustion) renders on
		//    the detail page — the loud-failure pillar's visible end.
		//    (workflow:error only updates runs already registered via start.)
		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: "wr-ev-43",
					workflowName: "demo-loop-counter",
					status: "running",
					startedAt: Date.now() - 30,
					steps: [],
				},
			},
		});
		await emitSse({
			type: "workflow:error",
			data: {
				workflowRun: {
					id: "wr-ev-43",
					workflowName: "demo-loop-counter",
					status: "error",
					startedAt: Date.now() - 30,
					finishedAt: Date.now(),
					steps: [{ stepName: "count", runId: "", status: "error", iterations: 5 }],
					result: {
						success: false,
						output: null,
						error: 'Step "count" exhausted 5 iterations without meeting its until-condition',
					},
				},
			},
		});
		await expect(
			page.getByText('Step "count" exhausted 5 iterations without meeting its until-condition'),
		).toBeVisible();
		await captureEvidence(page, testInfo, "workflows-run-failure-detail");
	});
});
