import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

test.describe("Interleaved Content Blocks", () => {
	const proj = makeProject({ id: "proj-1", name: "Block Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", model: "gpt-4", provider: "openai" });

	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Search for that",
	});

	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Here is the forecast.",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	const modelsRoute = {
		"/api/models": () => [
			{ provider: "openai", model: "gpt-4", displayName: "GPT-4", available: true },
		],
	};

	/** Send a chat message and wait for the API response (ensures startStreaming is called) */
	async function sendAndWaitForStream(page: Page, text: string) {
		const textarea = page.locator("textarea");
		await textarea.fill(text);
		await Promise.all([
			page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST"),
			page.getByRole("button", { name: "Send message" }).click(),
		]);
		await expect(page.getByText(text)).toBeVisible({ timeout: 5000 });
	}

	test.describe("Streaming: text between tool calls is visible", () => {
		test("text → tool → text renders in order during streaming", async ({ page, mockApi, emitSse }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [],
				routes: modelsRoute,
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);
			await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

			await sendAndWaitForStream(page, "Search for that");

			// Stream text before tool call
			await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Let me search." } });
			await expect(page.getByText("Let me search.")).toBeVisible({ timeout: 5000 });

			// Tool starts
			await emitSse({
				type: "tool:start",
				data: { conversationId: "conv-1", toolName: "web_search", input: { query: "test" }, timestamp: Date.now() },
			});
			await expect(page.locator("button").filter({ hasText: "web_search" })).toBeVisible({ timeout: 5000 });

			// Tool completes
			await emitSse({
				type: "tool:complete",
				data: { conversationId: "conv-1", toolName: "web_search", output: "results", duration: 100, success: true },
			});

			// Stream text after tool call
			await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Here are the results." } });
			await expect(page.getByText("Here are the results.")).toBeVisible({ timeout: 5000 });

			// Both text blocks should be visible simultaneously
			await expect(page.getByText("Let me search.")).toBeVisible();
			await expect(page.getByText("Here are the results.")).toBeVisible();
		});

		test("tool at start of response (no preceding text)", async ({ page, mockApi, emitSse }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [],
				routes: modelsRoute,
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);
			await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

			await sendAndWaitForStream(page, "Do it");

			// Tool starts immediately (no text before)
			await emitSse({
				type: "tool:start",
				data: { conversationId: "conv-1", toolName: "read_file", input: { path: "/test" }, timestamp: Date.now() },
			});
			await expect(page.locator("button").filter({ hasText: "read_file" })).toBeVisible({ timeout: 5000 });

			// Tool completes
			await emitSse({
				type: "tool:complete",
				data: { conversationId: "conv-1", toolName: "read_file", output: "file content", duration: 50, success: true },
			});

			// Text after tool
			await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Here is the file content." } });
			await expect(page.getByText("Here is the file content.")).toBeVisible({ timeout: 5000 });
		});

		test("multiple tools with text between each", async ({ page, mockApi, emitSse }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [],
				routes: modelsRoute,
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);
			await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

			await sendAndWaitForStream(page, "Multi tool");

			// Text → tool1 → text → tool2 → text
			await emitSse({ type: "run:token", data: { runId: "run-stream", token: "First I will read." } });

			await emitSse({
				type: "tool:start",
				data: { conversationId: "conv-1", toolName: "read_file", input: {}, timestamp: Date.now() },
			});
			await emitSse({
				type: "tool:complete",
				data: { conversationId: "conv-1", toolName: "read_file", output: "data", duration: 30, success: true },
			});

			await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Now I will search." } });

			await emitSse({
				type: "tool:start",
				data: { conversationId: "conv-1", toolName: "grep", input: {}, timestamp: Date.now() },
			});
			await emitSse({
				type: "tool:complete",
				data: { conversationId: "conv-1", toolName: "grep", output: "matches", duration: 20, success: true },
			});

			await emitSse({ type: "run:token", data: { runId: "run-stream", token: "All done." } });

			// All three text blocks should be visible
			await expect(page.getByText("First I will read.")).toBeVisible({ timeout: 5000 });
			await expect(page.getByText("Now I will search.")).toBeVisible({ timeout: 5000 });
			await expect(page.getByText("All done.")).toBeVisible({ timeout: 5000 });

			// Both tool cards should be visible
			await expect(page.locator("button").filter({ hasText: "read_file" })).toBeVisible();
			await expect(page.locator("button").filter({ hasText: "grep" })).toBeVisible();
		});
	});

	test.describe("Historical: tool calls render with message text", () => {
		const toolCall = {
			id: "tc-1",
			extensionId: "ext-1",
			extensionName: "search",
			toolName: "web_search",
			input: { query: "test" },
			outputSummary: "Found 5 results",
			output: "Found 5 results for test query",
			success: true,
			durationMs: 200,
			status: "complete" as const,
			createdAt: "2026-01-01T00:00:30.000Z",
		};

		function withToolCallsRoute(tcs: any[]) {
			return {
				"/api/conversations/conv-1/messages": (url: URL) => {
					if (url.searchParams.get("withToolCalls") === "true") {
						return {
							messages: [
								{ ...userMsg },
								{ ...assistantMsg, toolCalls: tcs },
							],
							subConversations: [],
						};
					}
					return [userMsg, assistantMsg];
				},
				"active-run": () => ({ runId: null }),
			};
		}

		test("historical message with tool calls renders text and tools", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsg],
				routes: withToolCallsRoute([toolCall]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			await expect(page.getByText("Here is the forecast.")).toBeVisible({ timeout: 5000 });
			await expect(page.locator("button").filter({ hasText: "web_search" })).toBeVisible({ timeout: 5000 });
		});

		test("historical message with no tool calls renders only text", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [userMsg, assistantMsg],
				routes: withToolCallsRoute([]),
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);

			await expect(page.getByText("Here is the forecast.")).toBeVisible({ timeout: 5000 });
			await expect(page.locator("button").filter({ hasText: "web_search" })).not.toBeVisible();
		});
	});

	test.describe("DOM ordering of interleaved blocks", () => {
		test("text appears before tool card which appears before trailing text in DOM order", async ({ page, mockApi, emitSse }) => {
			await mockApi({
				projects: [proj],
				conversations: [conv],
				messages: [],
				routes: modelsRoute,
			});
			await page.goto(`/project/${proj.id}/chat/${conv.id}`);
			await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

			await sendAndWaitForStream(page, "Check order");

			await emitSse({ type: "run:token", data: { runId: "run-stream", token: "BEFORE_TOOL" } });
			await emitSse({
				type: "tool:start",
				data: { conversationId: "conv-1", toolName: "test_tool", input: {}, timestamp: Date.now() },
			});
			await emitSse({
				type: "tool:complete",
				data: { conversationId: "conv-1", toolName: "test_tool", output: "ok", duration: 10, success: true },
			});
			await emitSse({ type: "run:token", data: { runId: "run-stream", token: "AFTER_TOOL" } });

			// Wait for all content to render
			await expect(page.getByText("BEFORE_TOOL")).toBeVisible({ timeout: 5000 });
			await expect(page.getByText("AFTER_TOOL")).toBeVisible({ timeout: 5000 });

			// Verify DOM order by checking bounding box Y positions
			const beforeBox = await page.getByText("BEFORE_TOOL").boundingBox();
			const toolCard = page.locator("button").filter({ hasText: "test_tool" });
			const toolBox = await toolCard.boundingBox();
			const afterBox = await page.getByText("AFTER_TOOL").boundingBox();

			expect(beforeBox).toBeTruthy();
			expect(toolBox).toBeTruthy();
			expect(afterBox).toBeTruthy();

			// Vertical order: before < tool < after
			expect(beforeBox!.y).toBeLessThan(toolBox!.y);
			expect(toolBox!.y).toBeLessThan(afterBox!.y);
		});
	});
});
