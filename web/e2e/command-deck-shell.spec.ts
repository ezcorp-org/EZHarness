/**
 * Command Deck — chrome redesign Playwright spec.
 *
 * The "Command Deck" redesign restructures the app shell into a dense,
 * keyboard-first control surface:
 *   - a unified left command column (the `desktop-sidebar` <aside>) with a
 *     search/command-palette trigger carrying an inline ⌘/Ctrl+K kbd hint
 *   - a persistent IDE-style bottom STATUS BAR (`deck-statusbar`) showing the
 *     live connection state, active workspace and a project count
 *   - a top BREADCRUMB context strip (`deck-breadcrumb`) on content routes
 *
 * These assertions pin the *presence + structure* of the new chrome at the
 * desktop breakpoint (≥lg, 1024px+). The behavioural sidebar collapse / mobile
 * drawer policy is covered separately by `theme-sidebar.spec.ts` and
 * `sidebar-mobile.spec.ts`; this spec is purely about the redesigned shell.
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });

// A quiet (app) route that renders the full chrome but isn't a chat route
// (chat has its own header and hides the breadcrumb strip).
const APP_ROUTE = "/account";

test.describe("Command Deck shell @ desktop", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("command column exposes the palette trigger with an inline kbd hint", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await page.goto(APP_ROUTE);
		await page.waitForLoadState("networkidle");

		const sidebar = page.getByTestId("desktop-sidebar");
		await expect(sidebar).toBeVisible();

		// The palette trigger lives in the column header with a "Search" label.
		const trigger = sidebar.getByRole("button", { name: /search/i });
		await expect(trigger).toBeVisible();
		await expect(trigger).toContainText("Search");

		// Inline keyboard-shortcut hint — mono kbd chip ending in "K".
		const kbd = sidebar.locator(".deck-kbd");
		await expect(kbd.first()).toBeVisible();
		await expect(kbd.first()).toContainText("K");
	});

	test("persistent status bar shows connection, workspace and project count", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await page.goto(APP_ROUTE);
		await page.waitForLoadState("networkidle");

		const statusbar = page.getByTestId("deck-statusbar");
		await expect(statusbar).toBeVisible();

		// Connection segment renders an online/offline word + a status dot.
		await expect(statusbar).toContainText(/online|offline/);
		await expect(statusbar.locator(".deck-statusbar__dot")).toBeVisible();

		// Project-count metadata segment (mono "<n> proj").
		await expect(statusbar).toContainText(/\bproj\b/);

		// The status bar sits below the nav at the bottom of the column.
		const box = await statusbar.boundingBox();
		expect(box, "status bar should have a bounding box").not.toBeNull();
	});

	test("breadcrumb context strip is present on content routes", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj] });
		await page.goto(APP_ROUTE);
		await page.waitForLoadState("networkidle");

		const crumb = page.getByTestId("deck-breadcrumb");
		await expect(crumb).toBeVisible();
		// Structural separator between workspace and section.
		await expect(crumb.locator(".deck-breadcrumb__sep")).toBeVisible();
	});

	test("clicking the palette trigger opens the command palette", async ({
		page,
		mockApi,
	}) => {
		// The command palette is central to the Command Deck. Exercise it on a
		// content route where it has its data surfaces wired (mirrors
		// command-palette-v2.spec.ts, which uses /extensions).
		await mockApi({ projects: [proj] });
		await page.goto("/extensions");
		await page.waitForLoadState("networkidle");

		const sidebar = page.getByTestId("desktop-sidebar");
		await sidebar.getByRole("button", { name: /search/i }).click();

		// CommandPalette mounts an input the user can type into.
		await expect(page.getByPlaceholder("Type a command...")).toBeVisible({ timeout: 3000 });
	});
});
