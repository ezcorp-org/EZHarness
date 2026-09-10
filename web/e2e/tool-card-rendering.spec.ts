import type { Page } from "@playwright/test";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { sendComposerMessage } from "./fixtures/composer.js";
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
	async function setupStreaming(page: Page, mockApi: (overrides?: MockOverrides) => Promise<void>, emitSse: (event: { type: string; data: unknown }) => Promise<void>) {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await Promise.all([
			page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST"),
			sendComposerMessage(page, "Do something"),
		]);

		await emitSse({
			type: "run:token",
			data: { runId: "run-stream", token: "Working..." },
		});
	}

	test("TerminalCard renders shell output", async ({ page, mockApi, emitSse }) => {
		await setupStreaming(page, mockApi, emitSse);

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "Bash",
				input: { command: "echo hello world" },
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "Bash",
				output: "hello world",
				duration: 120,
				success: true,
				cardType: "terminal",
			},
		});

		// Bash renders inside the collapse shell, collapsed by default —
		// expand it before asserting the TerminalCard body.
		const toggle = page.getByTestId("collapsible-card-toggle");
		await expect(toggle).toBeVisible();
		await toggle.click();

		// Phase 61-02: Swap `.bg-gray-900` strict-mode-collision-prone locator
		// for per-variant testid added to TerminalCard.svelte root container.
		const terminalCard = page.getByTestId("tool-card-terminal");
		await expect(terminalCard).toBeVisible();
		// Verify monospace command display with $ prompt
		await expect(terminalCard.getByText("echo hello world", { exact: true })).toBeVisible();
		// Verify output rendered
		await expect(page.getByTestId("tool-card-terminal").getByText("hello world", { exact: true })).toBeVisible();
	});

	test("TerminalCard shows kill button while running", async ({ page, mockApi, emitSse }) => {
		await setupStreaming(page, mockApi, emitSse);

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "Bash",
				input: { command: "sleep 60" },
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});

		// No tool:complete — still running. The dev-command card stays
		// collapsed even while running; the collapsed header shows the
		// spinner + "Running…" so progress is still signalled.
		const toggle = page.getByTestId("collapsible-card-toggle");
		await expect(toggle).toBeVisible();
		await expect(page.getByText("Running…")).toBeVisible();

		// Expand to reach the Kill button inside the TerminalCard body.
		await toggle.click();
		await expect(page.getByRole("button", { name: "Kill process" })).toBeVisible();
	});

	test("DiffCard renders diff view", async ({ page, mockApi, emitSse }) => {
		await setupStreaming(page, mockApi, emitSse);

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "Edit",
				input: { file_path: "/src/index.ts" },
				timestamp: Date.now(),
				cardType: "diff",
			},
		});

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
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

		// Edit/Write diffs render inside the collapse shell, collapsed by
		// default — expand it before asserting the DiffCard body.
		const toggle = page.getByTestId("collapsible-card-toggle");
		await expect(toggle).toBeVisible();
		await toggle.click();

		// Verify file path is displayed
		await expect(page.getByTestId("tool-card-diff").getByRole("button", { name: "/src/index.ts Copy output" })).toBeVisible();
		// Verify diff rendering appears (d2h classes or diff content)
		await expect(page.locator(".d2h-wrapper, .diff-card-content").first()).toBeVisible();
	});

	test("SearchResultsCard renders grep results", async ({ page, mockApi, emitSse }) => {
		await setupStreaming(page, mockApi, emitSse);

		const grepOutput = "src/app.ts:10:import { foo } from 'bar';\nsrc/app.ts:25:foo();\nsrc/utils.ts:3:export function foo() {}";

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "grep",
				input: { pattern: "foo" },
				timestamp: Date.now(),
				cardType: "search-results",
			},
		});

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "grep",
				output: grepOutput,
				duration: 50,
				success: true,
				cardType: "search-results",
			},
		});

		// grep results render inside the collapse shell, collapsed by
		// default — expand it before asserting the SearchResultsCard body.
		const toggle = page.getByTestId("collapsible-card-toggle");
		await expect(toggle).toBeVisible();
		await toggle.click();

		// Verify file paths appear
		await expect(page.getByText("src/app.ts")).toBeVisible();
		await expect(page.getByText("src/utils.ts")).toBeVisible();
		// Verify line numbers appear
		await expect(page.getByText("10")).toBeVisible();
		// Verify match count
		await expect(page.getByText("3 matches")).toBeVisible();
	});

	test("SearchResultsCard renders glob results @evidence", async ({ page, mockApi, emitSse }, testInfo) => {
		await setupStreaming(page, mockApi, emitSse);

		const globOutput = "src/index.ts\nsrc/utils.ts\nsrc/app.ts";

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "glob",
				input: { pattern: "src/**/*.ts" },
				timestamp: Date.now(),
				cardType: "search-results",
			},
		});

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "glob",
				output: globOutput,
				duration: 30,
				success: true,
				cardType: "search-results",
			},
		});

		// glob results render inside the collapse shell, collapsed by
		// default — expand it before asserting the SearchResultsCard body.
		const toggle = page.getByTestId("collapsible-card-toggle");
		await expect(toggle).toBeVisible();
		await toggle.click();

		// Verify file paths listed
		await expect(page.getByText("src/index.ts")).toBeVisible();
		await expect(page.getByText("src/utils.ts")).toBeVisible();
		await expect(page.getByText("src/app.ts")).toBeVisible();
		// Verify file count
		await expect(page.getByTestId("tool-card-search-results").getByText("3 files", { exact: true })).toBeVisible();
		await captureEvidence(page, testInfo, "glob-results-count");
	});

	test("DefaultCard renders for unknown cardType", async ({ page, mockApi, emitSse }) => {
		await setupStreaming(page, mockApi, emitSse);

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "some-unknown-tool",
				input: { query: "test" },
				timestamp: Date.now(),
				// no cardType
			},
		});

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
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

	test("tool:complete with success:false renders the red X (no green checkmark)", async ({ page, mockApi, emitSse }) => {
		// Regression guard: a runtime that finishes via `tool:complete` but signals
		// failure with `success: false` MUST surface as the red X status icon, not
		// a green checkmark. The fix lives in stores.svelte.ts's `tool:complete`
		// handler — this test pins the user-visible contract end-to-end.
		await setupStreaming(page, mockApi, emitSse);

		const toolCallId = "tc-failing";
		await emitSse({
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

		await emitSse({
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
		await expect(page.locator("pre").filter({ hasText: "command failed: exit 1" })).toBeVisible();
	});

	test("PermissionGate renders for permission request", async ({ page, mockApi, emitSse }) => {
		await setupStreaming(page, mockApi, emitSse);

		await emitSse({
			type: "tool:start",
			data: { conversationId: "conv-1", invocationId: "inv-card", toolName: "Bash", input: { command: "rm -rf /tmp/test" }, cardType: "terminal" },
		});

		await emitSse({
			type: "tool:permission_request",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
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

	test("TaskDetailCard renders task", async ({ page, mockApi, emitSse }) => {
		await setupStreaming(page, mockApi, emitSse);

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				extensionId: "ext-task-stack",
				toolName: "task-stack.add-task",
				input: { title: "Migrate DB" },
				timestamp: Date.now(),
				cardType: "task-detail",
			},
		});

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
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

	test("TaskListCard renders task list", async ({ page, mockApi, emitSse }) => {
		await setupStreaming(page, mockApi, emitSse);

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				extensionId: "ext-task-stack",
				toolName: "task-stack.list-tasks",
				input: {},
				timestamp: Date.now(),
				cardType: "task-list",
			},
		});

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
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

	test("CopyButton exists on cards with output", async ({ page, mockApi, emitSse }) => {
		await setupStreaming(page, mockApi, emitSse);

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "Bash",
				input: { command: "echo copytest" },
				timestamp: Date.now(),
				cardType: "terminal",
			},
		});

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				invocationId: "inv-card",
				toolName: "Bash",
				output: "copytest output",
				duration: 50,
				success: true,
				cardType: "terminal",
			},
		});

		// Bash is a dev-command card: it now renders inside the collapse
		// shell, collapsed by default. The CopyButton lives in the
		// TerminalCard body, so expand the shell before asserting it.
		const toggle = page.getByTestId("collapsible-card-toggle");
		await expect(toggle).toBeVisible();
		await toggle.click();

		// Verify copy button exists (CopyButton renders a button with copy-related aria)
		const copyButton = page.getByTestId("tool-card-terminal").getByRole("button", { name: "Copy output", exact: true });
		await expect(copyButton).toBeVisible();
	});

	test(
		"dev-command card (Bash) renders collapsed by default and expands on click",
		async ({ page, mockApi, emitSse }) => {
			await setupStreaming(page, mockApi, emitSse);

			await emitSse({
				type: "tool:start",
				data: {
					conversationId: "conv-1",
				invocationId: "inv-card",
					toolName: "Bash",
					input: { command: "echo hello world" },
					timestamp: Date.now(),
					cardType: "terminal",
				},
			});

			await emitSse({
				type: "tool:complete",
				data: {
					conversationId: "conv-1",
				invocationId: "inv-card",
					toolName: "Bash",
					output: "hello world",
					duration: 120,
					success: true,
					cardType: "terminal",
				},
			});

			// Collapsed-by-default: the shell is present but the
			// TerminalCard body is NOT mounted until the user expands it.
			const shell = page.getByTestId("collapsible-card");
			await expect(shell).toBeVisible();
			await expect(page.getByTestId("tool-card-terminal")).toHaveCount(0);
			// The collapsed header still identifies the call, and the FULL
			// command is shown verbatim in the always-visible code block.
			await expect(page.getByText("Bash")).toBeVisible();
			await expect(page.getByTestId("collapsible-card-command")).toHaveText(
				"echo hello world",
			);

			// Expand → TerminalCard body + its output are revealed; the
			// command code block stays, still matching the command used.
			await page.getByTestId("collapsible-card-toggle").click();
			await expect(page.getByTestId("tool-card-terminal")).toBeVisible();
			await expect(page.getByTestId("tool-card-terminal").getByText("hello world", { exact: true })).toBeVisible();
			await expect(page.getByTestId("collapsible-card-command")).toHaveText(
				"echo hello world",
			);
		},
	);

	test(
		"grep search-results card renders collapsed by default and expands on click",
		async ({ page, mockApi, emitSse }) => {
			await setupStreaming(page, mockApi, emitSse);

			const grepOutput = "src/app.ts:10:import { foo } from 'bar';\nsrc/utils.ts:3:export function foo() {}";

			await emitSse({
				type: "tool:start",
				data: {
					conversationId: "conv-1",
				invocationId: "inv-card",
					toolName: "grep",
					input: { pattern: "foo" },
					timestamp: Date.now(),
					cardType: "search-results",
				},
			});

			await emitSse({
				type: "tool:complete",
				data: {
					conversationId: "conv-1",
				invocationId: "inv-card",
					toolName: "grep",
					output: grepOutput,
					duration: 50,
					success: true,
					cardType: "search-results",
				},
			});

			const shell = page.getByTestId("collapsible-card");
			await expect(shell).toBeVisible();
			await expect(page.getByTestId("tool-card-search-results")).toHaveCount(0);
			// Collapsed header surfaces the tool name; the searched pattern
			// is shown verbatim in the always-visible command code block.
			await expect(page.getByText("grep")).toBeVisible();
			await expect(page.getByTestId("collapsible-card-command")).toHaveText("foo");

			await page.getByTestId("collapsible-card-toggle").click();
			await expect(page.getByTestId("tool-card-search-results")).toBeVisible();
			await expect(page.getByText("src/app.ts")).toBeVisible();
			await expect(page.getByTestId("collapsible-card-command")).toHaveText("foo");
		},
	);
});
