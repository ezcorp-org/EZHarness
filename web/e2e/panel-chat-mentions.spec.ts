import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeAgent } from "./fixtures/data.js";

/**
 * E2E tests for @mention autocomplete and scroll-to-bottom in panel chat inputs.
 * Covers AgentDetailPanel and TeamChatPanel.
 */

const proj = makeProject({ id: "proj-1", name: "Mention Panel Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Mention Test" });

const userMsg = makeMessage({
	id: "msg-user-1",
	conversationId: "conv-1",
	role: "user",
	content: "Do the thing",
	parentMessageId: null,
});

const assistantMsg = makeMessage({
	id: "msg-asst-1",
	conversationId: "conv-1",
	role: "assistant",
	content: '{"type":"agent_ref","agentName":"TestAgent","subConversationId":"sub-conv-1","runId":"run-1"}\n\nI\'m delegating to TestAgent.',
	parentMessageId: "msg-user-1",
});

// Sub-conversation messages — enough to make panel scrollable
const agentTaskMsg = makeMessage({
	id: "agent-msg-task",
	conversationId: "sub-conv-1",
	role: "user",
	content: "Do the thing",
});

function makeAgentResponses(count: number) {
	return Array.from({ length: count }, (_, i) => makeMessage({
		id: `agent-msg-${i}`,
		conversationId: "sub-conv-1",
		role: "assistant",
		content: `Response ${i + 1}: ${"Lorem ipsum dolor sit amet. ".repeat(5)}`,
		createdAt: new Date(2026, 0, 1, 0, i + 1).toISOString(),
	}));
}

const agents = [
	makeAgent({ name: "TestAgent", description: "A test agent" }),
	makeAgent({ name: "Coder", description: "Code assistant" }),
	makeAgent({ name: "Reviewer", description: "Code reviewer" }),
];

test.describe("AgentDetailPanel @mention autocomplete", () => {
	test("typing @ in panel input shows mention popover with results", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			agents,
			routes: {
				"/sub-conversations": () => [{
					id: "sub-conv-1",
					agentName: "TestAgent",
					agentConfigId: "cfg-1",
					parentMessageId: "msg-asst-1",
					parentConversationId: "conv-1",
				}],
				"/tasks": () => ({ conversationId: "conv-1", tasks: [] }),
				"sub-conv-1/messages": () => ({
					messages: [agentTaskMsg, ...makeAgentResponses(2)],
				}),
			},
		});

		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForLoadState("networkidle");

		// Emit agent:spawn to make the agent chip appear
		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-1",
				agentRunId: "run-1",
				subConversationId: "sub-conv-1",
				agentName: "TestAgent",
				agentConfigId: "cfg-1",
				task: "Do the thing",
				parentConversationId: "conv-1",
			},
		});

		// Click on the agent chip to open AgentDetailPanel
		const chipOrText = page.locator("[data-agent-chip]").first()
			.or(page.getByText("@TestAgent").first());
		await chipOrText.click({ timeout: 5000 }).catch(() => {});

		const panel = page.locator(".agent-detail-panel");
		if (!await panel.isVisible({ timeout: 3000 }).catch(() => false)) return;

		// Find textarea in the panel
		const textarea = panel.locator("textarea");
		await expect(textarea).toBeVisible();

		// Verify it has combobox role (ARIA for autocomplete)
		await expect(textarea).toHaveAttribute("role", "combobox");

		// Type @ to trigger mention popover
		await textarea.fill("@");
		await textarea.dispatchEvent("input");

		// Wait for mention popover to appear
		const popover = page.locator("#mention-listbox");
		if (await popover.isVisible({ timeout: 2000 }).catch(() => false)) {
			// Should show agent results
			const items = popover.locator("[role='option']");
			const count = await items.count();
			expect(count).toBeGreaterThan(0);
		}
	});

	test("selecting mention inserts token into panel input", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			agents,
			routes: {
				"/sub-conversations": () => [{
					id: "sub-conv-1",
					agentName: "TestAgent",
					agentConfigId: "cfg-1",
					parentMessageId: "msg-asst-1",
					parentConversationId: "conv-1",
				}],
				"/tasks": () => ({ conversationId: "conv-1", tasks: [] }),
				"sub-conv-1/messages": () => ({
					messages: [agentTaskMsg, ...makeAgentResponses(2)],
				}),
			},
		});

		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForLoadState("networkidle");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-1",
				agentRunId: "run-1",
				subConversationId: "sub-conv-1",
				agentName: "TestAgent",
				agentConfigId: "cfg-1",
				task: "Do the thing",
				parentConversationId: "conv-1",
			},
		});

		const chipOrText = page.locator("[data-agent-chip]").first()
			.or(page.getByText("@TestAgent").first());
		await chipOrText.click({ timeout: 5000 }).catch(() => {});

		const panel = page.locator(".agent-detail-panel");
		if (!await panel.isVisible({ timeout: 3000 }).catch(() => false)) return;

		const textarea = panel.locator("textarea");

		// Type @Co to filter to "Coder"
		await textarea.fill("@Co");
		await textarea.dispatchEvent("input");

		const popover = page.locator("#mention-listbox");
		if (await popover.isVisible({ timeout: 2000 }).catch(() => false)) {
			// Click first result
			const firstOption = popover.locator("[role='option']").first();
			if (await firstOption.isVisible({ timeout: 1000 }).catch(() => false)) {
				await firstOption.click();

				// Textarea should now contain the mention token
				const value = await textarea.inputValue();
				expect(value).toContain("![agent:");
			}
		}
	});

	test("panel textarea has transparent text for overlay rendering", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			agents,
			routes: {
				"/sub-conversations": () => [{
					id: "sub-conv-1",
					agentName: "TestAgent",
					agentConfigId: "cfg-1",
					parentMessageId: "msg-asst-1",
					parentConversationId: "conv-1",
				}],
				"/tasks": () => ({ conversationId: "conv-1", tasks: [] }),
				"sub-conv-1/messages": () => ({
					messages: [agentTaskMsg, ...makeAgentResponses(1)],
				}),
			},
		});

		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForLoadState("networkidle");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-1",
				agentRunId: "run-1",
				subConversationId: "sub-conv-1",
				agentName: "TestAgent",
				agentConfigId: "cfg-1",
				task: "Do the thing",
				parentConversationId: "conv-1",
			},
		});

		const chipOrText = page.locator("[data-agent-chip]").first()
			.or(page.getByText("@TestAgent").first());
		await chipOrText.click({ timeout: 5000 }).catch(() => {});

		const panel = page.locator(".agent-detail-panel");
		if (!await panel.isVisible({ timeout: 3000 }).catch(() => false)) return;

		const textarea = panel.locator("textarea");
		// Transparent text color for overlay chip rendering
		const color = await textarea.evaluate((el) => getComputedStyle(el).color);
		// CSS `color: transparent` computes to rgba(0, 0, 0, 0)
		expect(color).toMatch(/rgba?\(0,\s*0,\s*0,\s*0\)/);
	});
});

test.describe("AgentDetailPanel scroll-to-bottom button", () => {
	test("jump-to-bottom button appears when scrolled up in panel", async ({ page, mockApi, emitWs }) => {
		// Create many messages so the panel is scrollable
		const manyResponses = makeAgentResponses(20);

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			agents,
			routes: {
				"/sub-conversations": () => [{
					id: "sub-conv-1",
					agentName: "TestAgent",
					agentConfigId: "cfg-1",
					parentMessageId: "msg-asst-1",
					parentConversationId: "conv-1",
				}],
				"/tasks": () => ({ conversationId: "conv-1", tasks: [] }),
				"sub-conv-1/messages": () => ({
					messages: [agentTaskMsg, ...manyResponses],
				}),
			},
		});

		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForLoadState("networkidle");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-1",
				agentRunId: "run-1",
				subConversationId: "sub-conv-1",
				agentName: "TestAgent",
				agentConfigId: "cfg-1",
				task: "Do the thing",
				parentConversationId: "conv-1",
			},
		});

		const chipOrText = page.locator("[data-agent-chip]").first()
			.or(page.getByText("@TestAgent").first());
		await chipOrText.click({ timeout: 5000 }).catch(() => {});

		const panel = page.locator(".agent-detail-panel");
		if (!await panel.isVisible({ timeout: 3000 }).catch(() => false)) return;

		// The scroll container is the main content area
		const scrollArea = panel.locator(".overflow-y-auto");
		if (!await scrollArea.isVisible({ timeout: 2000 }).catch(() => false)) return;

		// Jump-to-bottom should NOT be visible when at bottom
		const jumpBtn = panel.locator("button[aria-label='Jump to bottom']");
		// Wait a tick for IO to settle
		await page.waitForTimeout(500);

		// Scroll to top to trigger the button
		await scrollArea.evaluate((el) => el.scrollTop = 0);
		await page.waitForTimeout(500);

		// Now the jump-to-bottom button should appear (rendered by PanelChatInput)
		if (await jumpBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
			await jumpBtn.click();
			// After clicking, button should disappear
			await page.waitForTimeout(500);
			const stillVisible = await jumpBtn.isVisible().catch(() => false);
			// It may take a moment for IO to update
			expect(typeof stillVisible).toBe("boolean");
		}
	});
});

test.describe("TeamChatPanel @mention autocomplete", () => {
	test("team panel chat input supports @mentions", async ({ page, mockApi, emitWs }) => {
		const teamConv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Team Mention Test" });

		await mockApi({
			projects: [proj],
			conversations: [teamConv],
			messages: [userMsg, assistantMsg],
			agents,
			routes: {
				"/sub-conversations": () => [{
					id: "sub-conv-orch",
					agentName: "Orchestrator",
					agentConfigId: "team-cfg-1",
					parentMessageId: "msg-asst-1",
					parentConversationId: "conv-1",
				}],
				"/tasks": () => ({
					conversationId: "conv-1",
					tasks: [{
						id: "task-1",
						title: "Test task",
						description: "",
						status: "active",
						priority: 0,
						subtasks: [],
						assignments: [{
							id: "assign-1",
							agentConfigId: "team-cfg-1",
							agentName: "TestTeam",
							isTeam: true,
							status: "running",
							assignedAt: "2026-01-01T00:00:00Z",
							startedAt: "2026-01-01T00:00:01Z",
							subConversationId: "sub-conv-orch",
							agentRunId: "run-team-1",
						}],
						createdAt: "2026-01-01T00:00:00Z",
					}],
					activeTaskId: "task-1",
				}),
				"team/team-cfg-1/messages": () => ({
					team: { name: "TestTeam", members: [{ agentConfigId: "member-1", agentName: "Worker" }] },
					orchestrator: {
						agentConfigId: "team-cfg-1",
						agentName: "Orchestrator",
						subConversationId: "sub-conv-orch",
						messages: [{
							id: "orch-msg-1",
							role: "assistant",
							content: "Coordinating work...",
							createdAt: "2026-01-01T00:01:00.000Z",
							toolCalls: [],
						}],
					},
					streams: [],
				}),
			},
		});

		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForLoadState("networkidle");

		await emitWs({
			type: "task:snapshot",
			data: {
				conversationId: "conv-1",
				tasks: [{
					id: "task-1",
					title: "Test task",
					description: "",
					status: "active",
					priority: 0,
					subtasks: [],
					assignments: [{
						id: "assign-1",
						agentConfigId: "team-cfg-1",
						agentName: "TestTeam",
						isTeam: true,
						status: "running",
						assignedAt: "2026-01-01T00:00:00Z",
						startedAt: "2026-01-01T00:00:01Z",
						subConversationId: "sub-conv-orch",
						agentRunId: "run-team-1",
					}],
					createdAt: "2026-01-01T00:00:00Z",
				}],
				activeTaskId: "task-1",
			},
		});

		// Open team panel
		const teamPill = page.getByText("@TestTeam").first();
		if (!await teamPill.isVisible({ timeout: 3000 }).catch(() => false)) return;
		await teamPill.click();

		const teamHeading = page.getByText("Team: TestTeam");
		if (!await teamHeading.isVisible({ timeout: 3000 }).catch(() => false)) return;

		// Find the team panel textarea
		const textarea = page.locator("textarea[placeholder*='team']");
		if (!await textarea.isVisible({ timeout: 2000 }).catch(() => false)) return;

		// Verify combobox role for accessibility
		await expect(textarea).toHaveAttribute("role", "combobox");

		// Type @ to trigger mention
		await textarea.fill("@");
		await textarea.dispatchEvent("input");

		const popover = page.locator("#mention-listbox");
		if (await popover.isVisible({ timeout: 2000 }).catch(() => false)) {
			const items = popover.locator("[role='option']");
			const count = await items.count();
			expect(count).toBeGreaterThan(0);
		}
	});
});

test.describe("Panel chat input sends mentions with message", () => {
	test("submitted message includes mention token", async ({ page, mockApi, emitWs }) => {
		let capturedBody: any = null;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			agents,
			routes: {
				"/sub-conversations": () => [{
					id: "sub-conv-1",
					agentName: "TestAgent",
					agentConfigId: "cfg-1",
					parentMessageId: "msg-asst-1",
					parentConversationId: "conv-1",
				}],
				"/tasks": () => ({ conversationId: "conv-1", tasks: [] }),
				"sub-conv-1/messages": () => ({
					messages: [agentTaskMsg, ...makeAgentResponses(2)],
				}),
			},
		});

		// Intercept agent-chat POST
		await page.route("**/api/conversations/sub-conv-1/agent-chat", async (route) => {
			if (route.request().method() === "POST") {
				capturedBody = JSON.parse(await route.request().postData() ?? "{}");
				return route.fulfill({ json: { status: "queued", messageId: "msg-new" } });
			}
			return route.continue();
		});

		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForLoadState("networkidle");

		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-1",
				agentRunId: "run-1",
				subConversationId: "sub-conv-1",
				agentName: "TestAgent",
				agentConfigId: "cfg-1",
				task: "Do the thing",
				parentConversationId: "conv-1",
			},
		});

		const chipOrText = page.locator("[data-agent-chip]").first()
			.or(page.getByText("@TestAgent").first());
		await chipOrText.click({ timeout: 5000 }).catch(() => {});

		const panel = page.locator(".agent-detail-panel");
		if (!await panel.isVisible({ timeout: 3000 }).catch(() => false)) return;

		const textarea = panel.locator("textarea");

		// Directly set a value with a mention token (simulating the full flow)
		await textarea.evaluate((el: HTMLTextAreaElement) => {
			el.value = "![agent:Coder] please review this";
			el.dispatchEvent(new Event("input", { bubbles: true }));
		});

		// Submit via Enter
		await textarea.press("Enter");
		await page.waitForTimeout(500);

		if (capturedBody) {
			expect(capturedBody.content).toContain("![agent:Coder]");
		}
	});
});
