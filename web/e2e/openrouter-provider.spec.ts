/**
 * OpenRouter provider card — visual-evidence e2e for `/settings/models`.
 *
 * Adding OpenRouter as a provider is a frontend-visual change, so the
 * "Visual evidence" CI gate requires an `@evidence`-tagged spec that calls
 * `captureEvidence`. Mirrors the import + call form used by
 * `rbac-permissions.spec.ts`. `captureEvidence` is a hard no-op unless
 * `EZCORP_E2E_EVIDENCE=1`, so normal `e2e-mock` runs stay byte-identical.
 */
import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProviderStatus } from "./fixtures/data.js";

function providerCard(page: Page, name: string) {
	return page.locator("div.rounded-lg.border").filter({ hasText: name }).first();
}

// Four providers, matching the shared onboarding order — OpenRouter last and
// BYOK-only (no subscription OAuth).
function providersWithOpenRouter() {
	return [
		makeProviderStatus({ provider: "anthropic", oauthSupported: false }),
		makeProviderStatus({ provider: "openai", oauthSupported: true }),
		makeProviderStatus({ provider: "google", oauthSupported: true }),
		makeProviderStatus({ provider: "openrouter", oauthSupported: false }),
	];
}

test.describe("OpenRouter provider card", () => {
	test("renders the OpenRouter card and captures evidence @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ providers: providersWithOpenRouter() });

		await page.goto("/settings/models");

		const card = providerCard(page, "OpenRouter");
		await expect(card.getByText("OpenRouter", { exact: true }).first()).toBeVisible();
		// BYOK affordances present, OAuth absent.
		await expect(card.getByPlaceholder("sk-or-v1-...")).toBeVisible();
		await expect(card.getByText("Get your OpenRouter API key")).toBeVisible();
		await expect(card.getByRole("button", { name: /Connect/ })).toHaveCount(0);

		await captureEvidence(page, testInfo, "openrouter-provider-card");

		// Assert the capture contract both with and without the flag (mirrors
		// rbac-permissions.spec.ts) so the test is meaningful in either mode.
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "openrouter-provider-card" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "openrouter-provider-card")).toBe(false);
		}
	});
});
