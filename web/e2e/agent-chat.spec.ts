import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeConversation } from "./fixtures/data.js";

test.describe("Agent Chat Flow", () => {
	test("config agent detail page shows Chat button", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({
					name: "chat-agent",
					source: "config",
					id: "cfg-1",
					prompt: "You are helpful.",
				}),
			],
		});
		await page.goto("/agents/chat-agent");

		await expect(page.getByTestId("agent-chat-cta")).toBeVisible();
	});

	test("file agent detail page does NOT show Chat button", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "file-agent", source: "file", id: null, prompt: null }),
			],
		});
		await page.goto("/agents/file-agent");

		await expect(page.getByTestId("agent-chat-cta")).not.toBeVisible();
	});

	test("Chat button creates conversation and navigates to chat", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({
					name: "chat-agent",
					source: "config",
					id: "cfg-1",
					prompt: "You are helpful.",
				}),
			],
		});
		// handleChat requires a non-"global" activeProjectId — seed it via localStorage
		// before navigation so the store reads it on init. (SUT semantic added post-v1.3.)
		await page.addInitScript(() => {
			localStorage.setItem("activeProjectId", "proj-1");
		});
		await page.goto("/agents/chat-agent");

		await page.getByTestId("agent-chat-cta").click();

		// Should navigate to a chat URL
		await page.waitForURL(/\/project\/.*\/chat\//, { timeout: 5000 });
	});

	test("agent conversation shows 'Agent conversation' subtitle in sidebar", async ({ page, mockApi }) => {
		const agentConv = makeConversation({
			id: "agent-conv-1",
			projectId: "proj-1",
			title: "Chat with my-agent",
			agentConfigId: "cfg-1",
			systemPrompt: "You are a helpful agent.",
			updatedAt: new Date().toISOString(),
		});
		const regularConv = makeConversation({
			id: "regular-conv-1",
			projectId: "proj-1",
			title: "Regular Chat",
			agentConfigId: null,
			updatedAt: new Date().toISOString(),
		});

		await mockApi({
			conversations: [agentConv, regularConv],
		});

		await page.goto("/project/proj-1/chat/agent-conv-1");

		// On mobile, the ConversationList sidebar lives inside a SwipeDrawer that
		// mounts children only when opened. Tap the hamburger before asserting.
		// Once opened, BOTH ConversationLists are in DOM (desktop CSS-hidden +
		// mobile drawer-mounted), so we scope the assertion to the drawer to
		// avoid strict-mode collision.
		const isMobile = (page.viewportSize()?.width ?? 0) < 768;
		if (isMobile) {
			await page.getByRole("button", { name: "Open conversations" }).click();
		}
		const sidebar = isMobile ? page.getByTestId("swipe-drawer") : page;

		// Agent conversation should show "Agent conversation" subtitle
		await expect(sidebar.getByText("Agent conversation")).toBeVisible();
		// Regular conversation should NOT have that subtitle
		await expect(sidebar.getByText("Regular Chat")).toBeVisible();
	});

	test("agent conversation settings shows read-only system prompt", async ({ page, mockApi }) => {
		const agentConv = makeConversation({
			id: "agent-conv-1",
			projectId: "proj-1",
			title: "Chat with my-agent",
			agentConfigId: "cfg-1",
			systemPrompt: "You are a helpful agent.",
			updatedAt: new Date().toISOString(),
		});

		await mockApi({
			conversations: [agentConv],
		});

		await page.goto("/project/proj-1/chat/agent-conv-1");
		await page.waitForLoadState("networkidle");

		// Open settings
		await page.getByLabel("Conversation settings").click();

		// Should show read-only prompt managed by agent
		await expect(page.getByText("managed by the agent persona")).toBeVisible();
		await expect(page.getByText("Managed by agent persona")).toBeVisible();

		// Should NOT have an editable textarea for system prompt
		await expect(page.locator("#conv-prompt")).not.toBeVisible();
	});

	test("regular conversation settings shows editable system prompt", async ({ page, mockApi }) => {
		const regularConv = makeConversation({
			id: "regular-conv-1",
			projectId: "proj-1",
			title: "Regular Chat",
			agentConfigId: null,
			updatedAt: new Date().toISOString(),
		});

		await mockApi({
			conversations: [regularConv],
		});

		await page.goto("/project/proj-1/chat/regular-conv-1");
		await page.waitForLoadState("networkidle");

		// Open settings
		await page.getByLabel("Conversation settings").click();

		// Should have an editable textarea
		await expect(page.locator("#conv-prompt")).toBeVisible();

		// Should NOT show agent-managed text
		await expect(page.getByText("managed by the agent persona")).not.toBeVisible();
	});
});
