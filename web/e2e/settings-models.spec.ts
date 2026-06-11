/**
 * Merged /settings/models page (Phase 2 of the settings UX overhaul):
 *   - providers + tier + order + custom models compose on one page
 *   - locked decision 6: no model id appears twice — ollama-provider
 *     entries render only inside the Ollama provider card
 *   - adding a custom model produces exactly one row
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const memberMe = {
	user: { id: "member-1", email: "member@test.local", name: "Member", role: "member" },
};

const mixedSettings = {
	"provider:defaultTier": "balanced",
	"provider:preferenceOrder": ["anthropic", "openai", "google"],
	"provider:ollamaUrl": "http://localhost:11434",
	"provider:customModels": [
		{ modelId: "llama3-local", provider: "ollama", tier: "balanced", baseUrl: "http://localhost:11434" },
		{ modelId: "gpt-4-custom", provider: "openai", tier: "powerful" },
	],
};

test.describe("merged models page", () => {
	test("ollama model renders exactly once (provider card only)", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			settings: mixedSettings,
			routes: { "/api/auth/me": () => memberMe },
		});
		await page.goto("/settings/models");

		await expect(page.locator("#custom-models")).toBeVisible();

		// The ollama model id appears exactly once on the entire page —
		// inside the Ollama card's "Active models" list.
		await expect(page.getByText("llama3-local", { exact: true })).toHaveCount(1);
		await expect(page.locator("#providers").getByText("llama3-local", { exact: true })).toBeVisible();
		await expect(page.locator("#custom-models").getByText("llama3-local", { exact: true })).toHaveCount(0);

		// The registry notes where the hidden entries live.
		await expect(page.getByTestId("ollama-managed-note")).toHaveText(
			"1 Ollama model is managed in the Ollama provider card above.",
		);

		// Non-ollama custom model renders once, in the registry.
		await expect(page.getByText("gpt-4-custom", { exact: true })).toHaveCount(1);
		await expect(page.locator("#custom-models").getByText("gpt-4-custom", { exact: true })).toBeVisible();
	});

	test("adding a custom model does not produce a duplicate row", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			settings: mixedSettings,
			routes: { "/api/auth/me": () => memberMe },
		});
		await page.goto("/settings/models");

		await page.getByLabel("Model ID").fill("brand-new-model");
		await page.locator("#custom-models").getByRole("button", { name: "Add", exact: true }).click();

		await expect(page.getByText("brand-new-model", { exact: true })).toHaveCount(1);

		// Adding again is a client-side no-op (id already registered).
		await page.getByLabel("Model ID").fill("brand-new-model");
		await page.locator("#custom-models").getByRole("button", { name: "Add", exact: true }).click();
		await expect(page.getByText("brand-new-model", { exact: true })).toHaveCount(1);
	});
});
