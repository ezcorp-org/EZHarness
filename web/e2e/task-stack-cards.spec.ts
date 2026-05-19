import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Task Stack Card Rendering", () => {
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

	test("task-detail tool:complete renders TaskDetailCard with title and status badge", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Trigger streaming
		const textarea = page.locator("textarea");
		await textarea.fill("Add a task");
		await textarea.press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "Working..." },
		});

		// Emit tool:start with task-detail cardType
		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.add-task",
				input: { title: "Setup DB" },
				timestamp: Date.now(),
				cardType: "task-detail",
			},
		});

		// Emit tool:complete with task detail output
		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.add-task",
				output: { content: [{ type: "text", text: JSON.stringify({
					id: "t-1",
					title: "Setup DB",
					status: "pending",
					dueDate: "2026-04-01",
				}) }] },
				duration: 50,
				success: true,
				cardType: "task-detail",
			},
		});

		// Verify the TaskDetailCard renders task title and status
		await expect(page.getByText("Setup DB")).toBeVisible();
		await expect(page.getByText("Pending")).toBeVisible();
		await expect(page.getByText("Due: 2026-04-01")).toBeVisible();
	});

	test("task-list tool:complete renders TaskListCard with task items", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea");
		await textarea.fill("List tasks");
		await textarea.press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "Listing..." },
		});

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
					{ id: "t-3", title: "Write Tests", status: "pending", readyForAgent: true },
				]) }] },
				duration: 30,
				success: true,
				cardType: "task-list",
			},
		});

		// Verify the TaskListCard renders all task items
		await expect(page.getByText("Setup DB")).toBeVisible();
		await expect(page.getByText("Build API")).toBeVisible();
		await expect(page.getByText("Write Tests")).toBeVisible();
		// Verify item count shown in header
		await expect(page.getByText("3 tasks")).toBeVisible();
		// Verify agent badge for readyForAgent task
		await expect(page.getByText("agent")).toBeVisible();
	});

	test("task-list renders stacks when items have name but no status", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea");
		await textarea.fill("List stacks");
		await textarea.press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "Listing..." },
		});

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.list-stacks",
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
				toolName: "task-stack.list-stacks",
				output: { content: [{ type: "text", text: JSON.stringify([
					{ id: "s-1", name: "inbox" },
					{ id: "s-2", name: "backlog" },
				]) }] },
				duration: 20,
				success: true,
				cardType: "task-list",
			},
		});

		// Verify stacks are rendered
		await expect(page.getByText("inbox")).toBeVisible();
		await expect(page.getByText("backlog")).toBeVisible();
		await expect(page.getByText("2 stacks")).toBeVisible();
	});

	test("task-detail shows completion summary for finished task", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea");
		await textarea.fill("Finish task");
		await textarea.press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "Finishing..." },
		});

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.finish-task",
				input: { taskId: "t-1", summary: "All done" },
				timestamp: Date.now(),
				cardType: "task-detail",
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.finish-task",
				output: { content: [{ type: "text", text: JSON.stringify({
					id: "t-1",
					title: "Setup DB",
					status: "completed",
					completedAt: "2026-03-21T10:00:00.000Z",
					completionSummary: "Database schema created and migrations run",
				}) }] },
				duration: 40,
				success: true,
				cardType: "task-detail",
			},
		});

		await expect(page.getByText("Setup DB")).toBeVisible();
		await expect(page.getByText("Completed")).toBeVisible();
		await expect(page.getByText("Database schema created and migrations run")).toBeVisible();
	});

	test("tool without cardType renders DefaultCard (not TaskCard)", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const textarea = page.locator("textarea");
		await textarea.fill("Update task");
		await textarea.press("Enter");
		await page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST");

		await emitWs({
			type: "run:token",
			data: { runId: "run-stream", token: "Updating..." },
		});

		// tool:start without cardType -> should use DefaultCard
		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.update-task",
				input: { taskId: "t-1", title: "Updated Title" },
				timestamp: Date.now(),
				// no cardType
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "ext-task-stack",
				toolName: "task-stack.update-task",
				output: { content: [{ type: "text", text: JSON.stringify({ id: "t-1", title: "Updated Title", status: "pending" }) }] },
				duration: 30,
				success: true,
				// no cardType
			},
		});

		// The tool name should be visible (DefaultCard shows it)
		await expect(page.getByText("task-stack.update-task")).toBeVisible();
	});
});
