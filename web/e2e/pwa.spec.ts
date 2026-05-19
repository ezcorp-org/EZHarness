import { test, expect } from "@playwright/test";

test.describe("PWA", () => {
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
		await page.goto("/login");
		const link = page.locator('link[rel="manifest"]');
		await expect(link).toHaveAttribute("href", "/manifest.json");
	});

	test("apple-touch-icon meta tag exists", async ({ page }) => {
		await page.goto("/login");
		const appleIcon = page.locator('link[rel="apple-touch-icon"]');
		await expect(appleIcon).toHaveCount(1);
		const href = await appleIcon.getAttribute("href");
		expect(href).toContain("favicon-192.png");
	});

	test("viewport has interactive-widget for mobile keyboard", async ({ page }) => {
		await page.goto("/login");
		const viewport = page.locator('meta[name="viewport"]');
		const content = await viewport.getAttribute("content");
		expect(content).toContain("interactive-widget");
	});

	test("theme-color meta tag is present and matches theme", async ({ page }) => {
		// Emulate dark mode so inline script keeps dark defaults
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto("/login");
		const theme = page.locator('meta[name="theme-color"]');
		await expect(theme).toHaveAttribute("content", "#111827");
	});

	test("theme-color updates to light when OS prefers light", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "light" });
		await page.goto("/login");
		const theme = page.locator('meta[name="theme-color"]');
		await expect(theme).toHaveAttribute("content", "#ffffff");
	});

	test("color-scheme meta tag matches OS preference", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto("/login");
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

	test("layout container uses 100dvh viewport height", async ({ page }) => {
		await page.goto("/login");
		// Login page does not use the app layout, so navigate to an authenticated page
		// Instead, check the login page source or go directly to check the app layout
		// The app layout wraps authenticated routes; check /login first for the meta,
		// then verify the layout div style via a page that renders it.
		// We can test this by checking if the CSS rule is present in the built output.
		// Since we can't easily authenticate, verify the raw layout uses dvh by
		// checking the page source includes the dvh pattern.
		const response = await page.goto("/");
		const content = await response?.text();
		// The built HTML should contain the dvh style from the layout component
		expect(content).toContain("100dvh");
	});
});
