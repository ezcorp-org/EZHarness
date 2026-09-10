/**
 * Full user-action coverage for task cards.
 *
 * A card reaches the chat only through the native composer request followed by
 * the runtime-events SSE stream.  These tests intentionally do not import or
 * mutate the inline-tool store: that bypass used a retired WebSocket path and
 * could make a card appear without a real stream anchor.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-base.js";
import { sendComposerMessage, threadMessages } from "./fixtures/composer.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";

const proj = makeProject({ id: "proj-task-actions", name: "Task Actions" });
const conv = makeConversation({ id: "conv-task-actions", projectId: proj.id, title: "Task actions" });
const userMsg = makeMessage({ id: "task-actions-user", conversationId: conv.id, role: "user", content: "Show tasks" });

type EmitSse = (event: { type: string; data: unknown }) => Promise<void>;
type Task = { id: string; title: string; status: "pending" | "active" | "completed"; description?: string };
type CapturedInvoke = { conversationId: string; invocationId: string; extensionName: string; toolName: string; input: Record<string, unknown> };

async function setup(page: Page, mockApi: (overrides?: MockOverrides) => Promise<void>) {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [userMsg],
		routes: { "tool-permission-mode": () => ({ mode: "yolo" }) },
	});
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
}

async function startStreamingTurn(page: Page, text: string) {
	await Promise.all([
		page.waitForResponse((response) => response.url().endsWith(`/api/conversations/${conv.id}/messages`) && response.request().method() === "POST"),
		sendComposerMessage(page, text),
	]);
	await expect(threadMessages(page).getByText(text, { exact: true })).toBeVisible();
}

async function streamTaskCard(page: Page, emitSse: EmitSse, args: {
	kind: "task-list" | "task-detail";
	toolName: string;
	output: Task[] | Task;
	text?: string;
	complete?: boolean;
}) {
	await startStreamingTurn(page, args.text ?? `Show ${args.kind}`);
	await emitSse({ type: "run:token", data: { runId: "run-stream", token: "Working…" } });
	await emitSse({
		type: "tool:start",
		data: {
			conversationId: conv.id,
			extensionId: "task-stack",
			toolName: args.toolName,
			input: {},
			timestamp: Date.now(),
			cardType: args.kind,
		},
	});
	if (args.complete !== false) {
		await emitSse({
			type: "tool:complete",
			data: {
				conversationId: conv.id,
				extensionId: "task-stack",
				toolName: args.toolName,
				output: { content: [{ type: "text", text: JSON.stringify(args.output) }] },
				duration: 30,
				success: true,
				cardType: args.kind,
			},
		});
	}
}

async function interceptToolInvoke(page: Page): Promise<{ called: Promise<CapturedInvoke> }> {
	let resolveCall!: (body: CapturedInvoke) => void;
	const called = new Promise<CapturedInvoke>((resolve) => { resolveCall = resolve; });
	await page.route("**/api/tool-invoke", async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		resolveCall(route.request().postDataJSON() as CapturedInvoke);
		await route.fulfill({ json: { success: true, output: "{}", durationMs: 1 } });
	});
	return { called };
}

async function expectInvocation(called: Promise<CapturedInvoke>, toolName: string, input: Record<string, unknown>) {
	const body = await called;
	expect(body).toMatchObject({ conversationId: conv.id, extensionName: "task-stack", toolName });
	expect(body.invocationId).toEqual(expect.any(String));
	expect(body.invocationId.length).toBeGreaterThan(0);
	expect(body.input).toEqual(input);
}

test.describe("Task card actions through composer and runtime SSE", () => {
	test("list Start invokes start-task for the clicked pending row", async ({ page, mockApi, emitSse }) => {
		await setup(page, mockApi);
		const { called } = await interceptToolInvoke(page);
		await streamTaskCard(page, emitSse, { kind: "task-list", toolName: "task-stack.list-tasks", output: [{ id: "pending-1", title: "Setup DB", status: "pending" }] });
		const row = page.getByTestId("task-card-pending-1");
		await expect(row.getByText("Setup DB", { exact: true })).toBeVisible();
		await row.getByTitle("Start task").click();
		await expectInvocation(called, "start-task", { taskId: "pending-1" });
	});

	test("list Finish collects a summary before invoking finish-task", async ({ page, mockApi, emitSse }) => {
		await setup(page, mockApi);
		const { called } = await interceptToolInvoke(page);
		await streamTaskCard(page, emitSse, { kind: "task-list", toolName: "task-stack.list-tasks", output: [{ id: "active-1", title: "Build API", status: "active" }] });
		const row = page.getByTestId("task-card-active-1");
		await row.getByTitle("Finish task").click();
		const summary = page.locator('input[placeholder="Completion summary..."]');
		await expect(summary).toBeVisible();
		await summary.fill("All endpoints work");
		await page.getByRole("button", { name: "Done", exact: true }).click();
		await expectInvocation(called, "finish-task", { taskId: "active-1", summary: "All endpoints work" });
	});

	test("list Add Task sends the entered title", async ({ page, mockApi, emitSse }) => {
		await setup(page, mockApi);
		const { called } = await interceptToolInvoke(page);
		await streamTaskCard(page, emitSse, { kind: "task-list", toolName: "task-stack.list-tasks", output: [{ id: "pending-2", title: "Existing", status: "pending" }] });
		const card = page.getByTestId("tool-card-task-list");
		await card.getByRole("button", { name: "+ Add Task", exact: true }).click();
		await card.locator('input[placeholder="Task title..."]').fill("New Feature");
		await card.getByRole("button", { name: "Add", exact: true }).click();
		await expectInvocation(called, "add-task", { title: "New Feature" });
	});

	test("list Add Task keeps submit disabled for an empty title", async ({ page, mockApi, emitSse }) => {
		await setup(page, mockApi);
		await streamTaskCard(page, emitSse, { kind: "task-list", toolName: "task-stack.list-tasks", output: [{ id: "pending-3", title: "Existing", status: "pending" }] });
		const card = page.getByTestId("tool-card-task-list");
		await card.getByRole("button", { name: "+ Add Task", exact: true }).click();
		await expect(card.locator('input[placeholder="Task title..."]')).toHaveValue("");
		await expect(card.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
	});

	test("detail Start invokes start-task", async ({ page, mockApi, emitSse }) => {
		await setup(page, mockApi);
		const { called } = await interceptToolInvoke(page);
		await streamTaskCard(page, emitSse, { kind: "task-detail", toolName: "task-stack.get-task", output: { id: "pending-4", title: "Initialize DB", status: "pending", description: "Create schema" } });
		const card = page.getByTestId("tool-card-task-detail");
		await card.getByRole("button", { name: "Start", exact: true }).click();
		await expectInvocation(called, "start-task", { taskId: "pending-4" });
	});

	test("detail Finish invokes finish-task with the visible summary", async ({ page, mockApi, emitSse }) => {
		await setup(page, mockApi);
		const { called } = await interceptToolInvoke(page);
		await streamTaskCard(page, emitSse, { kind: "task-detail", toolName: "task-stack.get-task", output: { id: "active-2", title: "Build API", status: "active" } });
		const card = page.getByTestId("tool-card-task-detail");
		await card.getByRole("button", { name: "Finish", exact: true }).click();
		await card.locator('input[placeholder="Completion summary..."]').fill("API delivered");
		await card.getByRole("button", { name: "Done", exact: true }).click();
		await expectInvocation(called, "finish-task", { taskId: "active-2", summary: "API delivered" });
	});

	test("detail Edit sends only the changed title", async ({ page, mockApi, emitSse }) => {
		await setup(page, mockApi);
		const { called } = await interceptToolInvoke(page);
		await streamTaskCard(page, emitSse, { kind: "task-detail", toolName: "task-stack.get-task", output: { id: "pending-5", title: "Setup DB", status: "pending", description: "Create schema" } });
		const card = page.getByTestId("tool-card-task-detail");
		await card.getByRole("button", { name: "Edit", exact: true }).click();
		const title = card.locator('input[placeholder="Title..."]');
		await expect(title).toHaveValue("Setup DB");
		await title.fill("Setup PostgreSQL");
		await card.getByRole("button", { name: "Save", exact: true }).click();
		await expectInvocation(called, "update-task", { taskId: "pending-5", title: "Setup PostgreSQL" });
	});

	test("a running task card exposes no completed-task controls", async ({ page, mockApi, emitSse }) => {
		await setup(page, mockApi);
		await streamTaskCard(page, emitSse, { kind: "task-list", toolName: "task-stack.list-tasks", output: [], complete: false });
		const card = page.getByTestId("tool-card-task-list");
		await expect(card.getByText("Loading...", { exact: true })).toBeVisible();
		await expect(card.getByTitle("Start task")).toHaveCount(0);
		await expect(card.getByTitle("Finish task")).toHaveCount(0);
		await expect(card.getByRole("button", { name: "+ Add Task", exact: true })).toHaveCount(0);
	});

	test("completed task rows expose neither Start nor Finish", async ({ page, mockApi, emitSse }) => {
		await setup(page, mockApi);
		await streamTaskCard(page, emitSse, { kind: "task-list", toolName: "task-stack.list-tasks", output: [{ id: "done-1", title: "Completed task", status: "completed" }] });
		const row = page.getByTestId("task-card-done-1");
		await expect(row.getByText("Completed task", { exact: true })).toBeVisible();
		await expect(row.getByTitle("Start task")).toHaveCount(0);
		await expect(row.getByTitle("Finish task")).toHaveCount(0);
	});
});
