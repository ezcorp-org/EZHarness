import { test, expect } from "./fixtures/test-base.js";
import { makeProviderStatus } from "./fixtures/data.js";
import type { ProviderStatus } from "../../src/lib/api.js";

function threeProviders(overrides?: {
	anthropic?: Partial<ProviderStatus>;
	openai?: Partial<ProviderStatus>;
	google?: Partial<ProviderStatus>;
}) {
	return [
		makeProviderStatus({ provider: "anthropic", oauthSupported: false, ...overrides?.anthropic }),
		makeProviderStatus({ provider: "openai", oauthSupported: true, ...overrides?.openai }),
		makeProviderStatus({ provider: "google", oauthSupported: true, ...overrides?.google }),
	];
}

test.describe("Provider Settings", () => {
	// A. Accordion & Summary Chips
	test.describe("Accordion & Summary Chips", () => {
		test("providers section expanded by default with all three names visible", async ({ page, mockApi }) => {
			await mockApi({ providers: threeProviders() });
			await page.goto("/settings");

			await expect(page.getByText("Anthropic (Claude)").first()).toBeVisible();
			await expect(page.getByText("OpenAI").first()).toBeVisible();
			await expect(page.getByText("Google (Gemini)").first()).toBeVisible();
		});

		test("summary chips show colored dots matching provider state", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({
					anthropic: { hasKey: true, source: "byok" },       // green
					openai: { oauthConnected: true, oauthExpired: true }, // amber
					// google: unconfigured                              // gray
				}),
			});
			await page.goto("/settings");

			// The accordion header contains summary chips with dots
			const header = page.locator("button").filter({ hasText: "Providers" });
			await expect(header.locator(".bg-green-500")).toBeVisible();
			await expect(header.locator(".bg-amber-500")).toBeVisible();
			await expect(header.locator(".bg-gray-500")).toBeVisible();
		});

		test("click header collapses section, click again re-expands", async ({ page, mockApi }) => {
			await mockApi({ providers: threeProviders() });
			await page.goto("/settings");

			const header = page.locator("button").filter({ hasText: "Providers" });
			// Initially expanded — provider cards visible
			await expect(page.getByText("Not configured").first()).toBeVisible();

			// Collapse
			await header.click();
			await expect(page.getByText("Not configured").first()).not.toBeVisible();

			// Re-expand
			await header.click();
			await expect(page.getByText("Not configured").first()).toBeVisible();
		});
	});

	// B. Status Indicators
	test.describe("Status Indicators", () => {
		test("BYOK provider shows green Connected", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Anthropic (Claude)" });
			await expect(card.getByText("Connected")).toBeVisible();
			await expect(card.locator(".bg-green-500").first()).toBeVisible();
		});

		test("unconfigured provider shows gray Not configured", async ({ page, mockApi }) => {
			await mockApi({ providers: threeProviders() });
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Anthropic (Claude)" });
			await expect(card.getByText("Not configured")).toBeVisible();
			await expect(card.locator(".bg-gray-500").first()).toBeVisible();
		});

		test("expired OAuth shows amber Token expired", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({
					openai: { oauthConnected: true, oauthExpired: true, oauthSupported: true },
				}),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "OpenAI" });
			await expect(card.getByText("Token expired")).toBeVisible();
			await expect(card.locator(".bg-amber-500").first()).toBeVisible();
		});
	});

	// C. Access Mode Badges
	test.describe("Access Mode Badges", () => {
		test("BYOK provider shows blue API Key badge", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Anthropic (Claude)" });
			await expect(card.getByText("API Key")).toBeVisible();
		});

		test("OAuth provider shows Subscription badge; env shows Env badge", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({
					openai: { oauthConnected: true, oauthSupported: true, hasKey: false, source: "none" },
					google: { hasKey: true, source: "env" },
				}),
			});
			await page.goto("/settings");

			const openaiCard = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "OpenAI" });
			await expect(openaiCard.getByText("Subscription", { exact: true })).toBeVisible();

			const googleCard = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Google (Gemini)" });
			await expect(googleCard.getByText("Env")).toBeVisible();
		});
	});

	// D. Test Connection
	test.describe("Test Connection", () => {
		test("click Test shows Testing then Working on success", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Anthropic (Claude)" });
			const testBtn = card.getByRole("button", { name: "Test" });
			await testBtn.click();

			// Should show "Testing..." briefly then "Working"
			await expect(card.getByText("Working")).toBeVisible();
		});

		test("test connection failure shows error message", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings");

			// Override test route to return failure
			await page.route("**/api/providers/*/test", (route) => {
				return route.fulfill({ json: { success: false, error: "Invalid API key" } });
			});

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Anthropic (Claude)" });
			await card.getByRole("button", { name: "Test" }).click();

			await expect(card.getByText("Invalid API key")).toBeVisible();
		});
	});

	// E. Inline Key Update
	test.describe("Inline Key Update", () => {
		test("click Update shows input with placeholder and Save/Cancel", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Anthropic (Claude)" });
			await card.getByRole("button", { name: "Update" }).click();

			await expect(card.getByPlaceholder("sk-ant-...")).toBeVisible();
			await expect(card.getByRole("button", { name: "Save" })).toBeVisible();
			await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
		});

		test("click Cancel returns to Key saved state", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Anthropic (Claude)" });
			await card.getByRole("button", { name: "Update" }).click();
			await expect(card.getByPlaceholder("sk-ant-...")).toBeVisible();

			await card.getByRole("button", { name: "Cancel" }).click();
			await expect(card.getByText("Key saved")).toBeVisible();
			await expect(card.getByPlaceholder("sk-ant-...")).not.toBeVisible();
		});
	});

	// F. Inline Remove Confirmation
	test.describe("Inline Remove Confirmation", () => {
		test("click Remove shows confirmation with Confirm and Cancel", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Anthropic (Claude)" });
			await card.getByRole("button", { name: "Remove" }).click();

			await expect(card.getByText("Remove API key?")).toBeVisible();
			await expect(card.getByRole("button", { name: "Confirm" })).toBeVisible();
			await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
		});

		test("click Confirm calls DELETE and re-fetch shows Not configured", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Anthropic (Claude)" });
			// Wait for the BYOK card to load with Remove button visible
			await expect(card.getByRole("button", { name: "Remove" })).toBeVisible();

			// Now override routes so DELETE succeeds and re-fetch returns unconfigured
			let deleteCount = 0;
			await page.route("**/api/providers", async (route) => {
				if (route.request().method() === "DELETE") {
					deleteCount++;
					return route.fulfill({ json: { success: true } });
				}
				if (route.request().method() === "GET") {
					return route.fulfill({ json: threeProviders() });
				}
				return route.continue();
			});

			await card.getByRole("button", { name: "Remove" }).click();
			await card.getByRole("button", { name: "Confirm" }).click();

			await expect(card.getByText("Not configured")).toBeVisible();
			expect(deleteCount).toBe(1);
		});
	});

	// G. Inline Disconnect Confirmation
	test.describe("Inline Disconnect Confirmation", () => {
		test("click Disconnect shows confirmation prompt", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({
					openai: { oauthConnected: true, oauthSupported: true },
				}),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "OpenAI" });
			await card.getByRole("button", { name: "Disconnect" }).click();

			await expect(card.getByText("Disconnect OpenAI subscription?")).toBeVisible();
			await expect(card.getByRole("button", { name: "Confirm" })).toBeVisible();
			await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
		});

		test("click Cancel dismisses confirmation, Subscription Connected still visible", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({
					openai: { oauthConnected: true, oauthSupported: true },
				}),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "OpenAI" });
			await card.getByRole("button", { name: "Disconnect" }).click();
			await expect(card.getByText("Disconnect OpenAI subscription?")).toBeVisible();

			await card.getByRole("button", { name: "Cancel" }).click();
			await expect(card.getByText("Disconnect OpenAI subscription?")).not.toBeVisible();
			await expect(card.getByText("Subscription Connected")).toBeVisible();
		});
	});

	// H. Onboarding Hints
	test.describe("Onboarding Hints", () => {
		test("unconfigured providers show hint text with link to key page", async ({ page, mockApi }) => {
			await mockApi({ providers: threeProviders() });
			await page.goto("/settings");

			const anthropicCard = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "Anthropic (Claude)" });
			await expect(anthropicCard.getByText("Get your Anthropic API key")).toBeVisible();
			const link = anthropicCard.locator("a[href='https://console.anthropic.com/keys']");
			await expect(link).toBeVisible();

			const openaiCard = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "OpenAI" });
			await expect(openaiCard.getByText("Get your OpenAI API key")).toBeVisible();
			const openaiLink = openaiCard.locator("a[href='https://platform.openai.com/api-keys']");
			await expect(openaiLink).toBeVisible();
		});
	});

	// I. Token Expiry
	test.describe("Token Expiry", () => {
		test("expired OAuth with past expiresAt shows amber relative time with ago", async ({ page, mockApi }) => {
			const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
			await mockApi({
				providers: threeProviders({
					openai: {
						oauthConnected: true,
						oauthExpired: true,
						oauthSupported: true,
						expiresAt: pastDate,
					},
				}),
			});
			await page.goto("/settings");

			const card = page.locator(".rounded-lg.bg-gray-900").filter({ hasText: "OpenAI" });
			// The relativeTime for a date 2h ago should contain "ago"
			const expiryText = card.locator(".text-amber-400");
			await expect(expiryText.filter({ hasText: "ago" })).toBeVisible();
		});
	});
});
