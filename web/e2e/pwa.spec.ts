import { test, expect } from "./fixtures/test-base.js";

test.describe("PWA", () => {
	test.beforeEach(async ({ mockApi }) => {
		await mockApi({});
	});
	test("manifest is served with correct fields", async ({ page }) => {
		const response = await page.goto("/manifest.json");
		expect(response?.status()).toBe(200);
		const manifest = await response?.json();
		expect(manifest.display).toBe("standalone");
		expect(manifest.icons.length).toBeGreaterThan(0);
	});

	test("manifest has name, short_name, and start_url", async ({ page }) => {
		const response = await page.goto("/manifest.json");
		const manifest = await response?.json();
		expect(manifest.name).toBe("EZCorp AI Platform");
		expect(manifest.short_name).toBe("EZCorp");
		expect(manifest.start_url).toBe("/");
	});

	test("manifest icons are served", async ({ request }) => {
		const res192 = await request.get("/favicon-192.png");
		expect(res192.status()).toBe(200);
		expect(res192.headers()["content-type"]).toContain("image/png");

		const res512 = await request.get("/favicon-512.png");
		expect(res512.status()).toBe(200);
		expect(res512.headers()["content-type"]).toContain("image/png");
	});

	test("app.html includes manifest link", async ({ page }) => {
		await page.goto("/extensions");
		const link = page.locator('link[rel="manifest"]');
		await expect(link).toHaveAttribute("href", "/manifest.json");
	});

	test("apple-touch-icon meta tag exists", async ({ page }) => {
		await page.goto("/extensions");
		const appleIcon = page.locator('link[rel="apple-touch-icon"]');
		await expect(appleIcon).toHaveCount(1);
		const href = await appleIcon.getAttribute("href");
		expect(href).toContain("favicon-192.png");
	});

	test("viewport has interactive-widget for mobile keyboard", async ({ page }) => {
		await page.goto("/extensions");
		const viewport = page.locator('meta[name="viewport"]');
		const content = await viewport.getAttribute("content");
		expect(content).toContain("interactive-widget");
	});

	test("theme-color meta tag is present and matches theme", async ({ page }) => {
		// Emulate dark mode so inline script keeps dark defaults
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto("/extensions");
		const theme = page.locator('meta[name="theme-color"]');
		await expect(theme).toHaveAttribute("content", "#111827");
	});

	test("theme-color updates to light when OS prefers light", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "light" });
		await page.goto("/extensions");
		const theme = page.locator('meta[name="theme-color"]');
		await expect(theme).toHaveAttribute("content", "#ffffff");
	});

	test("color-scheme meta tag matches OS preference", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto("/extensions");
		const colorScheme = page.locator('meta[name="color-scheme"]');
		await expect(colorScheme).toHaveAttribute("content", "dark");
	});

	test("manifest theme_color matches app surface color", async ({ page }) => {
		const response = await page.goto("/manifest.json");
		const manifest = await response?.json();
		expect(manifest.theme_color).toBe("#111827");
		expect(manifest.background_color).toBe("#111827");
	});

	test("service worker is served", async ({ request }) => {
		const response = await request.get("/service-worker.js");
		expect(response.status()).toBe(200);
		const body = await response.text();
		expect(body.length).toBeGreaterThan(0);
	});

	test("app layout follows the dynamic viewport height", async ({ page }) => {
		await page.goto("/extensions");
		const layout = page.locator('div[style*="height: 100dvh"]');
		await expect(layout).toBeVisible();
		for (const height of [720, 500]) {
			await page.setViewportSize({ width: 1280, height });
			await expect.poll(async () => (await layout.boundingBox())?.height).toBe(height);
		}
	});
});
