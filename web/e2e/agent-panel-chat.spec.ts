import { test, expect } from "./fixtures/test-base.js";
import { makeAgent } from "./fixtures/data.js";
import { openAgentPanel, openTeamPanel, type MockApi } from "./fixtures/panel-chat.js";
import type { Page } from "@playwright/test";

const agents = [makeAgent({ name: "TestAgent", description: "Delegated agent" })];
async function open(page: Page, mockApi: MockApi) {
	return openAgentPanel(page, mockApi, { agents });
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

	test("sends message via agent-chat endpoint on submit", async ({ page, mockApi }) => {
		const panel = await open(page, mockApi);
		let body: unknown;
		await page.route("**/api/conversations/sub-conv-1/messages", async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			body = route.request().postDataJSON();
			return route.fulfill({ json: { userMessage: { id: "sent", conversationId: "sub-conv-1", role: "user", content: "Focus on tests first", createdAt: "2026-01-01T00:02:00Z" }, runId: "run-sent", attachments: [], ezActionResults: [] } });
		});
		await panel.locator("textarea").fill("Focus on tests first");
		const sent = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/conversations/sub-conv-1/messages");
		await panel.getByRole("button", { name: "Send message" }).click();
		await sent;
		expect(body).toMatchObject({ content: "Focus on tests first" });
	});
});

test.describe("AgentDetailPanel Model Picker", () => {
	test("picker is visible and shows the agent's last-used model", async ({ page, mockApi }) => {
		const panel = await open(page, mockApi);
		const picker = panel.getByTestId("model-selector");
		await expect(picker).toBeVisible();
		await expect(picker.getByRole("button")).toBeVisible();
	});

	test("switching the model PUTs { provider, model } to the sub-conv endpoint", async ({ page, mockApi }) => {
		const panel = await open(page, mockApi);
		let update: unknown;
		await page.route("**/api/conversations/sub-conv-1", async (route) => {
		if (route.request().method() !== "PUT") return route.continue();
			update = route.request().postDataJSON();
			return route.fulfill({ json: {} });
		});
		const picker = panel.getByTestId("model-selector");
		await picker.getByRole("button").click();
		const option = page.getByRole("option").nth(1);
		await expect(option).toBeVisible();
		const updated = page.waitForRequest((request) => request.method() === "PUT" && new URL(request.url()).pathname === "/api/conversations/sub-conv-1");
		await option.click();
		await updated;
		expect(update).toEqual(expect.objectContaining({ provider: expect.any(String), model: expect.any(String) }));
	});

	test("sending a message after switching includes the new { provider, model } in the agent-chat body", async ({ page, mockApi }) => {
		const panel = await open(page, mockApi);
		let update: { provider: string; model: string } | undefined;
		let body: unknown;
		await page.route("**/api/conversations/sub-conv-1", async (route) => {
			if (route.request().method() !== "PUT") return route.continue();
			update = route.request().postDataJSON() as { provider: string; model: string };
			return route.fulfill({ json: {} });
		});
		await page.route("**/api/conversations/sub-conv-1/messages", async (route) => {
			if (route.request().method() !== "POST") return route.continue();
			body = route.request().postDataJSON();
			return route.fulfill({ json: { userMessage: { id: "sent", conversationId: "sub-conv-1", role: "user", content: "Try again", createdAt: "2026-01-01T00:02:00Z" }, runId: "run-sent", attachments: [], ezActionResults: [] } });
		});
		const picker = panel.getByTestId("model-selector");
		await picker.getByRole("button").click();
		const option = page.getByRole("option").nth(1);
		const updated = page.waitForRequest((request) => request.method() === "PUT" && new URL(request.url()).pathname === "/api/conversations/sub-conv-1");
		await option.click();
		await updated;
		expect(update).toEqual(expect.objectContaining({ provider: expect.any(String), model: expect.any(String) }));
		await panel.locator("textarea").fill("Try again");
		const sent = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/conversations/sub-conv-1/messages");
		await panel.getByRole("button", { name: "Send message" }).click();
		await sent;
		expect(body).toMatchObject({ content: "Try again", ...update });
	});
});

test.describe("TeamChatPanel Chat Input", () => {
	test("shows chat input in team overview when orchestrator exists", async ({ page, mockApi }) => {
		const panel = await openTeamPanel(page, mockApi);
		await expect(panel.getByRole("combobox", { name: "Send a message to the team..." })).toBeVisible();
	});
});
