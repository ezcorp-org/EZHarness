/**
 * Hub side-nav dropdown + ABC-ordered tabs — page-level e2e (mockApi, no Docker).
 *
 * Covers the two user-visible behaviours added on top of the Extension Pages
 * Hub:
 *   1. The sidebar "Hub" entry is a collapsible dropdown that STARTS COLLAPSED,
 *      expands to reveal every Hub page ALPHABETICALLY, collapses again, and
 *      navigates into a page on click.
 *   2. The Hub page's own tab bar renders those same pages ALPHABETICALLY.
 *
 * The listing is served deliberately OUT of order so a passing assertion can
 * only mean the UI sorted it (not that the source happened to be alphabetical).
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });

// Source order: Zephyr, Cron Dashboard, Briefing.
// Expected ABC order everywhere: Briefing, Cron Dashboard, Zephyr.
const listing = {
	pages: [
		{ id: "core:zephyr", title: "Zephyr", kind: "core" },
		{ id: "ext:cron-dashboard:dashboard", title: "Cron Dashboard", kind: "ext" },
		{ id: "core:briefing", title: "Briefing", kind: "core" },
	],
};

const ABC = ["Briefing", "Cron Dashboard", "Zephyr"];

function tree(title: string) {
	return { title, nodes: [{ type: "status", label: "Ready", state: "success" }] };
}

/** Wire the listing + a render endpoint for every page id. Render routes match
 *  on the decoded pathname (the id's colons are percent-encoded in the URL). */
async function mockHub(page: Page) {
	await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
	for (const p of listing.pages) {
		await page.route(
			(url) => decodeURIComponent(url.pathname).endsWith(`/api/hub/pages/${p.id}`),
			(route) => route.fulfill({ json: { page: tree(p.title) } }),
		);
	}
}

test.describe("Hub side-nav dropdown", () => {
	test("sidebar Hub entry: starts collapsed, expands to an ABC list, collapses, navigates", async ({
		page,
		mockApi,
		isMobile,
	}) => {
		// The dropdown lives in the desktop command column; the mobile drawer is
		// a separate lane exercised by the same component's DOM tests.
		test.skip(isMobile, "sidebar dropdown targets the desktop command column");
		await mockApi({ projects: [proj] });
		await mockHub(page);

		await page.goto("/memories");
		const sidebar = page.getByTestId("desktop-sidebar");
		const toggle = sidebar.getByTestId("hub-nav-toggle");

		// Starts COLLAPSED — the page list is not rendered.
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(sidebar.getByTestId("hub-nav-pages")).toHaveCount(0);

		// Expand → the pages appear ALPHABETICALLY.
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		const pages = sidebar.getByTestId("hub-nav-page");
		await expect(pages).toHaveCount(3);
		for (let i = 0; i < ABC.length; i++) {
			await expect(pages.nth(i)).toHaveText(ABC[i]!);
		}

		// Collapse hides the list again.
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(sidebar.getByTestId("hub-nav-pages")).toHaveCount(0);

		// Re-expand (cached) and click a page → lands on that hub page.
		await toggle.click();
		await sidebar.getByTestId("hub-nav-page").filter({ hasText: "Briefing" }).click();
		await expect(page).toHaveURL(/\/hub\/core%3Abriefing$/);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Briefing");
	});

	test("hub page tab bar renders tabs in ABC order regardless of listing order", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await mockHub(page);

		await page.goto(`/hub/${encodeURIComponent("core:briefing")}`);
		await expect(page.getByTestId("hub-page-title")).toHaveText("Briefing");

		const tabs = page.getByTestId("hub-tab");
		await expect(tabs).toHaveCount(3);
		for (let i = 0; i < ABC.length; i++) {
			await expect(tabs.nth(i)).toHaveText(ABC[i]!);
		}
		// The active tab is the one we deep-linked to, wherever it sorts.
		await expect(tabs.filter({ hasText: "Briefing" })).toHaveAttribute("aria-selected", "true");
	});

	test("expanded dropdown + ABC tab bar render for visual evidence @evidence", async ({
		page,
		mockApi,
		isMobile,
	}, testInfo) => {
		test.skip(isMobile, "sidebar dropdown targets the desktop command column");
		await mockApi({ projects: [proj] });
		await mockHub(page);

		await page.goto("/memories");
		const sidebar = page.getByTestId("desktop-sidebar");
		await sidebar.getByTestId("hub-nav-toggle").click();
		await expect(sidebar.getByTestId("hub-nav-page")).toHaveCount(3);
		await captureEvidence(page, testInfo, "hub-sidebar-dropdown");

		await sidebar.getByTestId("hub-nav-page").filter({ hasText: "Briefing" }).click();
		await expect(page.getByTestId("hub-page-title")).toHaveText("Briefing");
		await expect(page.getByTestId("hub-tab")).toHaveCount(3);
		await captureEvidence(page, testInfo, "hub-tab-bar-abc");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "hub-sidebar-dropdown" && a.contentType === "image/png",
				),
			).toBe(true);
			expect(
				testInfo.attachments.some(
					(a) => a.name === "hub-tab-bar-abc" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "hub-sidebar-dropdown")).toBe(false);
		}
	});
});
