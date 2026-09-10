import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-base.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { invokeExtensionToolFromComposer } from "./fixtures/composer.js";
import { makeProject, makeConversation, makeMessage, makeExtension } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1", name: "Test Project" });
const conv = makeConversation({ id: "conv-1", projectId: proj.id, title: "Test Chat" });
const userMsg = makeMessage({ id: "m1", conversationId: conv.id, role: "user", content: "Inspect the workspace" });
const assistantMsg = makeMessage({
	id: "m2", conversationId: conv.id, role: "assistant", content: "Inspection is complete.",
	parentMessageId: userMsg.id, createdAt: "2026-01-01T00:01:00.000Z",
});
const extension = makeExtension({ name: "workspace-inspector", enabled: true });
const chatUrl = `/project/${proj.id}/chat/${conv.id}`;
type MockApi = (overrides?: MockOverrides) => Promise<void>;
type EmitSse = (event: { type: string; data: unknown }) => Promise<void>;

function persistedCall(id: string, label: string, messageId?: string) {
	return {
		id, extensionId: extension.name, toolName: "inspect", input: { label },
		outputSummary: label, fullOutput: label, success: true, durationMs: 50,
		status: "success" as const, ...(messageId ? { messageId } : {}),
	};
}

async function setup(mockApi: MockApi, initialCalls: ReturnType<typeof persistedCall>[] = []) {
	const snapshot = { messages: initialCalls.length ? [userMsg, assistantMsg] : [userMsg], calls: initialCalls };
	await mockApi({
		projects: [proj], conversations: [conv], messages: snapshot.messages, extensions: [extension],
		routes: {
			"tool-permission-mode": () => ({ mode: "yolo" }),
			"extensions/workspace-inspector/tools": () => ({ tools: [{
				name: "inspect", description: "Inspect a workspace entry",
				inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
			}] }),
			"/api/conversations/conv-1/messages": (url) => url.searchParams.get("withToolCalls") === "true"
				? { messages: snapshot.messages, orphanedToolCalls: snapshot.calls, subConversations: [], subConversationToolCalls: {} }
				: snapshot.messages,
		},
	});
	return snapshot;
}

async function invoke(page: Page, emitSse: EmitSse, label: string) {
	const requestPromise = page.waitForRequest((request) =>
		request.method() === "POST" && new URL(request.url()).pathname === "/api/tool-invoke",
	);
	await invokeExtensionToolFromComposer(page, extension.name, { label });
	const body = (await requestPromise).postDataJSON();
	expect(body).toMatchObject({
		extensionName: extension.name, toolName: "inspect", input: { label },
		conversationId: conv.id, messageId: userMsg.id, invocationId: expect.any(String),
	});
	expect(body.invocationId).not.toBe("");
	const data = {
		conversationId: conv.id, extensionId: extension.name, toolName: "inspect",
		source: "inline", invocationId: body.invocationId, input: { label },
	};
	await emitSse({ type: "tool:start", data: { ...data, timestamp: Date.now() } });
	await emitSse({ type: "tool:complete", data: { ...data, output: label, duration: 50, success: true } });
	await expect(toolCard(page, label)).toBeVisible();
	return persistedCall(body.invocationId, label, userMsg.id);
}

function toolCard(page: Page, label: string): Locator {
	return page.locator("div.ml-4.rounded-md.border").filter({ has: page.getByRole("button", { name: new RegExp(`inspect.*${label}`) }) });
}

async function assertAfter(earlier: Locator, later: Locator) {
	await expect(earlier).toBeVisible();
	await expect(later).toBeVisible();
	const laterElement = await later.elementHandle();
	if (!laterElement) throw new Error("The later element is missing");
	expect(await earlier.evaluate((element, next) => Boolean(element.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING), laterElement)).toBe(true);
}

async function assertAnchored(page: Page, call: ReturnType<typeof persistedCall>, hasReply: boolean) {
	const card = toolCard(page, call.outputSummary);
	await expect(card).toHaveCount(1);
	await assertAfter(page.locator('[data-message-id="m1"]'), card);
	if (hasReply) await assertAfter(card, page.locator('[data-message-id="m2"]'));
	await expect(page.locator(`#tool-call-${call.id}`)).toHaveCount(0);
}

test.describe("Tool Call Anchoring", () => {
	test("native inline tool call stays beside its message after refresh", async ({ page, mockApi, emitSse }) => {
		const snapshot = await setup(mockApi);
		await page.route("**/api/tool-invoke", (route) => route.fulfill({ json: { success: true } }));
		await page.goto(chatUrl);
		const call = await invoke(page, emitSse, "workspace checked");
		await assertAnchored(page, call, false);
		snapshot.calls.push(call);
		snapshot.messages.push(assistantMsg);
		await page.reload();
		await assertAnchored(page, call, true);
	});

	test("legacy tool call without messageId stays in the fallback section after refresh", async ({ page, mockApi }) => {
		const call = persistedCall("legacy-invocation", "legacy result");
		await setup(mockApi, [call]);
		await page.goto(chatUrl);
		for (let load = 0; load < 2; load++) {
			const fallback = page.locator(`#tool-call-${call.id}`);
			await expect(fallback).toContainText(call.outputSummary);
			await assertAfter(page.locator('[data-message-id="m2"]'), fallback);
			if (load === 0) await page.reload();
		}
	});

	test("multiple native tool calls retain their order beside the same message after refresh", async ({ page, mockApi, emitSse }) => {
		const snapshot = await setup(mockApi);
		await page.route("**/api/tool-invoke", (route) => route.fulfill({ json: { success: true } }));
		await page.goto(chatUrl);
		const first = await invoke(page, emitSse, "first inspection");
		const second = await invoke(page, emitSse, "second inspection");
		expect(first.id).not.toBe(second.id);
		for (const call of [first, second]) await assertAnchored(page, call, false);
		await assertAfter(toolCard(page, first.outputSummary), toolCard(page, second.outputSummary));
		snapshot.calls.push(first, second);
		snapshot.messages.push(assistantMsg);
		await page.reload();
		for (const call of [first, second]) await assertAnchored(page, call, true);
		await assertAfter(toolCard(page, first.outputSummary), toolCard(page, second.outputSummary));
	});
});
