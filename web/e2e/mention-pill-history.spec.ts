import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Pill Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

test.describe("Mention pills in chat history", () => {
	test("assistant message renders extension mention as purple pill", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "analyze this" }),
				makeMessage({ id: "m2", conversationId: "conv-1", role: "assistant", content: "I used ![ext:analyzer] to check your code.", parentMessageId: "m1", createdAt: "2026-01-01T00:01:00.000Z" }),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The pill should render instead of raw text
		const pill = page.locator("span").filter({ hasText: "!analyzer" });
		await expect(pill).toBeVisible({ timeout: 5000 });

		// Raw token should NOT be visible
		await expect(page.getByText("![ext:analyzer]")).not.toBeVisible();

		// Pill should have purple styling
		const style = await pill.getAttribute("style");
		expect(style).toContain("rgba(168,85,247");
	});

	test("assistant message renders agent mention as blue pill", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "help me" }),
				makeMessage({ id: "m2", conversationId: "conv-1", role: "assistant", content: "Let me invoke ![agent:Code Assistant] for you.", parentMessageId: "m1", createdAt: "2026-01-01T00:01:00.000Z" }),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const pill = page.locator("span").filter({ hasText: "!Code Assistant" });
		await expect(pill).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("![agent:Code Assistant]")).not.toBeVisible();

		const style = await pill.getAttribute("style");
		expect(style).toContain("rgba(59,130,246");
	});

	test("assistant message with multiple mentions renders all as pills", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "do both" }),
				makeMessage({ id: "m2", conversationId: "conv-1", role: "assistant", content: "I used ![ext:analyzer] and ![agent:Summarizer] together.", parentMessageId: "m1", createdAt: "2026-01-01T00:01:00.000Z" }),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator("span").filter({ hasText: "!analyzer" })).toBeVisible({ timeout: 5000 });
		await expect(page.locator("span").filter({ hasText: "!Summarizer" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("![ext:analyzer]")).not.toBeVisible();
		await expect(page.getByText("![agent:Summarizer]")).not.toBeVisible();
	});

	test("user message renders mention as MentionChip component", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Check ![ext:analyzer] please" }),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// User messages use MentionChip component (Svelte) with purple Tailwind classes
		const chip = page.locator("span.border-purple-500\\/30").filter({ hasText: "!analyzer" });
		await expect(chip).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("![ext:analyzer]")).not.toBeVisible();
	});
});
