import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeConversation, makeProject } from "./fixtures/data.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import type { Page } from "@playwright/test";

const project = makeProject({ id: "proj-chat-save-errors", name: "Save Error Project" });
const conversation = makeConversation({
	id: "conv-chat-save-errors",
	projectId: project.id,
	title: "Original chat title",
});

async function showChat(page: Page, mockApi: (overrides?: MockOverrides) => Promise<void>) {
	await mockApi({ projects: [project], conversations: [conversation], messages: [] });
	await page.goto(`/project/${project.id}/chat/${conversation.id}`);
	await expect(page.getByTestId("chat-title")).toHaveText(conversation.title);
}

test("@evidence failed title rename keeps the typed draft and shows the server error", async ({ page, mockApi }, testInfo) => {
	await showChat(page, mockApi);
	await page.route(`**/api/conversations/${conversation.id}`, async (route) => {
		if (route.request().method() !== "PUT") return route.fallback();
		await route.fulfill({ status: 503, json: { error: "Rename service unavailable" } });
	});

	await page.getByTestId("chat-title").dblclick();
	const titleInput = page.getByTestId("chat-title-input");
	await titleInput.fill("Keep this title");
	await page.getByTestId("chat-title-save").click();

	await expect(page.getByTestId("chat-title-save-error")).toHaveText("Rename service unavailable");
	await expect(titleInput).toBeEditable();
	await expect(titleInput).toHaveValue("Keep this title");
	await captureEvidence(page, testInfo, "chat-title-save-error");
});

test("@evidence failed instruction save keeps the typed draft and shows the server error", async ({ page, mockApi }, testInfo) => {
	await showChat(page, mockApi);
	await page.route(`**/api/conversations/${conversation.id}`, async (route) => {
		if (route.request().method() !== "PUT") return route.fallback();
		await route.fulfill({ status: 503, json: { error: "Instruction service unavailable" } });
	});

	await page.getByRole("button", { name: "Conversation settings" }).click();
	const instructions = page.locator("#conv-prompt");
	await expect(instructions).toBeVisible();
	await instructions.fill("Keep these instructions");
	await page.getByRole("button", { name: "Save", exact: true }).click();

	await expect(page.getByTestId("conversation-settings-save-error")).toHaveText("Instruction service unavailable");
	await expect(instructions).toBeEditable();
	await expect(instructions).toHaveValue("Keep these instructions");
	await captureEvidence(page, testInfo, "conversation-instructions-save-error");
});
