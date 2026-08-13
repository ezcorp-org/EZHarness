/**
 * Kilo provider card — visual-evidence e2e for `/settings/models`.
 *
 * Adding Kilo is a frontend-visual change, so the "Visual evidence" CI gate
 * requires an `@evidence`-tagged spec that calls `captureEvidence`. Follows
 * `openrouter-provider.spec.ts` verbatim in form.
 *
 * The behaviour that makes Kilo different from every other provider card, and
 * what these tests pin: with NO key configured it is not "Not configured" —
 * its free models already answer, so the card says so, and it discloses the
 * one thing a user needs to know before sending a prompt to a $0 endpoint.
 */
import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProviderStatus } from "./fixtures/data.js";

function providerCard(page: Page, name: string) {
	return page.locator("div.rounded-lg.border").filter({ hasText: name }).first();
}

/** Five providers in the shared onboarding order — Kilo last, BYOK-only. */
function providersWithKilo(kiloOverrides: Record<string, unknown> = {}) {
	return [
		makeProviderStatus({ provider: "anthropic", oauthSupported: false }),
		makeProviderStatus({ provider: "openai", oauthSupported: true }),
		makeProviderStatus({ provider: "google", oauthSupported: true }),
		makeProviderStatus({ provider: "openrouter", oauthSupported: false }),
		makeProviderStatus({ provider: "kilo", oauthSupported: false, ...kiloOverrides }),
	];
}

test.describe("Kilo provider card", () => {
	test("an unconfigured Kilo card reads 'Free tier active' and captures evidence @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ providers: providersWithKilo() });

		await page.goto("/settings/models");

		const card = providerCard(page, "Kilo (Gateway)");
		await expect(card.getByText("Kilo (Gateway)", { exact: true }).first()).toBeVisible();

		// THE distinguishing assertion. Every other keyless provider card says
		// "Not configured"; for Kilo that would be false — it already answers.
		await expect(card.getByText("Free tier active")).toBeVisible();
		await expect(card.getByText("Not configured")).toHaveCount(0);

		// The disclosure a user needs before sending a prompt to a free endpoint.
		await expect(card.getByTestId("provider-free-tier-note-kilo")).toContainText(
			/may log free-tier prompts/i,
		);

		// BYOK affordances present (a key is optional, not absent), OAuth absent.
		await expect(card.getByPlaceholder("Optional — free models need no key")).toBeVisible();
		await expect(card.getByRole("button", { name: /Connect/ })).toHaveCount(0);

		await captureEvidence(page, testInfo, "kilo-provider-card");

		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "kilo-provider-card" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "kilo-provider-card")).toBe(false);
		}
	});

	test("the BYOK key field opts out of browser autofill", async ({ page, mockApi }) => {
		// The key box is a masked field with a show/hide toggle
		// (`type={showKey[p.provider] ? "text" : "password"}` in
		// ProviderSettings.svelte), so in its default state a password manager
		// sees a password input: it offers to fill a saved account password into
		// the API-key box, and to SAVE the pasted key as a login credential.
		// `autocomplete="off"` declines both. The ternary is not an exemption —
		// this asserts the rendered attribute, which is what the browser reads.
		await mockApi({ providers: providersWithKilo() });

		await page.goto("/settings/models");

		const keyInput = providerCard(page, "Kilo (Gateway)").getByPlaceholder(
			"Optional — free models need no key",
		);
		await expect(keyInput).toBeVisible();
		await expect(keyInput).toHaveAttribute("type", "password");
		await expect(keyInput).toHaveAttribute("autocomplete", "off");
	});

	test("an UNCONFIGURED Kilo card still offers Test + Refresh models", async ({ page, mockApi }) => {
		// The gap this pins: the Test/Refresh block was gated on
		// `hasKey || oauthConnected`, which hid both controls on exactly the
		// deployment Kilo's free tier exists for. A free-tier user could neither
		// verify the provider worked nor pull newly-added free models — while the
		// backend routes supported both keylessly the whole time.
		await mockApi({ providers: providersWithKilo() });

		await page.goto("/settings/models");

		const card = providerCard(page, "Kilo (Gateway)");
		await expect(card.getByRole("button", { name: "Refresh models" })).toBeVisible();
		await expect(card.getByRole("button", { name: "Test" })).toBeVisible();
	});

	test("every other provider keeps the has-key gate on those controls", async ({ page, mockApi }) => {
		// The gate is widened for keyless-free providers only — an unconfigured
		// Anthropic card must not start offering a test it cannot run.
		await mockApi({ providers: providersWithKilo() });

		await page.goto("/settings/models");

		const anthropic = providerCard(page, "Anthropic (Claude)");
		await expect(anthropic.getByRole("button", { name: "Refresh models" })).toHaveCount(0);
		await expect(anthropic.getByRole("button", { name: "Test" })).toHaveCount(0);
	});

	test("a configured Kilo card drops the free-tier copy", async ({ page, mockApi }) => {
		// With a key saved the deployment is on FULL access, so the free-tier
		// framing (and its logging caveat, which does not apply to paid models)
		// must not linger.
		await mockApi({ providers: providersWithKilo({ hasKey: true, source: "byok" }) });

		await page.goto("/settings/models");

		const card = providerCard(page, "Kilo (Gateway)");
		await expect(card.getByText("Connected")).toBeVisible();
		await expect(card.getByText("Free tier active")).toHaveCount(0);
		await expect(card.getByTestId("provider-free-tier-note-kilo")).toHaveCount(0);
	});

	test("self-heals a stored preference order saved before Kilo existed", async ({ page, mockApi }) => {
		// Upgraded deployment: the stored order predates Kilo. The load path
		// appends it, so it is visible and reorderable rather than permanently
		// invisible in the UI while the backend routes to it.
		await mockApi({
			providers: providersWithKilo(),
			settings: { "provider:preferenceOrder": ["anthropic", "openai", "google", "openrouter"] },
		});

		await page.goto("/settings/models");

		const order = page.locator("#order");
		await expect(order.locator('button[title="Move up"]')).toHaveCount(5);
		await expect(order.getByText("Kilo (Gateway)", { exact: true })).toBeVisible();
		// Appended last — row 5.
		await expect(order.getByText("5.", { exact: true })).toBeVisible();
	});
});
