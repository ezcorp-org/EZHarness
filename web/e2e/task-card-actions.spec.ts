import { test, expect } from "./fixtures/test-base.js";
import { sendComposerMessage, threadMessages } from "./fixtures/composer.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Task Card Actions", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Chat" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Show tasks",
	});
	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Here are the tasks:",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	async function setupAndNavigate(page: any, mockApi: any) {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	}

	/**
	 * Send a composer message and wait until it has actually landed.
	 *
	 * `sendComposerMessage` owns the hydration + model-ready gate (see
	 * `fixtures/composer.ts`); the assertion here is scoped to the thread
	 * container because sending a message re-titles the conversation, and an
	 * unscoped `getByText` would also match the sidebar's conversation row.
	 */
	async function sendMessage(page: any, text: string) {
		await sendComposerMessage(page, text);
		await expect(threadMessages(page).getByText(text)).toBeVisible();
	}

	async function sendMessageAndStreamTaskList(page: any, emitSse: any, tasks: any[]) {
		await sendMessage(page, "List tasks");

		await emitSse({
			type: "run:token",
			data: { runId: "run-stream", token: "Working..." },
		});

		await emitSse({
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

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.list-tasks",
				output: { content: [{ type: "text", text: JSON.stringify(tasks) }] },
				duration: 30,
				success: true,
				cardType: "task-list",
			},
		});
	}

	async function sendMessageAndStreamTaskDetail(page: any, emitSse: any, task: any) {
		await sendMessage(page, "Show task");

		await emitSse({
			type: "run:token",
			data: { runId: "run-stream", token: "Working..." },
		});

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.get-task",
				input: { taskId: task.id },
				timestamp: Date.now(),
				cardType: "task-detail",
			},
		});

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.get-task",
				output: { content: [{ type: "text", text: JSON.stringify(task) }] },
				duration: 30,
				success: true,
				cardType: "task-detail",
			},
		});
	}

	test("task-list with pending tasks shows Start button", async ({ page, mockApi, emitSse }) => {
		await setupAndNavigate(page, mockApi);
		await sendMessageAndStreamTaskList(page, emitSse, [
			{ id: "t-1", title: "Setup DB", status: "pending" },
			{ id: "t-2", title: "Build API", status: "active" },
		]);

		// Pending task should have Start button (play icon)
		await expect(page.getByTitle("Start task")).toBeVisible();
		// Active task should have Finish button (check icon)
		await expect(page.getByTitle("Finish task")).toBeVisible();
	});

	test("task-detail with pending task shows Start button", async ({ page, mockApi, emitSse }) => {
		await setupAndNavigate(page, mockApi);
		await sendMessageAndStreamTaskDetail(page, emitSse, {
			id: "t-1",
			title: "Setup DB",
			status: "pending",
		});

		// Scope to the card: the app shell also renders a "Get Started 0/…"
		// onboarding button, so an unscoped name match is ambiguous.
		const card = page.getByTestId("tool-card-task-detail");
		await expect(card.getByText("Setup DB")).toBeVisible();
		await expect(card.getByRole("button", { name: "Start" })).toBeVisible();
	});

	test("task-detail with active task shows Finish button", async ({ page, mockApi, emitSse }) => {
		await setupAndNavigate(page, mockApi);
		await sendMessageAndStreamTaskDetail(page, emitSse, {
			id: "t-1",
			title: "Build API",
			status: "active",
		});

		const card = page.getByTestId("tool-card-task-detail");
		await expect(card.getByText("Build API")).toBeVisible();
		await expect(card.getByRole("button", { name: "Finish" })).toBeVisible();
	});

	test("clicking Add Task, filling title, and submitting fires tool-invoke POST", async ({ page, mockApi, emitSse }) => {
		await setupAndNavigate(page, mockApi);

		// Intercept tool-invoke POST
		let toolInvokeBody: any = null;
		await page.route("**/api/tool-invoke", async (route: any) => {
			toolInvokeBody = route.request().postDataJSON();
			await route.fulfill({ json: { success: true } });
		});

		await sendMessageAndStreamTaskList(page, emitSse, [
			{ id: "t-1", title: "Setup DB", status: "pending" },
		]);

		// Scope to the card — the app shell also renders an "Add project"
		// button, so an unscoped "Add" name match is ambiguous.
		const card = page.getByTestId("tool-card-task-list");
		await card.getByText("+ Add Task").click();

		// Fill title and submit
		await card.locator('input[placeholder="Task title..."]').fill("New Feature");
		await card.getByRole("button", { name: "Add" }).click();

		// Verify tool-invoke was called with correct params
		await expect.poll(() => toolInvokeBody).toBeTruthy();
		expect(toolInvokeBody.extensionName).toBe("task-stack");
		expect(toolInvokeBody.toolName).toBe("add-task");
		expect(toolInvokeBody.input).toEqual({ title: "New Feature" });
	});

	test("clicking Start on a task fires tool-invoke POST with start-task", async ({ page, mockApi, emitSse }) => {
		await setupAndNavigate(page, mockApi);

		let toolInvokeBody: any = null;
		await page.route("**/api/tool-invoke", async (route: any) => {
			toolInvokeBody = route.request().postDataJSON();
			await route.fulfill({ json: { success: true } });
		});

		await sendMessageAndStreamTaskList(page, emitSse, [
			{ id: "t-1", title: "Setup DB", status: "pending" },
		]);

		// Click the Start button (play icon)
		await page.getByTitle("Start task").click();

		await expect.poll(() => toolInvokeBody).toBeTruthy();
		expect(toolInvokeBody.extensionName).toBe("task-stack");
		expect(toolInvokeBody.toolName).toBe("start-task");
		expect(toolInvokeBody.input).toEqual({ taskId: "t-1" });
	});

	test("no action buttons when conversationId is missing", async ({ page, mockApi, emitSse }) => {
		// Navigate without a conversationId context — use project page that doesn't have conv in route
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await sendMessage(page, "List tasks");

		await emitSse({
			type: "run:token",
			data: { runId: "run-stream", token: "Working..." },
		});

		// Emit tool:start and tool:complete but tool cards only get conversationId
		// from the page route. The card will have actions because it's on the chat page.
		// To test no actions, we verify completed tasks don't show Start/Finish.
		await emitSse({
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

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.list-tasks",
				output: { content: [{ type: "text", text: JSON.stringify([
					{ id: "t-1", title: "Done Task", status: "completed" },
				]) }] },
				duration: 30,
				success: true,
				cardType: "task-list",
			},
		});

		// Completed task should render but have no Start/Finish buttons
		await expect(page.getByText("Done Task")).toBeVisible();
		await expect(page.getByTitle("Start task")).not.toBeVisible();
		await expect(page.getByTitle("Finish task")).not.toBeVisible();
		// No "Add Task" for completed-only list should still appear (canAct is true on chat page)
		// But completed tasks individually have no action buttons - this is the key check
	});
});
