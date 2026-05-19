import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });

// Phase 59-06 (TEST-02): all sidebar/ThemeToggle SUT lives inside the
// `(app)` route group (`web/src/routes/(app)/+layout.svelte`). The bare
// `/` route is the public landing page (`web/src/routes/+page.svelte`)
// and intentionally has NO sidebar — so these tests navigate to a quiet
// `(app)` route (`/account`) instead. Use `data-testid` selectors that
// target the layout SUT directly (no role / class drift).
const APP_ROUTE = "/account";

// ThemeToggle is rendered TWICE in the (app) layout:
//   - inside `desktop-sidebar` (visible at ≥lg, 1024px+)
//   - inside `mobile-header`   (visible at <lg, also `!isChatRoute`)
// Resolve to the visible instance based on viewport so chromium (default
// desktop) and mobile-chromium (Pixel 5, 393px) both pick the right node.
function themeToggle(page: import("@playwright/test").Page) {
	return page.locator(
		"[data-testid='desktop-sidebar']:visible button[aria-label='Toggle theme']," +
		" [data-testid='mobile-header']:visible button[aria-label='Toggle theme']"
	);
}

test.describe("Theme", () => {
	test("theme toggle button is visible", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto(APP_ROUTE);

		await expect(themeToggle(page)).toBeVisible();
	});

	test("toggle dark to light removes .dark class", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		// Pre-set dark theme deterministically so this test doesn't depend on
		// the host's `prefers-color-scheme` (which Playwright defaults to light).
		await page.addInitScript(() => {
			localStorage.setItem("ezcorp-theme", "dark");
		});
		await page.goto(APP_ROUTE);
		await waitForSplashGone(page);

		await expect(page.locator("html")).toHaveClass(/dark/);

		await themeToggle(page).click();

		await expect(page.locator("html")).not.toHaveClass(/dark/);
	});

	test("toggle light to dark adds .dark class", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		// Pre-set light theme before navigation so the FOUC script picks it up
		await page.addInitScript(() => {
			localStorage.setItem("ezcorp-theme", "light");
		});
		await page.goto(APP_ROUTE);

		await expect(page.locator("html")).not.toHaveClass(/dark/);

		await themeToggle(page).click();

		await expect(page.locator("html")).toHaveClass(/dark/);
	});

	test("theme persists in localStorage", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto(APP_ROUTE);

		// Toggle away from default
		await themeToggle(page).click();

		const stored = await page.evaluate(() => localStorage.getItem("ezcorp-theme"));
		expect(stored).toBeTruthy();
		expect(["dark", "light"]).toContain(stored);
	});

	test("FOUC prevention script sets .dark before hydration", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });

		// Set dark preference so the inline script in app.html adds .dark
		await page.addInitScript(() => {
			localStorage.setItem("ezcorp-theme", "dark");
		});

		// Intercept before Svelte hydration: check .dark is present on DOMContentLoaded
		const hasDarkBeforeHydration = await new Promise<boolean>((resolve) => {
			page.on("domcontentloaded", async () => {
				const result = await page.evaluate(() =>
					document.documentElement.classList.contains("dark"),
				);
				resolve(result);
			});
			page.goto(APP_ROUTE);
		});

		expect(hasDarkBeforeHydration).toBe(true);
	});
});

// Desktop viewport for the sidebar collapse/expand tests — the desktop
// sidebar is `hidden lg:flex` (≥1024px). Pixel-5-defaulted mobile-chromium
// hides the sidebar entirely; explicit setViewportSize ensures the same
// surface is exercised across both project matrices.
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

// The (app) layout shows a full-viewport `#splash` overlay (z-index 9999)
// until onMount removes it. Playwright `click()` should wait for the
// covering element to disappear, but the 300ms fade animation can race
// with reactive state updates — wait for splash detach explicitly so
// the button click reliably lands on the underlying button, not the
// half-faded splash overlay.
async function waitForSplashGone(page: import("@playwright/test").Page) {
	await page.waitForFunction(() => !document.getElementById("splash"), undefined, { timeout: 5000 });
}

// Phase 61-01 (Bucket B REPAIR): the 5 sidebar fixmes from Phase 59-06
// (commit ca1de59) were misdiagnosed as a Svelte 5 singleton-store
// reactivity bug. The actual root cause is `test-env-only`:
// `/account/+page.svelte:308` reads `account.name.charAt(0)` after
// `onMount` fetches `/api/account`, which returns `{}` from the
// api-mocks default catch-all. The thrown TypeError aborts Svelte 5's
// effect scheduler mid-flush so subsequent `{#if}` blocks never
// re-render. See .planning/debug/svelte5-layout-reactivity-2026-05-12.md
// for the full verdict. Fix shape: pre-mount /api/account mock so
// the page mounts cleanly; no SUT change required.
//
// IMPORTANT: this helper MUST be called AFTER `mockApi(...)` because
// Playwright runs page.route handlers in reverse-registration order —
// `setupApiMocks` (called by mockApi) registers a `**/api/**` catch-all
// that would otherwise win and return `{}`. Registering these
// narrower-match routes LAST puts them first in the resolution order.
async function mockAccountEndpoints(page: import("@playwright/test").Page) {
	await page.route("**/api/account", (route) =>
		route.fulfill({
			json: {
				id: "u1",
				email: "test@example.com",
				name: "Test User",
				role: "member",
				createdAt: new Date().toISOString(),
			},
		}),
	);
	await page.route("**/api/account/sessions", (route) =>
		route.fulfill({ json: { sessions: [] } }),
	);
	await page.route("**/api/account/login-history", (route) =>
		route.fulfill({ json: { entries: [] } }),
	);
}

test.describe("Sidebar", () => {

	test("collapse button hides sidebar", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await mockAccountEndpoints(page);
		await page.setViewportSize(DESKTOP_VIEWPORT);
		await page.goto(APP_ROUTE);

		const sidebar = page.getByTestId("desktop-sidebar");
		await expect(sidebar).toBeVisible();

		await page.getByTestId("sidebar-collapse-btn").click();

		// After collapse the aside gets w-0 and the expand button appears.
		await expect(page.getByTestId("sidebar-expand-btn")).toBeVisible();
	});

	test("expand after collapse restores sidebar", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await mockAccountEndpoints(page);
		await page.setViewportSize(DESKTOP_VIEWPORT);
		await page.goto(APP_ROUTE);
		await waitForSplashGone(page);

		// Collapse
		await page.getByTestId("sidebar-collapse-btn").click();
		await expect(page.getByTestId("sidebar-expand-btn")).toBeVisible();

		// Expand
		await page.getByTestId("sidebar-expand-btn").click();

		// Sidebar content should be visible again
		const sidebar = page.getByTestId("desktop-sidebar");
		await expect(sidebar).toBeVisible();
		// "Home" link is always present in the (app) sidebar nav (global project default)
		await expect(sidebar.getByRole("link", { name: "Home" })).toBeVisible();
	});

	test("Ctrl+\\ shortcut toggles sidebar", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await mockAccountEndpoints(page);
		await page.setViewportSize(DESKTOP_VIEWPORT);
		await page.goto(APP_ROUTE);
		await waitForSplashGone(page);

		const sidebar = page.getByTestId("desktop-sidebar");
		await expect(sidebar).toBeVisible();

		// Press Ctrl+\ to collapse
		await page.keyboard.press("Control+\\");
		await expect(page.getByTestId("sidebar-expand-btn")).toBeVisible();

		// Press again to expand
		await page.keyboard.press("Control+\\");
		await expect(sidebar.getByRole("link", { name: "Home" })).toBeVisible();
	});

	test("collapsed state persists in localStorage", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.setViewportSize(DESKTOP_VIEWPORT);
		await page.goto(APP_ROUTE);

		await page.getByTestId("sidebar-collapse-btn").click();

		const stored = await page.evaluate(() =>
			localStorage.getItem("pi-sidebar-collapsed"),
		);
		expect(stored).toBe("true");
	});

	test("mobile hamburger button appears on small viewport", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.setViewportSize({ width: 375, height: 667 });
		await page.goto(APP_ROUTE);

		await expect(page.getByTestId("mobile-menu-toggle")).toBeVisible();

		// Desktop sidebar should be hidden on mobile (hidden via `hidden lg:flex`)
		await expect(page.getByTestId("desktop-sidebar")).toBeHidden();
	});

	test("mobile drawer opens on hamburger click", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await mockAccountEndpoints(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await page.goto(APP_ROUTE);
		await waitForSplashGone(page);

		await page.getByTestId("mobile-menu-toggle").click();

		// The SwipeDrawer overlay should appear with navigation links
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible();
		const panel = page.getByTestId("swipe-drawer-panel");
		await expect(panel.getByRole("link", { name: "Home" })).toBeVisible();
	});

	test("mobile drawer closes on backdrop click", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await mockAccountEndpoints(page);
		await page.setViewportSize({ width: 375, height: 667 });
		await page.goto(APP_ROUTE);
		await waitForSplashGone(page);

		await page.getByTestId("mobile-menu-toggle").click();

		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible();

		// Click the backdrop to close the drawer
		const backdrop = page.getByTestId("swipe-drawer-backdrop");
		await backdrop.click({ force: true });

		await expect(drawer).toBeHidden();
	});
});
