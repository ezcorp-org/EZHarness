import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeMessage } from "./fixtures/data.js";
import { openAgentPanel, openTeamPanel, panelMock, type MockApi } from "./fixtures/panel-chat.js";
import type { Locator, Page } from "@playwright/test";

/** E2E coverage for mentions and scroll controls in the current shared panel chat. */
const mentionAgents = [
	makeAgent({ name: "TestAgent", description: "The delegated agent" }),
	makeAgent({ name: "Coder", description: "Code assistant" }),
	makeAgent({ name: "Reviewer", description: "Code reviewer" }),
];

async function openMentionPanel(page: Page, mockApi: MockApi) {
	return openAgentPanel(page, mockApi, { agents: mentionAgents });
}

async function installMentionSearch(page: Page) {
	await page.route("**/api/mentions/search**", (route) =>
		route.fulfill({ json: [
			{ name: "Coder", description: "Code assistant", kind: "agent" },
			{ name: "Reviewer", description: "Code reviewer", kind: "agent" },
		] }),
	);
}

async function selectCoder(scope: Locator, textarea: Locator) {
	await textarea.fill("!agent:Co");
	const list = scope.locator("#mention-listbox");
	await expect(list).toBeVisible();
	const coder = list.getByRole("option", { name: /Coder/ });
	await expect(coder).toBeVisible();
	await textarea.press("Enter");
}

async function clickCoder(scope: Locator, textarea: Locator) {
	await textarea.fill("!agent:Co");
	const coder = scope.locator("#mention-listbox").getByRole("option", { name: /Coder/ });
	await expect(coder).toBeVisible();
	await coder.click();
}

test.describe("AgentDetailPanel @mention autocomplete", () => {
	test("typing @ in panel input shows mention popover with results", async ({ page, mockApi }) => {
		const panel = await openMentionPanel(page, mockApi);
		await installMentionSearch(page);
		const textarea = panel.locator("textarea");
		await expect(textarea).toHaveAttribute("role", "combobox");
		await textarea.fill("!");
		const list = panel.locator("#mention-listbox");
		await expect(list).toBeVisible();
		await expect(list.getByRole("option", { name: /Coder/ })).toBeVisible();
		await expect(list.getByRole("option", { name: /Reviewer/ })).toBeVisible();
	});

	test("selecting mention inserts token into panel input", async ({ page, mockApi }) => {
		const panel = await openMentionPanel(page, mockApi);
		await installMentionSearch(page);
		const textarea = panel.locator("textarea");
		await clickCoder(panel, textarea);
		await expect(panel.locator('[data-mention-kind="agent"][data-mention-name="Coder"]')).toBeVisible();
		await expect(textarea).toHaveValue(/!Coder/);
	});

	test("panel textarea has transparent text for overlay rendering", async ({ page, mockApi }) => {
		const panel = await openMentionPanel(page, mockApi);
		await installMentionSearch(page);
		const textarea = panel.locator("textarea");
		await selectCoder(panel, textarea);
		await expect(panel.locator('[data-mention-kind="agent"][data-mention-name="Coder"]')).toBeVisible();
		await expect(textarea).toHaveValue(/!Coder/);
		await expect(textarea).toHaveCSS("color", "rgba(0, 0, 0, 0)");
	});
});

test.describe("AgentDetailPanel scroll-to-bottom button", () => {
	test("jump-to-bottom button appears when scrolled up in panel", async ({ page, mockApi }) => {
		const many = Array.from({ length: 30 }, (_, index) => makeMessage({
			id: `long-${index}`,
			conversationId: "sub-conv-1",
			role: "assistant",
			content: `Long panel response ${index}: ${"text ".repeat(40)}`,
			parentMessageId: index === 0 ? "panel-reply-1" : `long-${index - 1}`,
			createdAt: new Date(2026, 0, 1, 1, index).toISOString(),
		}));
		const panel = await openAgentPanel(page, mockApi, { agents: mentionAgents, messages: [ ...panelMock().messages!, ...many ] });
		const scroller = panel.locator('[data-testid="chat-messages-container"]');
		await expect(scroller).toBeVisible();
		await expect(panel.getByText("Long panel response 29", { exact: false })).toBeVisible();
		const initialMetrics = await scroller.evaluate((element) => ({
			scrollHeight: element.scrollHeight,
			clientHeight: element.clientHeight,
		}));
		expect(initialMetrics.scrollHeight).toBeGreaterThan(initialMetrics.clientHeight);
		await scroller.hover();
		await page.mouse.wheel(0, -10_000);
		await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		const jump = panel.getByRole("button", { name: "Jump to bottom" });
		await expect(jump).toBeVisible();
		await jump.click();
		await expect(jump).toBeHidden();
		await expect.poll(() => scroller.evaluate((element) =>
			element.scrollHeight - element.scrollTop - element.clientHeight,
		)).toBeLessThanOrEqual(2);
		await expect(panel.getByText("Long panel response 29", { exact: false })).toBeInViewport();
	});
});

test.describe("TeamChatPanel @mention autocomplete", () => {
	test("team panel chat input supports @mentions", async ({ page, mockApi }) => {
		const panel = await openTeamPanel(page, mockApi);
		await installMentionSearch(page);
		const textarea = panel.getByRole("combobox", { name: "Send a message to the team..." });
		await expect(textarea).toHaveAttribute("aria-expanded", "false");
		await textarea.fill("!agent:Co");
		const list = panel.locator("#mention-listbox");
		await expect(list).toBeVisible();
		await expect(list.getByRole("option", { name: /Coder/ })).toBeVisible();
		await textarea.press("Enter");
		await expect(panel.locator('[data-mention-kind="agent"][data-mention-name="Coder"]')).toBeVisible();
	});
});

test.describe("Panel chat input sends mentions with message", () => {
	test("submitted message includes mention token", async ({ page, mockApi }) => {
		const panel = await openMentionPanel(page, mockApi);
		await installMentionSearch(page);
		const textarea = panel.locator("textarea");
		await selectCoder(panel, textarea);
		await expect(textarea).toHaveValue(/!Coder/);
		await textarea.press("End");
		await textarea.pressSequentially("please review this");
		const sent = page.waitForResponse((response) => response.request().method() === "POST"
			&& new URL(response.url()).pathname === "/api/conversations/sub-conv-1/messages");
		await panel.getByRole("button", { name: "Send message" }).click();
		const response = await sent;
		expect(response.status()).toBe(200);
		expect(response.request().postDataJSON()).toMatchObject({ content: "![agent:Coder] please review this" });
		await expect(panel.getByTestId("chat-messages-container").getByText("please review this", { exact: false })).toBeVisible();
	});
});
