/**
 * ez-code Hub dashboard — page-level e2e (mockApi + emitSse, no Docker).
 *
 * Proves the B1 user-visible contract against mocked Hub API routes:
 *   - the ez-code tab renders the dispatched-runs table with status badges,
 *   - a `task:assignment_update` server-side push (which the extension turns
 *     into a content-free `ext:page-state` SSE signal) makes the open tab
 *     re-pull the render endpoint and show the run's NEW status live.
 *
 * The extension's server-side logic (spawnAssignment, Storage, pushPage) is
 * covered by the bun suite (docs/extensions/examples/ez-code/index.test.ts);
 * here the mocks return already-rendered trees, mirroring web/e2e/hub.spec.ts.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

const EXT_ID = "ext:ez-code:dashboard";

const listing = {
	pages: [{ id: EXT_ID, title: "ez-code", kind: "ext" }],
};

/** A dashboard tree with one run row at the given status. Live runs carry a
 *  confirm-gated cancel action (B2); terminal runs deep-link. */
function dashboardTree(status: string, latest: string) {
	const isLive = status === "▶ running" || status === "● dispatched";
	return {
		title: "ez-code",
		nodes: [
			{
				type: "stats",
				items: [
					{ label: "Total runs", value: "1" },
					{ label: "Active", value: isLive ? "1" : "0" },
					{ label: "Completed", value: status === "✓ completed" ? "1" : "0" },
					{ label: "Failed", value: "0" },
				],
			},
			{
				type: "table",
				columns: ["Run", "Agent", "Status", "Updated", "Latest event"],
				rows: [
					{
						cells: ["Bugfix", "coder", status, "2026-06-13 08:00", latest],
						...(isLive
							? {
									action: {
										event: "ez-code:cancel",
										payload: { runId: "run-1" },
										confirm: 'Cancel run "Bugfix"? This stops the agent.',
									},
								}
							: { href: "/chat/sub-1" }),
					},
				],
			},
		],
	};
}

test.describe("ez-code dashboard", () => {
	test("renders the dispatched-runs table with a status badge", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) =>
			route.fulfill({ json: { page: dashboardTree("● dispatched", "dispatched"), renderedAt: Date.now() } }),
		);

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toHaveText("ez-code");
		await expect(page.getByTestId("hub-node-stats")).toContainText("Total runs");
		await expect(page.getByTestId("hub-node-table")).toContainText("coder");
		await expect(page.getByTestId("hub-node-table")).toContainText("dispatched");
	});

	test("terminal run row deep-links to its sub-conversation", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) =>
			route.fulfill({ json: { page: dashboardTree("✓ completed", "completed"), renderedAt: Date.now() } }),
		);

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-row-link")).toHaveAttribute("href", "/chat/sub-1");
	});

	test("B2: clicking a live run's cancel → confirm → POSTs the cancel event; SSE re-pull shows cancelled", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [proj] });
		let cancelBody: unknown = null;
		let renders = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) => {
			renders++;
			return route.fulfill({
				json: {
					page:
						renders === 1
							? dashboardTree("▶ running", "running")
							: dashboardTree("⊘ cancelled", "cancelled"),
					renderedAt: Date.now(),
				},
			});
		});
		// Extension page actions POST to the generic extension events route
		// (NOT /api/hub/.../actions). The host dispatches the event to the
		// subprocess, which cancels + pushPage → an ext:page-state SSE signal.
		await page.route("**/api/extensions/ez-code/events/cancel", async (route) => {
			cancelBody = route.request().postDataJSON();
			return route.fulfill({ json: { ok: true } });
		});

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-node-table")).toContainText("running");

		// Click the live row → host confirm dialog → confirm fires the POST.
		await page.getByTestId("hub-table-row").first().click();
		await expect(page.getByTestId("hub-confirm-dialog")).toContainText("Cancel run");
		await page.getByTestId("hub-confirm-ok").click();

		// The POST carried the run payload through the hub-source body shape.
		await expect.poll(() => cancelBody).toEqual({
			source: "hub",
			pageId: "dashboard",
			payload: { runId: "run-1" },
		});

		// The subprocess's pushPage drives the content-free invalidation; the
		// open tab re-pulls and shows the cancelled tree.
		await emitSse({
			type: "ext:page-state",
			data: { extensionId: "ext-ez-code", extensionName: "ez-code", pageId: "dashboard", timestamp: Date.now() },
		});
		await expect(page.getByTestId("hub-node-table")).toContainText("cancelled");
	});

	test("live update: a run's status flips after the ext:page-state push re-pull", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [proj] });
		let renders = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) => {
			renders++;
			// First render: dispatched. After the assignment_update push: completed.
			return route.fulfill({
				json: {
					page:
						renders === 1
							? dashboardTree("● dispatched", "dispatched")
							: dashboardTree("✓ completed", "completed — 3 files changed"),
					renderedAt: Date.now(),
				},
			});
		});

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-node-table")).toContainText("dispatched");
		expect(renders).toBe(1);

		// The extension's task:assignment_update handler pushed a fresh tree
		// server-side; the SSE layer broadcasts the content-free signal and the
		// open tab re-pulls the (session-authed) render endpoint.
		await emitSse({
			type: "ext:page-state",
			data: {
				extensionId: "ext-ez-code",
				extensionName: "ez-code",
				pageId: "dashboard",
				timestamp: Date.now(),
			},
		});

		await expect(page.getByTestId("hub-node-table")).toContainText("completed");
		await expect(page.getByTestId("hub-node-table")).toContainText("3 files changed");
		expect(renders).toBe(2);
	});
});
