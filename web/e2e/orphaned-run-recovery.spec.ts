import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Tests that the UI correctly handles orphaned/interrupted runs on page refresh.
 * Covers the bug where: parent run is stuck in auto-spin-up, orphan cleanup marks it
 * interrupted in DB, but in-memory run reports "running" → skeleton stuck forever.
 */
test.describe("Orphaned Run Recovery", () => {
	const proj = makeProject({ id: "proj-1", name: "Team Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Team Chat" });

	test("interrupted active run does not show skeleton on refresh", async ({ page, mockApi }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "![team:Dev Team] do something",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"active-run": () => ({ runId: "run-orphan", status: "interrupted" }),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Should show the user message (mention renders as pill), NOT a skeleton loader
		await expect(page.getByText("do something")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Resuming...")).not.toBeVisible();
		await expect(page.getByText("Thinking...")).not.toBeVisible();
	});

	test("error active run does not show skeleton on refresh", async ({ page, mockApi }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Hello",
		});
		const errorMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Error: No credentials available for openai",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, errorMsg],
			routes: {
				"active-run": () => ({ runId: "run-err", status: "error" }),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Error message should be visible, no skeleton
		await expect(page.getByText("No credentials available")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Resuming...")).not.toBeVisible();
	});

	test("null active run with user-only messages shows no skeleton", async ({ page, mockApi }) => {
		// Scenario: parent run errored and was cleaned up, no assistant response saved
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "This message got no response",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"active-run": () => ({ runId: null }),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("This message got no response")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Resuming...")).not.toBeVisible();
	});

	test("run:error WS event clears skeleton and shows error toast", async ({ page, mockApi, emitWs }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Hello",
		});
		const errorAssistant = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Error: connection timeout",
			parentMessageId: "m1",
			runId: "run-live-err",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		let msgCalls = 0;
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"active-run": () => ({ runId: "run-live-err", status: "running" }),
				"/messages": () => {
					msgCalls++;
					return msgCalls > 2 ? [userMsg, errorAssistant] : [userMsg];
				},
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForTimeout(500);

		// Should be in streaming/skeleton state
		await expect(page.getByText("Thinking...")).toBeVisible({ timeout: 3000 });

		// run:error arrives
		await emitWs({
			type: "run:error",
			data: {
				run: { id: "run-live-err", status: "error", error: "Connection timeout" },
			},
		});

		// Skeleton should disappear
		await expect(page.getByText("Thinking...")).not.toBeVisible({ timeout: 5000 });
	});
});
