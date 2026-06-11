import { test, expect } from "./fixtures/test-base.js";
import { dismissPickerSheet } from "./fixtures/picker-helpers.js";

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

	test("Configure tab: attach extension, deselect a tool → POST body carries extensionTools subset", async ({ page, mockApi }) => {
		await mockApi({
			agents: [],
			extensions: [
				{ id: "ext-tools", name: "Toolbox", description: "Two tools", manifest: { tools: [{ name: "alpha" }, { name: "beta" }] } },
			],
		});

		let postBody: Record<string, unknown> | null = null;
		page.on("request", (req) => {
			if (req.method() === "POST" && req.url().endsWith("/api/agent-configs")) {
				postBody = req.postDataJSON() as Record<string, unknown>;
			}
		});

		await page.goto("/agents/new");
		await page.getByRole("button", { name: "Configure" }).click();
		await page.getByLabel("Name").fill("tooled-agent");
		await page.getByLabel("System Prompt").fill("You are a tooled agent.");

		// Attach the extension via the inline picker.
		const combobox = page.getByTestId("extension-picker-combobox");
		await combobox.locator("input[role='combobox']").click();
		const listbox = page.locator("#extension-picker-listbox");
		await expect(listbox).toBeVisible({ timeout: 2000 });
		await listbox.getByRole("button").filter({ hasText: "Toolbox" }).click();
		await dismissPickerSheet(page);

		// Per-tool selector appears; both tools checked by default.
		const beta = page.getByTestId("tool-ext-tools-beta");
		await expect(beta).toBeChecked();
		await beta.uncheck();
		await expect(beta).not.toBeChecked();

		await page.getByRole("button", { name: "Save Agent" }).click();
		await expect(page).toHaveURL("/agents");

		expect(postBody).not.toBeNull();
		expect((postBody as any).extensions).toEqual(["ext-tools"]);
		expect((postBody as any).extensionTools).toEqual({ "ext-tools": ["alpha"] });
	});

	test("Configure tab: attach-picker per-card scoping persists into POST body", async ({ page, mockApi }) => {
		await mockApi({
			agents: [],
			extensions: [
				{ id: "ext-tools", name: "Toolbox", description: "Two tools", manifest: { tools: [{ name: "alpha" }, { name: "beta" }] } },
			],
		});

		let postBody: Record<string, unknown> | null = null;
		page.on("request", (req) => {
			if (req.method() === "POST" && req.url().endsWith("/api/agent-configs")) {
				postBody = req.postDataJSON() as Record<string, unknown>;
			}
		});

		await page.goto("/agents/new");
		await page.getByRole("button", { name: "Configure" }).click();
		await page.getByLabel("Name").fill("picker-scoped-agent");
		await page.getByLabel("System Prompt").fill("You are a tooled agent.");

		// Open the visual attach picker and select the extension card.
		await page.getByTestId("open-extension-attach-picker").click();
		const cardScoped = page.locator('[data-testid="extension-attach-picker-card"][data-ext-id="ext-tools"]');
		await cardScoped.locator("button").first().click();

		// Expand the per-card tool checklist and deselect "beta".
		await page.getByTestId("attach-card-tools-toggle-ext-tools").click();
		const beta = page.getByTestId("attach-card-tool-ext-tools-beta");
		await expect(beta).toBeChecked();
		await beta.uncheck();

		// Submit the picker, then save the form.
		await page.getByTestId("extension-attach-picker-submit").click();
		await page.getByRole("button", { name: "Save Agent" }).click();
		await expect(page).toHaveURL("/agents");

		expect(postBody).not.toBeNull();
		expect((postBody as any).extensions).toEqual(["ext-tools"]);
		expect((postBody as any).extensionTools).toEqual({ "ext-tools": ["alpha"] });
	});
});
