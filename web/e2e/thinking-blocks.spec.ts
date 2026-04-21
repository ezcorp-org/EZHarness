import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

test.describe("Thinking Blocks", () => {
	const proj = makeProject({ id: "proj-think", name: "Thinking Project" });
	const conv = makeConversation({ id: "conv-think", projectId: "proj-think", model: "claude-sonnet-4-20250514", provider: "anthropic" });

	async function sendAndWaitForStream(page: Page, text: string) {
		const textarea = page.locator("textarea");
		await textarea.fill(text);
		await Promise.all([
			page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST"),
			page.getByRole("button", { name: "Send message" }).click(),
		]);
		await expect(page.getByText(text)).toBeVisible({ timeout: 5000 });
	}

	test.describe("Streaming: thinking appears in collapsible card", () => {
		test("thinking → text renders thinking card above response", async ({ page, mockApi, emitWs }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [],
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);
			await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

			await sendAndWaitForStream(page, "Explain quantum computing");

			// Stream thinking tokens
			await emitWs({ type: "run:token", data: { runId: "run-stream", token: "Let me break this down step by step.", kind: "thinking" } });

			// Thinking card should appear with "Thinking" label
			await expect(page.locator("button").filter({ hasText: "Thinking" })).toBeVisible({ timeout: 5000 });

			// Stream text tokens
			await emitWs({ type: "run:token", data: { runId: "run-stream", token: "Quantum computing uses qubits.", kind: "text" } });
			await expect(page.getByText("Quantum computing uses qubits.")).toBeVisible({ timeout: 5000 });

			// Both thinking card and text should be visible
			await expect(page.locator("button").filter({ hasText: "Thinking" })).toBeVisible();
			await expect(page.getByText("Quantum computing uses qubits.")).toBeVisible();
		});

		test("thinking card appears above text in DOM order", async ({ page, mockApi, emitWs }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [],
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);
			await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

			await sendAndWaitForStream(page, "Think about this");

			await emitWs({ type: "run:token", data: { runId: "run-stream", token: "Analyzing the problem carefully.", kind: "thinking" } });
			await emitWs({ type: "run:token", data: { runId: "run-stream", token: "RESPONSE_TEXT_MARKER", kind: "text" } });

			await expect(page.locator("button").filter({ hasText: "Thinking" })).toBeVisible({ timeout: 5000 });
			await expect(page.getByText("RESPONSE_TEXT_MARKER")).toBeVisible({ timeout: 5000 });

			// Verify thinking card is above the response text
			const thinkingBox = await page.locator("button").filter({ hasText: "Thinking" }).boundingBox();
			const textBox = await page.getByText("RESPONSE_TEXT_MARKER").boundingBox();

			expect(thinkingBox).toBeTruthy();
			expect(textBox).toBeTruthy();
			expect(thinkingBox!.y).toBeLessThan(textBox!.y);
		});

		test("text-only stream (no thinking) renders normally without thinking card", async ({ page, mockApi, emitWs }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [],
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);
			await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

			await sendAndWaitForStream(page, "Simple question");

			// Stream text tokens only (kind: "text" or no kind)
			await emitWs({ type: "run:token", data: { runId: "run-stream", token: "Simple answer.", kind: "text" } });
			await expect(page.getByText("Simple answer.")).toBeVisible({ timeout: 5000 });

			// No thinking card should appear
			await expect(page.locator("button").filter({ hasText: "Thinking" })).not.toBeVisible();
		});

		test("thinking with tool calls renders all three block types", async ({ page, mockApi, emitWs }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [],
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);
			await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

			await sendAndWaitForStream(page, "Search and think");

			// Thinking
			await emitWs({ type: "run:token", data: { runId: "run-stream", token: "I should search for this.", kind: "thinking" } });
			await expect(page.locator("button").filter({ hasText: "Thinking" })).toBeVisible({ timeout: 5000 });

			// Text before tool
			await emitWs({ type: "run:token", data: { runId: "run-stream", token: "Let me search.", kind: "text" } });

			// Tool call
			await emitWs({
				type: "tool:start",
				data: { conversationId: "conv-think", toolName: "web_search", input: { query: "test" }, timestamp: Date.now() },
			});
			await expect(page.locator("button").filter({ hasText: "web_search" })).toBeVisible({ timeout: 5000 });

			// Text after tool
			await emitWs({
				type: "tool:complete",
				data: { conversationId: "conv-think", toolName: "web_search", output: "results", duration: 100, success: true },
			});
			await emitWs({ type: "run:token", data: { runId: "run-stream", token: "Found the answer.", kind: "text" } });

			// All three types visible
			await expect(page.locator("button").filter({ hasText: "Thinking" })).toBeVisible();
			await expect(page.locator("button").filter({ hasText: "web_search" })).toBeVisible();
			await expect(page.getByText("Found the answer.")).toBeVisible();
		});
	});

	test.describe("Historical: thinking card persists after streaming", () => {
		const userMsg = makeMessage({
			id: "m-think-1",
			conversationId: "conv-think",
			role: "user",
			content: "Explain this",
		});

		const assistantMsgWithThinking = makeMessage({
			id: "m-think-2",
			conversationId: "conv-think",
			role: "assistant",
			content: "The answer is 42.",
			thinkingContent: "Let me reason through this carefully. The question asks about the meaning of life.",
			parentMessageId: "m-think-1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		const assistantMsgNoThinking = makeMessage({
			id: "m-think-3",
			conversationId: "conv-think",
			role: "assistant",
			content: "A simple response.",
			thinkingContent: null,
			parentMessageId: "m-think-1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		function withToolCallsRoute(msgs: any[]) {
			return {
				[`/api/conversations/conv-think/messages`]: (url: URL) => {
					if (url.searchParams.get("withToolCalls") === "true") {
						return {
							messages: msgs.map(m => ({ ...m, toolCalls: [] })),
							subConversations: [],
						};
					}
					if (url.searchParams.get("all") === "true") {
						return msgs;
					}
					return msgs;
				},
				"active-run": () => ({ runId: null }),
			};
		}

		test("historical message with thinking shows thinking card", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsgWithThinking],
				routes: withToolCallsRoute([userMsg, assistantMsgWithThinking]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			// Thinking card should be visible (collapsed)
			await expect(page.locator("button").filter({ hasText: "Thinking" })).toBeVisible({ timeout: 5000 });
			// Response text should also be visible
			await expect(page.getByText("The answer is 42.")).toBeVisible({ timeout: 5000 });
		});

		test("historical message without thinking shows no thinking card", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsgNoThinking],
				routes: withToolCallsRoute([userMsg, assistantMsgNoThinking]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			// Response text should be visible
			await expect(page.getByText("A simple response.")).toBeVisible({ timeout: 5000 });
			// No thinking card
			await expect(page.locator("button").filter({ hasText: "Thinking" })).not.toBeVisible();
		});

		test("thinking card is expandable and shows content", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsgWithThinking],
				routes: withToolCallsRoute([userMsg, assistantMsgWithThinking]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			// Click to expand
			const thinkingButton = page.locator("button").filter({ hasText: "Thinking" });
			await expect(thinkingButton).toBeVisible({ timeout: 5000 });
			await thinkingButton.click();

			// Thinking content should now be visible
			await expect(page.getByText("Let me reason through this carefully")).toBeVisible({ timeout: 5000 });
		});
	});
});
