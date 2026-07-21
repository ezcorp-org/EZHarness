/**
 * ez-code-factory run links + run-detail + status tones — page-level e2e
 * (mockApi, no Docker). Proves the clickable-run-row feature's user-visible
 * contract against mocked Hub API routes:
 *   - a per-project dashboard run row is a LINK, and its Status cell carries
 *     the status→tone colour class (red for a failed run),
 *   - clicking the run row navigates to the `?run=<id>` detail variant; the
 *     render pull carries `?run=` and the detail tree renders — the pipeline
 *     step table (toned step status) + the agent-turn provenance table,
 *   - the detail surfaces the sub-conversation id as TEXT provenance, never a
 *     `/chat/<id>` deep-link (the ez-code privacy precedent).
 *
 * The extension's server-side builders (hrefs, tones, detail tree) are covered
 * by the bun suite under docs/extensions/examples/ez-code-factory/lib/page.test.ts;
 * here the mocks return already-rendered trees, mirroring ez-code-factory-hub.spec.ts.
 *
 * The `@evidence` test captures the populated run detail, satisfying the Visual
 * evidence gate for this frontend-visual feature.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "ext:ez-code-factory:dashboard";
const RUN_ID = "run_abc123";

const listing = {
	pages: [{ id: EXT_ID, title: "ez-code-factory", kind: "ext" }],
};

/** Project-scoped dashboard: one FAILED run whose row links to its detail
 *  (`?run=`) and whose Status cell is toned danger. */
const projectDashboardTree = {
	title: "ez-code-factory — Test Project",
	nodes: [
		{
			type: "stats",
			items: [
				{ label: "Total runs", value: "1" },
				{ label: "Active", value: "0" },
				{ label: "Completed", value: "0" },
				{ label: "Failed", value: "1" },
			],
		},
		{
			type: "table",
			columns: ["Run", "Branch", "Head", "Status", "Updated"],
			rows: [
				{
					cells: [
						RUN_ID,
						"feat/x",
						"deadbeef",
						{ text: "✗ failed", tone: "danger" },
						"2026-07-17 10:00",
					],
					href: `/project/${proj.id}/hub/${encodeURIComponent(EXT_ID)}?run=${RUN_ID}`,
				},
			],
		},
	],
};

/** The `?run=` detail variant: run meta + step table (toned) + agent-turn
 *  provenance. Mirrors buildRunDetailView's output shape. */
const runDetailTree = {
	title: `ez-code-factory — run ${RUN_ID}`,
	nodes: [
		{
			type: "section",
			title: `Run ${RUN_ID} · feat/x`,
			nodes: [
				{
					type: "stats",
					items: [
						{ label: "Status", value: "✗ failed" },
						{ label: "Head", value: "deadbeef" },
						{ label: "Updated", value: "2026-07-17 10:00" },
						{ label: "Intent", value: "none" },
					],
				},
				{
					type: "table",
					columns: ["Step", "Status", "Rounds"],
					rows: [
						{ cells: ["review", { text: "✗ failed", tone: "danger" }, "1"] },
						{ cells: ["test", "◌ pending", "0"] },
					],
				},
			],
		},
		{
			type: "section",
			title: "review · ✗ failed",
			nodes: [
				{
					type: "table",
					columns: ["Severity", "File", "Description", "Action"],
					rows: [{ cells: ["⛔ error", "src/a.ts", "null deref", "ask-user"] }],
				},
				{ type: "heading", level: 3, text: "Agent turns" },
				{
					type: "table",
					columns: ["#", "Role", "Sub-conversation", "Assignment", "When"],
					rows: [{ cells: ["1", "reviewer", "sub-1", "asg-1", "2026-07-18 09:30"] }],
				},
			],
		},
	],
};

test.describe("ez-code-factory run links + detail + status tones", () => {
	test("a run row links to its detail; the status cell is toned; the detail shows chat-turn provenance @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));

		const runPulls: string[] = [];
		await page.route(
			(url) => decodeURIComponent(url.pathname).endsWith(`/api/hub/pages/${EXT_ID}`),
			(route) => {
				const url = new URL(route.request().url());
				const run = url.searchParams.get("run");
				if (run) runPulls.push(run);
				return route.fulfill({
					json: { page: run ? runDetailTree : projectDashboardTree, renderedAt: Date.now() },
				});
			},
		);

		// Open the project-scoped dashboard.
		await page.goto(`/project/${proj.id}/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-node-table")).toContainText(RUN_ID);

		// R4: the failed run's Status cell carries the danger tone (data-tone +
		// the red status colour class on its text span).
		const dangerCell = page.locator('[data-testid="hub-table-cell"][data-tone="danger"]');
		await expect(dangerCell).toContainText("failed");
		await expect(dangerCell.locator("span")).toHaveClass(/text-red-400/);

		// R1: the run row is a LINK to its `?run=` detail variant.
		const rowLink = page.getByTestId("hub-row-link");
		await expect(rowLink).toHaveText(RUN_ID);
		await expect(rowLink).toHaveAttribute("href", new RegExp(`\\?run=${RUN_ID}`));

		// R2: click → navigate to the detail; the pull carries `?run=`.
		await rowLink.click();
		await expect(page).toHaveURL(new RegExp(`\\?run=${RUN_ID}`));
		await expect(page.getByTestId("hub-page-title")).toHaveText(`ez-code-factory — run ${RUN_ID}`);

		// The detail shows the pipeline step table (toned step status) + the
		// agent-turn provenance table with the recorded sub-conversation id.
		await expect(page.getByRole("heading", { name: "Agent turns" })).toBeVisible();
		const turns = page.getByTestId("hub-node-table").filter({ hasText: "Sub-conversation" });
		await expect(turns).toContainText("reviewer");
		await expect(turns).toContainText("sub-1");
		// The detail's step Status cell is toned too.
		await expect(
			page.locator('[data-testid="hub-table-cell"][data-tone="danger"]').first(),
		).toContainText("failed");

		expect(runPulls).toEqual([RUN_ID]);
		await captureEvidence(page, testInfo, "ez-code-factory-run-detail");

		// PRIVACY: the shared detail carries the sub-conversation id as text but
		// never as a /chat/<id> deep-link.
		await expect(page.locator('a[href*="/chat/"]')).toHaveCount(0);
	});
});
