import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Active Run Resume on Page Refresh", () => {
	const proj = makeProject({ id: "proj-1", name: "Resume Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Streaming Chat" });

	test("no active run — page loads normally without streaming", async ({ page, mockApi }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Hello",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Hi there!",
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"active-run": () => ({ runId: null }),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Hello")).toBeVisible();
		await expect(page.getByText("Hi there!")).toBeVisible();
		// No streaming indicator should be visible
		const stopButton = page.getByRole("button", { name: /stop/i });
		await expect(stopButton).not.toBeVisible();
	});

	test("active run detected — streaming resumes and tokens appear", async ({ page, mockApi, emitWs }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Tell me a story",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"active-run": () => ({ runId: "run-resume-1" }),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Wait for the active run check to complete and streaming to start
		await page.waitForTimeout(500);

		// Simulate tokens arriving via WebSocket
		await emitWs({ type: "run:token", data: { runId: "run-resume-1", token: "Once upon " } });
		await emitWs({ type: "run:token", data: { runId: "run-resume-1", token: "a time..." } });

		// The streamed text should appear
		await expect(page.getByText("Once upon a time...")).toBeVisible({ timeout: 3000 });
	});

	test("active run completes — message reconciles from DB", async ({ page, mockApi, emitWs }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Quick question",
		});

		// After reconciliation, the full message appears from DB
		const fullAssistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Here is the complete answer with all details.",
			parentMessageId: "m1",
			runId: "run-resume-2",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		let messagesCallCount = 0;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"active-run": () => ({ runId: "run-resume-2" }),
				"/messages": () => {
					messagesCallCount++;
					// After first load, return with the completed assistant message
					if (messagesCallCount > 1) {
						return [userMsg, fullAssistantMsg];
					}
					return [userMsg];
				},
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForTimeout(500);

		// Send some tokens then complete
		await emitWs({ type: "run:token", data: { runId: "run-resume-2", token: "Partial..." } });
		await emitWs({
			type: "run:complete",
			data: { run: { id: "run-resume-2", status: "success" }, conversationId: "conv-1" },
		});

		// After reconciliation, the full DB message should appear
		await expect(page.getByText("Here is the complete answer with all details.")).toBeVisible({ timeout: 5000 });
	});

	test("active run already completed before startStreaming — reconciles from DB", async ({ page, mockApi }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Fast question",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Fast answer!",
			parentMessageId: "m1",
			runId: "run-fast",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				// Run already completed — status is "success", not "running"
				"active-run": () => ({ runId: "run-fast", status: "success" }),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Since active-run returns a completed status, checkActiveRun skips streaming
		// and just reloads messages — which includes the assistant response
		await expect(page.getByText("Fast answer!")).toBeVisible({ timeout: 5000 });
	});

	test("active run with partial response displays saved text", async ({ page, mockApi }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Write an essay",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"active-run": () => ({
					runId: "run-partial-1",
					partialResponse: "The history of computing begins with",
				}),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The partial response text should render on page load
		await expect(page.getByText("The history of computing begins with")).toBeVisible({ timeout: 5000 });
	});

	test("cancel button sends POST to active-run endpoint", async ({ page, mockApi, emitWs }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Long task",
		});

		let cancelPosted = false;
		let cancelBody: any = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"active-run": () => {
					return { runId: "run-cancel-1" };
				},
			},
		});

		// Intercept POST to active-run endpoint specifically
		await page.route("**/api/conversations/conv-1/active-run", async (route) => {
			if (route.request().method() === "POST") {
				cancelBody = route.request().postDataJSON();
				cancelPosted = true;
				await route.fulfill({ json: { success: true } });
			} else {
				await route.fulfill({ json: { runId: "run-cancel-1" } });
			}
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForTimeout(500);

		// Emit a token so the stop button appears
		await emitWs({ type: "run:token", data: { runId: "run-cancel-1", token: "Working on it..." } });

		const stopButton = page.getByRole("button", { name: /stop/i });
		await expect(stopButton).toBeVisible({ timeout: 5000 });
		await stopButton.click();

		// Verify the POST was sent with cancel action
		await expect.poll(() => cancelPosted, { timeout: 5000 }).toBe(true);
		expect(cancelBody).toEqual(expect.objectContaining({ action: "cancel" }));
	});

	test("completed run status does not trigger streaming — reconciles immediately", async ({ page, mockApi }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Hello question",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Hello answer!",
			parentMessageId: "m1",
			runId: "run-done",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				// Run has a non-running status — should NOT try to start streaming
				"active-run": () => ({ runId: "run-done", status: "error" }),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Should show the assistant message, no skeleton loader
		await expect(page.getByText("Hello answer!")).toBeVisible({ timeout: 5000 });
		// The skeleton loader ("Thinking...") should NOT be visible
		await expect(page.getByText("Thinking...")).not.toBeVisible();
	});

	test("streaming run completes via WS — skeleton disappears and message shows", async ({ page, mockApi, emitWs }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "Active question",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "Stream completed!",
			parentMessageId: "m1",
			runId: "run-active",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		let messagesCallCount = 0;
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"active-run": () => ({ runId: "run-active", status: "running" }),
				"/messages": () => {
					messagesCallCount++;
					// After reconciliation (2nd+ call), include the assistant message
					if (messagesCallCount > 2) {
						return [userMsg, assistantMsg];
					}
					return [userMsg];
				},
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Should see skeleton while streaming
		await expect(page.getByText("Thinking...")).toBeVisible({ timeout: 5000 });

		// Now run completes via WS
		await emitWs({
			type: "run:complete",
			data: { run: { id: "run-active", status: "success", startedAt: Date.now(), finishedAt: Date.now() } },
		});

		// Skeleton should disappear after reconciliation
		await expect(page.getByText("Thinking...")).not.toBeVisible({ timeout: 5000 });
		// The assistant message should appear
		await expect(page.getByText("Stream completed!")).toBeVisible({ timeout: 5000 });
	});

	test("page load with no messages and no active run — shows empty state", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: {
				"active-run": () => ({ runId: null }),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();
	});
});
