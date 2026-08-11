import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeWorkflow } from "./fixtures/data.js";

/**
 * Seeing what a workflow run PRODUCED.
 *
 * The gap this closes is not a formatting one. `/workflows/<name>` fed its
 * Run History from live SSE frames and nothing else, so history emptied
 * itself on reload; the rows it did show carried statuses and never the
 * output; and nothing linked to `/workflows/runs/<id>`, which had fetched
 * `run.result` and dropped it on the floor for its whole existence. The
 * output of a run was not visible anywhere in the product.
 *
 * These assertions are therefore about REACHABILITY — that a person
 * arriving at the page after the fact can get to the value — and about the
 * one rendering property that decides whether it is readable at all: an
 * agent's prose must not arrive JSON-escaped onto a single line.
 */

const WORKFLOW = makeWorkflow({
	name: "release-notes",
	description: "Drafts and publishes the release notes",
	steps: [
		{ name: "draft", agent: "writer" },
		{ name: "publish", agent: "shipper", dependsOn: ["draft"] },
	],
});

/** Prose with real newlines and quotes — the shape `JSON.stringify` ruins. */
const OUTPUT = 'Shipped v2.\n\nHighlights:\n- 3x faster "cold" start\n- fewer retries';

/** Computed from now, so the relative timestamp on the row reads "3h ago"
 *  rather than a four-digit day count that grows with the calendar. */
const THREE_HOURS_AGO = new Date(Date.now() - 3 * 3600_000).toISOString();

/** Real UUIDs, because the row renders `id.slice(0, 8)`. A short synthetic
 *  id ("wrun-done") is cut mid-word by that and reads as a typo in the
 *  evidence shot; every run the executor mints is a `crypto.randomUUID()`. */
const DONE_ID = "9f3c1a2e-7b64-4d18-9a52-0c1e5d7f8a10";
const FAILED_ID = "2b71d4c8-3e09-4f55-b6ad-91c7e0d2f345";
const LIVE_ID = "c4e8a1b7-52d6-4a03-8f19-7d3b6e0c9a24";

const TRACE = {
	run: {
		id: DONE_ID,
		workflowName: "release-notes",
		status: "success",
		projectId: null,
		userId: "u1",
		startedAt: THREE_HOURS_AGO,
		finishedAt: THREE_HOURS_AGO,
		suspendedReason: null,
		resumable: false,
		jobRef: null,
		definitionHash: "abc123",
		definitionVersionId: null,
		runPhase: "boundary",
		idempotencyKey: null,
		result: { success: true, output: OUTPUT },
	},
	steps: [
		{
			stepName: "draft",
			status: "success",
			runId: null,
			provider: "anthropic",
			model: "claude-opus-5",
			attempt: 1,
			iterations: null,
			inputTokens: 1200,
			outputTokens: 300,
			costUsd: null,
			durationMs: 4200,
			errorCode: null,
			skippedReason: null,
			resolvedInput: null,
			output: null,
			startedAt: THREE_HOURS_AGO,
			updatedAt: THREE_HOURS_AGO,
			iterationRows: [],
		},
	],
	totals: { inputTokens: 1200, outputTokens: 300, durationMs: 4200, steps: 1 },
};

/** The same run as the list projection reports it: no `result`, no steps. */
const SUMMARY = {
	id: DONE_ID,
	workflowName: "release-notes",
	status: "success",
	startedAt: THREE_HOURS_AGO,
	finishedAt: THREE_HOURS_AGO,
	trace: TRACE,
};

/** A run that failed, whose message lives only in its trace. */
const FAILED = {
	id: FAILED_ID,
	workflowName: "release-notes",
	status: "error",
	startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
	trace: {
		...TRACE,
		run: {
			...TRACE.run,
			id: FAILED_ID,
			status: "error",
			result: {
				success: false,
				output: null,
				error: 'Gate "ready" failed: $steps.draft.output.ok is not truthy',
			},
		},
	},
};

/** One history row, addressed by the run it belongs to rather than by its
 *  position — the list is time-ordered, so `.first()` silently follows
 *  whichever fixture happens to be newest. */
function runRow(page: import("@playwright/test").Page, runId: string) {
	return page.getByTestId("run-row").filter({ hasText: runId.slice(0, 8) });
}

test.describe("Workflow run output — the workflow page", () => {
	test("@evidence a persisted run is listed, and its output opens in place", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ workflows: [WORKFLOW], workflowRuns: [SUMMARY, FAILED] });
		await page.goto("/workflows/release-notes");

		// THE regression. This history came from the server, not from a live
		// socket — before this the section was empty on every fresh load, so
		// a run you fired yesterday was simply gone.
		await expect(page.getByRole("heading", { name: "Run History" })).toBeVisible();
		await expect(page.getByTestId("run-row")).toHaveCount(2);
		await expect(page.getByTestId("run-started").first()).toContainText("ago");

		// The output is behind a disclosure: a workflow's answer can be a
		// whole document, and 25 of them stacked would bury the list.
		await expect(page.getByTestId("run-output")).toHaveCount(0);
		const done = runRow(page, DONE_ID);
		await done.getByTestId("run-output-toggle").click();

		const output = done.getByTestId("run-output");
		await expect(output).toBeVisible();
		// Verbatim, with its line breaks intact. Through `JSON.stringify`
		// this is one quoted line reading `Shipped v2.\n\nHighlights:...`,
		// which is the value the reader came for made unreadable.
		await expect(output).toContainText("Shipped v2.");
		await expect(output).toContainText('3x faster "cold" start');
		expect(await output.textContent()).not.toContain("\\n");

		// ...and the full trace is one click away, which it was not before:
		// no surface in the product linked to that route.
		await expect(done.getByTestId("run-trace-link")).toHaveAttribute(
			"href",
			`/workflows/runs/${DONE_ID}`,
		);

		// Scrolled to, and NOT `fullPage`. This app's scroll container is an
		// inner element, so a full-page shot here is just the viewport — and
		// the viewport, unscrolled, stops above the panel this test is about.
		await output.scrollIntoViewIfNeeded();
		await captureEvidence(page, testInfo, "workflow-run-output");
	});

	test("a failed run's message arrives with its output", async ({ page, mockApi }) => {
		// The list projection carries no `result`, so a persisted failure has
		// no message to show until the trace is fetched. Opening the row is
		// what fetches it — the alternative was a red status pill with no
		// explanation anywhere on the page.
		await mockApi({ workflows: [WORKFLOW], workflowRuns: [FAILED] });
		await page.goto("/workflows/release-notes");

		await expect(page.getByTestId("run-error")).toHaveCount(0);
		await page.getByTestId("run-output-toggle").click();

		await expect(page.getByTestId("run-error")).toContainText('Gate "ready" failed');
		// A failed run recorded no output, and the panel says exactly that
		// rather than rendering an empty box.
		await expect(page.getByTestId("run-output")).toHaveText("not recorded");
	});

	test("the toggle closes the panel it opened", async ({ page, mockApi }) => {
		await mockApi({ workflows: [WORKFLOW], workflowRuns: [SUMMARY] });
		await page.goto("/workflows/release-notes");

		const toggle = page.getByTestId("run-output-toggle");
		await toggle.click();
		await expect(page.getByTestId("run-output-panel")).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await toggle.click();
		await expect(page.getByTestId("run-output-panel")).toHaveCount(0);
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
	});

	test("a run whose trace cannot be read says so, and the row survives", async ({
		page,
		mockApi,
	}) => {
		// 404 covers both "gone" and "not yours" — the API refuses to
		// distinguish them. What matters here is that the failure lands in
		// the panel instead of taking the page down.
		await mockApi({
			workflows: [WORKFLOW],
			// No `trace`, so the mocked route answers 404 like the real one.
			workflowRuns: [{ ...SUMMARY, trace: undefined }],
		});
		await page.goto("/workflows/release-notes");

		await page.getByTestId("run-output-toggle").click();
		await expect(page.getByTestId("run-output-error")).toBeVisible();
		await expect(page.getByTestId("run-row")).toHaveCount(1);
	});

	test("live and persisted runs share ONE list, newest first", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// The two sources carry `startedAt` in different formats (ISO here,
		// epoch ms on the socket). Merged without normalizing, every live run
		// sorts above every persisted one — an order that looks chronological
		// and is not.
		await mockApi({ workflows: [WORKFLOW], workflowRuns: [SUMMARY, FAILED] });
		await page.goto("/workflows/release-notes");
		await expect(page.getByTestId("run-row")).toHaveCount(2);

		await emitSse({
			type: "workflow:start",
			data: {
				workflowRun: {
					id: LIVE_ID,
					workflowName: "release-notes",
					status: "running",
					// Older than the persisted `wrun-done`, so a source-ordered
					// list would put it first and a time-ordered one last.
					startedAt: Date.now() - 5 * 3600_000,
					steps: [{ stepName: "draft", runId: "r1", status: "running" }],
				},
			},
		});

		await expect(page.getByTestId("run-row")).toHaveCount(3);
		const ids = await page.getByTestId("run-row").allTextContents();
		expect(ids[2]).toContain(LIVE_ID.slice(0, 8));
		// The live row keeps the steps only the socket reports.
		await expect(page.getByTestId("run-step")).toHaveCount(1);
	});
});

test.describe("Workflow run output — the run trace", () => {
	test("@evidence the trace renders the run's final result", async ({
		page,
		mockApi,
	}, testInfo) => {
		// This page fetched `run.result`, typed it, and never rendered it.
		await mockApi({});
		await page.route(`**/api/workflows/runs/${DONE_ID}`, (route) => route.fulfill({ json: TRACE }));
		await page.goto(`/workflows/runs/${DONE_ID}`);

		await expect(page.getByTestId("trace-result")).toBeVisible();
		const output = page.getByTestId("trace-output");
		await expect(output).toContainText("Shipped v2.");
		await expect(output).toContainText("fewer retries");
		expect(await output.textContent()).not.toContain("\\n");
		// A successful run has nothing to explain.
		await expect(page.getByTestId("trace-error-text")).toHaveCount(0);

		await captureEvidence(page, testInfo, "workflow-run-trace-result", { fullPage: true });
	});

	test("a failed run's result shows the message AND the absent output", async ({
		page,
		mockApi,
	}) => {
		await mockApi({});
		await page.route(`**/api/workflows/runs/${FAILED_ID}`, (route) =>
			route.fulfill({ json: FAILED.trace }),
		);
		await page.goto(`/workflows/runs/${FAILED_ID}`);

		await expect(page.getByTestId("trace-error-text")).toContainText('Gate "ready" failed');
		await expect(page.getByTestId("trace-output")).toHaveText("not recorded");
	});
});
