import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";

/**
 * The run trace — DAG, timeline, per-step telemetry, loop iterations and
 * "Retry from here".
 *
 * The route and the display logic are unit-tested. What only an e2e can
 * show is that the page ASSEMBLES them: that a null token count reaches
 * the cell as a dash rather than a zero, that a redacted credential is
 * what actually renders, and that "Retry from here" is absent on a run it
 * could not continue.
 */

const STEP_DEFAULTS = {
	runId: null,
	provider: null,
	model: null,
	attempt: null,
	iterations: null,
	inputTokens: null,
	outputTokens: null,
	costUsd: null,
	durationMs: null,
	errorCode: null,
	skippedReason: null,
	resolvedInput: null,
	output: null,
	iterationRows: [],
};

const TRACE = {
	run: {
		id: "run-trace-1",
		workflowName: "publish-notes",
		status: "success",
		projectId: null,
		userId: "u1",
		startedAt: "2026-07-30T09:00:00.000Z",
		finishedAt: "2026-07-30T09:00:10.000Z",
		suspendedReason: null,
		resumable: false,
		jobRef: null,
		definitionHash: "abc123",
		definitionVersionId: null,
		runPhase: "boundary",
		idempotencyKey: null,
		result: { success: true, output: "published" },
	},
	steps: [
		{
			...STEP_DEFAULTS,
			stepName: "draft",
			status: "success",
			runId: "agent-run-1",
			provider: "anthropic",
			model: "claude-opus-5",
			attempt: 1,
			inputTokens: 12400,
			outputTokens: 830,
			durationMs: 4200,
			// A credential the author threaded through `$input`, stored
			// redacted — this is what the trace must render.
			resolvedInput: { topic: "release notes", token: "[REDACTED]" },
			output: { success: true, output: "a draft" },
			startedAt: "2026-07-30T09:00:00.000Z",
			updatedAt: "2026-07-30T09:00:04.200Z",
		},
		{
			...STEP_DEFAULTS,
			stepName: "revise",
			status: "success",
			attempt: 2,
			iterations: 2,
			inputTokens: 900,
			outputTokens: 120,
			durationMs: 3100,
			startedAt: "2026-07-30T09:00:04.200Z",
			updatedAt: "2026-07-30T09:00:07.300Z",
			iterationRows: [
				{
					iteration: 1, attempt: 0, status: "success", runId: null,
					provider: "anthropic", model: "claude-haiku-4-5",
					inputTokens: 400, outputTokens: 50, costUsd: null, durationMs: 1200, errorCode: null,
				},
				{
					iteration: 2, attempt: 0, status: "success", runId: null,
					provider: "anthropic", model: "claude-opus-5",
					inputTokens: 500, outputTokens: 70, costUsd: null, durationMs: 1900, errorCode: null,
				},
			],
		},
		{
			// A transform: no LLM, so every token column is genuinely absent.
			...STEP_DEFAULTS,
			stepName: "shape",
			status: "success",
			durationMs: 40,
			startedAt: "2026-07-30T09:00:07.300Z",
			updatedAt: "2026-07-30T09:00:07.340Z",
		},
	],
	totals: { inputTokens: 13300, outputTokens: 950, durationMs: 7340, steps: 3 },
};

const PARKED = {
	...TRACE,
	run: {
		...TRACE.run,
		id: "run-trace-2",
		status: "suspended",
		finishedAt: null,
		suspendedReason: "approval",
		resumable: true,
	},
	steps: [
		TRACE.steps[0]!,
		{ ...TRACE.steps[1]!, status: "awaiting_approval", errorCode: "approval-required" },
	],
};

async function openTrace(
	page: import("@playwright/test").Page,
	// Structural on purpose: `typeof TRACE` infers literal `null` types for
	// the unset columns, so the parked fixture (which sets some of them)
	// would not be assignable to it.
	trace: { run: { id: string } },
) {
	await page.route(`**/api/workflows/runs/${trace.run.id}`, (route) =>
		route.fulfill({ json: trace }),
	);
	await page.goto(`/workflows/runs/${trace.run.id}`);
	await expect(page.getByTestId("run-trace")).toBeVisible();
}

test.describe("Workflow run trace", () => {
	test("@evidence shows the graph, timeline and per-step cost telemetry", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({});
		await openTrace(page, TRACE);

		await expect(page.getByTestId("trace-run-id")).toHaveText("run-trace-1");
		await expect(page.getByTestId("trace-status")).toHaveText("Succeeded");

		// Rollups, computed at read time.
		await expect(page.getByTestId("trace-total-input")).toHaveText("13,300");
		await expect(page.getByTestId("trace-total-duration")).toHaveText("7.3s");

		// The DAG has one node per step, and the timeline one bar per step.
		await expect(page.getByTestId("dag-node")).toHaveCount(3);
		await expect(page.getByTestId("timeline-bar")).toHaveCount(3);

		// Per-step model and tokens.
		const rows = page.getByTestId("step-row");
		await expect(rows).toHaveCount(3);
		await expect(page.getByTestId("step-model").first()).toHaveText("claude-opus-5");
		await expect(page.getByTestId("step-input-tokens").first()).toHaveText("12,400");

		// Cost is a dash everywhere, with the reason on the cell rather than
		// left as a mystery — there is no price table, so a number here
		// would be invented.
		const costs = page.getByTestId("step-cost");
		for (let i = 0; i < 3; i++) await expect(costs.nth(i)).toHaveText("—");
		await expect(costs.first()).toHaveAttribute("title", /no price table/i);

		await captureEvidence(page, testInfo, "workflow-run-trace", { fullPage: true });
	});

	test("a step that ran no LLM shows dashes, never zeros", async ({ page, mockApi }) => {
		// The property the whole telemetry design turns on. A `0` here
		// would read as "this step was measured and cost nothing", which is
		// a different and false claim.
		await mockApi({});
		await openTrace(page, TRACE);

		const transformRow = page.getByTestId("step-row").nth(2);
		await expect(transformRow.getByTestId("step-name")).toHaveText("shape");
		await expect(transformRow.getByTestId("step-input-tokens")).toHaveText("—");
		await expect(transformRow.getByTestId("step-output-tokens")).toHaveText("—");
		// ...while its duration, which WAS measured, still shows.
		await expect(transformRow.getByTestId("step-duration")).toHaveText("40ms");
	});

	test("@evidence expands a step to its resolved input, output and loop iterations", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({});
		await openTrace(page, TRACE);

		// Detail is collapsed until asked for — a trace opens on the shape
		// of the run, not on a wall of payloads.
		await expect(page.getByTestId("step-detail")).toHaveCount(0);
		await page.getByTestId("step-toggle").first().click();
		await expect(page.getByTestId("step-detail")).toHaveCount(1);

		// The credential is rendered in its REDACTED form — this is the
		// end of the chain that starts at `prepareResolvedInput`.
		const resolved = page.getByTestId("step-resolved-input");
		await expect(resolved).toContainText("[REDACTED]");
		await expect(resolved).toContainText("release notes");
		await expect(page.getByTestId("step-output")).toContainText("a draft");

		// The linked agent transcript.
		await expect(page.getByTestId("step-transcript-link")).toHaveAttribute(
			"href",
			"/runs/agent-run-1",
		);

		// The looped step's per-iteration detail, including the escalation
		// the parent row cannot show.
		await page.getByTestId("step-toggle").nth(1).click();
		await page.getByTestId("iterations-toggle").click();
		await expect(page.getByTestId("iteration-row")).toHaveCount(2);
		const models = page.getByTestId("iteration-model");
		await expect(models.nth(0)).toHaveText("claude-haiku-4-5");
		await expect(models.nth(1)).toHaveText("claude-opus-5");

		await captureEvidence(page, testInfo, "workflow-run-trace-step-detail", { fullPage: true });
	});

	test("Retry from here appears only on a parked, resumable run", async ({ page, mockApi }) => {
		await mockApi({});

		// A finished run offers nothing to continue.
		await openTrace(page, TRACE);
		await page.getByTestId("step-toggle").first().click();
		await expect(page.getByTestId("step-retry")).toHaveCount(0);

		// A parked one does, on the step that has not succeeded.
		await openTrace(page, PARKED);
		await expect(page.getByTestId("trace-suspended-reason")).toContainText("approval");
		await page.getByTestId("step-toggle").first().click();
		// `draft` already succeeded — a resume serves it from its persisted
		// output rather than re-running it, so the button would be a lie.
		await expect(page.getByTestId("step-retry")).toHaveCount(0);

		await page.getByTestId("step-toggle").nth(1).click();
		await expect(page.getByTestId("step-retry")).toHaveCount(1);

		let resumed = false;
		await page.route(`**/api/workflows/runs/${PARKED.run.id}/resume`, (route) => {
			resumed = true;
			return route.fulfill({ json: { run: { id: PARKED.run.id, status: "running" } } });
		});
		await page.getByTestId("step-retry").click();
		await expect(page.getByTestId("retry-outcome")).toContainText("Resumed from");
		expect(resumed).toBe(true);
	});

	test("an unreadable run reports 404 without saying whether it exists", async ({
		page,
		mockApi,
	}) => {
		// The UI half of the existence-oracle guard: the API returns the
		// same 404 for "absent" and "not yours", and the page must not
		// invent a distinction the API deliberately refused to draw.
		await mockApi({});
		await page.route("**/api/workflows/runs/nope", (route) =>
			route.fulfill({ status: 404, json: { error: "Not found" } }),
		);
		await page.goto("/workflows/runs/nope");

		const err = page.getByTestId("trace-error");
		await expect(err).toBeVisible();
		await expect(err).toContainText(/does not exist, or you do not have access/i);
		await expect(page.getByTestId("step-row")).toHaveCount(0);
	});
});
