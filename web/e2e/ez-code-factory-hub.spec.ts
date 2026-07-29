/**
 * ez-code-factory Hub dashboard — page-level e2e (mockApi, no Docker).
 *
 * Proves the M0 user-visible contract against mocked Hub API routes:
 *   - the ez-code-factory tab renders the gate-runs table (Run / Branch / Head
 *     / Status / Updated) from the extension's `definePage` tree,
 *   - the empty state points the user at `init_gate`,
 *   - a `push-received` run's status flips live after the content-free
 *     `ext:page-state` SSE signal makes the open tab re-pull the render,
 *   - perProject navigation: the global hub renders the all-projects home
 *     whose project row deep-links into `/project/<id>/hub/...`, where the
 *     render pull carries `?project=` and the project-scoped tree renders.
 *
 * The extension's server-side logic (gate init, run/worktree lifecycle,
 * Storage) is covered by the bun suite under
 * docs/extensions/examples/ez-code-factory/. Here the mocks return
 * already-rendered trees, mirroring web/e2e/ez-code-dashboard.spec.ts.
 *
 * The `@evidence` test captures the populated dashboard, satisfying the Visual
 * evidence gate for this frontend-visual feature.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "ext:ez-code-factory:dashboard";

const listing = {
	pages: [{ id: EXT_ID, title: "ez-code-factory", kind: "ext" }],
};

/** A dashboard tree with one gate run at the given status. */
function dashboardTree(status: string, total = "1", active = "0", completed = "1", failed = "0") {
	return {
		title: "ez-code-factory",
		nodes: [
			{
				type: "markdown",
				content: "Runs created by `git push gate <branch>`.",
			},
			{
				type: "stats",
				items: [
					{ label: "Total runs", value: total },
					{ label: "Active", value: active },
					{ label: "Completed", value: completed },
					{ label: "Failed", value: failed },
				],
			},
			{
				type: "table",
				columns: ["Run", "Branch", "Head", "Status", "Updated"],
				rows: [
					{ cells: ["run_abc123", "feat/x", "deadbeef", status, "2026-07-15 08:00"] },
				],
			},
		],
	};
}

/** The empty tree (no runs yet). */
const emptyTree = {
	title: "ez-code-factory",
	nodes: [
		{ type: "markdown", content: "Runs created by `git push gate <branch>`." },
		{
			type: "stats",
			items: [
				{ label: "Total runs", value: "0" },
				{ label: "Active", value: "0" },
				{ label: "Completed", value: "0" },
				{ label: "Failed", value: "0" },
			],
		},
		{
			type: "empty-state",
			title: "No gate runs yet",
			detail: "Run the `init_gate` tool on this project, then `git push gate <branch>`.",
		},
	],
};

test.describe("ez-code-factory dashboard", () => {
	test("empty state points the user at init_gate", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) =>
			route.fulfill({ json: { page: emptyTree, renderedAt: Date.now() } }),
		);

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory");
		await expect(page.getByText("No gate runs yet")).toBeVisible();
		await expect(page.getByText("init_gate")).toBeVisible();
	});

	test("renders the gate-runs table with a status badge @evidence", async ({
		page,
		mockApi,
		emitSse,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		let renders = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) => {
			renders++;
			// First render: worktree-ready (active). After the push-received SSE
			// signal re-pulls: completed.
			return route.fulfill({
				json: {
					page:
						renders === 1
							? dashboardTree("▶ worktree", "1", "1", "0", "0")
							: dashboardTree("✓ completed", "1", "0", "1", "0"),
					renderedAt: Date.now(),
				},
			});
		});

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-node-table")).toContainText("feat/x");
		await expect(page.getByTestId("hub-node-table")).toContainText("deadbeef");
		await expect(page.getByTestId("hub-node-table")).toContainText("worktree");
		expect(renders).toBe(1);

		await captureEvidence(page, testInfo, "ez-code-factory-hub");

		// The extension's run lifecycle pushed a fresh tree server-side; the SSE
		// layer broadcasts the content-free signal and the open tab re-pulls.
		await emitSse({
			type: "ext:page-state",
			data: {
				extensionId: "ext-ez-code-factory",
				extensionName: "ez-code-factory",
				pageId: "dashboard",
				timestamp: Date.now(),
			},
		});

		await expect(page.getByTestId("hub-node-table")).toContainText("completed");
		expect(renders).toBe(2);
	});

	test("home lists projects; the project row opens the project-scoped view @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));

		/** Home tree (global hub): projects table whose row deep-links into the
		 *  project-scoped hub route. */
		const homeTree = {
			title: "ez-code-factory",
			nodes: [
				{ type: "markdown", content: "Runs created by `git push gate <branch>`, grouped by project." },
				{ type: "heading", level: 2, text: "Projects" },
				{
					type: "table",
					columns: ["Project", "Runs", "Active", "Parked", "Last push"],
					rows: [
						{
							cells: ["Test Project", "1", "0", "0", "2026-07-17 10:00"],
							href: `/project/${proj.id}/hub/${encodeURIComponent(EXT_ID)}`,
						},
					],
				},
			],
		};
		/** Project-scoped tree — what the extension renders for ctx.project. */
		const projectTree = {
			title: "ez-code-factory — Test Project",
			nodes: [
				{
					type: "table",
					columns: ["Run", "Branch", "Head", "Status", "Updated"],
					rows: [{ cells: ["run_abc123", "feat/x", "deadbeef", "✓ completed", "2026-07-17 10:00"] }],
				},
			],
		};

		const projectPulls: string[] = [];
		await page.route(
			(url) => decodeURIComponent(url.pathname).endsWith(`/api/hub/pages/${EXT_ID}`),
			(route) => {
				const url = new URL(route.request().url());
				const project = url.searchParams.get("project");
				if (project) projectPulls.push(project);
				return route.fulfill({
					json: { page: project ? projectTree : homeTree, renderedAt: Date.now() },
				});
			},
		);

		// Global hub → the home view with the projects table.
		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory");
		await expect(page.getByTestId("hub-node-table")).toContainText("Test Project");
		await captureEvidence(page, testInfo, "ez-code-factory-home");

		// The project row deep-links into the project-scoped hub, whose render
		// pull carries ?project= and gets the project-only tree.
		await page.getByTestId("hub-row-link").click();
		await expect(page).toHaveURL(new RegExp(`/project/${proj.id}/hub/`));
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code-factory — Test Project");
		await expect(page.getByTestId("hub-node-table")).toContainText("run_abc123");
		expect(projectPulls).toEqual([proj.id]);
		await captureEvidence(page, testInfo, "ez-code-factory-project-view");
	});
});
