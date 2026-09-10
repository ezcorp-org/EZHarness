import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Inline Tool Immediate Execution", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Chat" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Hello",
	});
	const taskStack = { name: "task-stack", description: "Task management", enabled: true };

	async function readyComposer(page: any) {
		const textarea = page.locator("textarea");
		await expect(textarea).toBeEnabled({ timeout: 10_000 });
		return textarea;
	}

	test("submitting tool form immediately invokes the tool", async ({ page, mockApi }) => {
		let toolInvokeBody: Record<string, unknown> | null = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			extensions: [taskStack],
			routes: {
				"tool-permission-mode": () => ({ mode: "yolo" }),
				// Mock extension tools endpoint
				"extensions/task-stack/tools": () => ({
					tools: [
						{ name: "list-tasks", description: "List all tasks", inputSchema: { type: "object", properties: { stackId: { type: "string" } } } },
					],
				}),
			},
		});

		// Intercept tool-invoke POST to verify it fires immediately
		await page.route("**/api/tool-invoke", async (route) => {
			if (route.request().method() === "POST") {
				toolInvokeBody = route.request().postDataJSON();
				await route.fulfill({ json: { success: true, output: "[]", durationMs: 50 } });
			} else {
				await route.fallback();
			}
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		// Type the extension-only sigil and select it through the native picker.
		const textarea = await readyComposer(page);
		await textarea.fill("!ext:task-stack");
		const listbox = page.locator("#mention-listbox");
		await expect(listbox.getByText("task-stack", { exact: true })).toBeVisible();
		await page.keyboard.press("Enter");
		const chip = page.locator('span[role="button"]').filter({ hasText: "!task-stack" });
		await expect(chip).toBeVisible();
		await chip.click();
		const submitBtn = page.locator('form button[type="submit"]');
		await expect(submitBtn).toBeVisible();
		await submitBtn.click();
		await expect.poll(() => toolInvokeBody).not.toBeNull();
		expect(toolInvokeBody).toMatchObject({ toolName: "list-tasks", extensionName: "task-stack" });
	});

	test("tool form closes after submission", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			extensions: [taskStack],
			routes: {
				"tool-permission-mode": () => ({ mode: "yolo" }),
				"extensions/task-stack/tools": () => ({
					tools: [
						{ name: "list-tasks", description: "List all tasks", inputSchema: { type: "object", properties: {} } },
					],
				}),
			},
		});

		await page.route("**/api/tool-invoke", async (route) => {
			await route.fulfill({ json: { success: true, output: "[]", durationMs: 50 } });
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		const textarea = await readyComposer(page);
		await textarea.fill("!ext:task-stack");
		await expect(page.locator("#mention-listbox").getByText("task-stack", { exact: true })).toBeVisible();
		await page.keyboard.press("Enter");
		const chip = page.locator('span[role="button"]').filter({ hasText: "!task-stack" });
		await expect(chip).toBeVisible();
		await chip.click();
		const submitBtn = page.locator('form button[type="submit"]');
		await expect(submitBtn).toBeVisible();
		await submitBtn.click();
		await expect(submitBtn).not.toBeVisible();
	});

	test("tool result renders in chat after immediate execution", async ({ page, mockApi, emitSse }) => {
		let invocationId = "";
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			extensions: [taskStack],
			routes: {
				"tool-permission-mode": () => ({ mode: "yolo" }),
				"extensions/task-stack/tools": () => ({ tools: [{ name: "list-tasks", inputSchema: { type: "object", properties: {} } }] }),
			},
		});

		await page.route("**/api/tool-invoke", async (route) => {
			invocationId = route.request().postDataJSON().invocationId;
			await route.fulfill({ json: { success: true, output: "[]", durationMs: 50 } });
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		const textarea = await readyComposer(page);
		await textarea.fill("!ext:task-stack");
		await expect(page.locator("#mention-listbox").getByText("task-stack", { exact: true })).toBeVisible();
		await page.keyboard.press("Enter");
		await page.locator('span[role="button"]').filter({ hasText: "!task-stack" }).click();
		await page.locator('form button[type="submit"]').click();
		await expect.poll(() => invocationId).not.toBe("");

		await emitSse({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "task-stack",
				toolName: "task-stack.list-tasks",
				input: {},
				timestamp: Date.now(),
				source: "inline",
				invocationId,
				cardType: "task-list",
			},
		});

		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: "conv-1",
				extensionId: "task-stack",
				toolName: "task-stack.list-tasks",
				output: {
					content: [{ type: "text", text: JSON.stringify([
						{ id: "t1", title: "Setup database", status: "completed", priority: 0 },
						{ id: "t2", title: "Build API endpoints", status: "active", priority: 1 },
					]) }],
					isError: false,
				},
				duration: 50,
				success: true,
				source: "inline",
				invocationId,
				cardType: "task-list",
			},
		});

		await page.waitForTimeout(500);

		// The tool result should be visible in the chat
		await expect(page.getByText("Setup database")).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("Build API endpoints")).toBeVisible();
	});
});
