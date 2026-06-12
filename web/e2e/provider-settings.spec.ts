import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-base.js";
import { makeProviderStatus } from "./fixtures/data.js";
import type { ProviderStatus } from "../src/lib/api.js";

/**
 * Provider card locator. The theme migrated to CSS variables long ago, so
 * the legacy `.rounded-lg.bg-gray-900` class pair matches nothing — the
 * stable shape is `div.rounded-lg.border` (ProviderSettings.svelte card).
 * `.first()` keeps strict mode happy when an ancestor also matches.
 */
function providerCard(page: Page, name: string) {
	return page.locator("div.rounded-lg.border").filter({ hasText: name }).first();
}

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
			await page.goto("/settings/models");

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
			await page.goto("/settings/models");

			// The accordion header contains summary chips with dots. Gray can
			// match more than once (unconfigured provider + the Ollama chip
			// from ProvidersSection's headerExtra) — scope with .first().
			const header = page.locator("button").filter({ hasText: "Providers" });
			await expect(header.locator(".bg-green-500").first()).toBeVisible();
			await expect(header.locator(".bg-amber-500").first()).toBeVisible();
			await expect(header.locator(".bg-gray-500").first()).toBeVisible();
		});

		test("click header collapses section, click again re-expands", async ({ page, mockApi }) => {
			await mockApi({ providers: threeProviders() });
			await page.goto("/settings/models");

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
			await page.goto("/settings/models");

			const card = providerCard(page, "Anthropic (Claude)");
			await expect(card.getByText("Connected")).toBeVisible();
			await expect(card.locator(".bg-green-500").first()).toBeVisible();
		});

		test("unconfigured provider shows gray Not configured", async ({ page, mockApi }) => {
			await mockApi({ providers: threeProviders() });
			await page.goto("/settings/models");

			const card = providerCard(page, "Anthropic (Claude)");
			await expect(card.getByText("Not configured")).toBeVisible();
			await expect(card.locator(".bg-gray-500").first()).toBeVisible();
		});

		test("expired OAuth shows amber Token expired", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({
					openai: { oauthConnected: true, oauthExpired: true, oauthSupported: true },
				}),
			});
			await page.goto("/settings/models");

			const card = providerCard(page, "OpenAI");
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
			await page.goto("/settings/models");

			const card = providerCard(page, "Anthropic (Claude)");
			await expect(card.getByText("API Key")).toBeVisible();
		});

		test("OAuth provider shows Subscription badge; env shows Env badge", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({
					openai: { oauthConnected: true, oauthSupported: true, hasKey: false, source: "none" },
					google: { hasKey: true, source: "env" },
				}),
			});
			await page.goto("/settings/models");

			const openaiCard = providerCard(page, "OpenAI");
			await expect(openaiCard.getByText("Subscription", { exact: true })).toBeVisible();

			const googleCard = providerCard(page, "Google (Gemini)");
			await expect(googleCard.getByText("Env")).toBeVisible();
		});
	});

	// D. Test Connection
	test.describe("Test Connection", () => {
		test("click Test shows Testing then Working on success", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings/models");

			const card = providerCard(page, "Anthropic (Claude)");
			const testBtn = card.getByRole("button", { name: "Test" });
			await testBtn.click();

			// Should show "Testing..." briefly then "Working"
			await expect(card.getByText("Working")).toBeVisible();
		});

		test("test connection failure shows error message", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings/models");

			// Override test route to return failure
			await page.route("**/api/providers/*/test", (route) => {
				return route.fulfill({ json: { success: false, error: "Invalid API key" } });
			});

			const card = providerCard(page, "Anthropic (Claude)");
			await card.getByRole("button", { name: "Test" }).click();

			await expect(card.getByText("Invalid API key")).toBeVisible();
		});
	});

	// D2. Model Refresh — manual button + auto-fetch on connect
	test.describe("Model Refresh", () => {
		test("manual Refresh models button shows Loaded N models", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ openai: { hasKey: true, source: "byok", oauthSupported: false } }),
			});
			await page.goto("/settings/models");

			const card = providerCard(page, "OpenAI");
			await card.getByRole("button", { name: "Refresh models" }).click();

			await expect(card.getByText("Loaded 3 models")).toBeVisible();
		});

		test("models auto-fetch right after saving an API key (no manual click)", async ({ page, mockApi }) => {
			let refreshCalled = false;
			await mockApi({
				providers: threeProviders({ openai: { hasKey: true, source: "byok", oauthSupported: false } }),
			});
			await page.route("**/api/providers/*/refresh-models", (route) => {
				refreshCalled = true;
				return route.fulfill({
					json: { success: true, count: 7, ids: ["gpt-5.2"], fetchedAt: new Date().toISOString() },
				});
			});
			await page.goto("/settings/models");

			const card = providerCard(page, "OpenAI");
			await card.getByRole("button", { name: "Update" }).click();
			await card.getByPlaceholder("sk-...").fill("sk-new-key-123");
			await card.getByRole("button", { name: "Save", exact: true }).click();

			// The "Loaded N models" chip appears without ever clicking "Refresh models"
			await expect(card.getByText("Loaded 7 models")).toBeVisible();
			expect(refreshCalled).toBe(true);
		});

		test("refresh failure shows Refresh failed", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ openai: { hasKey: true, source: "byok", oauthSupported: false } }),
			});
			await page.route("**/api/providers/*/refresh-models", (route) => {
				return route.fulfill({ json: { success: false, error: "models.dev returned 503" } });
			});
			await page.goto("/settings/models");

			const card = providerCard(page, "OpenAI");
			await card.getByRole("button", { name: "Refresh models" }).click();

			await expect(card.getByText("Refresh failed")).toBeVisible();
		});
	});

	// E. Inline Key Update
	test.describe("Inline Key Update", () => {
		test("click Update shows input with placeholder and Save/Cancel", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings/models");

			const card = providerCard(page, "Anthropic (Claude)");
			await card.getByRole("button", { name: "Update" }).click();

			await expect(card.getByPlaceholder("sk-ant-...")).toBeVisible();
			await expect(card.getByRole("button", { name: "Save" })).toBeVisible();
			await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
		});

		test("click Cancel returns to Key saved state", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings/models");

			const card = providerCard(page, "Anthropic (Claude)");
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
			await page.goto("/settings/models");

			const card = providerCard(page, "Anthropic (Claude)");
			await card.getByRole("button", { name: "Remove" }).click();

			await expect(card.getByText("Remove API key?")).toBeVisible();
			await expect(card.getByRole("button", { name: "Confirm" })).toBeVisible();
			await expect(card.getByRole("button", { name: "Cancel" })).toBeVisible();
		});

		test("click Confirm calls DELETE and re-fetch shows Not configured", async ({ page, mockApi }) => {
			await mockApi({
				providers: threeProviders({ anthropic: { hasKey: true, source: "byok" } }),
			});
			await page.goto("/settings/models");

			const card = providerCard(page, "Anthropic (Claude)");
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
			await page.goto("/settings/models");

			const card = providerCard(page, "OpenAI");
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
			await page.goto("/settings/models");

			const card = providerCard(page, "OpenAI");
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
			await page.goto("/settings/models");

			const anthropicCard = providerCard(page, "Anthropic (Claude)");
			await expect(anthropicCard.getByText("Get your Anthropic API key")).toBeVisible();
			const link = anthropicCard.locator("a[href='https://console.anthropic.com/keys']");
			await expect(link).toBeVisible();

			const openaiCard = providerCard(page, "OpenAI");
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
			await page.goto("/settings/models");

			const card = providerCard(page, "OpenAI");
			// The relativeTime for a date 2h ago should contain "ago"
			const expiryText = card.locator(".text-amber-400");
			await expect(expiryText.filter({ hasText: "ago" })).toBeVisible();
		});
	});
});
