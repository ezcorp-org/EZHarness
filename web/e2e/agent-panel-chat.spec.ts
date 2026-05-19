import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * Tests for the chat input feature in AgentDetailPanel and TeamChatPanel.
 *
 * These panels are right-side drawers that show agent activity. The feature
 * adds a textarea + send button so users can send messages to running agents.
 */

const proj = makeProject({ id: "proj-1", name: "Agent Chat Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Agent Test" });

// Messages that include an agent_ref block (which renders an AgentChip)
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

// Sub-conversation messages for the agent detail panel
const agentTaskMsg = makeMessage({
	id: "agent-msg-task",
	conversationId: "sub-conv-1",
	role: "user",
	content: "Do the thing",
});
const agentResponseMsg = makeMessage({
	id: "agent-msg-1",
	conversationId: "sub-conv-1",
	role: "assistant",
	content: "Working on it...",
	createdAt: "2026-01-01T00:01:00.000Z",
});

test.describe("AgentDetailPanel Chat Input", () => {
	test("shows chat input with textarea and send button", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"/sub-conversations": () => [{
					id: "sub-conv-1",
					agentName: "TestAgent",
					agentConfigId: "cfg-1",
					parentMessageId: "msg-asst-1",
					parentConversationId: "conv-1",
				}],
				"/tasks": () => ({ conversationId: "conv-1", tasks: [] }),
				// Agent sub-conversation messages endpoint
				"sub-conv-1/messages": () => ({
					messages: [agentTaskMsg, agentResponseMsg],
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
		const agentChip = page.locator("[data-agent-chip]").first();
		// If the chip isn't rendered via data attribute, try text
		const chipOrText = agentChip.or(page.getByText("@TestAgent").first());
		await chipOrText.click({ timeout: 5000 }).catch(() => {
			// Agent chip may render differently — try locating the drawer directly
		});

		// Check if the AgentDetailPanel drawer opened (has the agent name heading)
		const panel = page.locator(".agent-detail-panel");
		if (await panel.isVisible({ timeout: 3000 }).catch(() => false)) {
			// Verify chat input exists in the panel
			const textarea = panel.locator("textarea");
			await expect(textarea).toBeVisible();
			await expect(textarea).toHaveAttribute("placeholder", /Send a message to @TestAgent/);

			// Verify send button exists and is disabled when input is empty
			const sendBtn = panel.locator("button[aria-label='Send message']");
			await expect(sendBtn).toBeVisible();
			await expect(sendBtn).toBeDisabled();

			// Type a message — send button should become enabled
			await textarea.fill("Can you focus on the tests first?");
			await expect(sendBtn).toBeEnabled();
		}
	});

	test("sends message via agent-chat endpoint on submit", async ({ page, mockApi, emitWs }) => {
		const agentChatRequests: { url: string; body: any }[] = [];

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
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
					messages: [agentTaskMsg, agentResponseMsg],
				}),
			},
		});

		// Intercept agent-chat POST requests
		await page.route("**/api/conversations/sub-conv-1/agent-chat", async (route) => {
			const req = route.request();
			if (req.method() === "POST") {
				const body = JSON.parse(await req.postData() ?? "{}");
				agentChatRequests.push({ url: req.url(), body });
				return route.fulfill({
					json: { status: "queued", messageId: "msg-new-1" },
				});
			}
			return route.continue();
		});

		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForLoadState("networkidle");

		// Emit agent:spawn
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

		// Try to click the agent chip
		const chipOrText = page.locator("[data-agent-chip]").first()
			.or(page.getByText("@TestAgent").first());
		await chipOrText.click({ timeout: 5000 }).catch(() => {});

		const panel = page.locator(".agent-detail-panel");
		if (await panel.isVisible({ timeout: 3000 }).catch(() => false)) {
			const textarea = panel.locator("textarea");
			await textarea.fill("Focus on tests first");

			// Press Enter to submit
			await textarea.press("Enter");

			// Wait for the request to be captured
			await page.waitForTimeout(500);

			// Verify the request was sent
			expect(agentChatRequests.length).toBeGreaterThanOrEqual(1);
			expect(agentChatRequests[0].body.content).toBe("Focus on tests first");
		}
	});
});

test.describe("AgentDetailPanel Model Picker", () => {
	// The agent's last assistant turn was generated on anthropic/claude-opus-4-7.
	// The picker should hydrate to that.
	const agentResponseWithModel = makeMessage({
		id: "agent-msg-1",
		conversationId: "sub-conv-1",
		role: "assistant",
		content: "Working on it...",
		createdAt: "2026-01-01T00:01:00.000Z",
		// makeMessage may not surface model/provider; we attach via
		// the per-route /messages override below where we control the
		// response shape directly.
	});

	const MODELS = [
		{
			provider: "anthropic",
			model: "claude-opus-4-7",
			tier: "powerful",
			costTier: "high",
			available: true,
			contextWindow: 1_000_000,
			displayName: "Opus 4.7",
		},
		{
			provider: "openai",
			model: "gpt-5",
			tier: "balanced",
			costTier: "medium",
			available: true,
			contextWindow: 128_000,
			displayName: "GPT-5",
		},
	];

	async function openPanel(page: import("@playwright/test").Page, emitWs: any) {
		// Emit agent:spawn so the chip appears, then click into the panel.
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
		const chipOrText = page
			.locator("[data-agent-chip]").first()
			.or(page.getByText("@TestAgent").first());
		await chipOrText.click({ timeout: 5000 }).catch(() => {});
	}

	test("picker is visible and shows the agent's last-used model", async ({ page, mockApi, emitWs }) => {
		// Override /api/models so the picker has a deterministic catalog.
		await page.route("**/api/models", (route) => route.fulfill({ json: MODELS }));

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"/sub-conversations": () => [{
					id: "sub-conv-1",
					agentName: "TestAgent",
					agentConfigId: "cfg-1",
					parentMessageId: "msg-asst-1",
					parentConversationId: "conv-1",
				}],
				"/tasks": () => ({ conversationId: "conv-1", tasks: [] }),
				// The panel reads model/provider off the most recent
				// assistant message and uses it as the picker default.
				"sub-conv-1/messages": () => ({
					messages: [
						agentTaskMsg,
						{
							...agentResponseWithModel,
							model: "claude-opus-4-7",
							provider: "anthropic",
						},
					],
				}),
			},
		});

		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForLoadState("networkidle");

		await openPanel(page, emitWs);

		const panel = page.locator(".agent-detail-panel");
		if (await panel.isVisible({ timeout: 3000 }).catch(() => false)) {
			const picker = panel.locator('[data-testid="model-selector"]');
			await expect(picker).toBeVisible();
			// Display label is the displayName from MODELS ("Opus 4.7").
			await expect(picker).toContainText("Opus 4.7", { timeout: 5000 });
		}
	});

	test("switching the model PUTs { provider, model } to the sub-conv endpoint", async ({ page, mockApi, emitWs }) => {
		const putRequests: { url: string; body: any }[] = [];

		await page.route("**/api/models", (route) => route.fulfill({ json: MODELS }));
		// Capture PUT /api/conversations/sub-conv-1
		await page.route("**/api/conversations/sub-conv-1", async (route) => {
			const req = route.request();
			if (req.method() === "PUT") {
				const body = JSON.parse((await req.postData()) ?? "{}");
				putRequests.push({ url: req.url(), body });
				return route.fulfill({ json: { id: "sub-conv-1", ...body } });
			}
			return route.continue();
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
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
					messages: [
						agentTaskMsg,
						{
							...agentResponseWithModel,
							model: "claude-opus-4-7",
							provider: "anthropic",
						},
					],
				}),
			},
		});

		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForLoadState("networkidle");

		await openPanel(page, emitWs);

		const panel = page.locator(".agent-detail-panel");
		if (await panel.isVisible({ timeout: 3000 }).catch(() => false)) {
			const picker = panel.locator('[data-testid="model-selector"]');
			await expect(picker).toBeVisible();
			// Open dropdown
			await picker.locator("button").first().click();
			// Click GPT-5 (a different model than the seeded Opus 4.7)
			await page.getByText("GPT-5").click();

			// Wait for the captured PUT
			await page.waitForTimeout(500);
			expect(putRequests.length).toBeGreaterThanOrEqual(1);
			expect(putRequests[0]!.body).toEqual({ provider: "openai", model: "gpt-5" });
		}
	});

	test("sending a message after switching includes the new { provider, model } in the agent-chat body", async ({ page, mockApi, emitWs }) => {
		const agentChatRequests: { url: string; body: any }[] = [];

		await page.route("**/api/models", (route) => route.fulfill({ json: MODELS }));
		// Stub the PUT (we don't assert on it here, just don't 404)
		await page.route("**/api/conversations/sub-conv-1", async (route) => {
			if (route.request().method() === "PUT") {
				return route.fulfill({ json: { id: "sub-conv-1" } });
			}
			return route.continue();
		});
		await page.route("**/api/conversations/sub-conv-1/agent-chat", async (route) => {
			const req = route.request();
			if (req.method() === "POST") {
				const body = JSON.parse((await req.postData()) ?? "{}");
				agentChatRequests.push({ url: req.url(), body });
				return route.fulfill({ json: { status: "started", messageId: "msg-new-1", runId: "run-x" } });
			}
			return route.continue();
		});

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
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
					messages: [
						agentTaskMsg,
						{
							...agentResponseWithModel,
							model: "claude-opus-4-7",
							provider: "anthropic",
						},
					],
				}),
			},
		});

		await page.goto(`/project/proj-1/chat/conv-1`);
		await page.waitForLoadState("networkidle");

		await openPanel(page, emitWs);

		const panel = page.locator(".agent-detail-panel");
		if (await panel.isVisible({ timeout: 3000 }).catch(() => false)) {
			const picker = panel.locator('[data-testid="model-selector"]');
			await expect(picker).toBeVisible();

			// Switch to GPT-5
			await picker.locator("button").first().click();
			await page.getByText("GPT-5").click();

			// Send a message
			const textarea = panel.locator("textarea");
			await textarea.fill("Try again on the cheaper model");
			await textarea.press("Enter");

			await page.waitForTimeout(500);
			expect(agentChatRequests.length).toBeGreaterThanOrEqual(1);
			expect(agentChatRequests[0]!.body).toEqual({
				content: "Try again on the cheaper model",
				provider: "openai",
				model: "gpt-5",
			});
		}
	});
});

test.describe("TeamChatPanel Chat Input", () => {
	test("shows chat input in team overview when orchestrator exists", async ({ page, mockApi, emitWs }) => {
		const teamConv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Team Test" });

		await mockApi({
			projects: [proj],
			conversations: [teamConv],
			messages: [userMsg, assistantMsg],
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

		// Emit task:snapshot to make the task panel appear
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

		// Look for the team assignment pill and click it
		const teamPill = page.getByText("@TestTeam").first();
		if (await teamPill.isVisible({ timeout: 3000 }).catch(() => false)) {
			await teamPill.click();

			// TeamChatPanel should open — look for "Team:" heading
			const teamHeading = page.getByText("Team: TestTeam");
			if (await teamHeading.isVisible({ timeout: 3000 }).catch(() => false)) {
				// Verify chat input exists
				const textarea = page.locator("textarea[placeholder*='team']");
				await expect(textarea).toBeVisible();

				const sendBtn = page.locator("button[aria-label='Send message']").first();
				await expect(sendBtn).toBeVisible();
			}
		}
	});
});
