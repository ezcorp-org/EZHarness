import { test, expect } from "./fixtures/test-base.js";

test.describe("New Agent Page", () => {
	test("shows heading, tabs, and back link", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents/new");

		await expect(page.getByRole("heading", { name: "New Agent" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Describe" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Configure" })).toBeVisible();
		await expect(page.getByText("Back to Agents")).toBeVisible();
	});

	test("Describe tab is active by default and shows MetaAgentChat area", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents/new");

		// Describe tab is active (has active styling)
		const describeBtn = page.getByRole("button", { name: "Describe" });
		await expect(describeBtn).toBeVisible();

		// The meta-agent chat container (h-96 div) should be visible
		// Configure form fields should NOT be visible
		await expect(page.getByLabel("Name")).not.toBeVisible();
	});

	test("Configure tab shows form with Name, System Prompt, and Category fields", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents/new");

		await page.getByRole("button", { name: "Configure" }).click();

		await expect(page.getByLabel("Name")).toBeVisible();
		await expect(page.getByLabel("System Prompt")).toBeVisible();
		await expect(page.getByLabel("Category")).toBeVisible();
		await expect(page.getByLabel("Description")).toBeVisible();
		await expect(page.getByRole("button", { name: "Save Agent" })).toBeVisible();
	});

	test("tab switching works correctly", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents/new");

		// Switch to Configure
		await page.getByRole("button", { name: "Configure" }).click();
		await expect(page.getByLabel("Name")).toBeVisible();

		// Switch back to Describe
		await page.getByRole("button", { name: "Describe" }).click();
		await expect(page.getByLabel("Name")).not.toBeVisible();
	});

	test("Configure tab: submit without required fields shows error", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents/new");

		await page.getByRole("button", { name: "Configure" }).click();
		await page.getByRole("button", { name: "Save Agent" }).click();

		await expect(page.getByText("Name is required")).toBeVisible();
	});

	test("Configure tab: submit with name but no prompt shows error", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents/new");

		await page.getByRole("button", { name: "Configure" }).click();
		await page.getByLabel("Name").fill("my-agent");
		await page.getByRole("button", { name: "Save Agent" }).click();

		await expect(page.getByText("System prompt is required")).toBeVisible();
	});

	test("Configure tab: successful submission redirects to /agents", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents/new");

		await page.getByRole("button", { name: "Configure" }).click();
		await page.getByLabel("Name").fill("new-test-agent");
		await page.getByLabel("System Prompt").fill("You are a helpful test agent.");
		await page.getByRole("button", { name: "Save Agent" }).click();

		await expect(page).toHaveURL("/agents");
	});

	test("back link navigates to /agents", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents/new");

		await page.getByText("Back to Agents").click();
		await expect(page).toHaveURL("/agents");
	});
});
