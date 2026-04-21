import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-sm", name: "Save Memory Project" });
const conv = makeConversation({ id: "conv-sm", projectId: "proj-sm", title: "Memory Chat" });

const userMsg = makeMessage({
	id: "m-user",
	conversationId: "conv-sm",
	role: "user",
	content: "I prefer dark mode editors",
});

const assistantMsg = makeMessage({
	id: "m-asst",
	conversationId: "conv-sm",
	role: "assistant",
	content: "Noted! I will remember your preference for dark mode.",
	parentMessageId: "m-user",
	createdAt: "2026-01-01T00:01:00.000Z",
});

test.describe("Save to Memory Button", () => {
	test("save-memory button appears on user message hover", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await expect(page.getByText("I prefer dark mode editors")).toBeVisible({ timeout: 5000 });

		// Button should be hidden initially (opacity-0 via group-hover)
		const saveBtn = page.locator('[data-testid="save-memory-btn"]').first();

		// Hover over user message to reveal toolbar
		await page.getByText("I prefer dark mode editors").hover();
		await expect(saveBtn).toBeVisible({ timeout: 3000 });
		await expect(saveBtn).toHaveAttribute("aria-label", "Save to memory");
	});

	test("save-memory button appears on assistant message hover", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await expect(page.getByText("Noted! I will remember")).toBeVisible({ timeout: 5000 });

		// Hover over assistant message
		await page.getByText("Noted! I will remember").hover();
		const saveBtn = page.locator('[data-testid="save-memory-btn"]').last();
		await expect(saveBtn).toBeVisible({ timeout: 3000 });
	});

	test("clicking save-memory sends POST to /api/memories with message content", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });

		let postBody: Record<string, unknown> | null = null;
		await page.route("**/api/memories", async (route) => {
			if (route.request().method() === "POST") {
				postBody = route.request().postDataJSON();
				return route.fulfill({ status: 201, json: { id: "mem-new", content: postBody!.content } });
			}
			return route.fallback();
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await expect(page.getByText("I prefer dark mode editors")).toBeVisible({ timeout: 5000 });

		// Hover and click save
		await page.getByText("I prefer dark mode editors").hover();
		const saveBtn = page.locator('[data-testid="save-memory-btn"]').first();
		await expect(saveBtn).toBeVisible({ timeout: 3000 });
		await saveBtn.click();

		// Verify POST body
		expect(postBody).not.toBeNull();
		expect(postBody!.content).toBe("I prefer dark mode editors");
		expect(postBody!.category).toBe("preferences");
		expect(postBody!.confidence).toBe("medium");
	});

	test("button shows checkmark after saving", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });

		await page.route("**/api/memories", async (route) => {
			if (route.request().method() === "POST") {
				return route.fulfill({ status: 201, json: { id: "mem-new" } });
			}
			return route.fallback();
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await expect(page.getByText("I prefer dark mode editors")).toBeVisible({ timeout: 5000 });

		await page.getByText("I prefer dark mode editors").hover();
		const saveBtn = page.locator('[data-testid="save-memory-btn"]').first();
		await expect(saveBtn).toBeVisible({ timeout: 3000 });

		// Before click: "Save to memory"
		await expect(saveBtn).toHaveAttribute("aria-label", "Save to memory");

		await saveBtn.click();

		// After click: "Saved to memory!"
		await expect(saveBtn).toHaveAttribute("aria-label", "Saved to memory!", { timeout: 2000 });
	});

	test("checkmark transitions to saved state after 1.5s", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });

		await page.route("**/api/memories", async (route) => {
			if (route.request().method() === "POST") {
				return route.fulfill({ status: 201, json: { id: "mem-new" } });
			}
			return route.fallback();
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await expect(page.getByText("I prefer dark mode editors")).toBeVisible({ timeout: 5000 });

		await page.getByText("I prefer dark mode editors").hover();
		const saveBtn = page.locator('[data-testid="save-memory-btn"]').first();
		await expect(saveBtn).toBeVisible({ timeout: 3000 });
		await saveBtn.click();

		// Immediately shows "Saved to memory!"
		await expect(saveBtn).toHaveAttribute("aria-label", "Saved to memory!");

		// After 1.5s it transitions to persistent saved state (green brain + check)
		await page.getByText("I prefer dark mode editors").hover();
		await expect(saveBtn).toHaveAttribute("aria-label", "Saved to memory", { timeout: 3000 });
	});

	test("saving assistant message sends assistant content", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });

		let postBody: Record<string, unknown> | null = null;
		await page.route("**/api/memories", async (route) => {
			if (route.request().method() === "POST") {
				postBody = route.request().postDataJSON();
				return route.fulfill({ status: 201, json: { id: "mem-new" } });
			}
			return route.fallback();
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await expect(page.getByText("Noted! I will remember")).toBeVisible({ timeout: 5000 });

		// Hover over assistant message and save
		await page.getByText("Noted! I will remember").hover();
		const saveBtn = page.locator('[data-testid="save-memory-btn"]').last();
		await expect(saveBtn).toBeVisible({ timeout: 3000 });
		await saveBtn.click();

		expect(postBody).not.toBeNull();
		expect(postBody!.content).toBe("Noted! I will remember your preference for dark mode.");
	});

	test("hovering saved button shows remove state (red brain + minus)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });

		await page.route("**/api/memories", async (route) => {
			if (route.request().method() === "POST") {
				return route.fulfill({ status: 201, json: { id: "mem-to-remove" } });
			}
			return route.fallback();
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await expect(page.getByText("I prefer dark mode editors")).toBeVisible({ timeout: 5000 });

		// Save first
		await page.getByText("I prefer dark mode editors").hover();
		const saveBtn = page.locator('[data-testid="save-memory-btn"]').first();
		await saveBtn.click();

		// Move mouse to assistant message to leave the button, wait for justSaved to clear
		await page.getByText("Noted! I will remember").hover();
		await page.waitForTimeout(1600);

		// Re-hover the user message to show toolbar — should show saved state
		await page.getByText("I prefer dark mode editors").hover();
		await expect(saveBtn).toHaveAttribute("aria-label", "Saved to memory", { timeout: 3000 });

		// Now hover the button itself — should switch to "Remove from memory"
		await saveBtn.hover();
		await expect(saveBtn).toHaveAttribute("aria-label", "Remove from memory", { timeout: 2000 });
	});

	test("clicking remove deletes memory and resets to unsaved state", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });

		let deleteCalledWith: string | null = null;
		await page.route("**/api/memories/**", async (route) => {
			if (route.request().method() === "DELETE") {
				const url = new URL(route.request().url());
				deleteCalledWith = url.pathname.split("/").pop()!;
				return route.fulfill({ status: 204, body: "" });
			}
			return route.fallback();
		});

		await page.route("**/api/memories", async (route) => {
			if (route.request().method() === "POST") {
				return route.fulfill({ status: 201, json: { id: "mem-del-123" } });
			}
			return route.fallback();
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await expect(page.getByText("I prefer dark mode editors")).toBeVisible({ timeout: 5000 });

		// Save
		await page.getByText("I prefer dark mode editors").hover();
		const saveBtn = page.locator('[data-testid="save-memory-btn"]').first();
		await saveBtn.click();

		// Move away, wait for justSaved to clear
		await page.getByText("Noted! I will remember").hover();
		await page.waitForTimeout(1600);

		// Re-hover message to show toolbar in saved state
		await page.getByText("I prefer dark mode editors").hover();
		await expect(saveBtn).toHaveAttribute("aria-label", "Saved to memory", { timeout: 3000 });

		// Hover button to get remove state, then click
		await saveBtn.hover();
		await expect(saveBtn).toHaveAttribute("aria-label", "Remove from memory", { timeout: 2000 });
		await saveBtn.click();

		// Should call DELETE with the memory ID
		expect(deleteCalledWith).toBe("mem-del-123");

		// Should reset to unsaved (brain + plus)
		await page.getByText("I prefer dark mode editors").hover();
		await expect(saveBtn).toHaveAttribute("aria-label", "Save to memory", { timeout: 3000 });
	});

	test("toolbar is hidden via opacity when not hovering", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await expect(page.getByText("I prefer dark mode editors")).toBeVisible({ timeout: 5000 });

		// The toolbar container uses opacity-0 when not hovering
		// Button is inside Tooltip span, so go up to the toolbar div
		const toolbar = page.locator('[data-testid="save-memory-btn"]').first().locator('xpath=ancestor::div[contains(@class,"opacity-0")]');
		await expect(toolbar).toHaveCSS("opacity", "0");
	});
});
