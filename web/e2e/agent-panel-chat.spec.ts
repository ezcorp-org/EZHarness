import { test, expect } from "./fixtures/test-base.js";
import { makeAgent } from "./fixtures/data.js";
import { openAgentPanel, openTeamPanel, type MockApi } from "./fixtures/panel-chat.js";
import { sendComposerMessage, threadMessages } from "./fixtures/composer.js";
import type { Locator, Page } from "@playwright/test";

const agents = [makeAgent({ name: "TestAgent", description: "Delegated agent" })];
const selectedModel = { provider: "openai", model: "gpt-4o" };
async function open(page: Page, mockApi: MockApi) {
	return openAgentPanel(page, mockApi, { agents });
}

async function selectModel(page: Page, panel: Locator) {
	const picker = panel.getByTestId("model-selector");
	await expect(picker.getByRole("button")).toContainText("Claude Sonnet 4");
	await picker.getByRole("button").click();
	const updated = page.waitForResponse((response) => response.request().method() === "PUT"
		&& new URL(response.url()).pathname === "/api/conversations/sub-conv-1");
	await page.getByRole("option", { name: /GPT-4o/ }).click();
	const response = await updated;
	expect(response.status()).toBe(200);
	expect(response.request().postDataJSON()).toEqual(selectedModel);
	await expect(picker.getByRole("button")).toContainText("GPT-4o");
}

async function send(page: Page, panel: Locator, text: string) {
	const sent = page.waitForResponse((response) => response.request().method() === "POST"
		&& new URL(response.url()).pathname === "/api/conversations/sub-conv-1/messages");
	await sendComposerMessage(panel, text);
	const response = await sent;
	expect(response.status()).toBe(200);
	await expect(threadMessages(panel).getByText(text, { exact: true })).toBeVisible();
	return response.request().postDataJSON();
}

test.describe("AgentDetailPanel Chat Input", () => {
	test("shows chat input with textarea and send button", async ({ page, mockApi }) => {
		const panel = await open(page, mockApi);
		const textarea = panel.locator("textarea");
		const send = panel.getByRole("button", { name: "Send message" });
		await expect(textarea).toBeVisible();
		await expect(send).toBeDisabled();
		await textarea.fill("Can you focus on the tests first?");
		await expect(send).toBeEnabled();
	});

	test("sends a visible message through the sub-conversation messages endpoint", async ({ page, mockApi }) => {
		const panel = await open(page, mockApi);
		expect(await send(page, panel, "Focus on tests first")).toMatchObject({ content: "Focus on tests first" });
	});
});

test.describe("AgentDetailPanel Model Picker", () => {
	test("picker is visible and shows the agent's last-used model", async ({ page, mockApi }) => {
		const panel = await open(page, mockApi);
		await expect(panel.getByTestId("model-selector").getByRole("button")).toContainText("Claude Sonnet 4");
	});

	test("switching the model persists the exact provider and model", async ({ page, mockApi }) => {
		const panel = await open(page, mockApi);
		await selectModel(page, panel);
		await page.reload();
		await expect(panel).toBeVisible();
		await expect(panel.getByTestId("model-selector").getByRole("button")).toContainText("GPT-4o");
	});

	test("sending after switching uses the new provider and model", async ({ page, mockApi }) => {
		const panel = await open(page, mockApi);
		await selectModel(page, panel);
		expect(await send(page, panel, "Try again")).toMatchObject({ content: "Try again", ...selectedModel });
	});
});

test.describe("TeamChatPanel Chat Input", () => {
	test("shows chat input in team overview when orchestrator exists", async ({ page, mockApi }) => {
		const panel = await openTeamPanel(page, mockApi);
		await expect(panel.getByRole("combobox", { name: "Send a message to the team..." })).toBeVisible();
	});
});
