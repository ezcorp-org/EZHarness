import { test, expect } from "./fixtures/test-base.js";

// The /auth/callback page is the OAuth/OIDC redirect handler. It runs entirely
// client-side: it reads `code` and `state` from the URL, looks up a pending
// OAuth session in localStorage (written by the opener tab via startOAuthFlow),
// validates the state, then POSTs to /api/auth/oauth/callback to exchange the
// code for tokens. Success closes the popup; failure surfaces an error and a
// "Try Again" link back to /settings.
//
// We exercise the page by seeding localStorage in an addInitScript before
// navigation and stubbing the POST. The page belongs to the (auth) route group,
// which has no authentication gate, so it loads in unauthenticated test runs.

const STORAGE_KEY = "ezcorp-oauth-pending";

function pendingPayload(overrides: Partial<{ codeVerifier: string; state: string; provider: string; redirectUri: string }> = {}) {
	return {
		codeVerifier: "test-verifier",
		state: "valid-state",
		provider: "openai",
		redirectUri: "http://localhost:4173/auth/callback",
		...overrides,
	};
}

test.describe("OAuth Callback Page", () => {
	test("shows error when code parameter is missing", async ({ page, mockApi }) => {
		await mockApi({});

		await page.goto("/auth/callback?state=valid-state");

		await expect(page.getByRole("heading", { name: "Connection Failed" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Missing code or state parameter")).toBeVisible();
		await expect(page.getByRole("link", { name: "Try Again" })).toHaveAttribute("href", "/settings");
	});

	test("shows error when state parameter is missing", async ({ page, mockApi }) => {
		await mockApi({});

		await page.goto("/auth/callback?code=test-code");

		await expect(page.getByRole("heading", { name: "Connection Failed" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Missing code or state parameter")).toBeVisible();
	});

	test("shows error when no pending OAuth session is in localStorage", async ({ page, mockApi }) => {
		await mockApi({});

		// Make sure localStorage is clean for this origin before navigation.
		await page.addInitScript(() => {
			try {
				window.localStorage.removeItem("ezcorp-oauth-pending");
			} catch {}
		});

		await page.goto("/auth/callback?code=test-code&state=valid-state");

		await expect(page.getByRole("heading", { name: "Connection Failed" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText(/No pending OAuth session found/)).toBeVisible();
	});

	test("shows state-mismatch error when stored state does not match URL", async ({ page, mockApi }) => {
		await mockApi({});

		const stored = pendingPayload({ state: "different-state" });
		await page.addInitScript(([key, value]) => {
			window.localStorage.setItem(key, value);
		}, [STORAGE_KEY, JSON.stringify(stored)] as const);

		await page.goto("/auth/callback?code=test-code&state=valid-state");

		await expect(page.getByRole("heading", { name: "Connection Failed" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText(/State mismatch/)).toBeVisible();
	});

	test("shows success view when token exchange succeeds", async ({ page, mockApi }) => {
		await mockApi({
			routes: {
				"/api/auth/oauth/callback": () => ({ success: true }),
			},
		});

		const stored = pendingPayload();
		await page.addInitScript(([key, value]) => {
			window.localStorage.setItem(key, value);
		}, [STORAGE_KEY, JSON.stringify(stored)] as const);

		await page.goto("/auth/callback?code=test-code&state=valid-state");

		// Provider name is humanised from the stored provider id.
		await expect(page.getByRole("heading", { name: "OpenAI Connected" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText(/This tab will close automatically/)).toBeVisible();
	});

	test("shows error message when token exchange fails", async ({ page, mockApi }) => {
		await mockApi({});

		// Override the default mock with an error response. We register the
		// route AFTER mockApi so this handler matches first.
		await page.route("**/api/auth/oauth/callback", (route) => {
			return route.fulfill({
				status: 400,
				json: { error: "Token exchange failed: invalid grant" },
			});
		});

		const stored = pendingPayload({ provider: "google" });
		await page.addInitScript(([key, value]) => {
			window.localStorage.setItem(key, value);
		}, [STORAGE_KEY, JSON.stringify(stored)] as const);

		await page.goto("/auth/callback?code=test-code&state=valid-state");

		await expect(page.getByRole("heading", { name: "Connection Failed" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText(/Token exchange failed/)).toBeVisible();
		await expect(page.getByRole("link", { name: "Try Again" })).toHaveAttribute("href", "/settings");
	});
});
