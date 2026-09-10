import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeMode } from "./fixtures/data.js";
import { modelCatalogRoutes } from "./fixtures/model-routes.js";

const proj = makeProject({ id: "proj-1", name: "KB Nav" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
const msg = makeMessage({ id: "msg-1", conversationId: "conv-1", role: "user" });
const modes = [
	makeMode({ id: "m1", name: "Plan", slug: "plan", builtin: true, toolRestriction: "read-only" }),
	makeMode({ id: "m2", name: "Debug", slug: "debug", builtin: false }),
];

const models = [
	{ provider: "anthropic", model: "claude-sonnet", tier: "balanced", costTier: "medium", available: true, displayName: "Claude Sonnet", reasoning: true },
	{ provider: "openai", model: "gpt-4o", tier: "powerful", costTier: "high", available: true, displayName: "GPT-4o" },
	{ provider: "google", model: "gemini-pro", tier: "balanced", costTier: "medium", available: true, displayName: "Gemini Pro" },
];

test.beforeEach(async ({ page, mockApi }) => {
	await mockApi({
		projects: [proj], conversations: [conv], messages: [msg], modes,
		routes: modelCatalogRoutes(models),
	});
	await page.goto("/project/proj-1/chat/conv-1");
});

test.describe("Model selector keyboard navigation", () => {
	test("search input auto-focuses on open", async ({ page }) => {
		// Click model selector button
		await page.getByTestId("model-selector").getByRole("button").click();

		// Search input should be focused
		const input = page.getByTestId("model-selector").getByRole("combobox");
		await expect(input).toBeFocused({ timeout: 3000 });
	});

	test("ArrowDown and Enter selects a model", async ({ page }) => {
		await page.getByTestId("model-selector").getByRole("button").click();
		const input = page.getByTestId("model-selector").getByRole("combobox");
		await expect(input).toBeFocused({ timeout: 3000 });

		// ArrowDown to first model, Enter to select
		await input.press("ArrowDown");
		await input.press("Enter");

		await expect(input).not.toBeVisible({ timeout: 2000 });
		await expect(page.getByTestId("model-selector").getByRole("button")).toContainText("GPT-4o");
	});

	test("Escape closes model dropdown", async ({ page }) => {
		await page.getByTestId("model-selector").getByRole("button").click();
		const input = page.getByTestId("model-selector").getByRole("combobox");
		await expect(input).toBeVisible();

		await input.press("Escape");
		await expect(input).not.toBeVisible({ timeout: 2000 });
	});

	test("typing filters model list", async ({ page }) => {
		await page.getByTestId("model-selector").getByRole("button").click();
		const input = page.getByTestId("model-selector").getByRole("combobox");

		// Type "claude" to filter
		await input.fill("claude");

		// Only Claude should remain
		const options = page.getByTestId("model-selector").getByRole("option");
		await expect(options).toHaveCount(1);
		await expect(options.first()).toContainText("Claude Sonnet");
	});

	test("no match shows empty message", async ({ page }) => {
		await page.getByTestId("model-selector").getByRole("button").click();
		const input = page.getByTestId("model-selector").getByRole("combobox");

		await input.fill("zzzzz");
		await expect(page.getByTestId("model-selector").getByText("No models match your search")).toBeVisible();
	});
});

test.describe("Thinking selector keyboard navigation", () => {
	test.beforeEach(async ({ page }) => {
		const selector = page.getByTestId("model-selector");
		await selector.getByRole("button").click();
		const input = selector.getByRole("combobox");
		await input.fill("Claude Sonnet");
		await expect(selector.getByRole("option")).toHaveCount(1);
		await input.press("Enter");
		await expect(selector.getByRole("button")).toContainText("Claude Sonnet");
	});

	test("search input auto-focuses on open", async ({ page }) => {
		// Now thinking selector should appear — click it
		const thinkingBtn = page.getByTestId("thinking-selector").getByRole("button");
		await expect(thinkingBtn).toBeVisible({ timeout: 3000 });
		await thinkingBtn.click();

		const input = page.getByTestId("thinking-selector").getByRole("combobox");
		await expect(input).toBeFocused({ timeout: 3000 });
	});

	test("ArrowDown and Enter selects a thinking level", async ({ page }) => {
		// Open thinking selector
		await page.getByTestId("thinking-selector").getByRole("button").click();
		const input = page.getByTestId("thinking-selector").getByRole("combobox");

		// Navigate to "High" (index 4)
		for (let i = 0; i < 4; i++) await input.press("ArrowDown");
		await input.press("Enter");

		// Should show "High"
		const btn = page.getByTestId("thinking-selector").getByRole("button");
		await expect(btn).toContainText("High");
	});

	test("Escape closes thinking dropdown", async ({ page }) => {
		await page.getByTestId("thinking-selector").getByRole("button").click();
		const input = page.getByTestId("thinking-selector").getByRole("combobox");
		await expect(input).toBeVisible();

		await input.press("Escape");
		await expect(input).not.toBeVisible({ timeout: 2000 });
	});

	test("typing filters thinking levels", async ({ page }) => {
		await page.getByTestId("thinking-selector").getByRole("button").click();
		const input = page.getByTestId("thinking-selector").getByRole("combobox");

		// Type "max" to filter
		await input.fill("max");

		const options = page.getByTestId("thinking-selector").getByRole("option");
		await expect(options).toHaveCount(1);
		await expect(options.first()).toContainText("Max");
	});
});

test.describe("Mode selector search auto-focus", () => {
	test("search input auto-focuses when mode dropdown opens", async ({ page }) => {
		await page.getByTestId("mode-selector").getByRole("button").click();
		const input = page.getByTestId("mode-selector").getByRole("combobox");
		await expect(input).toBeFocused({ timeout: 3000 });
	});
});
