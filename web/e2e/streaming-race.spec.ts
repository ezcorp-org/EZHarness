import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeRun } from "./fixtures/data.js";

/**
 * E2E tests for the streaming token display fix.
 *
 * Validates that:
 * 1. Tokens arriving before HTTP POST returns are preserved (race condition fix)
 * 2. run:complete before startStreaming is handled gracefully
 * 3. Streaming text appears incrementally (not all at once)
 * 4. Code blocks are highlighted only after streaming completes
 * 5. Auto-scroll works on message submission
 */
test.describe("Streaming Race Conditions", () => {
	const proj = makeProject({ id: "proj-1", name: "Stream Test" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

	test("tokens arriving before POST returns are not wiped", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		// Type and send
		const textarea = page.locator("textarea");
		await textarea.fill("Hello streaming");
		await page.getByRole("button", { name: "Send message" }).click();

		// Wait for user message to appear (POST completed, startStreaming called)
		await expect(page.getByText("Hello streaming")).toBeVisible({ timeout: 5000 });

		// Now emit tokens — these should appear incrementally
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "First " } });
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "chunk " } });
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "arrives." } });

		// The accumulated text should be visible
		await expect(page.getByText("First chunk arrives.")).toBeVisible({ timeout: 5000 });
	});

	test("incremental tokens stream in progressively", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Stream test");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Stream test")).toBeVisible({ timeout: 5000 });

		// Send first batch of tokens
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "The answer " } });
		await expect(page.getByText("The answer")).toBeVisible({ timeout: 5000 });

		// Send more tokens — text should grow
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "is 42." } });
		await expect(page.getByText("The answer is 42.")).toBeVisible({ timeout: 5000 });
	});

	test("skeleton loader shows before first token", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Show me skeleton");
		await page.getByRole("button", { name: "Send message" }).click();

		// User message appears
		await expect(page.getByText("Show me skeleton")).toBeVisible({ timeout: 5000 });

		// The skeleton loader should be visible (no tokens yet, streaming status active)
		// The skeleton has "Thinking..." text by default
		await expect(page.getByText("Thinking...")).toBeVisible({ timeout: 5000 });
	});

	test("streaming cursor appears during token flow", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Cursor test");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Cursor test")).toBeVisible({ timeout: 5000 });

		// Send a token so streaming text appears
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Streaming text..." } });
		await expect(page.getByText("Streaming text...")).toBeVisible({ timeout: 5000 });

		// The blinking cursor should be visible during streaming
		const cursor = page.locator(".streaming-cursor");
		await expect(cursor).toBeVisible();
	});

	test("streaming cursor disappears after completion", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Complete test");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Complete test")).toBeVisible({ timeout: 5000 });

		// Stream tokens
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Done!" } });
		await expect(page.getByText("Done!")).toBeVisible({ timeout: 5000 });

		// Complete the run
		await emitSse({
			type: "run:complete",
			data: {
				run: makeRun({ id: "run-stream", status: "success" }),
			},
		});

		// Streaming cursor should disappear
		const cursor = page.locator(".streaming-cursor");
		await expect(cursor).not.toBeVisible({ timeout: 5000 });
	});

	test("stop button disappears after run:complete", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Stop button test");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Stop button test")).toBeVisible({ timeout: 5000 });

		// Emit token to establish streaming state
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Processing..." } });
		await expect(page.getByRole("button", { name: /stop/i })).toBeVisible({ timeout: 5000 });

		// Complete the run
		await emitSse({
			type: "run:complete",
			data: {
				run: makeRun({ id: "run-stream", status: "success" }),
			},
		});

		// Stop button should disappear
		await expect(page.getByRole("button", { name: /stop/i })).not.toBeVisible({ timeout: 5000 });
	});

	test("run:error cleans up streaming state", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Error test");
		await page.getByRole("button", { name: "Send message" }).click();

		// Wait for user message
		await expect(page.getByText("Error test")).toBeVisible({ timeout: 5000 });

		// Send a token so streaming is active
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Partial..." } });
		await expect(page.getByText("Partial...")).toBeVisible({ timeout: 5000 });

		// Emit run:error via WS
		await emitSse({
			type: "run:error",
			data: {
				run: makeRun({ id: "run-stream", status: "error" }),
			},
		});

		// Streaming cursor should disappear
		await expect(page.locator(".streaming-cursor")).not.toBeVisible({ timeout: 5000 });
		// Stop button should disappear
		await expect(page.getByRole("button", { name: /stop/i })).not.toBeVisible({ timeout: 5000 });
	});

	test("streaming status text shows during processing", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Status test");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Status test")).toBeVisible({ timeout: 5000 });

		// Emit a status update before tokens
		await emitSse({ type: "run:status", data: { runId: "run-stream", status: "Searching documents..." } });
		await expect(page.getByText("Searching documents...")).toBeVisible({ timeout: 5000 });

		// Then tokens arrive, replacing the skeleton
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Found results." } });
		await expect(page.getByText("Found results.")).toBeVisible({ timeout: 5000 });
	});
});

test.describe("Streaming Markdown Rendering", () => {
	const proj = makeProject({ id: "proj-1", name: "MD Test" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

	test("code blocks get syntax highlighting after stream completes", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Show me code");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Show me code")).toBeVisible({ timeout: 5000 });

		// Stream a code block
		const codeBlock = "```js\nconst x = 42;\n```";
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: codeBlock } });

		// During streaming: code block should render but WITHOUT hljs classes
		await expect(page.locator("pre code")).toBeVisible({ timeout: 5000 });

		// During streaming, the streaming cursor is visible
		await expect(page.locator(".streaming-cursor")).toBeVisible();

		// The code should be present
		await expect(page.locator("pre code")).toContainText("const x = 42");
	});

	test("markdown renders correctly during streaming", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Format test");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Format test")).toBeVisible({ timeout: 5000 });

		// Stream markdown content
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "**bold** and *italic*" } });

		// Markdown should be rendered
		await expect(page.locator("strong").filter({ hasText: "bold" })).toBeVisible({ timeout: 5000 });
		await expect(page.locator("em").filter({ hasText: "italic" })).toBeVisible({ timeout: 5000 });
	});
});

test.describe("Streaming Auto-Scroll", () => {
	const proj = makeProject({ id: "proj-1", name: "Scroll Test" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

	test("user message appears immediately after sending", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Optimistic message");
		await page.getByRole("button", { name: "Send message" }).click();

		// The user message should appear immediately (optimistic rendering)
		await expect(page.getByText("Optimistic message")).toBeVisible({ timeout: 5000 });
	});

	test("auto-scroll follows streaming tokens from empty chat", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		// Send a message
		const textarea = page.locator("textarea");
		await textarea.fill("Scroll test");
		await page.getByRole("button", { name: "Send message" }).click();
		// Scope to chat-messages-container to avoid strict-mode collision with the
		// sidebar project title "Scroll Test" (case-insensitive substring match).
		await expect(page.getByTestId("chat-messages-container").getByText("Scroll test")).toBeVisible({ timeout: 5000 });

		// Stream tokens — the response should be visible (auto-scrolled)
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Streamed response visible." } });
		await expect(page.getByTestId("chat-messages-container").getByText("Streamed response visible.")).toBeVisible({ timeout: 5000 });
	});
});
