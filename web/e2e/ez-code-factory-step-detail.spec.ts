/**
 * ez-code-factory step-detail view + stalled truthfulness — page-level e2e
 * (mockApi + emitSse, no Docker). Clones ez-code-factory-run-links.spec.ts and
 * proves the observability feature's user-visible contract against mocked Hub
 * API routes:
 *   - a run-detail step row is a LINK to `?run=<id>&step=<name>`; clicking it
 *     navigates to the step-detail variant, whose render pull carries BOTH
 *     params, and the detail renders per-round INPUTS (branch/head/worktree/
 *     config) + OUTPUTS (shell excerpt, prompt excerpt, dispatch deep-links,
 *     durations),
 *   - an old run (no recorded IO) shows the explicit "No recorded IO" state,
 *   - a STALLED run surfaces `⚠ stalled` (warning tone) at the run-row AND the
 *     step-row level,
 *   - a content-free `ext:page-state` SSE signal re-pulls the SAME step-detail
 *     variant (run + step preserved),
 *   - PRIVACY: the sub-conversation is reachable ONLY as a `/chat/<id>`
 *     deep-link — never inlined transcript content.
 *
 * The extension's server-side builders (hrefs, tones, step-detail tree,
 * excerpting, stalled display) are covered by the bun suite under
 * docs/extensions/examples/ez-code-factory/lib/page.test.ts + index.test.ts;
 * here the mocks return already-rendered trees, mirroring the run-links spec.
 *
 * The `@evidence` tests capture the populated step detail + the stalled run,
 * satisfying the Visual evidence gate for this frontend-visual feature.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "ext:ez-code-factory:dashboard";
const RUN_IO = "run_io123"; // has recorded IO
const RUN_OLD = "run_old456"; // predates IO recording
const RUN_STALLED = "run_stalled789"; // running + silent heartbeat → stalled

const listing = { pages: [{ id: EXT_ID, title: "ez-code-factory", kind: "ext" }] };

const hubBase = `/project/${proj.id}/hub/${encodeURIComponent(EXT_ID)}`;
const runHref = (id: string) => `${hubBase}?run=${id}`;
const stepHref = (id: string, step: string) => `${hubBase}?run=${id}&step=${step}`;

/** Run-detail tree whose step rows LINK to their step detail. When `stalled`,
 *  the in-flight review step's Status cell surfaces ⚠ stalled (warning). */
function runDetailTree(runId: string, stalled = false) {
	const reviewCell = stalled
		? { text: "⚠ stalled", tone: "warning" }
		: { text: "✓ completed", tone: "success" };
	return {
		title: `ez-code-factory — run ${runId}`,
		nodes: [
			{
				type: "section",
				title: `Run ${runId} · feat/x`,
				nodes: [
					{
						type: "stats",
						items: [
							{ label: "Status", value: stalled ? "⚠ stalled" : "✓ completed" },
							{ label: "Head", value: "deadbeef" },
							{ label: "Updated", value: "2026-07-17 10:00" },
							{ label: "Intent", value: "none" },
						],
					},
					{
						type: "table",
						columns: ["Step", "Status", "Rounds"],
						rows: [
							{ cells: ["review", reviewCell, "1"], href: stepHref(runId, "review") },
							{ cells: ["test", "◌ pending", "0"], href: stepHref(runId, "test") },
						],
					},
				],
			},
		],
	};
}

/** Step-detail tree with recorded IO: header stats + one round's inputs,
 *  agent dispatches (deep-linked to chat), and shell commands. */
function stepDetailTree(runId: string) {
	return {
		title: "ez-code-factory — step",
		nodes: [
			{
				type: "section",
				title: `Run ${runId} · review`,
				nodes: [
					{
						type: "stats",
						items: [
							{ label: "Run", value: runId },
							{ label: "Branch", value: "feat/x" },
							{ label: "Step", value: "review" },
							{ label: "Status", value: "✓ completed" },
							{ label: "Rounds", value: "1" },
							{ label: "Duration", value: "4200 ms" },
							{ label: "Updated", value: "2026-07-17 10:00" },
						],
					},
				],
			},
			{
				type: "section",
				title: "Round 1 · initial",
				nodes: [
					{
						type: "table",
						columns: ["Field", "Detail"],
						rows: [
							{ cells: ["Branch", "feat/x"] },
							{ cells: ["Head", "deadbeef"] },
							{ cells: ["Worktree", "/wt/run_io123"] },
							{ cells: ["Agent", "claude"] },
							{ cells: ["Commands", "test: bun test · lint: biome"] },
							{ cells: ["Duration", "5000 ms"] },
						],
					},
					{ type: "heading", level: 3, text: "Agent dispatches" },
					{
						type: "table",
						columns: ["#", "Role", "Prompt", "Result", "When"],
						rows: [
							{
								cells: ["1", "reviewer", "review this diff", "looks fine, one nit", "2026-07-17 08:00"],
								href: `/project/${proj.id}/chat/sub-1`,
							},
						],
					},
					{ type: "heading", level: 3, text: "Shell commands" },
					{
						type: "table",
						columns: ["Command", "Exit", "Duration", "Output"],
						rows: [{ cells: ["bun test", "0", "120 ms", "42 pass"] }],
					},
				],
			},
		],
	};
}

/** Step-detail tree for a run that predates IO recording — the explicit note. */
function stepDetailOldTree(runId: string) {
	return {
		title: "ez-code-factory — step",
		nodes: [
			{
				type: "section",
				title: `Run ${runId} · review`,
				nodes: [
					{
						type: "stats",
						items: [
							{ label: "Run", value: runId },
							{ label: "Step", value: "review" },
							{ label: "Rounds", value: "0" },
						],
					},
				],
			},
			{
				type: "empty-state",
				title: "No recorded IO for this step (run predates IO recording)",
				detail: "This step recorded no rounds — an old run from before per-round IO recording.",
			},
		],
	};
}

/** Project dashboard whose middle run is STALLED (warning tone). */
const dashboardTree = {
	title: "ez-code-factory — Test Project",
	nodes: [
		{
			type: "stats",
			items: [
				{ label: "Total runs", value: "2" },
				{ label: "Active", value: "0" },
				{ label: "Stalled", value: "1" },
				{ label: "Completed", value: "1" },
				{ label: "Failed", value: "0" },
			],
		},
		{
			type: "table",
			columns: ["Run", "Branch", "Head", "Status", "Updated"],
			rows: [
				{
					cells: [RUN_STALLED, "feat/x", "deadbeef", { text: "⚠ stalled", tone: "warning" }, "2026-07-17 10:00"],
					href: runHref(RUN_STALLED),
				},
				{
					cells: [RUN_IO, "feat/y", "cafebabe", { text: "✓ completed", tone: "success" }, "2026-07-17 11:00"],
					href: runHref(RUN_IO),
				},
			],
		},
	],
};

/** Route the Hub render endpoint: step detail (run+step) > run detail (run) >
 *  dashboard. Records every step pull's {run, step} so tests can assert the
 *  render pull carried both params. */
async function routeHub(
	page: import("@playwright/test").Page,
	stepPulls: Array<{ run: string; step: string }>,
) {
	await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
	await page.route(
		(url) => decodeURIComponent(url.pathname).endsWith(`/api/hub/pages/${EXT_ID}`),
		(route) => {
			const url = new URL(route.request().url());
			const run = url.searchParams.get("run");
			const step = url.searchParams.get("step");
			let pageTree: unknown = dashboardTree;
			if (run && step) {
				stepPulls.push({ run, step });
				pageTree = run === RUN_OLD ? stepDetailOldTree(run) : stepDetailTree(run);
			} else if (run) {
				pageTree = runDetailTree(run, run === RUN_STALLED);
			}
			return route.fulfill({ json: { page: pageTree, renderedAt: Date.now() } });
		},
	);
}

test.describe("ez-code-factory step detail + stalled truthfulness", () => {
	test("a run-detail step row links to its step detail; the detail shows inputs + outputs @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		const stepPulls: Array<{ run: string; step: string }> = [];
		await routeHub(page, stepPulls);

		// Open the run detail directly.
		await page.goto(runHref(RUN_IO));
		await expect(page.getByTestId("hub-page-title")).toHaveText(`ez-code-factory — run ${RUN_IO}`);

		// The review step row is a LINK carrying ?run=&step=review.
		const stepLink = page.getByTestId("hub-row-link").filter({ hasText: "review" });
		await expect(stepLink).toHaveAttribute(
			"href",
			new RegExp(`\\?run=${RUN_IO}&step=review`),
		);

		// Click → navigate to the step detail; the pull carried BOTH params.
		await stepLink.click();
		await expect(page).toHaveURL(new RegExp(`\\?run=${RUN_IO}&step=review`));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — step");
		expect(stepPulls).toEqual([{ run: RUN_IO, step: "review" }]);

		// INPUTS: branch/head/worktree/agent/commands.
		const body = page.getByTestId("hub-page-body");
		await expect(body).toContainText("Worktree");
		await expect(body).toContainText("/wt/run_io123");
		await expect(body).toContainText("test: bun test · lint: biome");
		// OUTPUTS: dispatch prompt/result excerpts + shell command with exit + duration.
		await expect(page.getByRole("heading", { name: "Agent dispatches" })).toBeVisible();
		await expect(body).toContainText("review this diff");
		await expect(body).toContainText("looks fine, one nit");
		await expect(page.getByRole("heading", { name: "Shell commands" })).toBeVisible();
		await expect(body).toContainText("bun test");
		await expect(body).toContainText("42 pass");
		await expect(body).toContainText("120 ms");

		await captureEvidence(page, testInfo, "ez-code-factory-step-detail");
	});

	test("an old run's step detail shows the explicit 'No recorded IO' state", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await routeHub(page, []);
		await page.goto(stepHref(RUN_OLD, "review"));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — step");
		await expect(page.getByTestId("hub-page-body")).toContainText(
			"No recorded IO for this step (run predates IO recording)",
		);
	});

	test("a stalled run surfaces ⚠ stalled (warning) at the run-row AND step-row level @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		await routeHub(page, []);

		// Dashboard: the stalled run's Status cell is toned warning.
		await page.goto(hubBase);
		const runWarn = page.locator('[data-testid="hub-table-cell"][data-tone="warning"]');
		await expect(runWarn).toContainText("stalled");
		await expect(runWarn.locator("span")).toHaveClass(/text-yellow-400/);
		await captureEvidence(page, testInfo, "ez-code-factory-stalled-dashboard");

		// Open the stalled run's detail: its in-flight review step is ALSO ⚠ stalled.
		await page.getByTestId("hub-row-link").filter({ hasText: RUN_STALLED }).click();
		await expect(page).toHaveURL(new RegExp(`\\?run=${RUN_STALLED}`));
		const stepWarn = page.locator('[data-testid="hub-table-cell"][data-tone="warning"]').filter({
			hasText: "stalled",
		});
		await expect(stepWarn.first()).toBeVisible();
	});

	test("an ext:page-state SSE signal re-pulls the SAME step-detail variant (run + step preserved)", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [proj] });
		const stepPulls: Array<{ run: string; step: string }> = [];
		await routeHub(page, stepPulls);

		await page.goto(stepHref(RUN_IO, "review"));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — step");
		expect(stepPulls).toEqual([{ run: RUN_IO, step: "review" }]);

		// The content-free live-invalidation signal → the open tab re-pulls its
		// OWN variant (run + step rebuilt from props), not the bare dashboard.
		await emitSse({
			type: "ext:page-state",
			data: {
				extensionId: "ext-ez-code-factory",
				extensionName: "ez-code-factory",
				pageId: "dashboard",
				timestamp: Date.now(),
			},
		});

		await expect.poll(() => stepPulls.length).toBe(2);
		expect(stepPulls[1]).toEqual({ run: RUN_IO, step: "review" });
	});

	test("PRIVACY: the sub-conversation is reachable ONLY as a /chat/ deep-link, never inlined", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await routeHub(page, []);
		await page.goto(stepHref(RUN_IO, "review"));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — step");

		// The dispatch row's chat deep-link exists — the ONLY path to conversation
		// content (fail-closed authz at the chat route). Work product (the bounded
		// result preview) renders inline; transcript content never does.
		const chatLinks = page.locator('a[href*="/chat/"]');
		await expect(chatLinks).toHaveCount(1);
		await expect(chatLinks.first()).toHaveAttribute("href", `/project/${proj.id}/chat/sub-1`);
		// No turn-by-turn transcript leaked into the shared, cached tree.
		await expect(page.getByTestId("hub-page-body")).not.toContainText("BEGIN TRANSCRIPT");
	});
});
