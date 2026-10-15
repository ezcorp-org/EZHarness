/**
 * Provider OAuth by pasted callback — `/settings/models`.
 *
 * Regression: after a pasted callback succeeded, the provider stayed
 * "saving", so its Disconnect control stayed disabled until a reload.
 * RENDER tier (mockApi plus per-spec OAuth routes).
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProviderStatus } from "./fixtures/data.js";

test("a successful pasted OAuth callback leaves the provider's controls enabled @evidence", async ({ page, mockApi }, testInfo) => {
	let connected = false;
	await mockApi({ providers: [makeProviderStatus({ provider: "openai", oauthSupported: true })] });
	// Registered after mockApi, so these win (Playwright matches routes LIFO).
	await page.route("**/api/providers", (route) =>
		route.request().method() === "GET"
			? route.fulfill({ json: [makeProviderStatus({ provider: "openai", oauthSupported: true, oauthConnected: connected })] })
			: route.fallback(),
	);
	await page.route("**/api/auth/oauth?*", (route) =>
		route.fulfill({
			json: {
				url: "https://auth.example.test/authorize",
				state: "st-1",
				codeVerifier: "cv-1",
				redirectUri: "http://localhost:1455/auth/callback",
			},
		}),
	);
	await page.route("**/api/auth/oauth/callback", (route) => {
		connected = true;
		return route.fulfill({ json: { success: true } });
	});
	await page.addInitScript(() => {
		window.open = () => null;
	});

	await page.goto("/settings/models");
	await page.getByRole("button", { name: "Connect OpenAI Subscription" }).click();
	await page
		.getByPlaceholder("Paste the callback URL here if automatic redirect didn't work")
		.fill("http://localhost:1455/auth/callback?code=abc&state=st-1");
	await page.getByRole("button", { name: "Submit" }).click();

	const disconnect = page.getByRole("button", { name: "Disconnect" });
	await expect(disconnect).toBeVisible();
	await expect(disconnect).toBeEnabled();
	await captureEvidence(page, testInfo, "provider-oauth-paste-connected");
});
