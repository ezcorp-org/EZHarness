import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

// ─── Streaming Indicators ────────────────────────────────────────────

test.describe("Streaming Indicators", () => {
	test("skeleton loader appears while waiting for tokens", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Hello");
		await page.getByRole("button", { name: "Send message" }).click();

		// Before any tokens arrive, the skeleton shimmer lines should be visible
		await expect(page.locator(".skeleton-line").first()).toBeVisible({ timeout: 5000 });
	});

	test("skeleton transitions to streamed content", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Tell me something");
		await page.getByRole("button", { name: "Send message" }).click();

		// Wait for skeleton to appear first
		await expect(page.locator(".skeleton-line").first()).toBeVisible({ timeout: 5000 });

		// Emit streaming tokens
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Here is " } });
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "the answer" } });

		// Skeleton should disappear, streamed text should appear
		await expect(page.locator(".skeleton-line")).not.toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Here is the answer")).toBeVisible({ timeout: 5000 });
	});

	test("tool call card appears on tool:start", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		// Send a message to initiate streaming (sets up streamingRunToConversation mapping)
		const textarea = page.locator("textarea");
		await textarea.fill("Search for something");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Search for something")).toBeVisible({ timeout: 5000 });

		// Emit a token to ensure stream is active
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Searching..." } });

		// Emit tool:start
		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "search",
				input: { query: "test" },
				timestamp: Date.now(),
			},
		});

		// Tool card should appear with the tool name and a spinner (animate-spin)
		await expect(page.getByText("search")).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".animate-spin")).toBeVisible({ timeout: 5000 });
	});

	test("tool call card shows complete state with checkmark", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Do a search");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Do a search")).toBeVisible({ timeout: 5000 });

		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Working..." } });

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "search",
				input: { query: "test" },
				timestamp: Date.now(),
			},
		});

		// Wait for spinner to confirm running state
		await expect(page.locator(".animate-spin")).toBeVisible({ timeout: 5000 });

		// Complete the tool call
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "search",
				output: "results here",
				duration: 150,
				success: true,
			},
		});

		// Spinner should be gone, green checkmark (text-green-500) should appear
		await expect(page.locator(".animate-spin")).not.toBeVisible({ timeout: 5000 });
		await expect(page.locator(".text-green-500")).toBeVisible({ timeout: 5000 });
	});

	test("tool call card shows error state", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Try something");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Try something")).toBeVisible({ timeout: 5000 });

		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Attempting..." } });

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "file_read",
				input: { path: "/etc/missing" },
				timestamp: Date.now(),
			},
		});

		await expect(page.locator(".animate-spin")).toBeVisible({ timeout: 5000 });

		// Error the tool call
		await emitSse({
			type: "tool:error",
			data: {
				conversationId: "conv-1",
				toolName: "file_read",
				error: "File not found",
				duration: 50,
			},
		});

		// Spinner gone, red error icon (text-red-500) should appear
		await expect(page.locator(".animate-spin")).not.toBeVisible({ timeout: 5000 });
		await expect(page.locator(".text-red-500")).toBeVisible({ timeout: 5000 });
	});

	test("tool call card expands on click to show details", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Lookup data");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Lookup data")).toBeVisible({ timeout: 5000 });

		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Looking up..." } });

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "db_query",
				input: { sql: "SELECT * FROM users" },
				timestamp: Date.now(),
			},
		});
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "db_query",
				output: { rows: [{ id: 1, name: "Alice" }] },
				duration: 200,
				success: true,
			},
		});

		// The card button should have aria-expanded=false initially
		const toolButton = page.locator('button[aria-expanded="false"]').filter({ hasText: "db_query" });
		await expect(toolButton).toBeVisible({ timeout: 5000 });

		// Click to expand
		await toolButton.click();

		// After expansion, the Input and Output sections should be visible
		await expect(page.getByText("Input")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Output")).toBeVisible({ timeout: 5000 });
		// Check that actual content is shown
		await expect(page.getByText("SELECT * FROM users")).toBeVisible();
		await expect(page.getByText("Alice")).toBeVisible();
	});

	test("multiple tool calls stack as separate cards", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Do multiple things");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Do multiple things")).toBeVisible({ timeout: 5000 });

		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Processing..." } });

		// Emit two tool:start events for different tools
		await emitSse({
			type: "tool:start",
			data: { conversationId: "conv-1", toolName: "search", input: { q: "a" }, timestamp: Date.now() },
		});
		await emitSse({
			type: "tool:start",
			data: { conversationId: "conv-1", toolName: "file_read", input: { path: "/x" }, timestamp: Date.now() },
		});

		// Both tool names should appear as separate cards
		await expect(page.getByText("search")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("file_read")).toBeVisible({ timeout: 5000 });

		// There should be at least 2 spinner icons (one per running card)
		await expect(page.locator(".animate-spin")).toHaveCount(2, { timeout: 5000 });
	});
});

// ─── Message Toolbar ─────────────────────────────────────────────────

test.describe("Message Toolbar", () => {
	const userMsg = makeMessage({
		id: "msg-u1",
		conversationId: "conv-1",
		role: "user",
		content: "Hello from the user",
	});
	const assistantMsg = makeMessage({
		id: "msg-a1",
		conversationId: "conv-1",
		role: "assistant",
		content: "Hello from the assistant",
	});

	test("toolbar appears on user message hover with Copy, Edit, Branch buttons", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from the user")).toBeVisible({ timeout: 5000 });

		// Hover over the user message container (has class "group")
		const messageRow = page.locator(".group").filter({ hasText: "Hello from the user" });
		await messageRow.hover();

		// Toolbar buttons should become visible
		await expect(page.getByRole("button", { name: "Copy message" })).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("button", { name: "Edit message" })).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("button", { name: "Branch from here" })).toBeVisible({ timeout: 3000 });
	});

	test("toolbar appears on assistant message hover with Copy, Regenerate, Branch buttons", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from the assistant")).toBeVisible({ timeout: 5000 });

		const messageRow = page.locator(".group").filter({ hasText: "Hello from the assistant" });
		await messageRow.hover();

		await expect(page.getByRole("button", { name: "Copy message" })).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("button", { name: "Regenerate response" })).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("button", { name: "Branch from here" })).toBeVisible({ timeout: 3000 });
	});

	test("copy button shows visual feedback when clicked", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from the user")).toBeVisible({ timeout: 5000 });

		const messageRow = page.locator(".group").filter({ hasText: "Hello from the user" });
		await messageRow.hover();

		// Grant clipboard permissions so the copy succeeds
		await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

		const copyBtn = page.getByRole("button", { name: "Copy message" });
		await copyBtn.click();

		// After clicking, the button label should change to "Copied!"
		await expect(page.getByRole("button", { name: "Copied!" })).toBeVisible({ timeout: 3000 });
	});

	test("toolbar is not shown on the streaming message", async ({ page, mockApi, emitSse }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		const textarea = page.locator("textarea");
		await textarea.fill("Stream this");
		await page.getByRole("button", { name: "Send message" }).click();
		await expect(page.getByText("Stream this")).toBeVisible({ timeout: 5000 });

		// Keep streaming active
		await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Streaming content" } });
		await expect(page.getByText("Streaming content")).toBeVisible({ timeout: 5000 });

		// The streaming assistant message area should not have Copy/Regenerate buttons
		// even when hovering over it (because isStreaming hides the toolbar)
		const streamingMsg = page.locator(".group").filter({ hasText: "Streaming content" });
		await streamingMsg.hover();

		// Toolbar buttons should NOT be visible
		await expect(page.getByRole("button", { name: "Copy message" })).not.toBeVisible({ timeout: 2000 });
		await expect(page.getByRole("button", { name: "Regenerate response" })).not.toBeVisible({ timeout: 2000 });
	});

	test("edit action on user message opens inline edit UI", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Hello from the user")).toBeVisible({ timeout: 5000 });

		const messageRow = page.locator(".group").filter({ hasText: "Hello from the user" });
		await messageRow.hover();

		await page.getByRole("button", { name: "Edit message" }).click();

		// The inline edit UI should appear with a textarea pre-filled with the message
		// and Save & Submit / Cancel buttons
		await expect(page.getByRole("button", { name: "Save & Submit" })).toBeVisible({ timeout: 3000 });
		await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible({ timeout: 3000 });

		// The textarea in the edit form should contain the original message content
		const editTextarea = page.locator("textarea").filter({ hasText: "Hello from the user" });
		await expect(editTextarea).toBeVisible({ timeout: 3000 });
	});
});

// ─── Keyboard Shortcuts ──────────────────────────────────────────────

test.describe("Keyboard Shortcuts", () => {
	test("Ctrl+/ opens the shortcut help panel", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Press Ctrl+/ (Control on Linux/Windows, maps to meta in matchShortcut)
		await page.keyboard.press("Control+/");

		// The ShortcutHelp modal should appear with the heading
		await expect(page.getByText("Keyboard Shortcuts")).toBeVisible({ timeout: 3000 });
	});

	test("help panel displays all default shortcuts", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.keyboard.press("Control+/");
		await expect(page.getByText("Keyboard Shortcuts")).toBeVisible({ timeout: 3000 });

		// Verify all four default shortcut labels are listed
		await expect(page.getByText("Open command palette")).toBeVisible();
		await expect(page.getByText("New conversation")).toBeVisible();
		await expect(page.getByText("Show keyboard shortcuts")).toBeVisible();
		await expect(page.getByText("Toggle sidebar")).toBeVisible();
	});

	test("help panel closes on Escape", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.keyboard.press("Control+/");
		await expect(page.getByText("Keyboard Shortcuts")).toBeVisible({ timeout: 3000 });

		// Press Escape to close
		await page.keyboard.press("Escape");

		await expect(page.getByText("Keyboard Shortcuts")).not.toBeVisible({ timeout: 3000 });
	});

	test("Ctrl+N creates a new conversation", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Wait for the page to load and store.activeProjectId to be set
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible({ timeout: 5000 });

		// Listen for the POST /api/conversations request
		const createPromise = page.waitForRequest(
			(req) => req.url().includes("/api/conversations") && req.method() === "POST"
		);

		await page.keyboard.press("Control+n");

		// Verify the API call to create a new conversation was made
		const createReq = await createPromise;
		expect(createReq.method()).toBe("POST");

		// The request body should include the active project's ID
		const body = createReq.postDataJSON();
		expect(body.projectId).toBe("proj-1");
	});
});
