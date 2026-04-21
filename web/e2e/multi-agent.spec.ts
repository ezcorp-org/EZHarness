import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

test.describe("Multi-Agent Orchestration", () => {
	const proj = makeProject({ id: "proj-1", name: "Agent Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", model: "gpt-4", provider: "openai" });

	const modelsRoute = {
		"/api/models": () => [
			{ provider: "openai", model: "gpt-4", displayName: "GPT-4", available: true },
		],
	};

	/** Send a chat message and wait for the API response (ensures startStreaming is called) */
	async function sendAndWaitForStream(page: Page, text: string) {
		const textarea = page.locator("textarea");
		await textarea.fill(text);
		await Promise.all([
			page.waitForResponse((r) => r.url().includes("/messages") && r.request().method() === "POST"),
			page.getByRole("button", { name: "Send message" }).click(),
		]);
		await expect(page.getByText(text)).toBeVisible({ timeout: 5000 });
	}

	// ── Streaming agent tests ──────────────────────────────────────────────

	test("agent:spawn event renders an agent chip in chat", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: modelsRoute,
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Research this topic");

		// Stream some text first
		await emitWs({ type: "run:token", data: { runId: "run-stream", token: "Let me delegate this." } });
		await expect(page.getByText("Let me delegate this.")).toBeVisible({ timeout: 5000 });

		// Agent spawns
		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "Find relevant papers",
				agentRunId: "agent-run-1",
			},
		});

		// Verify .agent-chip is visible with "@researcher"
		const chip = page.locator(".agent-chip");
		await expect(chip).toBeVisible({ timeout: 5000 });
		await expect(chip).toContainText("@researcher");
	});

	test("agent:complete updates chip to complete state", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: modelsRoute,
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Delegate task");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "Research",
				agentRunId: "agent-run-1",
			},
		});
		await expect(page.locator(".agent-chip")).toBeVisible({ timeout: 5000 });

		// Complete with success
		await emitWs({
			type: "agent:complete",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				success: true,
				resultPreview: "Found 5 papers",
			},
		});

		// Verify complete indicator appears
		await expect(page.locator(".agent-chip-complete")).toBeVisible({ timeout: 5000 });
	});

	test("agent:complete with success=false shows error on chip", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: modelsRoute,
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Try something");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "coder",
				agentConfigId: "cfg-2",
				task: "Fix the bug",
				agentRunId: "agent-run-2",
			},
		});
		await expect(page.locator(".agent-chip")).toBeVisible({ timeout: 5000 });

		// Complete with failure
		await emitWs({
			type: "agent:complete",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				success: false,
				resultPreview: "Connection timeout",
			},
		});

		// Verify error indicator appears
		await expect(page.locator(".agent-chip-error")).toBeVisible({ timeout: 5000 });
	});

	test("multiple agent:spawn events render multiple chips", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: modelsRoute,
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Use two agents");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "Research",
				agentRunId: "agent-run-1",
			},
		});

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-2",
				agentName: "coder",
				agentConfigId: "cfg-2",
				task: "Code",
				agentRunId: "agent-run-2",
			},
		});

		const chips = page.locator(".agent-chip");
		await expect(chips).toHaveCount(2, { timeout: 5000 });
		await expect(chips.nth(0)).toContainText("@researcher");
		await expect(chips.nth(1)).toContainText("@coder");
	});

	test("clicking agent chip opens detail panel", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: {
				...modelsRoute,
				// Mock the sub-conversation messages endpoint
				"/api/conversations/sub-1/messages": () => [
					{ id: "sc-m1", role: "user", content: "Research task", conversationId: "sub-1", createdAt: "2026-01-01T00:00:00.000Z", model: null, provider: null, usage: null, runId: null, parentMessageId: null },
					{ id: "sc-m2", role: "assistant", content: "Here are the results.", conversationId: "sub-1", createdAt: "2026-01-01T00:01:00.000Z", model: null, provider: null, usage: null, runId: null, parentMessageId: null },
				],
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Research this");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "Find papers",
				agentRunId: "agent-run-1",
			},
		});

		await emitWs({
			type: "agent:complete",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				success: true,
				resultPreview: "Found results",
			},
		});

		// Click the chip
		const chip = page.locator(".agent-chip");
		await expect(chip).toBeVisible({ timeout: 5000 });
		await chip.click();

		// Verify panel opens with agent name
		const panel = page.locator(".agent-detail-panel");
		await expect(panel).toBeVisible({ timeout: 5000 });
		await expect(panel).toContainText("@researcher");
	});

	test("agent:status event updates chip status text", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: modelsRoute,
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Research task");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "Find papers",
				agentRunId: "agent-run-1",
			},
		});

		const chip = page.locator(".agent-chip");
		await expect(chip).toBeVisible({ timeout: 5000 });
		// Default running status
		await expect(chip).toContainText("Working...");

		// Send status update
		await emitWs({
			type: "agent:status",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "researcher",
				status: "Searching databases...",
			},
		});

		// Chip should now display the custom status text
		await expect(chip).toContainText("Searching databases...");
	});

	test("detail panel shows loading state and renders messages", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: {
				...modelsRoute,
				"/api/conversations/sub-1/messages": () => [
					{ id: "sc-m1", role: "user", content: "Research task", conversationId: "sub-1", createdAt: "2026-01-01T00:00:00.000Z", model: null, provider: null, usage: null, runId: null, parentMessageId: null },
					{ id: "sc-m2", role: "assistant", content: "Found 3 relevant papers on quantum computing.", conversationId: "sub-1", createdAt: "2026-01-01T00:01:00.000Z", model: null, provider: null, usage: null, runId: null, parentMessageId: null },
				],
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Research quantum computing");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "Find quantum computing papers",
				agentRunId: "agent-run-1",
			},
		});

		await emitWs({
			type: "agent:complete",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				success: true,
				resultPreview: "Found 3 papers",
			},
		});

		// Click chip to open panel
		const chip = page.locator(".agent-chip");
		await expect(chip).toBeVisible({ timeout: 5000 });
		await chip.click();

		const panel = page.locator(".agent-detail-panel");
		await expect(panel).toBeVisible({ timeout: 5000 });

		// Panel should display the task description
		await expect(panel).toContainText("Find quantum computing papers");

		// Panel should display the fetched messages
		await expect(panel).toContainText("Found 3 relevant papers on quantum computing.");
	});

	test("clicking panel backdrop closes the panel", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			routes: {
				...modelsRoute,
				"/api/conversations/sub-1/messages": () => [],
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Do stuff");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "Research",
				agentRunId: "agent-run-1",
			},
		});

		// Open panel
		const chip = page.locator(".agent-chip");
		await expect(chip).toBeVisible({ timeout: 5000 });
		await chip.click();
		await expect(page.locator(".agent-detail-panel")).toBeVisible({ timeout: 5000 });

		// Click backdrop to close
		await page.locator(".agent-detail-backdrop").click();
		await expect(page.locator(".agent-detail-panel")).not.toBeVisible();
	});

	// ── Historical agent sub-conversation tests ────────────────────────────

	test("historical agent sub-conversations render as chips not SubConversationBlocks", async ({ page, mockApi }) => {
		const assistantMsg = makeMessage({
			id: "msg-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "I delegated the research.",
			parentMessageId: null,
		});

		// Sub-conversation WITH agentConfigId = agent-spawned
		const agentSubConvo = makeConversation({
			id: "sub-conv-1",
			title: "researcher",
			projectId: "proj-1",
			agentConfigId: "cfg-1",
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [assistantMsg],
			routes: {
				"/api/conversations/conv-1/sub-conversations": () => [
					{ ...agentSubConvo, parentMessageId: "msg-1" },
				],
				"/api/conversations/conv-1/messages": (url: URL) => {
					if (url.searchParams.get("withToolCalls") === "true") {
						return {
							messages: [{ ...assistantMsg, toolCalls: [] }],
							subConversations: [
								{ ...agentSubConvo, parentMessageId: "msg-1" },
							],
						};
					}
					return [assistantMsg];
				},
				"active-run": () => ({ runId: null }),
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// Agent chip should be visible (from historical agent sub-convo)
		await expect(page.locator(".agent-chip")).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".agent-chip")).toContainText("@researcher");

		// SubConversationBlock should NOT be visible
		await expect(page.locator(".sub-convo-block")).toHaveCount(0);
	});

	test("user-initiated sub-conversations still render as SubConversationBlock", async ({ page, mockApi }) => {
		const assistantMsg = makeMessage({
			id: "msg-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Started a sub-conversation.",
			parentMessageId: null,
		});

		// Sub-conversation WITHOUT agentConfigId = user-initiated
		const userSubConvo = makeConversation({
			id: "sub-conv-1",
			title: "Helper",
			projectId: "proj-1",
			agentConfigId: null,
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [assistantMsg],
			routes: {
				"/api/conversations/conv-1/sub-conversations": () => [
					{ ...userSubConvo, parentMessageId: "msg-1" },
				],
				"/api/conversations/conv-1/messages": (url: URL) => {
					if (url.searchParams.get("withToolCalls") === "true") {
						return {
							messages: [{ ...assistantMsg, toolCalls: [] }],
							subConversations: [
								{ ...userSubConvo, parentMessageId: "msg-1" },
							],
						};
					}
					return [assistantMsg];
				},
				"active-run": () => ({ runId: null }),
			},
		});
		await page.goto(`/project/proj-1/chat/conv-1`);

		// SubConversationBlock should be visible (user-initiated, no agentConfigId)
		await expect(page.locator(".sub-convo-block")).toBeVisible({ timeout: 5000 });

		// Agent chip should NOT be present
		await expect(page.locator(".agent-chip")).toHaveCount(0);
	});
});
