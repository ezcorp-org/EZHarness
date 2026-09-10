import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-base.js";
import { makeExtension, makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

type SseEvent = {
	type: "tool:start" | "tool:complete";
	data: Record<string, unknown>;
};

type EmitSse = (event: SseEvent) => Promise<void>;

test.describe("Inline Tool Custom Card Rendering", () => {
	const proj = makeProject({ id: "proj-1", name: "Test Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Test Chat" });
	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Hello",
	});
	const taskStack = makeExtension({ name: "task-stack", description: "Task management", enabled: true });
	const claudeDesign = makeExtension({ name: "claude-design", description: "Design canvas", enabled: true });
	const genericExtension = makeExtension({ name: "some-ext", description: "Generic tool", enabled: true });

	async function invokeFromPicker(page: Page, extensionName: string, toolName: string) {
		const captured = { invocation: null as Record<string, unknown> | null };
		await page.route("**/api/tool-invoke", async (route) => {
			captured.invocation = route.request().postDataJSON() as Record<string, unknown>;
			await route.fulfill({ json: { success: true, durationMs: 50 } });
		});

		const textarea = page.locator("textarea");
		await expect(textarea).toBeEnabled({ timeout: 10_000 });
		await textarea.fill(`!ext:${extensionName}`);
		await expect(page.locator("#mention-listbox").getByText(extensionName, { exact: true })).toBeVisible();
		await page.keyboard.press("Enter");
		const chip = page.locator('span[role="button"]').filter({ hasText: `!${extensionName}` });
		await expect(chip).toBeVisible();
		await chip.click();
		const submit = page.locator('form button[type="submit"]');
		await expect(submit).toBeVisible();
		await submit.click();
		await expect.poll(() => captured.invocation).not.toBeNull();
		if (!captured.invocation) throw new Error("Inline tool invocation was not captured");
		expect(captured.invocation).toMatchObject({ extensionName, toolName, conversationId: conv.id });
		return captured.invocation.invocationId as string;
	}

	async function completeInlineTool(
		emitSse: EmitSse,
		input: {
			invocationId: string;
			extensionId: string;
			toolName: string;
			output: unknown;
			cardType?: string;
		},
	) {
		const data = {
			conversationId: conv.id,
			extensionId: input.extensionId,
			toolName: input.toolName,
			input: {},
			timestamp: Date.now(),
			source: "inline",
			invocationId: input.invocationId,
			...(input.cardType ? { cardType: input.cardType } : {}),
		};
		await emitSse({ type: "tool:start", data });
		await emitSse({
			type: "tool:complete",
			data: { ...data, output: input.output, duration: 50, success: true },
		});
	}

	test("an invoked task-list tool renders its streamed task payload", async ({ page, mockApi, emitSse }) => {
		const tasks = [
			{ id: "t1", title: "Fix login bug", status: "pending", priority: 0 },
			{ id: "t2", title: "Add dark mode", status: "active", priority: 1 },
			{ id: "t3", title: "Write tests", status: "completed", priority: 2 },
		];
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			extensions: [taskStack],
			routes: {
				"tool-permission-mode": () => ({ mode: "yolo" }),
				"extensions/task-stack/tools": () => ({
					tools: [{ name: "list-tasks", inputSchema: { type: "object", properties: {} } }],
				}),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const invocationId = await invokeFromPicker(page, "task-stack", "list-tasks");
		await completeInlineTool(emitSse, {
			invocationId,
			extensionId: "task-stack",
			toolName: "task-stack.list-tasks",
			output: { content: [{ type: "text", text: JSON.stringify(tasks) }], isError: false },
			cardType: "task-list",
		});

		const card = page.getByTestId("tool-card-task-list");
		await expect(card).toBeVisible();
		await expect(card.getByText("Fix login bug")).toBeVisible();
		await expect(card.getByText("Add dark mode")).toBeVisible();
		await expect(card.getByText("Write tests")).toBeVisible();
		await expect(card.getByText("3 tasks")).toBeVisible();
	});

	test("an invoked task-detail tool renders its streamed task payload", async ({ page, mockApi, emitSse }) => {
		const task = {
			id: "t1",
			title: "Fix critical auth bug",
			status: "active",
			description: "Users getting logged out randomly",
			priority: 0,
			readyForAgent: true,
			dueDate: "2026-04-01",
		};
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			extensions: [taskStack],
			routes: {
				"tool-permission-mode": () => ({ mode: "yolo" }),
				"extensions/task-stack/tools": () => ({
					tools: [{ name: "get-active-task", inputSchema: { type: "object", properties: {} } }],
				}),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const invocationId = await invokeFromPicker(page, "task-stack", "get-active-task");
		await completeInlineTool(emitSse, {
			invocationId,
			extensionId: "task-stack",
			toolName: "task-stack.get-active-task",
			output: { content: [{ type: "text", text: JSON.stringify(task) }], isError: false },
			cardType: "task-detail",
		});

		const card = page.getByTestId("tool-card-task-detail");
		await expect(card).toBeVisible();
		await expect(card.getByText("Fix critical auth bug")).toBeVisible();
		await expect(card.getByText("agent-ready")).toBeVisible();
		await expect(card.getByText("Users getting logged out randomly")).toBeVisible();
	});

	test("an invoked canvas tool renders a sandboxed iframe from its streamed payload", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			extensions: [claudeDesign],
			routes: {
				"tool-permission-mode": () => ({ mode: "yolo" }),
				"extensions/claude-design/tools": () => ({
					tools: [{ name: "open-canvas", inputSchema: { type: "object", properties: {} } }],
				}),
			},
		});
		await page.route("**/api/extensions/claude-design/data/preview.html", async (route) => {
			await route.fulfill({ contentType: "text/html", body: "<main>Canvas preview</main>" });
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const invocationId = await invokeFromPicker(page, "claude-design", "open-canvas");
		await completeInlineTool(emitSse, {
			invocationId,
			extensionId: "claude-design",
			toolName: "claude-design.open-canvas",
			output: {
				content: [{ type: "text", text: JSON.stringify({
					draftId: "draft-inline-1",
					iframeSrc: "/api/extensions/claude-design/data/preview.html",
				}) }],
				isError: false,
			},
			cardType: "design-canvas",
		});

		const frame = page.getByTitle("Design canvas");
		await expect(frame).toBeVisible();
		await expect(frame).toHaveAttribute("src", "/api/extensions/claude-design/data/preview.html");
		await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
	});

	test("an invoked tool without a card type renders its expandable fallback", async ({ page, mockApi, emitSse }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg],
			extensions: [genericExtension],
			routes: {
				"tool-permission-mode": () => ({ mode: "yolo" }),
				"extensions/some-ext/tools": () => ({
					tools: [{ name: "do-thing", inputSchema: { type: "object", properties: {} } }],
				}),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const invocationId = await invokeFromPicker(page, "some-ext", "do-thing");
		await completeInlineTool(emitSse, {
			invocationId,
			extensionId: "some-ext",
			toolName: "some-ext.do-thing",
			output: { content: [{ type: "text", text: "done" }], isError: false },
		});

		const card = page.getByRole("button", { name: "some-ext > do-thing -- done (0.1s)" });
		await expect(card).toBeVisible();
		await card.click();
		await expect(page.getByText("done", { exact: true })).toBeVisible();
	});
});
