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

		await page.goto("/settings");
		await expect(page.getByText("llama3")).toBeVisible();
		await expect(page.getByText("http://localhost:11434")).toBeVisible();
		await expect(page.getByRole("button", { name: "Test" })).toBeVisible();
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

		await page.goto("/settings");
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

		await page.goto("/settings");

		// Find and click the Test button in the custom models section
		const customModelsSection = page.locator("text=Custom Models").locator("..");
		const testButton = customModelsSection.getByRole("button", { name: "Test" });
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

		await page.goto("/settings");

		const customModelsSection = page.locator("text=Custom Models").locator("..");
		const testButton = customModelsSection.getByRole("button", { name: "Test" });
		await testButton.click();

		// Should show failure indicator for reachable
		const reachableIndicator = page.getByTitle("Reachable");
		await expect(reachableIndicator).toBeVisible({ timeout: 5000 });
		// The indicator should contain a cross mark (red)
		await expect(reachableIndicator).toHaveClass(/text-red/);
	});

	test("base URL input field is present in custom model form", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj] });
		await page.goto("/settings");

		// The Base URL input field should exist in the custom models form
		await expect(page.getByPlaceholder("e.g. http://localhost:11434")).toBeVisible();
	});
});
