/**
 * Phase 49.1 — Mobile-responsive sidebar Playwright spec.
 *
 * Exercises the live UX at 375x667 (iPhone SE viewport):
 *   - hamburger is the visible nav affordance, project rail + sidebar
 *     are hidden
 *   - tap hamburger → drawer opens
 *   - tap a nav link inside the drawer → drawer closes + navigation
 *     happens (already wired via `onclick={() => (store.mobileMenuOpen
 *     = false)}` in +layout.svelte)
 *   - tap the backdrop → drawer closes
 *   - hamburger is `min-width: 44px; min-height: 44px` (WCAG 2.1 AA
 *     target size)
 *
 * The component-level breakpoint policy is pinned by
 * `src/__tests__/layout-mobile-breakpoint.test.ts` (jsdom can't apply
 * Tailwind utilities so visibility-via-class can't be asserted there).
 * This Playwright run is where Chromium actually applies media
 * queries.
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

test.describe("Phase 49.1 — mobile-responsive sidebar @ 375x667", () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test("hamburger visible, desktop sidebar hidden at <lg", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: "p1", name: "Demo" })] });
		await page.goto("/agents");
		await page.waitForLoadState("networkidle");

		// Hamburger is the visible nav affordance.
		const hamburger = page.getByTestId("mobile-menu-toggle");
		await expect(hamburger).toBeVisible();

		// Desktop sidebar (the inline <aside aria-label="Sidebar">) is
		// hidden at <lg. We don't assert `not.toBeVisible()` directly on
		// the aria-label="Sidebar" selector because the SwipeDrawer's
		// inner <aside> isn't rendered yet (drawer is closed) — we
		// instead assert the inline <aside> isn't visible.
		const desktopAside = page.locator('aside[aria-label="Sidebar"]').first();
		await expect(desktopAside).toBeHidden();
	});

	test("hamburger has 44x44 minimum touch target (WCAG 2.1 AA)", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: "p1", name: "Demo" })] });
		await page.goto("/agents");
		await page.waitForLoadState("networkidle");

		const box = await page.getByTestId("mobile-menu-toggle").boundingBox();
		expect(box, "hamburger should have a bounding box").not.toBeNull();
		expect(box!.width).toBeGreaterThanOrEqual(44);
		expect(box!.height).toBeGreaterThanOrEqual(44);
	});

	test("tap hamburger → drawer opens", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: "p1", name: "Demo" })] });
		await page.goto("/agents");
		await page.waitForLoadState("networkidle");

		// Drawer not yet mounted (visible=false → unmounted in SwipeDrawer)
		await expect(page.getByTestId("swipe-drawer")).toHaveCount(0);

		await page.getByTestId("mobile-menu-toggle").click();

		// Drawer mounts and is visible.
		await expect(page.getByTestId("swipe-drawer")).toBeVisible();
		await expect(page.getByTestId("swipe-drawer-panel")).toBeVisible();
	});

	test("tap backdrop → drawer closes", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: "p1", name: "Demo" })] });
		await page.goto("/agents");
		await page.waitForLoadState("networkidle");

		await page.getByTestId("mobile-menu-toggle").click();
		await expect(page.getByTestId("swipe-drawer")).toBeVisible();

		await page.getByTestId("swipe-drawer-backdrop").click({ position: { x: 350, y: 100 } });
		// Wait for the SwipeDrawer's 300ms close transition + unmount
		// timer (`visible = false` after 300ms in the $effect).
		await expect(page.getByTestId("swipe-drawer")).toHaveCount(0, { timeout: 1500 });
	});

	test("tap nav link inside drawer → drawer closes", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: "p1", name: "Demo" })] });
		await page.goto("/agents");
		await page.waitForLoadState("networkidle");

		await page.getByTestId("mobile-menu-toggle").click();
		const drawer = page.getByTestId("swipe-drawer");
		await expect(drawer).toBeVisible();

		// Click a known nav link (Extensions) inside the drawer.
		await drawer.getByRole("link", { name: "Extensions" }).first().click();
		await expect(page.getByTestId("swipe-drawer")).toHaveCount(0, { timeout: 1500 });
		await expect(page).toHaveURL(/\/extensions/);
	});
});
