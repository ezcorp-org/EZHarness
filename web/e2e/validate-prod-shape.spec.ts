/** Real persisted blank-turn regressions; every test creates its own history. */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/hydration.js";

async function loadHistory(page: Page) {
	const seeded = await page.request.post("/api/__test/seed", { data: { historyFixture: "blank-tool-turns" } });
	expect(seeded.status(), await seeded.text()).toBe(201);
	const { projectId, conversationId, historyFixture: ids } = await seeded.json() as {
		projectId: string; conversationId: string;
		historyFixture: Record<"user" | "thinking" | "generic" | "dock" | "empty" | "final", string>;
	};
	// The route reads actual PGlite rows. Verify the same query used by chat
	// preserves both tool-bearing blank turns before inspecting their UI.
	const snapshotResponse = await page.request.get(`/api/conversations/${conversationId}/messages?withToolCalls=true`);
	expect(snapshotResponse.status(), await snapshotResponse.text()).toBe(200);
	const snapshot = await snapshotResponse.json() as { messages: Array<{ id: string; content: string; toolCalls?: unknown[] }> };
	for (const key of ["generic", "dock"] as const) {
		expect(snapshot.messages.find((message) => message.id === ids[key])).toMatchObject({ content: "", toolCalls: [expect.any(Object)] });
	}
	await page.goto(`/project/${projectId}/chat/${conversationId}`);
	await expect(page.locator(`[data-message-id="${ids.final}"]`)).toContainText("Done — I created the design.");
	return ids;
}

test.describe("Persisted blank assistant turns", () => {
	test("final text renders exactly one populated markdown body", async ({ page }) => {
		const ids = await loadHistory(page);
		const markdown = page.locator(`[data-message-id="${ids.final}"] .markdown-body`);
		await expect(markdown).toHaveCount(1);
		await expect(markdown).toHaveText("Done — I created the design.");
	});

	test("blank turn with a generic tool remains visible without an empty markdown body", async ({ page }) => {
		const ids = await loadHistory(page);
		const row = page.locator(`[data-message-id="${ids.generic}"]`);
		await expect(row).toBeVisible();
		await expect(row.getByRole("button", { name: /generate-design/ })).toBeVisible();
		await expect(row.locator(".markdown-body")).toHaveCount(0);
	});

	test("blank turn with a dock tool retains its open control without an empty markdown body", async ({ page }) => {
		const ids = await loadHistory(page);
		const row = page.locator(`[data-message-id="${ids.dock}"]`);
		await expect(row).toBeVisible();
		await expect(row.getByTestId("dock-open-pill")).toBeVisible();
		await expect(row.locator(".markdown-body")).toHaveCount(0);
	});

	test("thinking-only turn retains its disclosure and content", async ({ page }) => {
		const ids = await loadHistory(page);
		const row = page.locator(`[data-message-id="${ids.thinking}"]`);
		await expect(row).toBeVisible();
		await row.getByRole("button", { name: /thinking/i }).click();
		await expect(row.getByText("I will inspect the design requirements.", { exact: true })).toBeVisible();
	});

	test("empty turn is hidden while meaningful turns survive a reload", async ({ page }) => {
		const ids = await loadHistory(page);
		await page.reload();
		for (const key of ["user", "thinking", "generic", "dock", "final"] as const) {
			await expect(page.locator(`[data-message-id="${ids[key]}"]`)).toBeVisible();
		}
		await expect(page.locator(`[data-message-id="${ids.empty}"]`)).toHaveCount(0);
		const markdown = page.locator('[data-testid="chat-messages-container"] .markdown-body');
		expect((await markdown.allTextContents()).every((content) => content.trim().length > 0)).toBe(true);
	});
});
