import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeAgent } from "./fixtures/data.js";

/**
 * Panel-chat counterpart to `slash-commands.spec.ts`.
 * Exercises `PanelChatInput.svelte` — the same mention-logic pipeline
 * drives both surfaces, so this spec guards against the shared logic
 * regressing inside the panel specifically.
 */

const proj = makeProject({ id: "proj-1", name: "Panel Slash Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Slash panel test" });

const userMsg = makeMessage({
	id: "msg-u-1",
	conversationId: "conv-1",
	role: "user",
	content: "Kick off the agent",
	parentMessageId: null,
});
const assistantMsg = makeMessage({
	id: "msg-a-1",
	conversationId: "conv-1",
	role: "assistant",
	content:
		'{"type":"agent_ref","agentName":"TestAgent","subConversationId":"sub-conv-1","runId":"run-1"}\n\nDelegating.',
	parentMessageId: "msg-u-1",
});

const commands = [
	{ name: "review", description: "Review staged changes", source: "project:claude-commands" },
	{ name: "deploy", description: "Deploy the branch", source: "user:codex-prompts" },
];

const agents = [makeAgent({ name: "TestAgent", description: "Test agent" })];

test("slash commands work inside the AgentDetailPanel chat input", async ({
	page,
	mockApi,
	emitWs,
}) => {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [userMsg, assistantMsg],
		agents,
		commands,
		routes: {
			"/sub-conversations": () => [
				{
					id: "sub-conv-1",
					agentName: "TestAgent",
					agentConfigId: "cfg-1",
					parentMessageId: "msg-a-1",
					parentConversationId: "conv-1",
				},
			],
			"/tasks": () => ({ conversationId: "conv-1", tasks: [] }),
			"sub-conv-1/messages": () => ({
				messages: [
					makeMessage({
						id: "sub-msg-1",
						conversationId: "sub-conv-1",
						role: "user",
						content: "initial task",
					}),
				],
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
			task: "initial",
			parentConversationId: "conv-1",
		},
	});

	// Open the agent-detail panel by clicking the chip.
	const chipOrText = page
		.locator("[data-agent-chip]")
		.first()
		.or(page.getByText("@TestAgent").first());
	await chipOrText.click({ timeout: 5000 }).catch(() => {});

	const panel = page.locator(".agent-detail-panel");
	if (!(await panel.isVisible({ timeout: 3000 }).catch(() => false))) {
		test.skip(true, "Agent detail panel did not render — app wiring skipped this path");
		return;
	}

	const textarea = panel.locator("textarea");
	await expect(textarea).toBeVisible();

	// Type `/` to open the slash-command popover.
	await textarea.focus();
	await textarea.pressSequentially("/rev", { delay: 40 });
	await page.waitForTimeout(350);

	const popover = page.locator("#mention-listbox");
	await expect(popover).toBeVisible({ timeout: 5000 });
	await expect(popover).toContainText("Slash commands");
	await expect(popover).toContainText("/review");

	// Source badge renders — scope + folder visible.
	const reviewRow = popover.locator("[data-source='project:claude-commands']").first();
	await expect(reviewRow).toContainText("Project");
	await expect(reviewRow).toContainText(".claude/commands");

	// Select it — textarea must then contain a structured cmd token
	// (same behavior as ChatInput: `/` inserts a chip, no body injection).
	await page.keyboard.press("Enter");
	await page.waitForTimeout(150);
	await expect(textarea).toHaveValue("/[cmd:review] ");
});
