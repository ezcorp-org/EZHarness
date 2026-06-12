/**
 * Extension Pages Hub — page-level e2e (mockApi + emitSse, no Docker).
 *
 * Covers the user-visible Hub contract end-to-end against mocked API
 * routes: nav entry → redirect to the first tab, tab-bar render of the
 * declarative tree, action button with the HOST-rendered confirm
 * dialog (cancel = no POST; confirm = POST + inline fresh-tree update),
 * the 200+{error} envelope → error card → retry flow, and the Phase 2
 * live-invalidation loop (`emitSse("ext:page-state")` → content-free
 * signal → the open tab re-pulls the render endpoint).
 *
 * Server-side behavior (validation, rate limits, grants) is covered by
 * the bun suites; here the mocks return already-validated trees.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

const CORE_ID = "core:briefing";
const EXT_ID = "ext:cron-dashboard:dashboard";

const listing = {
	pages: [
		{ id: CORE_ID, title: "Daily Briefing", kind: "core" },
		{ id: EXT_ID, title: "Cron Dashboard", kind: "ext" },
	],
};

function briefingTree(label = "Last run delivered") {
	return {
		title: "Daily Briefing",
		nodes: [
			{ type: "status", label, state: "success" },
			{ type: "kv", pairs: [{ key: "Schedule", value: "0 7 * * *" }] },
			{
				type: "button",
				label: "Run now",
				style: "primary",
				action: { event: "run-now", confirm: "Run your briefing now?" },
			},
			{
				type: "table",
				columns: ["Briefing", "Created"],
				rows: [{ cells: ["Briefing Mon", "2026-06-12 07:00"], href: "/project/proj-1/chat/conv-1" }],
			},
		],
	};
}

function cronTree(runs: number) {
	return {
		title: "Cron Dashboard",
		nodes: [
			{ type: "stats", items: [{ label: "Tracked runs", value: String(runs) }] },
			{ type: "empty-state", title: runs === 0 ? "No runs recorded yet" : "ignored" },
		],
	};
}

test.describe("Hub", () => {
	test("nav entry → /hub redirects to the first tab and renders the tree", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(CORE_ID)}`, (route) =>
			route.fulfill({ json: { page: briefingTree(), renderedAt: Date.now() } }),
		);

		await page.goto("/memories");
		// Mobile project: the sidebar lives in the hamburger drawer.
		const hamburger = page.getByTestId("mobile-menu-toggle");
		if (await hamburger.isVisible()) {
			await hamburger.click();
		}
		await page.getByRole("link", { name: "Hub", exact: true }).first().click();
		await expect(page).toHaveURL(/\/hub\/core%3Abriefing/);

		// Tab bar shows both tabs; the active tree renders.
		await expect(page.getByTestId("hub-tab")).toHaveCount(2);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Daily Briefing");
		await expect(page.getByTestId("hub-node-status")).toContainText("Last run delivered");
		await expect(page.getByTestId("hub-node-kv")).toContainText("0 7 * * *");
		// Table row deep-link renders as a safe internal anchor.
		await expect(page.getByTestId("hub-row-link")).toHaveAttribute("href", "/project/proj-1/chat/conv-1");
	});

	test("action button: confirm dialog gates the POST; fresh tree updates inline", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		let actionPosts = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(CORE_ID)}`, (route) =>
			route.fulfill({ json: { page: briefingTree(), renderedAt: Date.now() } }),
		);
		await page.route(`**/api/hub/pages/${encodeURIComponent(CORE_ID)}/actions/run-now`, (route) => {
			actionPosts++;
			return route.fulfill({
				json: { ok: true, page: briefingTree("Briefing run started"), renderedAt: Date.now() },
			});
		});

		await page.goto(`/hub/${encodeURIComponent(CORE_ID)}`);
		await expect(page.getByTestId("hub-node-button")).toHaveText("Run now");

		// Cancel path: dialog opens, no POST fires.
		await page.getByTestId("hub-node-button").click();
		await expect(page.getByTestId("hub-confirm-dialog")).toContainText("Run your briefing now?");
		await page.getByTestId("hub-confirm-cancel").click();
		await expect(page.getByTestId("hub-confirm-dialog")).toHaveCount(0);
		expect(actionPosts).toBe(0);

		// Confirm path: POST fires and the returned tree replaces the page.
		await page.getByTestId("hub-node-button").click();
		await page.getByTestId("hub-confirm-ok").click();
		await expect(page.getByTestId("hub-node-status")).toContainText("Briefing run started");
		expect(actionPosts).toBe(1);
	});

	test("render error envelope → error card → retry recovers", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		let renders = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(CORE_ID)}`, (route) => {
			renders++;
			if (renders === 1) {
				// 200 + {error} envelope — the render-failure contract.
				return route.fulfill({ json: { error: "This page failed to render — try again." } });
			}
			return route.fulfill({ json: { page: briefingTree(), renderedAt: Date.now() } });
		});

		await page.goto(`/hub/${encodeURIComponent(CORE_ID)}`);
		await expect(page.getByTestId("hub-error-card")).toContainText("failed to render");

		await page.getByTestId("hub-retry-btn").click();
		await expect(page.getByTestId("hub-page-title")).toHaveText("Daily Briefing");
		expect(renders).toBe(2);
	});

	test("extension tab renders and re-pulls on the ext:page-state invalidation signal", async ({
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
				json: { page: cronTree(renders === 1 ? 0 : 7), renderedAt: Date.now() },
			});
		});

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Cron Dashboard");
		await expect(page.getByTestId("hub-node-stats")).toContainText("0");
		expect(renders).toBe(1);

		// The extension pushed a fresh tree server-side; the SSE layer
		// broadcasts ONLY {extensionId, extensionName, pageId} — the open
		// tab must re-pull the (session-authed) render endpoint.
		await emitSse({
			type: "ext:page-state",
			data: {
				extensionId: "ext-cron",
				extensionName: "cron-dashboard",
				pageId: "dashboard",
				timestamp: Date.now(),
			},
		});
		await expect(page.getByTestId("hub-node-stats")).toContainText("7");
		expect(renders).toBe(2);
	});

	test("invalidation signals for OTHER pages don't trigger a re-pull", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj] });
		let renders = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) => {
			renders++;
			return route.fulfill({ json: { page: cronTree(0), renderedAt: Date.now() } });
		});

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Cron Dashboard");

		await emitSse({
			type: "ext:page-state",
			data: { extensionId: "ext-x", extensionName: "other-ext", pageId: "dashboard", timestamp: Date.now() },
		});
		await page.waitForTimeout(300);
		expect(renders).toBe(1);
	});

	test("/hub with no pages shows the empty explainer", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: { pages: [] } }));

		await page.goto("/hub");
		await expect(page.getByText("No Hub pages yet")).toBeVisible();
		await expect(page.getByRole("link", { name: "Browse extensions" })).toBeVisible();
	});
});
