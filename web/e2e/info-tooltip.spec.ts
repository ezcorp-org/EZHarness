import { test, expect } from "./fixtures/test-base.js";
import { makeProviderStatus } from "./fixtures/data.js";

test.describe("InfoTooltip", () => {
	test.describe("Agent editor (/agents/new)", () => {
		test("shows tooltip buttons next to System Prompt and Model labels", async ({ page, mockApi }) => {
			await mockApi({ agents: [] });
			await page.goto("/agents/new");
			await page.getByRole("button", { name: "Configure" }).click();

			// Both labels should have a "More info" button (the ? icon)
			const promptLabel = page.locator("label", { hasText: "System Prompt" });
			await expect(promptLabel.locator('button[aria-label="More info"]')).toBeVisible();

			const modelLabel = page.locator("label", { hasText: "Model" });
			await expect(modelLabel.locator('button[aria-label="More info"]')).toBeVisible();
		});

		test("hovering tooltip button for 300ms+ shows tooltip text", async ({ page, mockApi }) => {
			await mockApi({ agents: [] });
			await page.goto("/agents/new");
			await page.getByRole("button", { name: "Configure" }).click();

			const trigger = page.locator("label", { hasText: "System Prompt" }).locator('button[aria-label="More info"]');
			await trigger.hover();
			await page.waitForTimeout(350);

			const tooltip = page.locator('[role="tooltip"]');
			await expect(tooltip).toBeVisible();
		});

		test("quick hover (<300ms) does NOT show tooltip", async ({ page, mockApi }) => {
			await mockApi({ agents: [] });
			await page.goto("/agents/new");
			await page.getByRole("button", { name: "Configure" }).click();

			const trigger = page.locator("label", { hasText: "System Prompt" }).locator('button[aria-label="More info"]');
			await trigger.hover();
			await page.waitForTimeout(100);
			// Move mouse away from the trigger
			await page.mouse.move(0, 0);
			await page.waitForTimeout(250);

			const tooltip = page.locator('[role="tooltip"]');
			await expect(tooltip).not.toBeVisible();
		});

		test("tooltip has role=tooltip attribute", async ({ page, mockApi }) => {
			await mockApi({ agents: [] });
			await page.goto("/agents/new");
			await page.getByRole("button", { name: "Configure" }).click();

			const trigger = page.locator("label", { hasText: "Model" }).locator('button[aria-label="More info"]');
			await trigger.hover();
			await page.waitForTimeout(350);

			await expect(page.locator('[role="tooltip"]')).toHaveCount(1);
		});
	});

	test.describe("Settings page", () => {
		test("shows tooltip button next to Providers heading", async ({ page, mockApi }) => {
			await mockApi({
				providers: [
					makeProviderStatus({ provider: "anthropic" }),
					makeProviderStatus({ provider: "openai" }),
					makeProviderStatus({ provider: "google" }),
				],
			});
			await page.goto("/settings");

			const providersHeading = page.locator("h2", { hasText: "Providers" });
			await expect(providersHeading.locator('button[aria-label="More info"]')).toBeVisible();
		});
	});

	test.describe("Tooltip dismiss behavior", () => {
		test("tooltip disappears when mouse leaves", async ({ page, mockApi }) => {
			await mockApi({ agents: [] });
			await page.goto("/agents/new");
			await page.getByRole("button", { name: "Configure" }).click();

			const trigger = page.locator("label", { hasText: "System Prompt" }).locator('button[aria-label="More info"]');

			// Show tooltip
			await trigger.hover();
			await page.waitForTimeout(350);
			await expect(page.locator('[role="tooltip"]')).toBeVisible();

			// Move mouse away
			await page.mouse.move(0, 0);
			await expect(page.locator('[role="tooltip"]')).not.toBeVisible();
		});
	});

	test.describe("Keyboard accessibility", () => {
		test("focus on tooltip button shows tooltip after delay", async ({ page, mockApi }) => {
			await mockApi({ agents: [] });
			await page.goto("/agents/new");
			await page.getByRole("button", { name: "Configure" }).click();

			const trigger = page.locator("label", { hasText: "System Prompt" }).locator('button[aria-label="More info"]');
			await trigger.focus();
			await page.waitForTimeout(350);

			await expect(page.locator('[role="tooltip"]')).toBeVisible();
		});

		test("blur from tooltip button hides tooltip", async ({ page, mockApi }) => {
			await mockApi({ agents: [] });
			await page.goto("/agents/new");
			await page.getByRole("button", { name: "Configure" }).click();

			const trigger = page.locator("label", { hasText: "System Prompt" }).locator('button[aria-label="More info"]');
			await trigger.focus();
			await page.waitForTimeout(350);
			await expect(page.locator('[role="tooltip"]')).toBeVisible();

			// Blur by focusing something else
			await page.locator("#ac-prompt").focus();
			await expect(page.locator('[role="tooltip"]')).not.toBeVisible();
		});
	});
});
