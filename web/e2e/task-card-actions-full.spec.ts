import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Task Card Actions (Full Coverage)", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Chat" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Hello",
	});

	async function setup(page: any, mockApi: any) {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"tool-permission-mode": () => ({ mode: "yolo" }),
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		// Register inline tool store listener
		await page.evaluate(() => {
			window.addEventListener("__test_add_inline_tool", ((e: CustomEvent) => {
				import("/src/lib/inline-tool-store.svelte.js").then((mod: any) => {
					mod.inlineToolStore.add(e.detail);
				}).catch(() => {});
			}) as EventListener);
		});
	}

	async function emitInlineTool(
		page: any,
		emitWs: any,
		opts: {
			toolName: string;
			cardType: string;
			output: unknown;
			invocationId?: string;
		},
	) {
		const invId = opts.invocationId ?? `inv-${Date.now()}`;

		// Add to inline tool store
		await page.evaluate(
			({ id, toolName }: any) => {
				window.dispatchEvent(new CustomEvent("__test_add_inline_tool", {
					detail: { id, extensionName: "task-stack", toolName, input: {}, conversationId: "conv-1" },
				}));
			},
			{ id: invId, toolName: opts.toolName },
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
				invocationId: invId,
				cardType: opts.cardType,
			},
		});

		await emitWs({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "task-stack",
				toolName: opts.toolName,
				output: { content: [{ type: "text", text: typeof opts.output === "string" ? opts.output : JSON.stringify(opts.output) }], isError: false },
				duration: 30,
				success: true,
				source: "inline",
				invocationId: invId,
				cardType: opts.cardType,
			},
		});

		await page.waitForTimeout(300);
	}

	function interceptToolInvoke(page: any): { getBody: () => any; waitForCall: () => Promise<any> } {
		let body: any = null;
		let resolve: ((v: any) => void) | null = null;
		const promise = new Promise<any>((r) => { resolve = r; });
		page.route("**/api/tool-invoke", async (route: any) => {
			body = route.request().postDataJSON();
			resolve?.(body);
			await route.fulfill({ json: { success: true } });
		});
		return { getBody: () => body, waitForCall: () => promise };
	}

	// ── TaskListCard Tests ──

	test("TaskListCard Start button triggers start-task", async ({ page, mockApi, emitWs }) => {
		await setup(page, mockApi);
		const { waitForCall } = interceptToolInvoke(page);

		await emitInlineTool(page, emitWs, {
			toolName: "task-stack.list-tasks",
			cardType: "task-list",
			output: [{ id: "t-1", title: "Setup DB", status: "pending" }],
		});

		await page.getByTitle("Start task").click();

		const body = await waitForCall();
		expect(body.extensionName).toBe("task-stack");
		expect(body.toolName).toBe("start-task");
		expect(body.input).toEqual({ taskId: "t-1" });
	});

	test("TaskListCard Finish button opens summary form", async ({ page, mockApi, emitWs }) => {
		await setup(page, mockApi);
		const { waitForCall } = interceptToolInvoke(page);

		await emitInlineTool(page, emitWs, {
			toolName: "task-stack.list-tasks",
			cardType: "task-list",
			output: [{ id: "t-1", title: "Build API", status: "active" }],
		});

		// Click Finish button (check icon)
		await page.getByTitle("Finish task").click();

		// Summary input should appear
		const summaryInput = page.locator('input[placeholder*="ummary"], textarea[placeholder*="ummary"]');
		await expect(summaryInput).toBeVisible({ timeout: 3000 });

		await summaryInput.fill("All endpoints working");
		// Submit the form
		await page.getByRole("button", { name: /submit|finish|done/i }).click();

		const body = await waitForCall();
		expect(body.extensionName).toBe("task-stack");
		expect(body.toolName).toBe("finish-task");
		expect(body.input.summary).toBe("All endpoints working");
	});

	test("TaskListCard Add Task form", async ({ page, mockApi, emitWs }) => {
		await setup(page, mockApi);
		const { waitForCall } = interceptToolInvoke(page);

		await emitInlineTool(page, emitWs, {
			toolName: "task-stack.list-tasks",
			cardType: "task-list",
			output: [{ id: "t-1", title: "Setup DB", status: "pending" }],
		});

		await page.getByText("+ Add Task").click();

		const input = page.locator('input[placeholder="Task title..."]');
		await expect(input).toBeVisible({ timeout: 3000 });

		await input.fill("New Feature");
		await page.getByRole("button", { name: "Add" }).click();

		const body = await waitForCall();
		expect(body.extensionName).toBe("task-stack");
		expect(body.toolName).toBe("add-task");
		expect(body.input).toEqual({ title: "New Feature" });
	});

	test("TaskListCard Add Task rejects empty title", async ({ page, mockApi, emitWs }) => {
		await setup(page, mockApi);

		await emitInlineTool(page, emitWs, {
			toolName: "task-stack.list-tasks",
			cardType: "task-list",
			output: [{ id: "t-1", title: "Setup DB", status: "pending" }],
		});

		await page.getByText("+ Add Task").click();

		// Input should be visible and empty
		const input = page.locator('input[placeholder="Task title..."]');
		await expect(input).toBeVisible({ timeout: 3000 });
		await expect(input).toHaveValue("");

		// Submit button should be disabled with empty input
		const addBtn = page.getByRole("button", { name: "Add" });
		await expect(addBtn).toBeDisabled();
	});

	// ── TaskDetailCard Tests ──

	test("TaskDetailCard Start button", async ({ page, mockApi, emitWs }) => {
		await setup(page, mockApi);
		const { waitForCall } = interceptToolInvoke(page);

		await emitInlineTool(page, emitWs, {
			toolName: "task-stack.get-task",
			cardType: "task-detail",
			output: { id: "t-1", title: "Setup DB", status: "pending", description: "Initialize the database" },
		});

		await expect(page.getByText("Setup DB")).toBeVisible({ timeout: 3000 });
		await page.getByRole("button", { name: "Start" }).click();

		const body = await waitForCall();
		expect(body.extensionName).toBe("task-stack");
		expect(body.toolName).toBe("start-task");
		expect(body.input).toEqual({ taskId: "t-1" });
	});

	test("TaskDetailCard Finish with summary", async ({ page, mockApi, emitWs }) => {
		await setup(page, mockApi);
		const { waitForCall } = interceptToolInvoke(page);

		await emitInlineTool(page, emitWs, {
			toolName: "task-stack.get-task",
			cardType: "task-detail",
			output: { id: "t-1", title: "Build API", status: "active", description: "Build REST endpoints" },
		});

		await expect(page.getByText("Build API")).toBeVisible({ timeout: 3000 });
		await page.getByRole("button", { name: "Finish" }).click();

		// Summary input should appear
		const summaryInput = page.locator('input[placeholder*="ummary"], textarea[placeholder*="ummary"]');
		await expect(summaryInput).toBeVisible({ timeout: 3000 });

		await summaryInput.fill("All REST endpoints implemented and tested");
		await page.getByRole("button", { name: /submit|finish|done/i }).click();

		const body = await waitForCall();
		expect(body.extensionName).toBe("task-stack");
		expect(body.toolName).toBe("finish-task");
		expect(body.input.taskId).toBe("t-1");
		expect(body.input.summary).toBe("All REST endpoints implemented and tested");
	});

	test("TaskDetailCard Edit form", async ({ page, mockApi, emitWs }) => {
		await setup(page, mockApi);
		const { waitForCall } = interceptToolInvoke(page);

		await emitInlineTool(page, emitWs, {
			toolName: "task-stack.get-task",
			cardType: "task-detail",
			output: { id: "t-1", title: "Setup DB", status: "pending", description: "Initialize the database" },
		});

		await expect(page.getByText("Setup DB")).toBeVisible({ timeout: 3000 });
		await page.getByRole("button", { name: "Edit" }).click();

		// Title and description inputs should be populated
		const titleInput = page.locator('input[value="Setup DB"]');
		await expect(titleInput).toBeVisible({ timeout: 3000 });

		// Change the title
		await titleInput.clear();
		await titleInput.fill("Setup PostgreSQL");
		await page.getByRole("button", { name: /save|submit|update/i }).click();

		const body = await waitForCall();
		expect(body.extensionName).toBe("task-stack");
		expect(body.toolName).toBe("update-task");
		expect(body.input.title).toBe("Setup PostgreSQL");
	});

	// ── Negative / Edge-Case Tests ──

	test("No action buttons without conversationId", async ({ page, mockApi, emitWs }) => {
		// Emit tool events without the inline tool store + conversationId context
		// Simulate the agent streaming path (ToolCallCard without conversationId)
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		// Send message to get into streaming context
		const textarea = page.locator("textarea");
		await textarea.fill("Show tasks");
		await textarea.press("Enter");
		await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

		// Emit tool events WITHOUT conversationId in the data (simulating agent streaming path)
		await emitWs({
			type: "tool:start",
			data: {
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
				extensionId: "ext-task-stack",
				toolName: "task-stack.list-tasks",
				output: { content: [{ type: "text", text: JSON.stringify([{ id: "t-1", title: "A Task", status: "pending" }]) }] },
				duration: 30,
				success: true,
				cardType: "task-list",
			},
		});

		await page.waitForTimeout(500);

		// Task should render but no action buttons (no conversationId = no actions)
		await expect(page.getByText("A Task")).toBeVisible({ timeout: 3000 });
		await expect(page.getByTitle("Start task")).not.toBeVisible();
		await expect(page.getByTitle("Finish task")).not.toBeVisible();
		await expect(page.getByRole("button", { name: "Edit" })).not.toBeVisible();
		await expect(page.getByText("+ Add Task")).not.toBeVisible();
	});

	test("No action buttons while running", async ({ page, mockApi, emitWs }) => {
		await setup(page, mockApi);

		// Only emit tool:start (no tool:complete) — card is still "running"
		await page.evaluate(
			({ id, toolName }: any) => {
				window.dispatchEvent(new CustomEvent("__test_add_inline_tool", {
					detail: { id, extensionName: "task-stack", toolName, input: {}, conversationId: "conv-1" },
				}));
			},
			{ id: "inv-running", toolName: "task-stack.list-tasks" },
		);

		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "task-stack",
				toolName: "task-stack.list-tasks",
				input: {},
				timestamp: Date.now(),
				source: "inline",
				invocationId: "inv-running",
				cardType: "task-list",
			},
		});

		await page.waitForTimeout(500);

		// No action buttons should be present while tool is running
		await expect(page.getByTitle("Start task")).not.toBeVisible();
		await expect(page.getByTitle("Finish task")).not.toBeVisible();
		await expect(page.getByText("+ Add Task")).not.toBeVisible();
	});

	test("Completed tasks have no Start/Finish buttons", async ({ page, mockApi, emitWs }) => {
		await setup(page, mockApi);

		await emitInlineTool(page, emitWs, {
			toolName: "task-stack.list-tasks",
			cardType: "task-list",
			output: [{ id: "t-1", title: "Done Task", status: "completed" }],
		});

		await expect(page.getByText("Done Task")).toBeVisible({ timeout: 3000 });
		// Completed tasks should have no Start, Finish, or Edit buttons
		await expect(page.getByTitle("Start task")).not.toBeVisible();
		await expect(page.getByTitle("Finish task")).not.toBeVisible();
	});
});
