import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Chat Streaming", () => {
	const proj = makeProject({ id: "proj-1", name: "Stream Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

	test("streaming tokens appear in real-time via WebSocket", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Wait for the empty state
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		// Type and send a message
		const textarea = page.locator("textarea");
		await textarea.fill("Tell me a joke");
		await page.getByRole("button", { name: "Send message" }).click();

		// Wait for the user message to appear (either optimistic or from API response)
		await expect(page.getByText("Tell me a joke")).toBeVisible({ timeout: 5000 });

		// Simulate streaming tokens via WS
		await emitWs({ type: "run:token", data: { runId: "run-stream", token: "Why did " } });
		await emitWs({ type: "run:token", data: { runId: "run-stream", token: "the chicken" } });

		// Tokens should appear in the page
		await expect(page.getByText("Why did the chicken")).toBeVisible({ timeout: 5000 });
	});

	test("stop button appears during streaming", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Hello");
		await page.getByRole("button", { name: "Send message" }).click();

		// Wait for the send to complete (user message appears)
		await expect(page.getByText("Hello")).toBeVisible({ timeout: 5000 });

		// Emit a token to keep stream alive
		await emitWs({ type: "run:token", data: { runId: "run-stream", token: "Hi " } });

		// The stop button should appear
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({ timeout: 5000 });
	});

	test("stream completion removes streaming state", async ({ page, mockApi, emitWs }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Hi",
		});
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Simulate a run:complete event
		await emitWs({
			type: "run:complete",
			data: {
				id: "run-1",
				agentName: "test",
				status: "success",
				startedAt: "2026-01-01T00:00:00.000Z",
				logs: [],
				result: { success: true, output: "Done" },
			},
		});

		// After completion, stop button should not be present
		await expect(page.getByRole("button", { name: /stop/i })).not.toBeVisible();
	});
});
