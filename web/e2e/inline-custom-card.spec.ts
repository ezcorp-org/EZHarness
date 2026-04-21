import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Inline Tool Custom Card Rendering", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Chat" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Hello",
	});

	/**
	 * Helper: add an inline tool call to the store via page.evaluate,
	 * then emit WS events with matching invocationId.
	 */
	async function invokeInlineTool(
		page: any,
		emitWs: any,
		opts: {
			invocationId: string;
			extensionName: string;
			toolName: string;
			input: Record<string, unknown>;
			output: unknown;
			cardType?: string;
			conversationId?: string;
		},
	) {
		const convId = opts.conversationId ?? "conv-1";

		// Step 1: Add entry to inlineToolStore (simulates what handleToolInvoke does)
		await page.evaluate(
			({ id, extensionName, toolName, input, conversationId }: any) => {
				// Access the store via the module - it's a singleton
				const event = new CustomEvent("__test_add_inline_tool", {
					detail: { id, extensionName, toolName, input, conversationId },
				});
				window.dispatchEvent(event);
			},
			{
				id: opts.invocationId,
				extensionName: opts.extensionName,
				toolName: opts.toolName,
				input: opts.input,
				conversationId: convId,
			},
		);

		// Step 2: Emit tool:start via WS
		await emitWs({
			type: "tool:start",
			data: {
				conversationId: convId,
				extensionId: opts.extensionName,
				toolName: opts.toolName,
				input: opts.input,
				timestamp: Date.now(),
				source: "inline",
				invocationId: opts.invocationId,
				...(opts.cardType ? { cardType: opts.cardType } : {}),
			},
		});

		// Step 3: Emit tool:complete via WS
		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: convId,
				extensionId: opts.extensionName,
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

	test("inline tool with task-list cardType renders TaskListCard", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"tool-permission-mode": () => ({ mode: "ask" }),
			},
		});

		// Intercept tool-invoke to prevent actual execution
		await page.route("**/api/tool-invoke", async (route) => {
			await route.fulfill({ json: { success: true, output: "[]", durationMs: 50 } });
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		// Add inline tool store listener for tests
		await page.evaluate(() => {
			window.addEventListener("__test_add_inline_tool", ((e: CustomEvent) => {
				// Access the imported singleton — it should be available in module scope
				import("/src/lib/inline-tool-store.svelte.js").then((mod) => {
					mod.inlineToolStore.add(e.detail);
				}).catch(() => {
					// Fallback: try via window
					(window as any).__pendingInlineTools = (window as any).__pendingInlineTools ?? [];
					(window as any).__pendingInlineTools.push(e.detail);
				});
			}) as EventListener);
		});

		const tasks = [
			{ id: "t1", title: "Fix login bug", status: "pending", priority: 0 },
			{ id: "t2", title: "Add dark mode", status: "active", priority: 1 },
			{ id: "t3", title: "Write tests", status: "completed", priority: 2 },
		];

		await invokeInlineTool(page, emitWs, {
			invocationId: "inv-list-1",
			extensionName: "task-stack",
			toolName: "task-stack.list-tasks",
			input: {},
			cardType: "task-list",
			output: { content: [{ type: "text", text: JSON.stringify(tasks) }], isError: false },
		});

		// TaskListCard should show task titles
		await expect(page.getByText("Fix login bug")).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("Add dark mode")).toBeVisible();
		await expect(page.getByText("Write tests")).toBeVisible();
	});

	test("inline tool with task-detail cardType renders TaskDetailCard", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"tool-permission-mode": () => ({ mode: "ask" }),
			},
		});

		await page.route("**/api/tool-invoke", async (route) => {
			await route.fulfill({ json: { success: true } });
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		await page.evaluate(() => {
			window.addEventListener("__test_add_inline_tool", ((e: CustomEvent) => {
				import("/src/lib/inline-tool-store.svelte.js").then((mod) => {
					mod.inlineToolStore.add(e.detail);
				}).catch(() => {});
			}) as EventListener);
		});

		const task = {
			id: "t1",
			title: "Fix critical auth bug",
			status: "active",
			description: "Users getting logged out randomly",
			priority: 0,
			readyForAgent: true,
			dueDate: "2026-04-01",
		};

		await invokeInlineTool(page, emitWs, {
			invocationId: "inv-detail-1",
			extensionName: "task-stack",
			toolName: "task-stack.get-active-task",
			input: {},
			cardType: "task-detail",
			output: { content: [{ type: "text", text: JSON.stringify(task) }], isError: false },
		});

		// TaskDetailCard should show task details
		await expect(page.getByText("Fix critical auth bug")).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("agent-ready")).toBeVisible();
	});

	test("inline tool without cardType renders generic expandable card", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"tool-permission-mode": () => ({ mode: "ask" }),
			},
		});

		await page.route("**/api/tool-invoke", async (route) => {
			await route.fulfill({ json: { success: true } });
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		await page.evaluate(() => {
			window.addEventListener("__test_add_inline_tool", ((e: CustomEvent) => {
				import("/src/lib/inline-tool-store.svelte.js").then((mod) => {
					mod.inlineToolStore.add(e.detail);
				}).catch(() => {});
			}) as EventListener);
		});

		await invokeInlineTool(page, emitWs, {
			invocationId: "inv-generic-1",
			extensionName: "some-ext",
			toolName: "some-ext.do-thing",
			input: { query: "test" },
			output: { content: [{ type: "text", text: "done" }], isError: false },
			// No cardType — should render generic
		});

		// Generic card shows the summary line with tool name
		await expect(page.getByText(/some-ext.*do-thing/)).toBeVisible({ timeout: 3000 });
	});
});
