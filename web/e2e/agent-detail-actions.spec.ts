/**
 * Agent detail page (`/agents/[name]`) — the actions and their failure paths:
 * team and agent saves, JSON runs, Test and Chat (with and without an active
 * project), and the test-conversation list with its Clear action.
 * RENDER tier (mockApi plus per-test routes registered after it, which win).
 */
import type { Page } from "@playwright/test";
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeAgent, makeAgentConfig, makeConversation } from "./fixtures/data.js";

const configAgent = makeAgent({ name: "helper", source: "config", id: "cfg-helper", prompt: "Help.", description: "Helps" });
const helperConfig = makeAgentConfig({ id: "cfg-helper", name: "helper", prompt: "Help.", description: "Helps" });
const fileAgent = makeAgent({ name: "summarizer" });

const memberConfig = makeAgentConfig({ id: "cfg-member", name: "member", prompt: "Member." });
const teamAgent = makeAgent({ name: "squad", source: "config", id: "cfg-squad", category: "team", prompt: "Lead." });
const teamConfig = makeAgentConfig({
	id: "cfg-squad",
	name: "squad",
	prompt: "Lead the squad.",
	category: "team",
	references: { members: [{ agentConfigId: "cfg-member" }] },
} as Parameters<typeof makeAgentConfig>[0]);

function withProject(page: Page) {
	return page.addInitScript(() => localStorage.setItem("activeProjectId", "proj-1"));
}

function failWith(page: Page, pattern: string, method: string, error: string) {
	return page.route(pattern, (route) =>
		route.request().method() === method
			? route.fulfill({ status: 500, json: { error } })
			: route.fallback(),
	);
}

function runAgent(page: Page) {
	return page.locator(".md\\:block:visible, details.md\\:hidden:visible").filter({ hasText: "Run Agent" });
}

test.describe("Agent detail actions", () => {
	test("saving a team returns to the agent list; a failed save stays and explains @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ agents: [teamAgent], agentConfigs: [teamConfig, memberConfig] });
		await failWith(page, "**/api/agent-configs/cfg-squad", "PUT", "Team name already taken");
		await page.goto("/agents/squad");

		await page.getByRole("button", { name: "Save Team" }).click();
		await expect(page.getByText("Team name already taken")).toBeVisible();
		await expect(page).toHaveURL("/agents/squad");
		await captureEvidence(page, testInfo, "agent-detail-team-save-error");

		await page.unroute("**/api/agent-configs/cfg-squad");
		await page.getByRole("button", { name: "Save Team" }).click();
		await expect(page).toHaveURL("/agents");
	});

	test("a failed agent save shows the server's reason", async ({ page, mockApi }) => {
		await mockApi({ agents: [configAgent], agentConfigs: [helperConfig] });
		await failWith(page, "**/api/agent-configs/cfg-helper", "PUT", "Prompt is too long");
		await page.goto("/agents/helper");

		await page.getByRole("button", { name: "Save Agent" }).click();
		await expect(page.getByText("Prompt is too long")).toBeVisible();
		await expect(page).toHaveURL("/agents/helper");
	});

	test("a run with invalid JSON is refused; a failed run shows the server's reason", async ({ page, mockApi }) => {
		await mockApi({ agents: [fileAgent] });
		await failWith(page, "**/api/agents/summarizer/run", "POST", "Runner is busy");
		await page.goto("/agents/summarizer");
		const panel = runAgent(page);

		await panel.getByRole("textbox").fill("{not json");
		await panel.getByRole("button", { name: "Run" }).click();
		await expect(panel.getByText("Invalid JSON input")).toBeVisible();

		await panel.getByRole("textbox").fill('{"text":"hi"}');
		await panel.getByRole("button", { name: "Run" }).click();
		await expect(panel.getByText("Runner is busy")).toBeVisible();
	});

	test("Test and Chat need a project first", async ({ page, mockApi }) => {
		await mockApi({ agents: [configAgent], agentConfigs: [helperConfig] });
		await page.goto("/agents/helper");

		await page.getByRole("button", { name: "Test" }).click();
		await page.getByTestId("agent-chat-cta").click();
		await expect(page.getByText("Select a project first")).toHaveCount(2);
	});

	test("Test opens a test conversation in the active project", async ({ page, mockApi }) => {
		await mockApi({ agents: [configAgent], agentConfigs: [helperConfig] });
		await withProject(page);
		const created = page.waitForRequest((r) => r.url().endsWith("/api/conversations") && r.method() === "POST");
		await page.goto("/agents/helper");

		await page.getByRole("button", { name: "Test" }).click();
		expect((await created).postDataJSON()).toMatchObject({ projectId: "proj-1", agentConfigId: "cfg-helper", test: true, title: "Test: helper" });
		await page.waitForURL(/\/project\/proj-1\/chat\//);
	});

	test("failed Test and Chat starts show the server's reason", async ({ page, mockApi }) => {
		await mockApi({ agents: [configAgent], agentConfigs: [helperConfig] });
		await withProject(page);
		await failWith(page, "**/api/conversations", "POST", "Conversation limit reached");
		await page.goto("/agents/helper");

		await page.getByRole("button", { name: "Test" }).click();
		await page.getByTestId("agent-chat-cta").click();
		await expect(page.getByText("Conversation limit reached")).toHaveCount(2);
		await expect(page).toHaveURL("/agents/helper");
	});

	test("lists the agent's test conversations and clears them @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ agents: [configAgent], agentConfigs: [helperConfig] });
		const tests = [
			makeConversation({ id: "t-1", projectId: "proj-1", title: "Test: helper run one" }),
			makeConversation({ id: "t-2", projectId: "proj-1", title: "Test: helper run two" }),
		];
		let cleared = false;
		await page.route("**/api/agents/helper/test-conversations", (route) => {
			if (route.request().method() === "DELETE") {
				cleared = true;
				return route.fulfill({ json: { deleted: 2 } });
			}
			return route.fulfill({ json: cleared ? [] : tests });
		});
		await page.goto("/agents/helper");

		const list = page.getByRole("heading", { name: "Test Conversations" }).locator("xpath=../..");
		await expect(list.getByRole("link")).toHaveCount(2);
		await expect(list.getByRole("link").first()).toHaveAttribute("href", "/project/proj-1/chat/t-1");
		await expect(list.getByText("Test: helper run one")).toBeVisible();
		await captureEvidence(page, testInfo, "agent-detail-test-conversations");

		await page.getByRole("button", { name: "Clear All Tests" }).click();
		await expect(page.getByRole("heading", { name: "Test Conversations" })).toHaveCount(0);
		expect(cleared).toBe(true);
	});

	test("a failed test-conversation load leaves the page usable without the list", async ({ page, mockApi }) => {
		await mockApi({ agents: [configAgent], agentConfigs: [helperConfig] });
		const loaded = page.waitForResponse("**/api/agents/helper/test-conversations");
		await page.route("**/api/agents/helper/test-conversations", (route) =>
			route.fulfill({ status: 500, json: { error: "db down" } }),
		);
		await page.goto("/agents/helper");
		await loaded;
		await expect(page.getByRole("heading", { name: /Edit Agent: helper/ })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Test Conversations" })).toHaveCount(0);
	});
});
