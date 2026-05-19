import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeAgentConfig } from "./fixtures/data.js";

const STORAGE_KEY = "ezcorp-last-path";

const agents = [
	makeAgent({ name: "agent-1", source: "config", id: "a1", prompt: "p" }),
];
const teamConfig = makeAgentConfig({ id: "t1", name: "My Team", category: "team" });

test.describe("Agents page tab URL persistence", () => {
	test("defaults to agents tab with no query param", async ({ page, mockApi }) => {
		await mockApi({ agents, agentConfigs: [teamConfig] });
		await page.goto("/agents");

		await expect(page.getByText("agent-1")).toBeVisible();
		await expect(page.getByRole("link", { name: "+ New Agent" })).toBeVisible();
	});

	test("clicking Teams tab updates URL with ?tab=teams", async ({ page, mockApi }) => {
		await mockApi({ agents, agentConfigs: [teamConfig] });
		await page.goto("/agents");

		await page.getByRole("button", { name: "Teams", exact: false }).click();
		await expect(page).toHaveURL(/\/agents\?tab=teams/);
		await expect(page.getByRole("link", { name: "+ New Team" })).toBeVisible();
	});

	test("clicking Agents tab removes ?tab param", async ({ page, mockApi }) => {
		await mockApi({ agents, agentConfigs: [teamConfig] });
		await page.goto("/agents?tab=teams");

		await page.getByRole("button", { name: "Agents", exact: true }).click();
		await expect(page).toHaveURL(/\/agents$/);
		await expect(page.getByRole("link", { name: "+ New Agent" })).toBeVisible();
	});

	test("navigating directly to ?tab=teams shows teams tab", async ({ page, mockApi }) => {
		await mockApi({ agents, agentConfigs: [teamConfig] });
		await page.goto("/agents?tab=teams");

		await expect(page.getByRole("link", { name: "+ New Team" })).toBeVisible();
		await expect(page.getByText("My Team")).toBeVisible();
	});

	test("refresh on teams tab stays on teams tab", async ({ page, mockApi }) => {
		await mockApi({ agents, agentConfigs: [teamConfig] });
		await page.goto("/agents?tab=teams");
		await expect(page.getByRole("link", { name: "+ New Team" })).toBeVisible();

		// Refresh the page
		await page.reload();
		await expect(page).toHaveURL(/\/agents\?tab=teams/);
		await expect(page.getByRole("link", { name: "+ New Team" })).toBeVisible();
	});

	test("localStorage saves query params for resume-last-path", async ({ page, mockApi }) => {
		await mockApi({ agents, agentConfigs: [teamConfig] });
		await page.goto("/agents");

		// Switch to teams tab
		await page.getByRole("button", { name: "Teams", exact: false }).click();
		await expect(page).toHaveURL(/\/agents\?tab=teams/);

		const savedPath = await page.evaluate(
			(key) => localStorage.getItem(key),
			STORAGE_KEY,
		);
		expect(savedPath).toBe("/agents?tab=teams");
	});

	test("resume-last-path restores teams tab from root", async ({ page, mockApi }) => {
		await mockApi({ agents, agentConfigs: [teamConfig] });

		// Pre-set localStorage with teams tab URL
		await page.goto("/");
		await page.evaluate(
			({ key, value }) => localStorage.setItem(key, value),
			{ key: STORAGE_KEY, value: "/agents?tab=teams" },
		);

		// Navigate to root — should redirect to saved path with query params
		await page.goto("/");
		await page.waitForURL(/\/agents\?tab=teams/);
		await expect(page.getByRole("link", { name: "+ New Team" })).toBeVisible();
	});
});
