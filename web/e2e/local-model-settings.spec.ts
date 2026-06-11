import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Settings Test" });

test.describe("Local model settings", () => {
	test("custom model with baseUrl shows Test button", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			settings: {
				"provider:customModels": [
					{ modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
				],
			},
		});

		await page.goto("/settings/models");
		// Settings UX overhaul (locked decision 6): ollama-provider models
		// render inside the Ollama provider card, not the registry list.
		const ollamaCard = page.locator("#providers");
		await expect(ollamaCard.getByText("llama3")).toBeVisible();
		await expect(page.locator("#settings-ollama-base-url")).toHaveValue("http://localhost:11434");
		await expect(ollamaCard.getByRole("button", { name: "Test", exact: true })).toBeVisible();
	});

	test("custom model without baseUrl does not show Test button", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			settings: {
				"provider:customModels": [
					{ modelId: "gpt-4-turbo", provider: "openai", tier: "powerful" },
				],
			},
		});

		await page.goto("/settings/models");
		await expect(page.getByText("gpt-4-turbo")).toBeVisible();
		// No Test button in the custom models list because there's no baseUrl
		const localTestButton = page.locator(".space-y-2 button", { hasText: "Test" });
		await expect(localTestButton).toHaveCount(0);
	});

	test("clicking Test shows result indicators", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			settings: {
				"provider:customModels": [
					{ modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
				],
			},
		});

		await page.goto("/settings/models");

		// Ollama models live in the provider card now — Test runs there.
		const testButton = page.locator("#providers").getByRole("button", { name: "Test", exact: true });
		await testButton.click();

		// Wait for the result indicators (checkmarks for reachable, model available, inference ok)
		await expect(page.getByTitle("Reachable")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTitle("Model available")).toBeVisible();
		await expect(page.getByTitle("Inference OK")).toBeVisible();

		// Latency is shown
		await expect(page.getByText("150ms")).toBeVisible();
	});

	test("failed test shows error indicator", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			settings: {
				"provider:customModels": [
					{ modelId: "llama3", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:99999" },
				],
			},
			routes: {
				"/api/providers/local/test": () => ({
					reachable: false,
					modelAvailable: null,
					inferenceOk: null,
					endpointType: null,
					error: "Connection refused",
				}),
			},
		});

		await page.goto("/settings/models");

		const testButton = page.locator("#providers").getByRole("button", { name: "Test", exact: true });
		await testButton.click();

		// Should show failure indicator for reachable
		const reachableIndicator = page.getByTitle("Reachable");
		await expect(reachableIndicator).toBeVisible({ timeout: 5000 });
		// The indicator should contain a cross mark (red)
		await expect(reachableIndicator).toHaveClass(/text-red/);
	});

	test("base URL input field is present in custom model form", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/settings/models");

		// The Base URL input field should exist in the custom models form
		// (scoped — the Ollama provider card has its own Base URL input).
		await expect(page.locator("#custom-models").getByPlaceholder("e.g. http://localhost:11434")).toBeVisible();
	});
});
