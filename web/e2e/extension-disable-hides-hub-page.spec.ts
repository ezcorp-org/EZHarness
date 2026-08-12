/**
 * Disabling an extension hides its Hub tab — visual evidence.
 *
 * A frontend-visual change across three surfaces (the uninstall dialog, the
 * extension card's disabled state, and the sidebar's Hub list), so the
 * feature contract requires an `@evidence`-tagged spec that calls
 * `captureEvidence`.
 *
 * The bug this pins is a CACHE, not a permission. `/api/hub/pages` has
 * always filtered on `enabled` server-side, but `HubNavSection` loaded the
 * listing once and never refetched (`if (loaded || loading) return`). So
 * after disabling an extension the user was still looking at its tab in the
 * sidebar, and clicking it reached a page the server now 404s — with a full
 * reload as the only way out. The fix is an `extensions:changed` event the
 * Extensions page dispatches after every enable, disable and uninstall.
 *
 * Every test asserts before it captures: a screenshot of a broken render is
 * worse than no screenshot.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeExtension, makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-hub", name: "Hub Owner" });

const EXT_PAGE_ID = "ext:notes-keeper:dashboard";

/** Hub listing WITH the extension's tab, and the same listing without it. */
const withExtPage = {
	pages: [
		{ id: "core:briefing", title: "Briefing", kind: "core" },
		{ id: EXT_PAGE_ID, title: "Notes Dashboard", kind: "ext" },
	],
};
const withoutExtPage = { pages: [{ id: "core:briefing", title: "Briefing", kind: "core" }] };

/** A user-installed extension that contributes one Hub tab. */
function makeHubExtension(enabled: boolean) {
	return makeExtension({
		id: "ext-notes",
		name: "notes-keeper",
		description: "Keeps notes and ships a Hub dashboard",
		enabled,
		manifest: {
			name: "notes-keeper",
			tools: [],
			permissions: {},
			pages: [{ id: "dashboard", title: "Notes Dashboard" }],
		},
	});
}

/**
 * The Hub page rows currently on screen.
 *
 * `:visible` is required, not tidiness: `(app)/+layout.svelte` mounts
 * `HubNavSection` TWICE — once in the desktop command column and once in
 * the mobile drawer — so on the mobile project a plain `getByTestId` also
 * matches the hidden desktop copy, and `.first()` picks exactly the one
 * that can never be clicked.
 */
function hubNavPages(page: import("@playwright/test").Page) {
	return page.locator('[data-testid="hub-nav-page"]:visible');
}

/**
 * Bring the Hub page list on screen, whatever the viewport.
 *
 * IDEMPOTENT on purpose — it is called before and after the disable, and
 * the two viewports need different work. On desktop the sidebar is always
 * there and the section stays expanded, so a second blind `click()` would
 * COLLAPSE it. On mobile the drawer has to be reopened each time.
 */
async function showHubPages(page: import("@playwright/test").Page) {
	const hamburger = page.getByTestId("mobile-menu-toggle");
	if (await hamburger.isVisible()) await hamburger.click();
	const toggle = page.locator('[data-testid="hub-nav-toggle"]:visible').first();
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
	return hubNavPages(page);
}

/**
 * Get the mobile drawer out of the way. Its backdrop covers the page and
 * intercepts pointer events, so the extension card underneath is
 * unclickable while it is open. A no-op on desktop.
 *
 * Escape rather than a backdrop click: the backdrop spans the viewport, so
 * Playwright aims at its centre — which is underneath the drawer panel, and
 * the panel eats the event. `SwipeDrawer` binds Escape to close the topmost
 * drawer, which is also what a person would reach for.
 */
async function dismissDrawer(page: import("@playwright/test").Page) {
	const backdrop = page.getByTestId("swipe-drawer-backdrop");
	if (!(await backdrop.isVisible())) return;
	await page.keyboard.press("Escape");
	await expect(backdrop).toBeHidden();
}

test.describe("@evidence Disabling an extension hides its Hub page", () => {
	test("the sidebar tab disappears without a reload", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], extensions: [makeHubExtension(true)] });

		// Registered AFTER mockApi so these win over the fixture's catch-all.
		// The listing flips to "no extension page" once the disable lands,
		// exactly as the server would once `enabled` is false.
		let disabled = false;
		await page.route("**/api/hub/pages", (route) =>
			route.fulfill({ json: disabled ? withoutExtPage : withExtPage }),
		);
		await page.route("**/api/extensions/ext-notes", async (route) => {
			if (route.request().method() !== "PATCH") return route.fallback();
			disabled = true;
			return route.fulfill({ json: { id: "ext-notes", enabled: false } });
		});

		await page.goto("/extensions");

		// Before: the extension's tab is in the sidebar's Hub list.
		const rowsBefore = await showHubPages(page);
		await expect(rowsBefore.filter({ hasText: "Notes Dashboard" })).toHaveCount(1);
		await dismissDrawer(page);

		// Disable it from the card toggle. No navigation, no reload.
		await page.locator("button[title='Disable']").first().click();

		// After: the tab is gone, and the remaining core tab is untouched —
		// the listing was refetched, not merely emptied.
		//
		// The DESKTOP project is what pins the regression: its sidebar never
		// unmounts, so a stale cache would still be showing the tab here. The
		// mobile drawer is `{#if visible}`, so reopening it remounts the
		// component either way — that leg asserts the same user-visible
		// outcome rather than the cache behaviour behind it.
		const rowsAfter = await showHubPages(page);
		await expect(rowsAfter.filter({ hasText: "Notes Dashboard" })).toHaveCount(0, {
			timeout: 5000,
		});
		await expect(rowsAfter.filter({ hasText: "Briefing" })).toHaveCount(1);

		await captureEvidence(page, testInfo, "hub-tab-hidden-after-disable");
	});

	test("the card says the Hub tab is hidden while the extension is off", async ({ page, mockApi }, testInfo) => {
		// Cause and effect in one place: the Hub itself cannot explain why a
		// tab vanished, so the card that caused it does.
		await mockApi({ projects: [proj], extensions: [makeHubExtension(false)] });
		await page.goto("/extensions");

		const note = page.getByTestId("ext-card-pages-hidden");
		await expect(note).toBeVisible({ timeout: 5000 });
		await expect(note).toContainText("Hub tab is hidden");

		await captureEvidence(page, testInfo, "extension-card-hub-tab-hidden");
	});

	test("the uninstall dialog names the data directory and makes the user choose", async ({ page, mockApi }, testInfo) => {
		// The delete now reaches the filesystem. Neither option is
		// preselected: a default "delete" destroys data people meant to keep,
		// a default "keep" orphans directories nobody cleans up.
		await mockApi({ projects: [proj], extensions: [makeHubExtension(true)] });
		await page.goto("/extensions");

		await page.getByTestId("ext-card-uninstall").click();

		const dialog = page.getByTestId("uninstall-dialog");
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await expect(dialog).toContainText(".ezcorp/extension-data/notes-keeper/");
		await expect(page.getByTestId("uninstall-keep-data")).not.toBeChecked();
		await expect(page.getByTestId("uninstall-delete-data")).not.toBeChecked();
		await expect(page.getByTestId("uninstall-confirm")).toBeDisabled();

		await captureEvidence(page, testInfo, "uninstall-dialog-data-choice");
	});
});
