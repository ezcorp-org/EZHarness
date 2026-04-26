import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Tool Card Rendering", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Chat" });
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
		content: "Sure!",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	/** Navigate to chat, send a message, and emit run:token to set up streaming */
	async function setupStreaming(page: any, mockApi: any, emitWs: any) {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea");
		await textarea.fill("Do something");
		await textarea.press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "Working..." },
		});
	}

	test("TerminalCard renders shell output", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "Bash",
				input: { command: "echo hello world" },
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "Bash",
				output: "hello world",
				duration: 120,
				success: true,
				cardType: "terminal",
			},
		});

		// Verify dark terminal background (bg-gray-900)
		const terminalCard = page.locator(".bg-gray-900");
		await expect(terminalCard).toBeVisible();
		// Verify monospace command display with $ prompt
		await expect(page.getByText("echo hello world")).toBeVisible();
		// Verify output rendered
		await expect(page.getByText("hello world")).toBeVisible();
	});

	test("TerminalCard shows kill button while running", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "Bash",
				input: { command: "sleep 60" },
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});

		// No tool:complete — still running
		// Verify kill button is visible
		await expect(page.getByRole("button", { name: "Kill process" })).toBeVisible();
	});

	test("DiffCard renders diff view", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "Edit",
				input: { file_path: "/src/index.ts" },
				timestamp: Date.now(),
				cardType: "diff",
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "Edit",
				output: {
					oldContent: "const x = 1;",
					newContent: "const x = 2;",
				},
				duration: 80,
				success: true,
				cardType: "diff",
			},
		});

		// Verify file path is displayed
		await expect(page.getByText("/src/index.ts")).toBeVisible();
		// Verify diff rendering appears (d2h classes or diff content)
		await expect(page.locator(".d2h-wrapper, .diff-card-content").first()).toBeVisible();
	});

	test("SearchResultsCard renders grep results", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		const grepOutput = "src/app.ts:10:import { foo } from 'bar';\nsrc/app.ts:25:foo();\nsrc/utils.ts:3:export function foo() {}";

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "grep",
				input: { pattern: "foo" },
				timestamp: Date.now(),
				cardType: "search-results",
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "grep",
				output: grepOutput,
				duration: 50,
				success: true,
				cardType: "search-results",
			},
		});

		// Verify file paths appear
		await expect(page.getByText("src/app.ts")).toBeVisible();
		await expect(page.getByText("src/utils.ts")).toBeVisible();
		// Verify line numbers appear
		await expect(page.getByText("10")).toBeVisible();
		// Verify match count
		await expect(page.getByText("3 matches")).toBeVisible();
	});

	test("SearchResultsCard renders glob results", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		const globOutput = "src/index.ts\nsrc/utils.ts\nsrc/app.ts";

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "glob",
				input: { pattern: "src/**/*.ts" },
				timestamp: Date.now(),
				cardType: "search-results",
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "glob",
				output: globOutput,
				duration: 30,
				success: true,
				cardType: "search-results",
			},
		});

		// Verify file paths listed
		await expect(page.getByText("src/index.ts")).toBeVisible();
		await expect(page.getByText("src/utils.ts")).toBeVisible();
		await expect(page.getByText("src/app.ts")).toBeVisible();
		// Verify file count
		await expect(page.getByText("3 files")).toBeVisible();
	});

	test("DefaultCard renders for unknown cardType", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "some-unknown-tool",
				input: { query: "test" },
				timestamp: Date.now(),
				// no cardType
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "some-unknown-tool",
				output: "some result",
				duration: 40,
				success: true,
				// no cardType
			},
		});

		// DefaultCard shows the tool name
		await expect(page.getByText("some-unknown-tool")).toBeVisible();
	});

	test("tool:complete with success:false renders the red X (no green checkmark)", async ({ page, mockApi, emitWs }) => {
		// Regression guard: a runtime that finishes via `tool:complete` but signals
		// failure with `success: false` MUST surface as the red X status icon, not
		// a green checkmark. The fix lives in stores.svelte.ts's `tool:complete`
		// handler — this test pins the user-visible contract end-to-end.
		await setupStreaming(page, mockApi, emitWs);

		const toolCallId = "tc-failing";
		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "failing-tool",
				input: { query: "boom" },
				timestamp: Date.now(),
				invocationId: toolCallId,
				// no cardType — falls through to the basic ToolCallCard body
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "failing-tool",
				output: "command failed: exit 1",
				duration: 30,
				success: false,
				invocationId: toolCallId,
			},
		});

		// The card must show the tool name
		const toolName = page.getByText("failing-tool");
		await expect(toolName).toBeVisible();

		// Locate the card root (closest button — the collapsed header)
		const headerBtn = toolName.locator("xpath=ancestor::button[1]");
		await expect(headerBtn).toBeVisible();

		// The red-X status icon must be present
		const errorIcon = headerBtn.locator("svg.text-red-500").first();
		await expect(errorIcon).toBeVisible();

		// And the green checkmark must NOT be present on this card
		const greenCheck = headerBtn.locator("svg.text-green-500");
		await expect(greenCheck).toHaveCount(0);

		// Expanding reveals the error block with the failure text
		await headerBtn.click();
		await expect(page.getByText("command failed: exit 1")).toBeVisible();
	});

	test("PermissionGate renders for permission request", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		await emitWs({
			type: "tool:permission_request",
			data: {
				conversationId: "conv-1",
				toolCallId: "tc-perm-1",
				toolName: "Bash",
				input: { command: "rm -rf /tmp/test" },
				cardType: "terminal",
				category: "execute",
			},
		});

		// Verify tool name visible
		await expect(page.getByText("Bash")).toBeVisible();
		// Verify Allow/Deny buttons
		await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Deny" })).toBeVisible();
		// Verify security note for execute category
		await expect(page.getByText("This tool will run a shell command")).toBeVisible();
	});

	test("TaskDetailCard renders task", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.add-task",
				input: { title: "Migrate DB" },
				timestamp: Date.now(),
				cardType: "task-detail",
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.add-task",
				output: { content: [{ type: "text", text: JSON.stringify({
					id: "t-1",
					title: "Migrate DB",
					status: "pending",
					dueDate: "2026-05-01",
				}) }] },
				duration: 60,
				success: true,
				cardType: "task-detail",
			},
		});

		// Verify title
		await expect(page.getByText("Migrate DB")).toBeVisible();
		// Verify status badge
		await expect(page.getByText("Pending")).toBeVisible();
		// Verify due date
		await expect(page.getByText("Due: 2026-05-01")).toBeVisible();
	});

	test("TaskListCard renders task list", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.list-tasks",
				input: {},
				timestamp: Date.now(),
				cardType: "task-list",
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.list-tasks",
				output: { content: [{ type: "text", text: JSON.stringify([
					{ id: "t-1", title: "Setup DB", status: "completed" },
					{ id: "t-2", title: "Build API", status: "active" },
					{ id: "t-3", title: "Deploy", status: "pending" },
				]) }] },
				duration: 25,
				success: true,
				cardType: "task-list",
			},
		});

		// Verify list items
		await expect(page.getByText("Setup DB")).toBeVisible();
		await expect(page.getByText("Build API")).toBeVisible();
		await expect(page.getByText("Deploy")).toBeVisible();
		// Verify item count
		await expect(page.getByText("3 tasks")).toBeVisible();
	});

	test("CopyButton exists on cards with output", async ({ page, mockApi, emitWs }) => {
		await setupStreaming(page, mockApi, emitWs);

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				toolName: "Bash",
				input: { command: "echo copytest" },
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				toolName: "Bash",
				output: "copytest output",
				duration: 50,
				success: true,
				cardType: "terminal",
			},
		});

		// Verify copy button exists (CopyButton renders a button with copy-related aria)
		const copyButton = page.getByRole("button", { name: /copy/i });
		await expect(copyButton).toBeVisible();
	});
});
