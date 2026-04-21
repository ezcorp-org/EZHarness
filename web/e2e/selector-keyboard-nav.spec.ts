import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeMode } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "KB Nav" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });
const msg = makeMessage({ id: "msg-1", conversationId: "conv-1", role: "user" });
const modes = [
	makeMode({ id: "m1", name: "Plan", slug: "plan", builtin: true, toolRestriction: "read-only" }),
	makeMode({ id: "m2", name: "Debug", slug: "debug", builtin: false }),
];

test.describe("Model selector keyboard navigation", () => {
	test("search input auto-focuses on open", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			modes,
			routes: {
				"/api/models": () => [
					{ provider: "anthropic", model: "claude-sonnet", tier: "balanced", costTier: "medium", available: true, displayName: "Claude Sonnet" },
					{ provider: "openai", model: "gpt-4o", tier: "powerful", costTier: "high", available: true, displayName: "GPT-4o" },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Click model selector button
		await page.locator(".model-selector button").first().click();

		// Search input should be focused
		const input = page.locator(".model-selector input[role='combobox']");
		await expect(input).toBeFocused({ timeout: 3000 });
	});

	test("ArrowDown and Enter selects a model", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			modes,
			routes: {
				"/api/models": () => [
					{ provider: "anthropic", model: "claude-sonnet", tier: "balanced", costTier: "medium", available: true, displayName: "Claude Sonnet" },
					{ provider: "openai", model: "gpt-4o", tier: "powerful", costTier: "high", available: true, displayName: "GPT-4o" },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".model-selector button").first().click();
		const input = page.locator(".model-selector input[role='combobox']");
		await expect(input).toBeFocused({ timeout: 3000 });

		// ArrowDown to first model, Enter to select
		await input.press("ArrowDown");
		await input.press("Enter");

		// Dropdown should close
		await expect(input).not.toBeVisible({ timeout: 2000 });
	});

	test("Escape closes model dropdown", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			modes,
			routes: {
				"/api/models": () => [
					{ provider: "anthropic", model: "claude-sonnet", tier: "balanced", costTier: "medium", available: true, displayName: "Claude Sonnet" },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".model-selector button").first().click();
		const input = page.locator(".model-selector input[role='combobox']");
		await expect(input).toBeVisible();

		await input.press("Escape");
		await expect(input).not.toBeVisible({ timeout: 2000 });
	});

	test("typing filters model list", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			modes,
			routes: {
				"/api/models": () => [
					{ provider: "anthropic", model: "claude-sonnet", tier: "balanced", costTier: "medium", available: true, displayName: "Claude Sonnet" },
					{ provider: "openai", model: "gpt-4o", tier: "powerful", costTier: "high", available: true, displayName: "GPT-4o" },
					{ provider: "google", model: "gemini-pro", tier: "balanced", costTier: "medium", available: true, displayName: "Gemini Pro" },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".model-selector button").first().click();
		const input = page.locator(".model-selector input[role='combobox']");

		// Type "claude" to filter
		await input.fill("claude");

		// Only Claude should remain
		const options = page.locator(".model-selector [role='option']");
		await expect(options).toHaveCount(1);
		await expect(options.first()).toContainText("Claude Sonnet");
	});

	test("no match shows empty message", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			modes,
			routes: {
				"/api/models": () => [
					{ provider: "anthropic", model: "claude-sonnet", tier: "balanced", costTier: "medium", available: true, displayName: "Claude Sonnet" },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".model-selector button").first().click();
		const input = page.locator(".model-selector input[role='combobox']");

		await input.fill("zzzzz");
		await expect(page.locator(".model-selector").getByText("No models match your search")).toBeVisible();
	});
});

test.describe("Thinking selector keyboard navigation", () => {
	test("search input auto-focuses on open", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			modes,
			routes: {
				// Return a reasoning model so thinking selector appears
				"/api/models": () => [
					{ provider: "anthropic", model: "claude-sonnet", tier: "balanced", costTier: "medium", available: true, displayName: "Claude Sonnet", reasoning: true },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Select the reasoning model first
		await page.locator(".model-selector button").first().click();
		const modelInput = page.locator(".model-selector input[role='combobox']");
		await modelInput.press("ArrowDown");
		await modelInput.press("Enter");

		// Now thinking selector should appear — click it
		const thinkingBtn = page.locator(".thinking-selector button").first();
		await expect(thinkingBtn).toBeVisible({ timeout: 3000 });
		await thinkingBtn.click();

		const input = page.locator(".thinking-selector input[role='combobox']");
		await expect(input).toBeFocused({ timeout: 3000 });
	});

	test("ArrowDown and Enter selects a thinking level", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			modes,
			routes: {
				"/api/models": () => [
					{ provider: "anthropic", model: "claude-sonnet", tier: "balanced", costTier: "medium", available: true, displayName: "Claude Sonnet", reasoning: true },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Select reasoning model
		await page.locator(".model-selector button").first().click();
		const mi = page.locator(".model-selector input[role='combobox']");
		await mi.press("ArrowDown");
		await mi.press("Enter");

		// Open thinking selector
		await page.locator(".thinking-selector button").first().click();
		const input = page.locator(".thinking-selector input[role='combobox']");

		// Navigate to "High" (index 4)
		for (let i = 0; i < 4; i++) await input.press("ArrowDown");
		await input.press("Enter");

		// Should show "High"
		const btn = page.locator(".thinking-selector button").first();
		await expect(btn).toContainText("High");
	});

	test("Escape closes thinking dropdown", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			modes,
			routes: {
				"/api/models": () => [
					{ provider: "anthropic", model: "claude-sonnet", tier: "balanced", costTier: "medium", available: true, displayName: "Claude Sonnet", reasoning: true },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".model-selector button").first().click();
		const mi = page.locator(".model-selector input[role='combobox']");
		await mi.press("ArrowDown");
		await mi.press("Enter");

		await page.locator(".thinking-selector button").first().click();
		const input = page.locator(".thinking-selector input[role='combobox']");
		await expect(input).toBeVisible();

		await input.press("Escape");
		await expect(input).not.toBeVisible({ timeout: 2000 });
	});

	test("typing filters thinking levels", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			modes,
			routes: {
				"/api/models": () => [
					{ provider: "anthropic", model: "claude-sonnet", tier: "balanced", costTier: "medium", available: true, displayName: "Claude Sonnet", reasoning: true },
				],
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".model-selector button").first().click();
		const mi = page.locator(".model-selector input[role='combobox']");
		await mi.press("ArrowDown");
		await mi.press("Enter");

		await page.locator(".thinking-selector button").first().click();
		const input = page.locator(".thinking-selector input[role='combobox']");

		// Type "max" to filter
		await input.fill("max");

		const options = page.locator(".thinking-selector [role='option']");
		await expect(options).toHaveCount(1);
		await expect(options.first()).toContainText("Max");
	});
});

test.describe("Mode selector search auto-focus", () => {
	test("search input auto-focuses when mode dropdown opens", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msg],
			modes,
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		await page.locator(".mode-selector button").first().click();
		const input = page.locator(".mode-selector input[role='combobox']");
		await expect(input).toBeFocused({ timeout: 3000 });
	});
});
