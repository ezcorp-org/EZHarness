import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";
import { mockPageData, resumePage } from "./fixtures/page-data.js";

// Render the shipped login component through SvelteKit client navigation.
// Only server loader data and HTTP responses are controlled. Real cookie,
// credential, and server returnTo validation run in the real-auth/server suites.
async function gotoLogin(page: Page, search = "", returnTo = "/") {
  await mockPageData(page, "/login", { returnTo });
  await resumePage(page, `/login${search}`);
}

test.describe("Auth — Login Page", () => {
	for (const colorScheme of ["light", "dark"] as const) {
		test(`${colorScheme}: expired-session and login-error messages are readable`, async ({ page, mockApi }, testInfo) => {
			await page.emulateMedia({ colorScheme });
			await mockApi({});
			await page.route("**/api/auth/login", route => route.fulfill({ status: 401, json: { error: "Invalid email or password" } }));
			await gotoLogin(page, "?reason=session_expired");
			await expect(page.getByText("Your session has expired. Please log in again.", { exact: true })).toBeVisible();
			const warning = await new AxeBuilder({ page }).include(".max-w-md").analyze();
			expect.soft(warning.violations).toEqual([]);
			await captureEvidence(page, testInfo, `login-warning-${colorScheme}`);
			await page.getByLabel("Email", { exact: true }).fill("invalid@example.com");
			await page.getByLabel("Password", { exact: true }).fill("password123");
			await page.getByRole("button", { name: "Sign In", exact: true }).click();
			await expect(page.getByText("Invalid email or password", { exact: true })).toBeVisible();
			const error = await new AxeBuilder({ page }).include(".max-w-md").analyze();
			expect.soft(error.violations).toEqual([]);
			await captureEvidence(page, testInfo, `login-error-${colorScheme}`);
		});
	}

	test("login form renders with email, password, and submit button", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('input[type="password"]')).toBeVisible();
		await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
	});

	test("page title is set correctly", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		await expect(page).toHaveTitle(/Sign In/i);
	});

	test("page shows 'Sign in to EZCorp' heading", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		await expect(page.getByText("Sign in to EZCorp")).toBeVisible({ timeout: 5000 });
	});

	test("shows Email and Password labels", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		await expect(page.getByText("Email")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Password")).toBeVisible();
	});

	test("submit button becomes disabled and shows loading text while submitting", async ({ page, mockApi }) => {
		await mockApi({});
        let releaseResponse!: () => void;
        const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
        await page.route("**/api/auth/login", async route => {
            await responseGate;
            await route.fulfill({ status: 401, json: { error: "Try again" } });
        });
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("Test@Example.com");
		await page.locator('input[type="password"]').fill("password123");
		const submitted = page.waitForRequest(request => request.url().endsWith("/api/auth/login") && request.method() === "POST");
		await page.getByRole("button", { name: "Sign In" }).click();
		expect((await submitted).postDataJSON()).toEqual({ email: "test@example.com", password: "password123" });

		await expect(page.getByRole("button", { name: "Signing in..." })).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("button", { name: "Signing in..." })).toBeDisabled();
        releaseResponse();
        await expect(page.getByText("Try again", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "Sign In", exact: true })).toBeEnabled();
	});

	test("shows error message on invalid credentials", async ({ page, mockApi }) => {
		await mockApi({});
		await page.route("**/api/auth/login", (route) => {
			return route.fulfill({ status: 401, json: { error: "Invalid email or password" } });
		});
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("bad@example.com");
		await page.locator('input[type="password"]').fill("wrongpass");
		await page.getByRole("button", { name: "Sign In" }).click();

		await expect(page.getByText("Invalid email or password")).toBeVisible({ timeout: 5000 });
	});

	test("shows generic 'Login failed' when server returns no error message", async ({ page, mockApi }) => {
		await mockApi({});
		await page.route("**/api/auth/login", (route) => {
			return route.fulfill({ status: 500, json: {} });
		});
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("test@example.com");
		await page.locator('input[type="password"]').fill("password123");
		await page.getByRole("button", { name: "Sign In" }).click();

		await expect(page.getByText("Login failed")).toBeVisible({ timeout: 5000 });
	});

	test("shows session expired warning when ?reason=session_expired", async ({ page, mockApi }, testInfo) => {
		await mockApi({});
		await gotoLogin(page, "?reason=session_expired");

		await expect(page.getByText("Your session has expired")).toBeVisible({ timeout: 5000 });
		await captureEvidence(page, testInfo, "login-session-expired-native");
	});

	test("does not show session expired banner without query param", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		const banner = page.getByText("Your session has expired", { exact: false });
		await expect(banner).not.toBeVisible();
	});

	test("successful login redirects away from /login", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: "proj-1" })] });
		await page.route("**/api/auth/login", (route) => {
			return route.fulfill({ json: { token: "test-jwt", user: { id: "u1", email: "test@example.com" } } });
		});
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("test@example.com");
		await page.locator('input[type="password"]').fill("password123");

		// Listen for navigation away
		const navigationPromise = page.waitForURL((url: URL) => url.pathname !== "/login", { timeout: 5000 });
		await page.getByRole("button", { name: "Sign In" }).click();
		await navigationPromise;

		expect(page.url()).not.toContain("/login");
	});

	test("shows invite hint text at bottom of page", async ({ page, mockApi }) => {
		await mockApi({});
		await gotoLogin(page);

		await expect(page.getByText("Have an invite link?")).toBeVisible({ timeout: 5000 });
	});

	// ── returnTo: restore prior page after re-login ──────────────────
	// The login page is reached either directly or via hooks.server.ts when
	// the user's session expires. In the expired case the redirect carries
	// `?returnTo=<original-path>` so the client can navigate back there
	// after a successful login. These tests exercise the client-side half
	// (the server-side capture and sanitization is covered by
	// hooks-server-return-to.server.test.ts and login-page.server.test.ts).

	test("returnTo: successful login navigates to the captured returnTo path", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: "proj-1" })] });
		await page.route("**/api/auth/login", (route) => {
			return route.fulfill({ json: { token: "test-jwt", user: { id: "u1", email: "test@example.com" } } });
		});
		await gotoLogin(page, "?returnTo=%2Fproject%2Fproj-1%2Fchat", "/project/proj-1/chat");

		await page.locator('input[type="email"]').fill("test@example.com");
		await page.locator('input[type="password"]').fill("password123");

		const navigationPromise = page.waitForURL((url: URL) => url.pathname === "/project/proj-1/chat", { timeout: 5000 });
		await page.getByRole("button", { name: "Sign In" }).click();
		await navigationPromise;

		expect(new URL(page.url()).pathname).toBe("/project/proj-1/chat");
	});

	test("returnTo: missing param falls back to / on successful login", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: "proj-1" })] });
		await page.route("**/api/auth/login", (route) => {
			return route.fulfill({ json: { token: "test-jwt", user: { id: "u1", email: "test@example.com" } } });
		});
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("test@example.com");
		await page.locator('input[type="password"]').fill("password123");

		const navigationPromise = page.waitForURL((url: URL) => url.pathname === "/", { timeout: 5000 });
		await page.getByRole("button", { name: "Sign In" }).click();
		await navigationPromise;

		expect(new URL(page.url()).pathname).toBe("/");
	});

	test("returnTo: the client uses the safe loader path when the URL contains an unsafe target", async ({ page, mockApi }) => {
		await mockApi({ projects: [makeProject({ id: "proj-1" })] });
		await page.route("**/api/auth/login", (route) => {
			return route.fulfill({ json: { token: "test-jwt", user: { id: "u1", email: "test@example.com" } } });
		});
		// The server returns a safe destination. The client must use that
		// loader value, rather than rereading the unsafe query parameter.
		await gotoLogin(page, "?returnTo=%2F%2Fevil.com%2Fphish", "/");

		await page.locator('input[type="email"]').fill("test@example.com");
		await page.locator('input[type="password"]').fill("password123");

		const originalHost = new URL(page.url()).host;
		const navigationPromise = page.waitForURL(
			(url: URL) => url.pathname === "/" && url.host === originalHost,
			{ timeout: 5000 },
		);
		await page.getByRole("button", { name: "Sign In" }).click();
		await navigationPromise;

		const final = new URL(page.url());
		expect(final.host).toBe(originalHost);
		expect(final.pathname).toBe("/");
		// Critical: must NOT have navigated off-site.
		expect(final.host).not.toContain("evil.com");
	});

	test("submit button re-enables after failed login", async ({ page, mockApi }) => {
		await mockApi({});
		await page.route("**/api/auth/login", (route) => {
			return route.fulfill({ status: 401, json: { error: "Bad credentials" } });
		});
		await gotoLogin(page);

		await page.locator('input[type="email"]').fill("test@example.com");
		await page.locator('input[type="password"]').fill("bad");
		await page.getByRole("button", { name: "Sign In" }).click();

		await expect(page.getByText("Bad credentials")).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Sign In" })).toBeEnabled();
	});

	test("a network failure leaves the form ready for a successful retry", async ({ page, mockApi }) => {
		await mockApi({});
		let attempts = 0;
		await page.route("**/api/auth/login", route => ++attempts === 1
			? route.abort("failed")
			: route.fulfill({ json: { token: "test-jwt" } }));
		await gotoLogin(page, "?returnTo=%2Fsettings", "/settings");
		await page.getByLabel("Email", { exact: true }).fill("retry@example.com");
		await page.getByLabel("Password", { exact: true }).fill("password123");
		await page.getByRole("button", { name: "Sign In", exact: true }).click();
		await expect(page.getByText("Network error. Please try again.", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Sign In", exact: true })).toBeEnabled();
		await page.getByRole("button", { name: "Sign In", exact: true }).click();
		await expect(page).toHaveURL(url => url.pathname === "/settings");
		expect(attempts).toBe(2);
	});
});
