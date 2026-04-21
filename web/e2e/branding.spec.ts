import { test, expect } from "./fixtures/test-base.js";

/** Remove the splash overlay so underlying page content is testable. */
async function dismissSplash(page: import("@playwright/test").Page) {
	await page.evaluate(() => document.getElementById("splash")?.remove());
}

test.describe("Branding - Login page", () => {
	test("displays the EZCorp logo", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/login");
		await dismissSplash(page);

		const logo = page.locator('img[alt="EZCorp"][src="/logo.svg"]');
		await expect(logo).toBeVisible();
	});

	test("has page title containing EZCorp", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/login");

		const title = await page.title();
		expect(title).toContain("EZCorp");
	});

	test("error page shows branded EZCorp logo", async ({ page, mockApi }) => {
		// Auth pages hit 500 in e2e (no real DB), so the error page is shown.
		// Verify the error page itself uses EZCorp branding.
		await mockApi();
		await page.goto("/login");
		await dismissSplash(page);

		// The custom error page should show the EZ logo
		const logo = page.locator('img[alt="EZCorp"]');
		await expect(logo).toBeVisible();
		// And a "Go home" link
		await expect(page.getByText("Go home")).toBeVisible();
	});
});

test.describe("Branding - Setup page", () => {
	test("displays the EZCorp logo", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/setup");
		await dismissSplash(page);

		const logo = page.locator('img[alt="EZCorp"][src="/logo.svg"]');
		await expect(logo).toBeVisible();
	});

	test("has page title containing EZCorp", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/setup");

		const title = await page.title();
		expect(title).toContain("EZCorp");
	});

	test("setup error page shows branded EZCorp logo", async ({
		page,
		mockApi,
	}) => {
		await mockApi();
		await page.goto("/setup");
		await dismissSplash(page);

		const logo = page.locator('img[alt="EZCorp"]');
		await expect(logo).toBeVisible();
	});
});

test.describe("Branding - App layout", () => {
	// Landing page is chromeless by design — no sidebar/header on /
	test.skip("sidebar displays small logo", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/");

		const sidebarLogo = page.locator('aside img[src="/logo-small.png"]');
		await expect(sidebarLogo.first()).toBeVisible();
	});

	// Landing page is chromeless by design — no sidebar/header on /
	test.skip("mobile header displays small logo", async ({ page, mockApi }) => {
		await mockApi();
		await page.setViewportSize({ width: 375, height: 667 });
		await page.goto("/");

		const mobileLogo = page.locator(
			'div.flex.md\\:hidden img[src="/logo-small.png"]',
		);
		await expect(mobileLogo).toBeVisible();
	});

	test("has default page title containing EZCorp", async ({
		page,
		mockApi,
	}) => {
		await mockApi();
		await page.goto("/");

		const title = await page.title();
		expect(title).toContain("EZCorp");
	});
});

test.describe("Branding - Favicon", () => {
	test("has favicon.ico link in head", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/");

		const hasFavicon = await page.evaluate(
			() =>
				document.querySelector(
					'link[rel="icon"][href*="favicon.ico"]',
				) !== null,
		);
		expect(hasFavicon).toBe(true);
	});

	test("has PNG favicon link in head", async ({ page, mockApi }) => {
		await mockApi();
		await page.goto("/");

		const hasPng = await page.evaluate(
			() =>
				document.querySelector(
					'link[rel="icon"][type="image/png"][href*="favicon-192"]',
				) !== null,
		);
		expect(hasPng).toBe(true);
	});
});

test.describe("Branding - Splash screen", () => {
	test("splash div exists in initial HTML and contains logo", async ({
		page,
	}) => {
		const hasSplashLogo = await new Promise<boolean>((resolve) => {
			page.on("domcontentloaded", async () => {
				const result = await page.evaluate(() => {
					const splash = document.getElementById("splash");
					if (!splash) return false;
					return splash.querySelector('img[src="/logo.svg"]') !== null;
				});
				resolve(result);
			});
			page.goto("/login");
		});

		expect(hasSplashLogo).toBe(true);
	});

	test("splash is removed after app hydration", async ({
		page,
		mockApi,
	}) => {
		await mockApi();
		await page.goto("/");

		// After hydration the app layout's onMount removes #splash
		await expect(page.locator("#splash")).toHaveCount(0, { timeout: 5000 });
	});
});
