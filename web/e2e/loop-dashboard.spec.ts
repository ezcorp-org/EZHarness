/**
 * Loop primitive dashboard — page-level e2e (mockApi + emitSse, no Docker).
 *
 * Proves the user-visible contract of `defineLoop({ log: { dashboard } })`
 * end-to-end against the Hub render pipeline:
 *   1. trigger → act → a run row appears in the dashboard table,
 *   2. a row ACTION (the primitive's `rowActions`) POSTs to the generic
 *      extension events route, and
 *   3. the content-free `ext:page-state` SSE signal (the primitive's
 *      `pushPage`) makes the open tab re-pull and show the NEW status.
 *
 * The tree is built in the SHAPE the primitive's dashboard helper emits
 * (PageBuilder stats + table + a confirm-gated row action) — the
 * tree-PRODUCTION itself is covered by the bun loop-log suite
 * (packages/@ezcorp/sdk/test/loop-log.test.ts). This spec covers the Hub
 * render + action + live-refresh contract for a loop dashboard, mirroring
 * web/e2e/ez-code-dashboard.spec.ts.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

// A sample loop extension ("sample-loop") declaring a dashboard page.
const EXT_ID = "ext:sample-loop:dashboard";

const listing = {
	pages: [{ id: EXT_ID, title: "Sample Loop", kind: "ext" }],
};

/**
 * A dashboard tree in the shape `LoopDashboard.render` produces for one run
 * at the given status. Open (non-terminal) runs carry a confirm-gated row
 * action — the primitive's `rowActions` surface.
 */
function loopDashboardTree(status: string, latest: string) {
	const isOpen = status === "running" || status === "dispatched";
	return {
		title: "Sample Loop",
		nodes: [
			{
				type: "stats",
				items: [
					{ label: "Total runs", value: "1" },
					{ label: "Active", value: isOpen ? "1" : "0" },
					{ label: "Done", value: status === "completed" ? "1" : "0" },
				],
			},
			{
				type: "table",
				columns: ["Run", "Status", "Updated", "Latest event"],
				rows: [
					{
						cells: ["nightly-distill", status, "2026-06-18 08:00", latest],
						...(isOpen
							? {
									action: {
										event: "sample-loop:cancel",
										payload: { runId: "run-1" },
										confirm: 'Cancel run "nightly-distill"? This stops the loop.',
									},
								}
							: {}),
					},
				],
			},
		],
	};
}

test.describe("loop dashboard", () => {
	test("trigger → act → the run row appears with a status badge", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) =>
			route.fulfill({ json: { page: loopDashboardTree("dispatched", "dispatched"), renderedAt: Date.now() } }),
		);

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Sample Loop");
		await expect(page.getByTestId("hub-node-stats")).toContainText("Total runs");
		await expect(page.getByTestId("hub-node-table")).toContainText("nightly-distill");
		await expect(page.getByTestId("hub-node-table")).toContainText("dispatched");
	});

	test("row action → confirm → POSTs the loop's rowAction event; SSE re-pull shows the new status", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [proj] });
		let actionBody: unknown = null;
		let renders = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) => {
			renders++;
			return route.fulfill({
				json: {
					page:
						renders === 1
							? loopDashboardTree("running", "running")
							: loopDashboardTree("cancelled", "cancelled"),
					renderedAt: Date.now(),
				},
			});
		});
		// The primitive's row action dispatches through the generic extension
		// events route (eventSubscriptions-gated), same wire format as every
		// page action. The host delivers it to the loop's `rowActions` handler.
		await page.route("**/api/extensions/sample-loop/events/cancel", async (route) => {
			actionBody = route.request().postDataJSON();
			return route.fulfill({ json: { ok: true } });
		});

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-node-table")).toContainText("running");

		// Click the open run's row → host confirm → confirm fires the POST.
		await page.getByTestId("hub-table-row").first().click();
		await expect(page.getByTestId("hub-confirm-dialog")).toContainText("Cancel run");
		await page.getByTestId("hub-confirm-ok").click();

		// The POST carries the loop's rowAction payload via the hub-source body.
		await expect.poll(() => actionBody).toEqual({
			source: "hub",
			pageId: "dashboard",
			payload: { runId: "run-1" },
		});

		// The loop's `pushDashboard` drives the content-free invalidation; the
		// open tab re-pulls and shows the cancelled tree.
		await emitSse({
			type: "ext:page-state",
			data: {
				extensionId: "ext-sample-loop",
				extensionName: "sample-loop",
				pageId: "dashboard",
				timestamp: Date.now(),
			},
		});
		await expect(page.getByTestId("hub-node-table")).toContainText("cancelled");
	});

	test("deferred completion: ext:page-state push re-pull flips the run terminal", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [proj] });
		let renders = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) => {
			renders++;
			return route.fulfill({
				json: {
					page:
						renders === 1
							? loopDashboardTree("dispatched", "dispatched")
							: loopDashboardTree("completed", "completed — done"),
					renderedAt: Date.now(),
				},
			});
		});

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-node-table")).toContainText("dispatched");
		expect(renders).toBe(1);

		// The deferred run's task:assignment_update closed the run server-side;
		// the primitive pushed a fresh tree → content-free SSE → tab re-pulls.
		await emitSse({
			type: "ext:page-state",
			data: {
				extensionId: "ext-sample-loop",
				extensionName: "sample-loop",
				pageId: "dashboard",
				timestamp: Date.now(),
			},
		});
		await expect(page.getByTestId("hub-node-table")).toContainText("completed");
		expect(renders).toBe(2);
	});
});
