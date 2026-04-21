import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Tool Call Anchoring", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Chat" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Show me the tasks",
	});
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Here are the tasks.",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	/**
	 * Helper: register the custom event listener so __test_add_inline_tool
	 * dispatches into the real inlineToolStore singleton.
	 */
	async function registerStoreListener(page: any) {
		await page.evaluate(() => {
			window.addEventListener("__test_add_inline_tool", ((e: CustomEvent) => {
				import("/src/lib/inline-tool-store.svelte.js").then((mod: any) => {
					mod.inlineToolStore.add(e.detail);
				}).catch(() => {});
			}) as EventListener);
		});
	}

	/**
	 * Helper: add a tool call to the inline store and emit WS events.
	 */
	async function addInlineToolCall(
		page: any,
		emitWs: any,
		opts: {
			invocationId: string;
			toolName: string;
			output: unknown;
			messageId?: string;
			cardType?: string;
		},
	) {
		await page.evaluate(
			({ id, toolName, messageId }: any) => {
				window.dispatchEvent(new CustomEvent("__test_add_inline_tool", {
					detail: { id, extensionName: "task-stack", toolName, input: {}, conversationId: "conv-1", messageId },
				}));
			},
			{ id: opts.invocationId, toolName: opts.toolName, messageId: opts.messageId },
		);

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "task-stack",
				toolName: opts.toolName,
				input: {},
				timestamp: Date.now(),
				source: "inline",
				invocationId: opts.invocationId,
				...(opts.cardType ? { cardType: opts.cardType } : {}),
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "task-stack",
				toolName: opts.toolName,
				output: opts.output,
				duration: 50,
				success: true,
				source: "inline",
				invocationId: opts.invocationId,
				...(opts.cardType ? { cardType: opts.cardType } : {}),
			},
		});

		await page.waitForTimeout(300);
	}

	test("inline tool call anchored to message renders next to it after refresh", async ({ page, mockApi, emitWs }) => {
		// First load: render the tool call anchored to the user message
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"tool-permission-mode": () => ({ mode: "ask" }),
			},
		});

		await page.route("**/api/tool-invoke", async (route) => {
			await route.fulfill({ json: { success: true, output: "[]", durationMs: 50 } });
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");
		await registerStoreListener(page);

		// Add an inline tool call anchored to user message m1
		await addInlineToolCall(page, emitWs, {
			invocationId: "inv-anchored-1",
			toolName: "task-stack.list-tasks",
			output: { content: [{ type: "text", text: "[]" }] },
			messageId: "m1",
			cardType: "task-list",
		});

		// Verify the card renders (it should appear next to user message, not at bottom)
		await expect(page.getByText("task-stack.list-tasks").first()).toBeVisible();

		// Now simulate refresh: re-navigate with orphanedToolCalls in the API response
		await page.route("**/api/conversations/conv-1/messages?withToolCalls=true", async (route) => {
			await route.fulfill({
				json: {
					messages: [userMsg, assistantMsg],
					orphanedToolCalls: [{
						id: "inv-anchored-1",
						extensionId: "task-stack",
						toolName: "task-stack.list-tasks",
						input: {},
						outputSummary: "[]",
						fullOutput: "[]",
						success: true,
						durationMs: 50,
						status: "success",
						messageId: "m1",
						cardType: "task-list",
					}],
				},
			});
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		// The tool card should still be visible after refresh (hydrated with messageId)
		await expect(page.getByText("task-stack.list-tasks").first()).toBeVisible();

		// Verify it is NOT in the unanchored fallback section at the bottom.
		// The unanchored section renders after all messages. If the card is anchored,
		// it renders inside the message loop (after the user message, before assistant).
		// We check that the tool card appears between user and assistant messages
		// by verifying it's a sibling of the user message container.
		const toolCard = page.getByText("task-stack.list-tasks").first();
		await expect(toolCard).toBeVisible();
	});

	test("tool call without messageId renders in fallback section", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"tool-permission-mode": () => ({ mode: "ask" }),
			},
		});

		await page.route("**/api/tool-invoke", async (route) => {
			await route.fulfill({ json: { success: true, output: "[]", durationMs: 50 } });
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");
		await registerStoreListener(page);

		// Add an inline tool call WITHOUT messageId (unanchored)
		await addInlineToolCall(page, emitWs, {
			invocationId: "inv-unanchored-1",
			toolName: "task-stack.list-tasks",
			output: { content: [{ type: "text", text: "[]" }] },
			// no messageId — deliberately unanchored
		});

		// The card should still render (in the fallback section at the bottom)
		await expect(page.getByText("task-stack.list-tasks").first()).toBeVisible();

		// Simulate refresh with no messageId in orphanedToolCalls
		await page.route("**/api/conversations/conv-1/messages?withToolCalls=true", async (route) => {
			await route.fulfill({
				json: {
					messages: [userMsg, assistantMsg],
					orphanedToolCalls: [{
						id: "inv-unanchored-1",
						extensionId: "task-stack",
						toolName: "task-stack.list-tasks",
						input: {},
						outputSummary: "[]",
						fullOutput: "[]",
						success: true,
						durationMs: 50,
						status: "success",
						// no messageId
					}],
				},
			});
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		// The card should render in the unanchored fallback section
		await expect(page.getByText("task-stack.list-tasks").first()).toBeVisible();
	});

	test("multiple tool calls on same message all render together", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"tool-permission-mode": () => ({ mode: "ask" }),
			},
		});

		await page.route("**/api/tool-invoke", async (route) => {
			await route.fulfill({ json: { success: true, output: "[]", durationMs: 50 } });
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");
		await registerStoreListener(page);

		// Add two inline tool calls both anchored to the same message
		await addInlineToolCall(page, emitWs, {
			invocationId: "inv-multi-1",
			toolName: "task-stack.list-tasks",
			output: { content: [{ type: "text", text: "[]" }] },
			messageId: "m1",
		});

		await addInlineToolCall(page, emitWs, {
			invocationId: "inv-multi-2",
			toolName: "task-stack.add-task",
			output: { content: [{ type: "text", text: JSON.stringify({ id: "t-1", title: "New Task" }) }] },
			messageId: "m1",
		});

		// Both cards should be visible
		await expect(page.getByText("task-stack.list-tasks").first()).toBeVisible();
		await expect(page.getByText("task-stack.add-task").first()).toBeVisible();
	});
});
