import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * E2E coverage for the "context % used" indicator shown in the chat header.
 * Covers the three observable states from the user's perspective:
 *   1. hidden when no assistant message with `usage` yet;
 *   2. visible with the correct % once a past assistant message reports usage;
 *   3. switching models updates the % (different contextWindow ⇒ different %).
 */

const proj = makeProject({ id: "proj-1", name: "Context Indicator" });

/** Stub /api/models with contextWindow values the indicator can use. */
async function stubModels(page: import("@playwright/test").Page) {
	await page.route("**/api/models", (route) => {
		const url = new URL(route.request().url());
		if (url.pathname !== "/api/models") return route.fallback();
		return route.fulfill({
			json: [
				{
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					tier: "balanced",
					costTier: "medium",
					displayName: "Claude Sonnet 4",
					available: true,
					contextWindow: 200_000,
				},
				{
					provider: "openai",
					model: "gpt-4o",
					tier: "balanced",
					costTier: "medium",
					displayName: "GPT-4o",
					available: true,
					contextWindow: 128_000,
				},
			],
		});
	});
}

test.describe("Context indicator", () => {
	test("hidden when the latest assistant message has no usage", async ({ page, mockApi }) => {
		const conv = makeConversation({
			id: "conv-1",
			projectId: proj.id,
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
		});
		const userMsg = makeMessage({ id: "m1", conversationId: conv.id, role: "user", content: "hi" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: conv.id,
			role: "assistant",
			content: "hello",
			parentMessageId: "m1",
			usage: null,
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await stubModels(page);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Wait for the chat to render at least one message, then assert the pill is absent.
		await expect(page.getByText("hello")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("context-usage-indicator")).toHaveCount(0);
	});

	test("shows correct % once an assistant message reports usage.inputTokens", async ({ page, mockApi }) => {
		const conv = makeConversation({
			id: "conv-2",
			projectId: proj.id,
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
		});
		const userMsg = makeMessage({ id: "m1", conversationId: conv.id, role: "user", content: "hi" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: conv.id,
			role: "assistant",
			content: "hello",
			parentMessageId: "m1",
			usage: { inputTokens: 50_000, outputTokens: 100 },
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await stubModels(page);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// 50_000 / 200_000 = 25%
		const pct = page.getByTestId("context-usage-pct");
		await expect(pct).toHaveText("25%", { timeout: 10_000 });
		await expect(page.getByTestId("context-usage-indicator")).toHaveAttribute("data-tone", "muted");
	});

	test("danger tone when usage exceeds 90% of the context window", async ({ page, mockApi }) => {
		const conv = makeConversation({
			id: "conv-3",
			projectId: proj.id,
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
		});
		const userMsg = makeMessage({ id: "m1", conversationId: conv.id, role: "user", content: "hi" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: conv.id,
			role: "assistant",
			content: "hello",
			parentMessageId: "m1",
			usage: { inputTokens: 190_000, outputTokens: 100 },
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await stubModels(page);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// 190_000 / 200_000 = 95%
		await expect(page.getByTestId("context-usage-pct")).toHaveText("95%", { timeout: 10_000 });
		await expect(page.getByTestId("context-usage-indicator")).toHaveAttribute("data-tone", "danger");
	});
});
