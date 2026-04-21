import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeAgent, makeAgentConfig, makeMessage } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

const proj = makeProject({ id: "proj-1", name: "Team Project" });
const conv = makeConversation({ id: "conv-1", projectId: "proj-1" });

const agents = [
	makeAgent({ name: "Code Assistant", description: "Helps write code" }),
	makeAgent({ name: "Summarizer", description: "Summarizes text" }),
];

const teamConfig = makeAgentConfig({
	id: "team-1",
	name: "Engineering Team",
	description: "A team of engineering agents",
	category: "team",
	references: { agents: ["Code Assistant", "Summarizer"], extensions: [] },
});

const modelsRoute = {
	"/api/models": () => [
		{ provider: "openai", model: "gpt-4", displayName: "GPT-4", available: true },
	],
};

// ── Helpers ────────────────────────────────────────────────────────────

async function setupAndFocus(page: Page, mockApi: any, overrides: Record<string, any> = {}) {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [],
		agents,
		agentConfigs: [teamConfig],
		...overrides,
	});
	await page.goto(`/project/${proj.id}/chat/${conv.id}`);
	await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

	const textarea = page.locator("textarea");

	// Retry firing open events until WS connection is established
	await page.waitForFunction(() => {
		const listeners = (window as any).__fakeWsListeners;
		if (listeners?.open) {
			for (const fn of listeners.open) {
				try { fn(new Event("open")); } catch {}
			}
		}
		const ta = document.querySelector("textarea");
		return ta && !ta.disabled;
	}, { timeout: 5000 });

	await expect(textarea).toBeEnabled({ timeout: 5000 });
	await page.waitForTimeout(100);
	await textarea.click();
	return textarea;
}

async function typeIntoTextarea(page: Page, textarea: any, text: string) {
	await textarea.focus();
	await textarea.pressSequentially(text, { delay: 50 });
	await page.waitForTimeout(350);
}

async function waitForPopover(page: Page) {
	await expect(page.locator("#mention-listbox")).toBeVisible({ timeout: 5000 });
}

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

// ── Team mention autocomplete ──────────────────────────────────────────

test.describe("Team Orchestration", () => {
	test("!team: prefix shows Teams heading and team name in popover", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!team:");

		await waitForPopover(page);

		const listbox = page.locator("#mention-listbox");
		await expect(listbox.getByText("Teams")).toBeVisible({ timeout: 3000 });
		await expect(listbox.getByText("Engineering Team")).toBeVisible({ timeout: 3000 });
		// Agents should not appear when filtered to team: prefix
		await expect(listbox.getByText("Code Assistant")).not.toBeVisible();
	});

	test("selecting team from popover inserts ![team:TeamName] token", async ({ page, mockApi }) => {
		const textarea = await setupAndFocus(page, mockApi);
		await typeIntoTextarea(page, textarea, "!team:");

		await waitForPopover(page);
		await expect(page.locator("#mention-listbox").getByText("Engineering Team")).toBeVisible({ timeout: 3000 });

		await page.keyboard.press("Enter");

		// Popover should close
		await expect(page.locator("#mention-listbox")).not.toBeVisible();

		// Textarea should contain the team mention token
		await expect(textarea).toHaveValue(/!\[team:Engineering Team\] /);
	});

	// ── Inline agent chips in chat messages ──────────────────────────────

	test("inline agent chips show in streaming message with completion counter", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			agents,
			agentConfigs: [teamConfig],
			routes: modelsRoute,
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Use the team");

		// Spawn two agents
		await emitWs({
			type: "agent:spawn",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "Research papers",
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
				task: "Write code",
				agentRunId: "agent-run-2",
			},
		});

		// Agent chips appear inline within the streaming message
		const chips = page.locator(".agent-chip");
		await expect(chips).toHaveCount(2, { timeout: 5000 });

		// Agent chips are visible inline
		await expect(page.getByText("researcher")).toBeVisible({ timeout: 3000 });
		await expect(page.getByText("coder")).toBeVisible({ timeout: 3000 });

		// Completion counter shows 0/2 complete
		await expect(page.getByText("0/2 complete")).toBeVisible({ timeout: 3000 });

		// Complete one agent
		await emitWs({
			type: "agent:complete",
			data: {
				runId: "run-stream",
				subConversationId: "sub-1",
				success: true,
				resultPreview: "Done researching",
			},
		});

		// Counter updates to 1/2
		await expect(page.getByText("1/2 complete")).toBeVisible({ timeout: 3000 });

		// No global sticky bar exists
		await expect(page.getByTestId("sticky-agent-bar")).not.toBeVisible();
	});

	test("completion counter only visible with 2+ agents", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			agents,
			agentConfigs: [teamConfig],
			routes: modelsRoute,
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Use the team");

		// Spawn single agent — counter should NOT appear
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

		await expect(page.locator(".agent-chip")).toHaveCount(1, { timeout: 5000 });
		// No counter with single agent
		await expect(page.getByText(/\d+\/\d+ complete/)).not.toBeVisible();

		// Spawn second agent — counter should appear
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

		await expect(page.locator(".agent-chip")).toHaveCount(2, { timeout: 5000 });
		await expect(page.getByText("0/2 complete")).toBeVisible({ timeout: 3000 });
	});

	// ── Per-message agent scoping ─────────────────────────────────────────

	test("historical agent chips scoped to their specific assistant messages", async ({ page, mockApi }) => {
		// Two assistant messages, each with different agents anchored via parentMessageId
		const msgUser1 = makeMessage({ id: "msg-u1", conversationId: conv.id, role: "user", content: "Use team A" });
		const msgAsst1 = makeMessage({ id: "msg-a1", conversationId: conv.id, role: "assistant", content: "Team A results", parentMessageId: "msg-u1" });
		const msgUser2 = makeMessage({ id: "msg-u2", conversationId: conv.id, role: "user", content: "Use team B", parentMessageId: "msg-a1" });
		const msgAsst2 = makeMessage({ id: "msg-a2", conversationId: conv.id, role: "assistant", content: "Team B results", parentMessageId: "msg-u2" });

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [msgUser1, msgAsst1, msgUser2, msgAsst2],
			agents,
			agentConfigs: [teamConfig],
			routes: modelsRoute,
			subConversations: [
				// Team A agents — anchored to msg-a1
				{ id: "sub-1", agentName: "researcher", agentConfigId: "cfg-1", parentMessageId: "msg-a1", parentConversationId: conv.id },
				{ id: "sub-2", agentName: "coder", agentConfigId: "cfg-2", parentMessageId: "msg-a1", parentConversationId: conv.id },
				// Team B agent — anchored to msg-a2
				{ id: "sub-3", agentName: "reviewer", agentConfigId: "cfg-3", parentMessageId: "msg-a2", parentConversationId: conv.id },
			],
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Wait for messages to load
		await expect(page.getByText("Team A results")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Team B results")).toBeVisible({ timeout: 5000 });

		// All agent chips should be visible inline with their messages
		const allChips = page.locator(".agent-chip");
		await expect(allChips).toHaveCount(3, { timeout: 5000 });

		// Agent names visible in the conversation, inline with their messages
		await expect(page.getByText("researcher")).toBeVisible();
		await expect(page.getByText("coder")).toBeVisible();
		await expect(page.getByText("reviewer")).toBeVisible();
	});

	// ── Human input card ───────────────────────────────────────────────────

	test("human input card appears and transitions to responded state", async ({ page, mockApi, emitWs }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			agents,
			agentConfigs: [teamConfig],
			routes: {
				...modelsRoute,
				"/api/orchestrator/human-input": () => ({ success: true }),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await expect(page.getByText("Send a message to start the conversation")).toBeVisible();

		await sendAndWaitForStream(page, "Start orchestration");

		// Fire human input request
		await emitWs({
			type: "orchestrator:human_input",
			data: {
				runId: "run-stream",
				conversationId: "conv-1",
				question: "Should we proceed with the refactor?",
				requestId: "hir-1",
			},
		});

		// Assert the amber input card appears with the question text
		const card = page.locator(".border-amber-500\\/30");
		await expect(card).toBeVisible({ timeout: 5000 });
		await expect(card.getByText("Should we proceed with the refactor?")).toBeVisible();

		// Type a response in the input field
		const inputField = card.locator('input[type="text"]');
		await inputField.fill("Yes, go ahead");

		// Click the Respond button
		await card.getByRole("button", { name: "Respond" }).click();

		// Card should transition to "Responded" state with green checkmark
		const checkmark = card.locator("svg path[d='M5 13l4 4L19 7']");
		await expect(checkmark).toBeVisible({ timeout: 5000 });
	});
});

// ── Team builder form ─────────────────────────────────────────────────

test.describe("team builder form", () => {
	const nonTeamAgentConfigs = [
		makeAgentConfig({ id: "ac-1", name: "Reviewer", description: "Reviews code", category: null }),
		makeAgentConfig({ id: "ac-2", name: "Fixer", description: "Fixes code", category: null }),
	];

	const teamAgentConfig = makeAgentConfig({
		id: "ac-3",
		name: "QA Team",
		description: "QA workflow",
		category: "team",
		references: {
			agents: ["ac-1", "ac-2"],
			extensions: [],
			members: [{ agentConfigId: "ac-1" }, { agentConfigId: "ac-2" }],
		},
	});

	const allAgentConfigs = [...nonTeamAgentConfigs, teamAgentConfig];

	// Agents returned by GET /api/agents — mirrors the agentConfigs but as Agent objects
	const nonTeamAgents = [
		makeAgent({ name: "Reviewer", description: "Reviews code", category: null, id: "ac-1", source: "config" }),
		makeAgent({ name: "Fixer", description: "Fixes code", category: null, id: "ac-2", source: "config" }),
	];

	const teamAgent = makeAgent({
		name: "QA Team",
		description: "QA workflow",
		category: "team",
		id: "ac-3",
		source: "config",
	});

	const allAgents = [...nonTeamAgents, teamAgent];

	test("navigate to team builder via New Team button", async ({ page, mockApi }) => {
		await mockApi({
			agents: allAgents,
			agentConfigs: allAgentConfigs,
		});

		await page.goto("/agents");

		// Click the Teams tab
		await page.getByRole("button", { name: "Teams" }).click();

		// Click the "+ New Team" button
		await page.getByRole("link", { name: "+ New Team" }).click();

		// Assert page shows "New Team" heading
		await expect(page.getByRole("heading", { name: "New Team" })).toBeVisible({ timeout: 5000 });

		// Assert "Coordination Instructions" label exists (not "System Prompt")
		await expect(page.getByText("Coordination Instructions")).toBeVisible();
		await expect(page.getByText("System Prompt")).not.toBeVisible();
	});

	test("add member to team", async ({ page, mockApi }) => {
		await mockApi({
			agents: nonTeamAgents,
			agentConfigs: nonTeamAgentConfigs,
		});

		await page.goto("/agents/new?type=team");

		// Wait for the form to render
		await expect(page.getByRole("heading", { name: "New Team" })).toBeVisible({ timeout: 5000 });

		// Assert empty state text
		await expect(page.getByText("No members added yet")).toBeVisible();

		// Type in the search picker to find and select an agent
		const searchInput = page.getByPlaceholder("Search and add a member...");
		await searchInput.click();
		await searchInput.fill("Reviewer");
		await page.waitForTimeout(200);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");

		// Assert the agent name appears in the member tree
		await expect(page.locator(".font-medium", { hasText: "Reviewer" })).toBeVisible({ timeout: 3000 });

		// The empty state text should be gone
		await expect(page.getByText("No members added yet")).not.toBeVisible();
	});

	test("auto-invoke checkbox is visible and toggleable", async ({ page, mockApi }) => {
		await mockApi({
			agents: nonTeamAgents,
			agentConfigs: nonTeamAgentConfigs,
		});

		await page.goto("/agents/new?type=team");
		await expect(page.getByRole("heading", { name: "New Team" })).toBeVisible({ timeout: 5000 });

		// Assert "Auto-invoke all members" text is visible
		await expect(page.getByText("Auto-invoke all members")).toBeVisible();

		// Assert the checkbox exists and is not checked by default
		const checkbox = page.locator('input[type="checkbox"]');
		await expect(checkbox).toBeVisible();
		await expect(checkbox).not.toBeChecked();

		// Click the checkbox
		await checkbox.check();

		// Assert it becomes checked
		await expect(checkbox).toBeChecked();

		// Assert the explanation text is visible
		await expect(page.getByText("When enabled, all team members are invoked")).toBeVisible();
	});

	test("agents and teams tab navigation", async ({ page, mockApi }) => {
		await mockApi({
			agents: allAgents,
			agentConfigs: allAgentConfigs,
		});

		await page.goto("/agents");

		// "Agents" tab is active by default (has border-b-2 border-blue-500)
		const agentsTab = page.getByRole("button", { name: "Agents", exact: true });
		await expect(agentsTab).toBeVisible({ timeout: 5000 });
		await expect(agentsTab).toHaveClass(/border-blue-500/);

		// Non-team agents should be visible
		await expect(page.getByText("Reviewer")).toBeVisible();
		await expect(page.getByText("Fixer")).toBeVisible();

		// Click Teams tab
		const teamsTab = page.getByRole("button", { name: "Teams" });
		await teamsTab.click();

		// Teams tab should now be active
		await expect(teamsTab).toHaveClass(/border-blue-500/);

		// Team name should be visible
		await expect(page.getByText("QA Team")).toBeVisible({ timeout: 3000 });

		// "+ New Team" button should be visible on Teams tab
		await expect(page.getByRole("link", { name: "+ New Team" })).toBeVisible();
	});
});

// ── Agent search picker (typeahead) ─────────────────────────────────────

test.describe("agent search picker", () => {
	const pickerAgentConfigs = [
		makeAgentConfig({
			id: "ac-rev",
			name: "Reviewer",
			description: "Reviews pull requests carefully",
			prompt: "You are a meticulous code reviewer.",
			category: null,
		}),
		makeAgentConfig({
			id: "ac-fix",
			name: "Fixer",
			description: "Fixes bugs in production code",
			prompt: "You are a bug-fixing specialist.",
			category: null,
		}),
		makeAgentConfig({
			id: "ac-doc",
			name: "Documenter",
			description: "Writes technical documentation",
			prompt: "You are a documentation expert.",
			category: null,
		}),
	];

	const pickerAgents = pickerAgentConfigs.map((c) =>
		makeAgent({ id: c.id, name: c.name, description: c.description, category: null, source: "config" }),
	);

	async function openTeamBuilder(page: Page, mockApi: any) {
		await mockApi({
			agents: pickerAgents,
			agentConfigs: pickerAgentConfigs,
		});
		await page.goto("/agents/new?type=team");
		await expect(page.getByRole("heading", { name: "New Team" })).toBeVisible({ timeout: 5000 });
	}

	function searchInput(page: Page) {
		return page.getByPlaceholder("Search and add a member...");
	}

	function listbox(page: Page) {
		return page.locator("#agent-picker-listbox");
	}

	test("typeahead filters agents by name", async ({ page, mockApi }) => {
		await openTeamBuilder(page, mockApi);

		const input = searchInput(page);
		await input.click();
		await input.pressSequentially("Rev", { delay: 30 });

		const lb = listbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("Reviewer")).toBeVisible();
		await expect(lb.getByText("Fixer")).not.toBeVisible();
		await expect(lb.getByText("Documenter")).not.toBeVisible();
	});

	test("typeahead filters agents by description", async ({ page, mockApi }) => {
		await openTeamBuilder(page, mockApi);

		const input = searchInput(page);
		await input.click();
		await input.pressSequentially("documentation", { delay: 30 });

		const lb = listbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("Documenter")).toBeVisible();
		await expect(lb.getByText("Reviewer")).not.toBeVisible();
		await expect(lb.getByText("Fixer")).not.toBeVisible();
	});

	test("keyboard navigation and selection", async ({ page, mockApi }) => {
		await openTeamBuilder(page, mockApi);

		const input = searchInput(page);
		await input.click();
		await input.pressSequentially("Fix", { delay: 30 });

		const lb = listbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("Fixer")).toBeVisible();

		// Arrow down to highlight the first (only) item
		await page.keyboard.press("ArrowDown");
		const option = lb.locator('[role="option"]').filter({ hasText: "Fixer" });
		await expect(option).toHaveAttribute("aria-selected", "true");

		// Press Enter to select
		await page.keyboard.press("Enter");

		// Dropdown should close
		await expect(lb).not.toBeVisible();

		// Agent should appear in the team member list
		await expect(page.locator(".font-medium", { hasText: "Fixer" })).toBeVisible({ timeout: 3000 });
	});

	test("shows agent details on highlight", async ({ page, mockApi }) => {
		await openTeamBuilder(page, mockApi);

		const input = searchInput(page);
		await input.click();
		await input.pressSequentially("Rev", { delay: 30 });

		const lb = listbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });

		// Arrow down to highlight the Reviewer
		await page.keyboard.press("ArrowDown");

		const option = lb.locator('[role="option"]').filter({ hasText: "Reviewer" });
		await expect(option).toHaveAttribute("aria-selected", "true");

		// System Prompt detail section should appear within the highlighted item
		await expect(option.getByText("System Prompt")).toBeVisible({ timeout: 3000 });
		await expect(option.getByText("You are a meticulous code reviewer.")).toBeVisible();
	});

	test("empty state shows 'No matching agents'", async ({ page, mockApi }) => {
		await openTeamBuilder(page, mockApi);

		const input = searchInput(page);
		await input.click();
		await input.pressSequentially("zzzznonexistent", { delay: 30 });

		const lb = listbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("No matching agents")).toBeVisible();
	});

	test("ARIA attributes are correct", async ({ page, mockApi }) => {
		await openTeamBuilder(page, mockApi);

		const input = searchInput(page);

		// Verify combobox role
		await expect(input).toHaveAttribute("role", "combobox");
		await expect(input).toHaveAttribute("aria-haspopup", "listbox");

		// Focus to open the dropdown
		await input.click();

		// aria-expanded should be true when open
		await expect(input).toHaveAttribute("aria-expanded", "true");

		// The dropdown listbox
		const lb = listbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb).toHaveAttribute("role", "listbox");

		// Each item should have role="option"
		const options = lb.locator('[role="option"]');
		const count = await options.count();
		expect(count).toBe(pickerAgentConfigs.length);
		for (let i = 0; i < count; i++) {
			await expect(options.nth(i)).toHaveAttribute("role", "option");
		}
	});

	test("click-outside closes dropdown", async ({ page, mockApi }) => {
		await openTeamBuilder(page, mockApi);

		const input = searchInput(page);
		await input.click();

		const lb = listbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });

		// Click on the page heading (outside the dropdown)
		await page.getByRole("heading", { name: "New Team" }).click();

		// Dropdown should close
		await expect(lb).not.toBeVisible({ timeout: 3000 });
	});

	test("mouse click selects agent", async ({ page, mockApi }) => {
		await openTeamBuilder(page, mockApi);

		const input = searchInput(page);
		await input.click();

		const lb = listbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });

		// Click directly on the "Fixer" agent item (uses onmousedown)
		await lb.locator('button', { hasText: "Fixer" }).click({ force: true });

		// Dropdown should close
		await expect(lb).not.toBeVisible({ timeout: 3000 });

		// Agent should appear in the team member list
		await expect(page.locator(".font-medium", { hasText: "Fixer" })).toBeVisible({ timeout: 3000 });
	});
});

// ── Model search picker ──────────────────────────────────────────────

test.describe("model search picker", () => {
	const modelPickerAgentConfigs = [
		makeAgentConfig({
			id: "ac-rev",
			name: "Reviewer",
			description: "Reviews pull requests carefully",
			prompt: "You are a meticulous code reviewer.",
			category: null,
		}),
	];

	const modelPickerAgents = modelPickerAgentConfigs.map((c) =>
		makeAgent({ id: c.id, name: c.name, description: c.description, category: null, source: "config" }),
	);

	async function openTeamBuilderWithMember(page: Page, mockApi: any) {
		await mockApi({
			agents: modelPickerAgents,
			agentConfigs: modelPickerAgentConfigs,
		});
		await page.goto("/agents/new?type=team");
		await expect(page.getByRole("heading", { name: "New Team" })).toBeVisible({ timeout: 5000 });

		// Add a member agent so the override panel is available
		const searchInput = page.getByPlaceholder("Search and add a member...");
		await searchInput.click();
		await searchInput.fill("Reviewer");
		await page.waitForTimeout(200);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect(page.locator(".font-medium", { hasText: "Reviewer" })).toBeVisible({ timeout: 3000 });

		// Expand the member's override panel by clicking the member row
		await page.locator(".cursor-pointer", { hasText: "Reviewer" }).click();
	}

	function modelSearchInput(page: Page) {
		return page.locator('input[role="combobox"][aria-controls="model-picker-listbox"]');
	}

	function modelListbox(page: Page) {
		return page.locator("#model-picker-listbox");
	}

	test("shows models in dropdown when focused", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = modelSearchInput(page);
		await input.click();

		const lb = modelListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("Claude Sonnet 4")).toBeVisible();
		await expect(lb.getByText("Claude Opus 4")).toBeVisible();
		await expect(lb.getByText("GPT-4o")).toBeVisible();
		await expect(lb.getByText("Gemini 2.0 Flash")).toBeVisible();
	});

	test("filters models by search", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = modelSearchInput(page);
		await input.click();
		await input.pressSequentially("opus", { delay: 30 });

		const lb = modelListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("Claude Opus 4")).toBeVisible();
		await expect(lb.getByText("GPT-4o")).not.toBeVisible();
	});

	test("selects model and shows it in input", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = modelSearchInput(page);
		await input.click();
		await input.pressSequentially("sonnet", { delay: 30 });

		const lb = modelListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("Claude Sonnet 4")).toBeVisible();

		// ArrowDown to highlight, Enter to select
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");

		// Dropdown should close
		await expect(lb).not.toBeVisible({ timeout: 3000 });

		// Input should show the selected model's display name
		await expect(input).toHaveValue("Claude Sonnet 4");
	});

	test("shows provider badge and cost tier", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = modelSearchInput(page);
		await input.click();

		const lb = modelListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });

		// Provider badges: colored initial letters (A for Anthropic, O for OpenAI, G for Google)
		const badges = lb.locator("span.rounded.text-white");
		const badgeCount = await badges.count();
		expect(badgeCount).toBe(4);

		// Cost tier indicators should be visible
		await expect(lb.getByText("$$", { exact: true }).first()).toBeVisible(); // medium costTier
		await expect(lb.getByText("$$$")).toBeVisible(); // high costTier
		await expect(lb.getByText("$", { exact: true }).first()).toBeVisible(); // low costTier
	});

	test("ARIA compliance for model picker", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = modelSearchInput(page);

		// Verify combobox role before opening
		await expect(input).toHaveAttribute("role", "combobox");
		await expect(input).toHaveAttribute("aria-haspopup", "listbox");

		// Focus to open
		await input.click();

		// aria-expanded should be true when open
		await expect(input).toHaveAttribute("aria-expanded", "true");

		// Dropdown listbox
		const lb = modelListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb).toHaveAttribute("role", "listbox");

		// Each item should have role="option"
		const options = lb.locator('[role="option"]');
		const count = await options.count();
		expect(count).toBe(4);
		for (let i = 0; i < count; i++) {
			await expect(options.nth(i)).toHaveAttribute("role", "option");
		}
	});
});

// ── Mode search picker ──────────────────────────────────────────────

test.describe("mode search picker", () => {
	const modePickerAgentConfigs = [
		makeAgentConfig({
			id: "ac-rev",
			name: "Reviewer",
			description: "Reviews pull requests carefully",
			prompt: "You are a meticulous code reviewer.",
			category: null,
		}),
	];

	const modePickerAgents = modePickerAgentConfigs.map((c) =>
		makeAgent({ id: c.id, name: c.name, description: c.description, category: null, source: "config" }),
	);

	async function openTeamBuilderWithMember(page: Page, mockApi: any) {
		await mockApi({
			agents: modePickerAgents,
			agentConfigs: modePickerAgentConfigs,
		});
		await page.goto("/agents/new?type=team");
		await expect(page.getByRole("heading", { name: "New Team" })).toBeVisible({ timeout: 5000 });

		// Add a member agent so the override panel is available
		const searchInput = page.getByPlaceholder("Search and add a member...");
		await searchInput.click();
		await searchInput.fill("Reviewer");
		await page.waitForTimeout(200);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect(page.locator(".font-medium", { hasText: "Reviewer" })).toBeVisible({ timeout: 3000 });

		// Expand the member's override panel by clicking the member row
		await page.locator(".cursor-pointer", { hasText: "Reviewer" }).click();
	}

	function modeSearchInput(page: Page) {
		return page.locator('input[role="combobox"][aria-controls="mode-picker-listbox"]');
	}

	function modeListbox(page: Page) {
		return page.locator("#mode-picker-listbox");
	}

	test("shows modes in dropdown", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = modeSearchInput(page);
		await input.click();

		const lb = modeListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("Code Review")).toBeVisible();
		await expect(lb.getByText("Full Auto")).toBeVisible();
		await expect(lb.getByText("Chat Only")).toBeVisible();
	});

	test("filters modes by search", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = modeSearchInput(page);
		await input.click();
		await input.pressSequentially("code", { delay: 30 });

		const lb = modeListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("Code Review")).toBeVisible();
		await expect(lb.getByText("Full Auto")).not.toBeVisible();
	});

	test("selects mode", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = modeSearchInput(page);
		await input.click();
		await input.pressSequentially("auto", { delay: 30 });

		const lb = modeListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("Full Auto")).toBeVisible();

		// ArrowDown past "Inherited" to highlight "Full Auto", then Enter to select
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");

		// Dropdown should close
		await expect(lb).not.toBeVisible({ timeout: 3000 });

		// Input should show the selected mode name
		await expect(input).toHaveValue(/Full Auto/);
	});

	test("shows mode details on highlight", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = modeSearchInput(page);
		await input.click();

		const lb = modeListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });

		// ArrowDown past "Inherited" to highlight first mode
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");

		// Tool restriction badge should be visible on the highlighted option
		await expect(lb.getByText("Read-only")).toBeVisible({ timeout: 3000 });
	});

	test("inherited option clears selection", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = modeSearchInput(page);

		// First, select a mode
		await input.click();
		await input.pressSequentially("auto", { delay: 30 });

		const lb = modeListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect(lb).not.toBeVisible({ timeout: 3000 });

		// Input should show the selected mode
		await expect(input).toHaveValue(/Full Auto/);

		// Reopen and select "Inherited (no override)"
		await input.click();
		const lb2 = modeListbox(page);
		await expect(lb2).toBeVisible({ timeout: 3000 });
		await page.keyboard.press("ArrowDown"); // highlight "Inherited (no override)"
		await page.keyboard.press("Enter");

		// Dropdown should close and input should be cleared
		await expect(lb2).not.toBeVisible({ timeout: 3000 });
		await expect(input).toHaveValue("");
	});
});

// ── Team edit page ──────────────────────────────────────────────────

test.describe("team edit page", () => {
	const memberConfigs = [
		makeAgentConfig({ id: "edit-m1", name: "Editor Agent", description: "Edits documents", category: null, prompt: "You edit things." }),
		makeAgentConfig({ id: "edit-m2", name: "Proofer Agent", description: "Proofreads text", category: null, prompt: "You proofread." }),
	];
	const teamConfigData = makeAgentConfig({
		id: "edit-team",
		name: "Writing Team",
		description: "A writing workflow team",
		category: "team",
		prompt: "Coordinate the writing team.",
		references: {
			agents: ["edit-m1", "edit-m2"],
			extensions: [],
			members: [
				{ agentConfigId: "edit-m1" },
				{ agentConfigId: "edit-m2", overrides: { permissionMode: "yolo" } },
			],
		},
	});

	const allConfigs = [...memberConfigs, teamConfigData];

	const memberAgents = [
		makeAgent({ name: "Editor Agent", description: "Edits documents", category: null, id: "edit-m1", source: "config", prompt: "You edit things." }),
		makeAgent({ name: "Proofer Agent", description: "Proofreads text", category: null, id: "edit-m2", source: "config", prompt: "You proofread." }),
	];
	const teamAgent = makeAgent({
		name: "Writing Team",
		description: "A writing workflow team",
		category: "team",
		id: "edit-team",
		source: "config",
	});
	const allAgents = [...memberAgents, teamAgent];

	test("team page shows Edit Team heading and Chat button", async ({ page, mockApi }) => {
		await mockApi({
			agents: allAgents,
			agentConfigs: allConfigs,
		});

		await page.goto("/agents/Writing Team");

		await expect(page.getByRole("heading", { name: "Edit Team: Writing Team" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
	});

	test("team page does NOT show Run Agent or Run History", async ({ page, mockApi }) => {
		await mockApi({
			agents: allAgents,
			agentConfigs: allConfigs,
		});

		await page.goto("/agents/Writing Team");

		await expect(page.getByRole("heading", { name: "Edit Team: Writing Team" })).toBeVisible({ timeout: 5000 });

		// Run Agent and Run History should not appear for teams
		await expect(page.getByText("Run Agent")).not.toBeVisible();
		await expect(page.getByText("Run History")).not.toBeVisible();
	});

	test("non-team agent shows regular agent UI", async ({ page, mockApi }) => {
		await mockApi({
			agents: allAgents,
			agentConfigs: allConfigs,
		});

		await page.goto("/agents/Editor Agent");

		// Regular agent buttons should be visible
		await expect(page.getByRole("button", { name: "Chat with this agent" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByRole("heading", { name: "Run Agent" })).toBeVisible();

		// Team edit heading should NOT be present
		await expect(page.getByText("Edit Team")).not.toBeVisible();
	});

	test("team builder form renders with initial team data", async ({ page, mockApi }) => {
		// Use the new team builder page with query params to provide initial data,
		// which avoids the async team config loading entirely
		await mockApi({
			agents: memberAgents,
			agentConfigs: allConfigs,
		});

		await page.goto("/agents/new?type=team");
		await expect(page.getByRole("heading", { name: "New Team" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Coordination Instructions")).toBeVisible();

		// The form should show the Coordination Instructions label (not System Prompt)
		await expect(page.getByText("System Prompt")).not.toBeVisible();
	});

	test("team builder shows member overrides indicator", async ({ page, mockApi }) => {
		// Navigate to the team builder and add members with overrides
		await mockApi({
			agents: memberAgents,
			agentConfigs: memberConfigs,
		});

		await page.goto("/agents/new?type=team");
		await expect(page.getByRole("heading", { name: "New Team" })).toBeVisible({ timeout: 5000 });

		// Add a member agent
		const searchInput = page.getByPlaceholder("Search and add a member...");
		await searchInput.click();
		await searchInput.fill("Editor");
		await page.waitForTimeout(200);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect(page.locator(".font-medium", { hasText: "Editor Agent" })).toBeVisible({ timeout: 3000 });

		// Expand the member's override panel by clicking the member row
		await page.locator(".cursor-pointer", { hasText: "Editor Agent" }).click();

		// The override panel should appear with the Mode label
		await expect(page.locator("text=System Prompt Append")).toBeVisible({ timeout: 3000 });
	});

	test("team edit page loads existing members", async ({ page, mockApi }) => {
		await mockApi({
			agents: allAgents,
			agentConfigs: allConfigs,
		});

		await page.goto("/agents/Writing Team");

		await expect(page.getByRole("heading", { name: "Edit Team: Writing Team" })).toBeVisible({ timeout: 5000 });

		// Member agent names should be visible in the member tree
		await expect(page.locator(".font-medium", { hasText: "Editor Agent" })).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".font-medium", { hasText: "Proofer Agent" })).toBeVisible({ timeout: 5000 });

		// Empty state text should NOT be visible since members are loaded
		await expect(page.getByText("No members added yet")).not.toBeVisible();
	});

	test("team edit page loads member overrides", async ({ page, mockApi }) => {
		await mockApi({
			agents: allAgents,
			agentConfigs: allConfigs,
		});

		await page.goto("/agents/Writing Team");

		await expect(page.getByRole("heading", { name: "Edit Team: Writing Team" })).toBeVisible({ timeout: 5000 });

		// Wait for member tree to render
		await expect(page.locator(".font-medium", { hasText: "Proofer Agent" })).toBeVisible({ timeout: 5000 });

		// Proofer Agent has overrides (permissionMode: "yolo"), so the amber override indicator should be visible
		const prooferRow = page.locator(".cursor-pointer", { hasText: "Proofer Agent" });
		await expect(prooferRow.locator(".bg-amber-400")).toBeVisible({ timeout: 3000 });

		// Editor Agent has no overrides, so no amber indicator
		const editorRow = page.locator(".cursor-pointer", { hasText: "Editor Agent" });
		await expect(editorRow.locator(".bg-amber-400")).not.toBeVisible();

		// Click Proofer Agent to expand overrides panel
		await prooferRow.click();

		// The override panel should appear with the System Prompt Append section
		await expect(page.locator("text=System Prompt Append")).toBeVisible({ timeout: 3000 });
	});

	test("legacy team (agents without members) loads members from flat agents array", async ({ page, mockApi }) => {
		// Simulate a team created before the members feature — has references.agents but NO references.members
		const legacyTeamConfig = makeAgentConfig({
			id: "legacy-team",
			name: "Legacy Team",
			description: "Created before members feature",
			category: "team",
			prompt: "Coordinate legacy team.",
			references: { agents: ["edit-m1", "edit-m2"], extensions: [] } as any,
		});
		const legacyTeamAgent = makeAgent({
			name: "Legacy Team", description: "Created before members feature",
			category: "team", id: "legacy-team", source: "config",
		});

		await mockApi({
			agents: [...memberAgents, legacyTeamAgent],
			agentConfigs: [...memberConfigs, legacyTeamConfig],
		});

		await page.goto("/agents/Legacy Team");

		await expect(page.getByRole("heading", { name: "Edit Team: Legacy Team" })).toBeVisible({ timeout: 5000 });

		// Members should be populated from the flat agents array
		await expect(page.locator(".font-medium", { hasText: "Editor Agent" })).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".font-medium", { hasText: "Proofer Agent" })).toBeVisible({ timeout: 5000 });

		// Empty state should NOT be visible
		await expect(page.getByText("No members added yet")).not.toBeVisible();
	});
});

// ── Tool search picker ──────────────────────────────────────────────

test.describe("tool search picker", () => {
	const toolPickerAgentConfigs = [
		makeAgentConfig({
			id: "ac-rev",
			name: "Reviewer",
			description: "Reviews pull requests carefully",
			prompt: "You are a meticulous code reviewer.",
			category: null,
		}),
	];

	const toolPickerAgents = toolPickerAgentConfigs.map((c) =>
		makeAgent({ id: c.id, name: c.name, description: c.description, category: null, source: "config" }),
	);

	async function openTeamBuilderWithMember(page: Page, mockApi: any) {
		await mockApi({
			agents: toolPickerAgents,
			agentConfigs: toolPickerAgentConfigs,
		});
		await page.goto("/agents/new?type=team");
		await expect(page.getByRole("heading", { name: "New Team" })).toBeVisible({ timeout: 5000 });

		// Add a member agent so the override panel is available
		const searchInput = page.getByPlaceholder("Search and add a member...");
		await searchInput.click();
		await searchInput.fill("Reviewer");
		await page.waitForTimeout(200);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect(page.locator(".font-medium", { hasText: "Reviewer" })).toBeVisible({ timeout: 3000 });

		// Expand the member's override panel by clicking the member row
		await page.locator(".cursor-pointer", { hasText: "Reviewer" }).click();
	}

	function toolSearchInput(page: Page) {
		return page.locator('input[role="combobox"][aria-controls="tool-picker-listbox"]');
	}

	function toolListbox(page: Page) {
		return page.locator("#tool-picker-listbox");
	}

	test("shows tools in dropdown", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = toolSearchInput(page);
		// Scroll far enough that the dropdown fits in the viewport
		await input.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await input.click();

		const lb = toolListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });

		// Verify all 4 tools are present in the listbox
		const options = lb.locator('[role="option"]');
		await expect(options).toHaveCount(4);
		await expect(lb.getByText("scan")).toBeVisible();
		await expect(lb.getByText("lint")).toBeVisible();
		await expect(lb.getByText("search")).toBeVisible();
		await expect(lb.getByText("format", { exact: true })).toBeVisible();
	});

	test("filters tools by search", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = toolSearchInput(page);
		await input.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await input.click();
		await input.pressSequentially("scan", { delay: 30 });

		const lb = toolListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });
		await expect(lb.getByText("scan")).toBeVisible();
		await expect(lb.locator('[role="option"]', { hasText: "lint" })).not.toBeVisible();
		await expect(lb.locator('[role="option"]', { hasText: "format" })).not.toBeVisible();
	});

	test("multi-select toggle", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = toolSearchInput(page);
		await input.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await input.click();

		const lb = toolListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });

		// ArrowDown to highlight scan (idx 0), Enter to toggle on
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		// Dropdown stays open (multi-select), highlight remains at idx 0

		// ArrowDown to lint (idx 1), Enter to toggle on
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		// highlight now at idx 1

		// Both should have checked checkbox indicators (border-blue-500)
		const scanOption = lb.locator('[role="option"]', { hasText: "scan" });
		await expect(scanOption.locator("span.border-blue-500")).toBeVisible();
		const lintOption = lb.locator('[role="option"]', { hasText: "lint" });
		await expect(lintOption.locator("span.border-blue-500")).toBeVisible();

		// ArrowUp back to scan (idx 0), Enter to toggle off
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("Enter");

		// scan should no longer have the checked indicator
		await expect(scanOption.locator("span.border-blue-500")).not.toBeVisible();
		// lint should still be checked
		await expect(lintOption.locator("span.border-blue-500")).toBeVisible();
	});

	test("shows selected tool chips", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = toolSearchInput(page);
		await input.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await input.click();

		const lb = toolListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });

		// Select "scan" via keyboard
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");

		// Close dropdown by pressing Escape
		await input.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await input.click();
		await page.keyboard.press("Escape");
		await expect(lb).not.toBeVisible({ timeout: 3000 });

		// Assert chip with tool name appears below the input
		const chip = page.locator("span.rounded-full", { hasText: "analyzer.scan" });
		await expect(chip).toBeVisible({ timeout: 3000 });
	});

	test("shows extension badge", async ({ page, mockApi }) => {
		await openTeamBuilderWithMember(page, mockApi);

		const input = toolSearchInput(page);
		await input.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await input.click();

		const lb = toolListbox(page);
		await expect(lb).toBeVisible({ timeout: 3000 });

		// Extension type badges should be visible: "analyzer", "formatter" for extension type, "MCP" for mcp type
		await expect(lb.getByText("analyzer").first()).toBeVisible();
		await expect(lb.getByText("MCP")).toBeVisible();
		await expect(lb.getByText("formatter")).toBeVisible();
	});
});
