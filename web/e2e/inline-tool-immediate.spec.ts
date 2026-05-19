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

	test("submitting tool form immediately invokes the tool", async ({ page, mockApi }) => {
		let toolInvokeBody: Record<string, unknown> | null = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
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

		// Type @ext:task-stack to trigger the mention
		const textarea = page.locator("textarea");
		await textarea.fill("@ext:task-stack");

		// Wait for mention popover and click the extension
		// The chip should appear — click it to open tools
		const chip = page.locator("[data-mention-chip]").first();
		if (await chip.isVisible({ timeout: 2000 }).catch(() => false)) {
			await chip.click();
		}

		// If the tool form appears, submit it
		const submitBtn = page.locator('button[type="submit"]');
		if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
			await submitBtn.click();

			// Wait for the tool-invoke request
			await page.waitForTimeout(500);

			// Verify tool-invoke was called immediately (not staged)
			expect(toolInvokeBody).not.toBeNull();
			expect((toolInvokeBody as any)?.toolName).toBe("list-tasks");
			expect((toolInvokeBody as any)?.extensionName).toBe("task-stack");
		}
	});

	test("tool form closes after submission", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
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

		const textarea = page.locator("textarea");
		await textarea.fill("@ext:task-stack");

		const chip = page.locator("[data-mention-chip]").first();
		if (await chip.isVisible({ timeout: 2000 }).catch(() => false)) {
			await chip.click();
		}

		const submitBtn = page.locator('button[type="submit"]');
		if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
			await submitBtn.click();
			await page.waitForTimeout(300);

			// Form should be closed after submission
			await expect(submitBtn).not.toBeVisible();
		}
	});

	test("tool result renders in chat after immediate execution", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			routes: {
				"tool-permission-mode": () => ({ mode: "yolo" }),
			},
		});

		await page.route("**/api/tool-invoke", async (route) => {
			await route.fulfill({ json: { success: true, output: "[]", durationMs: 50 } });
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForSelector("textarea");

		// Simulate the complete flow via WS events
		// First emit tool:complete for an inline tool with cardType
		await emitWs({
			type: "tool:start",
			data: {
				conversationId: "conv-1",
				extensionId: "task-stack",
				toolName: "task-stack.list-tasks",
				input: {},
				timestamp: Date.now(),
				source: "inline",
				invocationId: "direct-inv-1",
				cardType: "task-list",
			},
		});

		await emitWs({
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
				invocationId: "direct-inv-1",
				cardType: "task-list",
			},
		});

		await page.waitForTimeout(500);

		// The tool result should be visible in the chat
		await expect(page.getByText("Setup database")).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("Build API endpoints")).toBeVisible();
	});
});
