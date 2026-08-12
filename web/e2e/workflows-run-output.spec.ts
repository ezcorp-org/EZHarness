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

/** A second workflow whose only step hands off to the first, so the two
 *  detail pages sit ONE client-side click apart. A fresh `page.goto` would
 *  remount the route and prove nothing about the history effect re-running
 *  when only `page.params.name` changes underneath a live component. */
const CHAIN = makeWorkflow({
	name: "chain",
	description: "Hands off to release-notes",
	steps: [{ name: "hand-off", kind: "workflow", workflow: "release-notes" }],
});

const CHAIN_RUN_ID = "5a0d9e31-6c72-4b88-91fe-2a4d8c6b7e05";
const OTHER_LIVE_ID = "e17b40f9-8c25-4d6a-b309-5f2a7c1e8b6d";

/** `chain`'s own history — one row, and one that must never be seen under
 *  `release-notes`. */
const CHAIN_RUN = {
	id: CHAIN_RUN_ID,
	workflowName: "chain",
	status: "success",
	startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
	trace: { ...TRACE, run: { ...TRACE.run, id: CHAIN_RUN_ID, workflowName: "chain" } },
};

/** One history row, addressed by the run it belongs to rather than by its
 *  position — the list is time-ordered, so `.first()` silently follows
 *  whichever fixture happens to be newest. */
function runRow(page: import("@playwright/test").Page, runId: string) {
	return page.getByTestId("run-row").filter({ hasText: runId.slice(0, 8) });
}

/** A `workflow:*` frame as the socket delivers it. */
function liveFrame(
	over: { id: string; workflowName?: string; status?: string; result?: unknown },
	type = "workflow:start",
) {
	const { id, workflowName = "release-notes", status = "running", result } = over;
	return {
		type,
		data: {
			workflowRun: {
				id,
				workflowName,
				status,
				startedAt: Date.now(),
				steps: [],
				...(result !== undefined ? { result } : {}),
			},
		},
	};
}

/** Is this the run LIST request (not one run's trace)? */
const isRunList = (url: URL) => url.pathname === "/api/workflows/runs";
/** Is this ONE run's trace? */
const isRunTrace = (url: URL) => /^\/api\/workflows\/runs\/[^/]+$/.test(url.pathname);

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

/**
 * What the page ASKS FOR, and when.
 *
 * The section above proves the output is reachable once the data is on
 * screen. These are about the fetching policy that puts it there — an
 * effect keyed on the workflow name, a guard against a stale answer to a
 * question the reader has moved on from, and a per-run cache with a
 * deliberate exception. None of it is visible in a screenshot, and all of
 * it is the difference between a correct list and a plausible one.
 */
test.describe("Workflow run output — how the history is fetched", () => {
	test("the page asks for ONE workflow's history, bounded, exactly once", async ({
		page,
		mockApi,
	}) => {
		const listed: URL[] = [];
		const traced: string[] = [];
		await mockApi({ workflows: [WORKFLOW], workflowRuns: [SUMMARY, FAILED] });
		await page.route(isRunList, async (route, request) => {
			listed.push(new URL(request.url()));
			await route.fallback();
		});
		await page.route(isRunTrace, async (route, request) => {
			traced.push(request.url());
			await route.fallback();
		});

		await page.goto("/workflows/release-notes");
		await expect(page.getByTestId("run-row")).toHaveCount(2);

		expect(listed).toHaveLength(1);
		expect(listed[0]!.searchParams.get("workflowName")).toBe("release-notes");
		// BOUNDED. Unpaged, this is every run the workflow has ever had, and
		// the route refuses anything outside 1..RUN_PAGE_MAX outright — so an
		// unbounded page would not render long, it would render an error.
		expect(Number(listed[0]!.searchParams.get("limit"))).toBe(25);
		// And no result payloads until one is asked for. The list projection
		// omits `result` precisely so the page does not pull 25 uncapped
		// documents to answer a question nobody has asked.
		expect(traced).toEqual([]);
	});

	test("history reloads when the workflow NAME changes under the same page", async ({
		page,
		mockApi,
	}) => {
		// The effect is keyed on `page.params.name`. Without the re-run, a
		// client-side hop between two workflows leaves the first one's runs
		// on screen under the second one's heading — every row a lie about
		// which workflow produced it.
		await mockApi({ workflows: [WORKFLOW, CHAIN], workflowRuns: [SUMMARY, FAILED, CHAIN_RUN] });
		await page.goto("/workflows/chain");
		await expect(page.getByTestId("run-row")).toHaveCount(1);
		await expect(runRow(page, CHAIN_RUN_ID)).toBeVisible();

		await page.getByTestId("step-nested-workflow").click();
		await expect(page).toHaveURL(/\/workflows\/release-notes$/);

		// REPLACED, not appended: three rows here would mean the two
		// histories had been concatenated.
		await expect(page.getByTestId("run-row")).toHaveCount(2);
		await expect(runRow(page, CHAIN_RUN_ID)).toHaveCount(0);
	});

	test("a slow answer for one workflow never paints under another", async ({ page, mockApi }) => {
		// The in-flight guard. Held open here on purpose rather than raced
		// against a timer: the stale response is released by this test, at a
		// point where the reader has provably already moved on, so nothing
		// depends on how fast the box is.
		await mockApi({ workflows: [WORKFLOW, CHAIN], workflowRuns: [SUMMARY, FAILED, CHAIN_RUN] });

		let releaseChain: () => void = () => {};
		const chainHeld = new Promise<void>((resolve) => {
			releaseChain = resolve;
		});
		await page.route(
			(url) => isRunList(url) && url.searchParams.get("workflowName") === "chain",
			async (route) => {
				await chainHeld;
				await route.fallback();
			},
		);

		await page.goto("/workflows/chain");
		// Its history is still in flight, so the section has nothing yet.
		await expect(page.getByTestId("run-row")).toHaveCount(0);

		await page.getByTestId("step-nested-workflow").click();
		await expect(page.getByTestId("run-row")).toHaveCount(2);

		// Now let the stale answer land. Ungarded, `persistedRuns = loaded`
		// replaces this page's history with chain's single row.
		const stale = page.waitForResponse(
			(res) => res.url().includes("/api/workflows/runs?") && res.url().includes("chain"),
		);
		releaseChain();
		await stale;
		// Two animation frames, so the rejected update has had every chance
		// to render before the negative assertion below reads the DOM.
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		);

		await expect(runRow(page, CHAIN_RUN_ID)).toHaveCount(0);
		await expect(page.getByTestId("run-row")).toHaveCount(2);
	});

	test("a terminal run's trace is fetched ONCE; a live run's is re-fetched", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// The cache policy, and the reason it has an exception. A finished
		// run's trace cannot change, so paying for it twice is waste; a
		// RUNNING run's result is still being written, and serving the copy
		// taken at first open would show a stale answer as the final one.
		await mockApi({ workflows: [WORKFLOW], workflowRuns: [SUMMARY] });

		const hits: string[] = [];
		await page.route(isRunTrace, async (route, request) => {
			const id = new URL(request.url()).pathname.split("/").pop()!;
			hits.push(id);
			if (id !== LIVE_ID) return route.fallback();
			return route.fulfill({
				json: {
					...TRACE,
					run: {
						...TRACE.run,
						id: LIVE_ID,
						status: "running",
						result: { success: true, output: "partial draft" },
					},
				},
			});
		});

		await page.goto("/workflows/release-notes");
		await emitSse(liveFrame({ id: LIVE_ID }));
		await expect(page.getByTestId("run-row")).toHaveCount(2);

		const done = runRow(page, DONE_ID);
		for (const expected of ["Shipped v2.", null, "Shipped v2."]) {
			await done.getByTestId("run-output-toggle").click();
			if (expected === null) {
				await expect(page.getByTestId("run-output-panel")).toHaveCount(0);
			} else {
				await expect(done.getByTestId("run-output")).toContainText(expected);
			}
		}
		expect(hits.filter((id) => id === DONE_ID)).toHaveLength(1);

		const live = runRow(page, LIVE_ID);
		for (const expected of ["partial draft", null, "partial draft"]) {
			await live.getByTestId("run-output-toggle").click();
			if (expected === null) {
				await expect(page.getByTestId("run-output-panel")).toHaveCount(0);
			} else {
				await expect(live.getByTestId("run-output")).toContainText(expected);
			}
		}
		expect(hits.filter((id) => id === LIVE_ID)).toHaveLength(2);
	});

	test("a LIVE run's failure message needs no round trip", async ({ page, mockApi, emitSse }) => {
		// The row reads the result from whichever source HAS it. A persisted
		// row has none until its trace is fetched (covered above), but a
		// socket frame carries one — so this message must be on screen with
		// nothing opened and nothing requested.
		await mockApi({ workflows: [WORKFLOW] });
		const traced: string[] = [];
		await page.route(isRunTrace, async (route, request) => {
			traced.push(request.url());
			await route.fallback();
		});
		await page.goto("/workflows/release-notes");

		await emitSse(liveFrame({ id: LIVE_ID }));
		await expect(page.getByTestId("run-row")).toHaveCount(1);
		await expect(page.getByTestId("run-error")).toHaveCount(0);

		await emitSse(
			liveFrame(
				{
					id: LIVE_ID,
					status: "error",
					result: { success: false, output: null, error: "exhausted 3 iterations" },
				},
				"workflow:error",
			),
		);

		await expect(page.getByTestId("run-error")).toContainText("exhausted 3 iterations");
		await expect(page.getByTestId("run-output-panel")).toHaveCount(0);
		expect(traced).toEqual([]);
	});

	test("a live run belonging to ANOTHER workflow stays off this page", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// `store.workflowRuns` is instance-wide: every workflow's frames land
		// in it. The page filters, and an unfiltered merge would show one
		// workflow's runs in another's history.
		await mockApi({ workflows: [WORKFLOW, CHAIN], workflowRuns: [SUMMARY] });
		await page.goto("/workflows/release-notes");
		await expect(page.getByTestId("run-row")).toHaveCount(1);

		await emitSse(liveFrame({ id: LIVE_ID, workflowName: "chain" }));
		// A frame that DOES belong here, emitted second. It is the
		// synchronization point: once its row is on screen the foreign frame
		// has provably been processed, so the absence below is a decision
		// rather than a race.
		await emitSse(liveFrame({ id: OTHER_LIVE_ID }));

		await expect(runRow(page, OTHER_LIVE_ID)).toBeVisible();
		await expect(runRow(page, LIVE_ID)).toHaveCount(0);
		await expect(page.getByTestId("run-row")).toHaveCount(2);
	});

	test("one run's unreadable trace does not follow the reader to the next row", async ({
		page,
		mockApi,
	}) => {
		// `traceErrors` is keyed by run id for this reason. Held as a single
		// string it would survive the close and paint over the NEXT run's
		// output — an error message attributed to a run that answered fine.
		await mockApi({
			workflows: [WORKFLOW],
			// FAILED has no `trace`, so its row 404s; SUMMARY's answers.
			workflowRuns: [SUMMARY, { ...FAILED, trace: undefined }],
		});
		await page.goto("/workflows/release-notes");

		const broken = runRow(page, FAILED_ID);
		await broken.getByTestId("run-output-toggle").click();
		await expect(broken.getByTestId("run-output-error")).toBeVisible();

		const fine = runRow(page, DONE_ID);
		await fine.getByTestId("run-output-toggle").click();
		await expect(fine.getByTestId("run-output")).toContainText("Shipped v2.");
		await expect(page.getByTestId("run-output-error")).toHaveCount(0);
	});

	test("the panel says it is LOADING rather than sitting blank", async ({ page, mockApi }) => {
		// A trace is a round trip, and on a slow link the disclosure would
		// otherwise open onto nothing — indistinguishable from a run that
		// recorded no output, which is the one confusion this whole surface
		// is built to prevent.
		await mockApi({ workflows: [WORKFLOW], workflowRuns: [SUMMARY] });
		let releaseTrace: () => void = () => {};
		const traceHeld = new Promise<void>((resolve) => {
			releaseTrace = resolve;
		});
		await page.route(isRunTrace, async (route) => {
			await traceHeld;
			await route.fallback();
		});
		await page.goto("/workflows/release-notes");

		await page.getByTestId("run-output-toggle").click();
		await expect(page.getByTestId("run-output-loading")).toBeVisible();
		// Not "not recorded": the page must not answer a question it has not
		// heard back on.
		await expect(page.getByTestId("run-output")).toHaveCount(0);

		releaseTrace();
		await expect(page.getByTestId("run-output")).toContainText("Shipped v2.");
		await expect(page.getByTestId("run-output-loading")).toHaveCount(0);
	});

	test("a history error CLEARS when the next workflow loads", async ({ page, mockApi }) => {
		// Kept, the message sits under a healthy list and reads as a failure
		// of the workflow now on screen.
		await mockApi({ workflows: [WORKFLOW, CHAIN], workflowRuns: [SUMMARY, FAILED, CHAIN_RUN] });
		await page.route(
			(url) => isRunList(url) && url.searchParams.get("workflowName") === "chain",
			(route) => route.fulfill({ status: 500, json: { error: "run history is unavailable" } }),
		);
		await page.goto("/workflows/chain");
		await expect(page.getByTestId("run-history-error")).toBeVisible();

		await page.getByTestId("step-nested-workflow").click();
		await expect(page.getByTestId("run-row")).toHaveCount(2);
		await expect(page.getByTestId("run-history-error")).toHaveCount(0);
	});

	test("a history that cannot be loaded says so, instead of claiming there are none", async ({
		page,
		mockApi,
	}) => {
		// "No runs yet" is a claim about the database. A page that could not
		// read it has not earned that claim, and an operator who believes it
		// stops looking for the run they are missing.
		await mockApi({ workflows: [WORKFLOW], workflowRuns: [SUMMARY] });
		await page.route(isRunList, (route) =>
			route.fulfill({ status: 500, json: { error: "run history is unavailable" } }),
		);
		await page.goto("/workflows/release-notes");

		await expect(page.getByTestId("run-history-error")).toContainText("run history is unavailable");
		await expect(page.getByText("No runs yet")).toHaveCount(0);
	});
});

test.describe("Workflow run output — reaching the trace", () => {
	test("Full trace → opens the run's own page, showing the same output", async ({
		page,
		mockApi,
	}) => {
		// Reachability, walked rather than asserted as an `href`. Nothing in
		// the product linked to `/workflows/runs/<id>` before this feature,
		// so the round trip — list, trace, back — is the journey that was
		// missing, not the anchor.
		await mockApi({ workflows: [WORKFLOW], workflowRuns: [SUMMARY] });
		await page.goto("/workflows/release-notes");

		await runRow(page, DONE_ID).getByTestId("run-trace-link").click();
		await expect(page).toHaveURL(new RegExp(`/workflows/runs/${DONE_ID}$`));
		// The SAME value, off the same field, rendered by the same component
		// — the two surfaces must not disagree about what the run produced.
		await expect(page.getByTestId("trace-output")).toContainText('3x faster "cold" start');

		await page.getByTestId("trace-workflow-link").click();
		await expect(page).toHaveURL(/\/workflows\/release-notes$/);
		await expect(page.getByTestId("run-row")).toHaveCount(1);
	});
});
