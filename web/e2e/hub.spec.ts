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

	test("tab switch: title swaps and the new page's render route is pulled ($effect param reload)", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		let coreRenders = 0;
		let extRenders = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(CORE_ID)}`, (route) => {
			coreRenders++;
			return route.fulfill({ json: { page: briefingTree(), renderedAt: Date.now() } });
		});
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) => {
			extRenders++;
			return route.fulfill({ json: { page: cronTree(3), renderedAt: Date.now() } });
		});

		await page.goto(`/hub/${encodeURIComponent(CORE_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Daily Briefing");
		expect(coreRenders).toBe(1);

		// Click the OTHER tab: shallow client-side navigation — the
		// $effect on page.params.pageId must fire a second render pull.
		await page.getByTestId("hub-tab").filter({ hasText: "Cron Dashboard" }).click();
		await expect(page).toHaveURL(/cron-dashboard/);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Cron Dashboard");
		await expect(page.getByTestId("hub-node-stats")).toContainText("3");
		expect(extRenders).toBe(1);
		expect(coreRenders).toBe(1); // the old tab wasn't re-pulled
	});

	test("refresh button re-pulls the render endpoint and renders the updated tree", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		let renders = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(CORE_ID)}`, (route) => {
			renders++;
			return route.fulfill({
				json: {
					page: briefingTree(renders === 1 ? "Last run delivered" : "Fresh after refresh"),
					renderedAt: Date.now(),
				},
			});
		});

		await page.goto(`/hub/${encodeURIComponent(CORE_ID)}`);
		await expect(page.getByTestId("hub-node-status")).toContainText("Last run delivered");

		await page.getByTestId("hub-refresh-btn").click();
		await expect(page.getByTestId("hub-node-status")).toContainText("Fresh after refresh");
		expect(renders).toBe(2);
	});

	test("action failure (429 {error}) surfaces a toast; the tree stays unchanged", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		// Confirm-free button so the POST dispatches straight from the click.
		const tree = {
			title: "Daily Briefing",
			nodes: [
				{ type: "status", label: "Last run delivered", state: "success" },
				{ type: "button", label: "Run now", style: "primary", action: { event: "run-now" } },
			],
		};
		let renders = 0;
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(CORE_ID)}`, (route) => {
			renders++;
			return route.fulfill({ json: { page: tree, renderedAt: Date.now() } });
		});
		await page.route(`**/api/hub/pages/${encodeURIComponent(CORE_ID)}/actions/run-now`, (route) =>
			route.fulfill({
				status: 429,
				json: { error: "Briefing was already run recently — try again later", retryAfter: 290 },
			}),
		);

		await page.goto(`/hub/${encodeURIComponent(CORE_ID)}`);
		await page.getByTestId("hub-node-button").click();

		// Toast carries the server's {error} verbatim.
		await expect(
			page.getByRole("alert").filter({ hasText: "already run recently" }),
		).toBeVisible({ timeout: 3000 });
		// Tree unchanged; a FAILED action must not trigger a re-pull.
		await expect(page.getByTestId("hub-node-status")).toContainText("Last run delivered");
		expect(renders).toBe(1);
	});

	test("stale:true render shows the refreshing… indicator", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) =>
			route.fulfill({ json: { page: cronTree(2), renderedAt: Date.now() - 90_000, stale: true } }),
		);

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Cron Dashboard");
		await expect(page.getByTestId("hub-stale-indicator")).toBeVisible();
		await expect(page.getByTestId("hub-stale-indicator")).toHaveText("refreshing…");
	});

	test("loading skeleton shows while the render request is in flight; tab icon renders a lucide svg", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		const iconListing = {
			pages: [{ id: CORE_ID, title: "Daily Briefing", kind: "core", icon: "Sunrise" }],
		};
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: iconListing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(CORE_ID)}`, async (route) => {
			await new Promise((r) => setTimeout(r, 700));
			return route.fulfill({ json: { page: briefingTree(), renderedAt: Date.now() } });
		});

		await page.goto(`/hub/${encodeURIComponent(CORE_ID)}`);
		// While the render hangs, the skeleton (with its status text) shows.
		await expect(page.getByText("Loading page…")).toBeVisible();
		// The `icon` branch mounts a LucideIcon (an inline svg) in the tab.
		await expect(page.getByTestId("hub-tab").locator("svg")).toBeVisible();
		// Then the tree replaces the skeleton.
		await expect(page.getByTestId("hub-page-title")).toHaveText("Daily Briefing");
		await expect(page.getByText("Loading page…")).toHaveCount(0);
	});

	test("a slow superseded render can't overwrite the newer tab (fetch-race guard)", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		// The FIRST tab's render is slow; the tab the user switches to is fast.
		await page.route(`**/api/hub/pages/${encodeURIComponent(CORE_ID)}`, async (route) => {
			await new Promise((r) => setTimeout(r, 1200));
			return route.fulfill({ json: { page: briefingTree(), renderedAt: Date.now() } });
		});
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) =>
			route.fulfill({ json: { page: cronTree(5), renderedAt: Date.now() } }),
		);

		await page.goto(`/hub/${encodeURIComponent(CORE_ID)}`);
		// Switch tabs while the first render is still in flight.
		await page.getByTestId("hub-tab").filter({ hasText: "Cron Dashboard" }).click();
		await expect(page.getByTestId("hub-page-title")).toHaveText("Cron Dashboard");

		// Let the stale core response land — it must be DISCARDED.
		await page.waitForTimeout(1500);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Cron Dashboard");
	});

	test("Hub nav link renders on the Global project sidebar (global navLinks branch)", async ({
		page,
		mockApi,
		isMobile,
	}) => {
		// Mobile renders the project-menu UI on /project/global — there is
		// no sidebar (and no hamburger) to host navLinks at this route.
		test.skip(isMobile, "global project route has no sidebar on mobile");
		const globalProj = makeProject({ id: "global", name: "Global" });
		await mockApi({ projects: [globalProj] });
		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: { pages: [] } }));

		await page.goto("/project/global");
		const hubLink = page.getByRole("link", { name: "Hub", exact: true }).first();
		await expect(hubLink).toBeVisible();
		await expect(hubLink).toHaveAttribute("href", "/hub");
	});
});
