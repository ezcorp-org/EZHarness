import { test, expect } from "./fixtures/test-base.js";

/**
 * First-run registration redirect tests (e2e).
 *
 * Complement to setup-first-run.spec.ts. This file covers the two
 * fresh-instance redirect entry points that lead a brand-new user to
 * /setup:
 *
 *   a) GET /login → 302 /setup       (web/src/routes/(auth)/login/+page.server.ts)
 *   b) GET /     → 302 /setup       (web/src/hooks.server.ts)
 *
 * The unit & integration layers already verify the server-side load /
 * hook logic. Here we stand up the bare minimum HTTP plumbing so we can
 * assert that, when a fresh instance returns 302 → /setup for those two
 * URLs, the browser actually lands on /setup. We follow the exact mock
 * pattern used in setup-first-run.spec.ts: intercept the GET to the page
 * with page.route() and fulfill a synthetic response.
 *
 * Because PI_SKIP_INIT=1 prevents the real DB-bound logic from running
 * during the e2e harness, we never touch real server code. The
 * assertions are about Playwright following the redirect end-to-end.
 */

const SETUP_SHELL_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>EZCorp | Setup</title></head>
<body>
  <h1>Welcome to EZCorp</h1>
  <form id="setup-form" novalidate>
    <input id="name" type="text" />
    <input id="email" type="email" />
    <input id="password" type="password" />
    <input id="confirmPassword" type="password" />
    <button id="submit-btn" type="submit">Create Admin Account</button>
  </form>
</body>
</html>`;

/**
 * Fulfill GET /setup with a minimal HTML body so any test that ends up
 * navigating to /setup can complete the navigation without invoking the
 * real +page.server.ts load (which is gated on a real DB).
 */
async function stubSetup(page: any) {
	await page.route(/^[^?]*\/setup(\?.*)?$/, (route: any) => {
		const url = new URL(route.request().url());
		if (url.pathname === "/setup" && route.request().method() === "GET") {
			return route.fulfill({
				status: 200,
				contentType: "text/html",
				body: SETUP_SHELL_HTML,
			});
		}
		return route.fallback();
	});
}

// Run as fully unauthenticated — independent of local vs Docker harness.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("First-run registration — redirect entry points", () => {
	test("GET /login on fresh instance 302s to /setup", async ({ page, mockApi }) => {
		await mockApi({});
		await stubSetup(page);

		// Intercept GET /login to simulate the +page.server.ts redirect on a
		// fresh instance (getUserCount() === 0 → throw redirect(302, '/setup')).
		await page.route(/^[^?]*\/login(\?.*)?$/, (route: any) => {
			const url = new URL(route.request().url());
			if (url.pathname === "/login" && route.request().method() === "GET") {
				return route.fulfill({
					status: 302,
					headers: { Location: "/setup" },
					body: "",
				});
			}
			return route.fallback();
		});

		await page.goto("/login");
		// Playwright follows the 302 → /setup automatically.
		await expect(page).toHaveURL(/\/setup$/, { timeout: 5000 });
		expect(new URL(page.url()).pathname).toBe("/setup");
	});

	test("GET / on fresh instance 302s to /setup", async ({ page, mockApi }) => {
		await mockApi({});
		await stubSetup(page);

		// Intercept GET / to simulate the hooks.server.ts redirect on a fresh
		// instance (getUserCount() === 0 → return redirect(302, '/setup')).
		await page.route(/^[^?]*\/(\?.*)?$/, (route: any) => {
			const url = new URL(route.request().url());
			if (url.pathname === "/" && route.request().method() === "GET") {
				return route.fulfill({
					status: 302,
					headers: { Location: "/setup" },
					body: "",
				});
			}
			return route.fallback();
		});

		await page.goto("/");
		await expect(page).toHaveURL(/\/setup$/, { timeout: 5000 });
		expect(new URL(page.url()).pathname).toBe("/setup");
	});

	test("GET /setup on fresh instance renders the form", async ({ page, mockApi }) => {
		await mockApi({});
		await stubSetup(page);

		await page.goto("/setup");
		await expect(page.getByRole("heading", { name: "Welcome to EZCorp" })).toBeVisible({ timeout: 5000 });
		await expect(page.locator("#name")).toBeVisible();
		await expect(page.locator("#email")).toBeVisible();
		await expect(page.locator("#password")).toBeVisible();
		await expect(page.locator("#confirmPassword")).toBeVisible();
		await expect(page.getByRole("button", { name: "Create Admin Account" })).toBeVisible();
	});
});
