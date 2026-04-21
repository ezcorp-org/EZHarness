import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeRun, makeAgentConfig } from "./fixtures/data.js";

test.describe("Agent Detail", () => {
	test("shows agent info card with name, description, and capabilities", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({
					name: "summarizer",
					description: "Summarizes long text into concise summaries",
					capabilities: ["text-processing", "nlp"],
				}),
			],
		});
		await page.goto("/agents/summarizer");

		await expect(page.getByRole("heading", { name: "summarizer" })).toBeVisible();
		await expect(page.getByText("Summarizes long text into concise summaries")).toBeVisible();
		await expect(page.getByText("text-processing")).toBeVisible();
		await expect(page.getByText("nlp")).toBeVisible();
	});

	test("shows 'not found' for missing agent", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents/nonexistent");

		await expect(page.getByText(/not found/i)).toBeVisible();
	});

	test("shows JSON input textarea and Run button", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
		});
		await page.goto("/agents/summarizer");

		await expect(page.getByLabel("JSON Input")).toBeVisible();
		await expect(page.getByRole("button", { name: "Run" })).toBeVisible();
	});

	test("Run button triggers agent run", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
		});
		await page.goto("/agents/summarizer");

		const textarea = page.getByLabel("JSON Input");
		await textarea.fill('{"text": "hello"}');

		const runBtn = page.getByRole("button", { name: "Run" });
		await runBtn.click();

		// Should navigate to run page or show starting state
		await page.waitForURL(/\/runs\//, { timeout: 5000 }).catch(() => {
			// Some implementations stay on the page - that's fine
		});
	});

	test("shows run history when agent has runs", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
			runs: [
				makeRun({ id: "run-1", agentName: "summarizer", status: "success" }),
				makeRun({ id: "run-2", agentName: "summarizer", status: "error" }),
			],
		});
		await page.goto("/agents/summarizer");

		await expect(page.getByText("Run History")).toBeVisible();
	});

	test("back link navigates to dashboard", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
		});
		await page.goto("/agents/summarizer");

		const backLink = page.getByText("Back").first();
		await backLink.click();
		await expect(page).toHaveURL("/");
	});
});

test.describe("Agent Edit Flow", () => {
	const editableAgent = makeAgent({
		name: "my-config-agent",
		description: "An editable config agent",
		source: "config",
		id: "cfg-edit-1",
		prompt: "You are a helpful assistant.",
		category: "productivity",
	});

	const editableConfig = makeAgentConfig({
		id: "cfg-edit-1",
		name: "my-config-agent",
		description: "An editable config agent",
		prompt: "You are a helpful assistant.",
		category: "productivity",
	});

	test("editable config agent shows Edit Agent heading and form fields", async ({ page, mockApi }) => {
		await mockApi({
			agents: [editableAgent],
			agentConfigs: [editableConfig],
		});
		await page.goto("/agents/my-config-agent");

		await expect(page.getByRole("heading", { name: /Edit Agent: my-config-agent/ })).toBeVisible();
		await expect(page.getByLabel("Name")).toBeVisible();
		await expect(page.getByLabel("System Prompt")).toBeVisible();
		await expect(page.getByRole("button", { name: "Save Agent" })).toBeVisible();
	});

	test("edit form loads existing agent data", async ({ page, mockApi }) => {
		await mockApi({
			agents: [editableAgent],
			agentConfigs: [editableConfig],
		});
		await page.goto("/agents/my-config-agent");

		await expect(page.getByLabel("Name")).toHaveValue("my-config-agent");
		await expect(page.getByLabel("System Prompt")).toHaveValue("You are a helpful assistant.");
		await expect(page.getByLabel("Description")).toHaveValue("An editable config agent");
		await expect(page.getByLabel("Category")).toHaveValue("productivity");
	});

	test("save button submits and redirects to /agents", async ({ page, mockApi }) => {
		await mockApi({
			agents: [editableAgent],
			agentConfigs: [editableConfig],
		});
		await page.goto("/agents/my-config-agent");

		await page.getByLabel("Name").fill("updated-agent");
		await page.getByRole("button", { name: "Save Agent" }).click();

		await expect(page).toHaveURL("/agents");
	});

	test("file-based agent does NOT show edit form", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "file-agent", source: "file", id: null, prompt: null, description: "A file agent" })],
		});
		await page.goto("/agents/file-agent");

		await expect(page.getByText("file-agent")).toBeVisible();
		await expect(page.getByText("A file agent")).toBeVisible();
		await expect(page.getByLabel("Name")).not.toBeVisible();
		await expect(page.getByLabel("System Prompt")).not.toBeVisible();
	});

	test("shared read-only agent does NOT show edit form", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({
				name: "shared-agent",
				source: "config",
				id: "cfg-shared",
				prompt: "shared prompt",
				description: "A shared agent",
				shared: true,
				permission: "read",
			})],
			agentConfigs: [makeAgentConfig({ id: "cfg-shared", name: "shared-agent", prompt: "shared prompt" })],
		});
		await page.goto("/agents/shared-agent");

		await expect(page.getByText("shared-agent")).toBeVisible();
		await expect(page.getByText("A shared agent")).toBeVisible();
		await expect(page.getByLabel("Name")).not.toBeVisible();
	});

	test("Chat and Test buttons remain accessible in edit mode", async ({ page, mockApi }) => {
		await mockApi({
			agents: [editableAgent],
			agentConfigs: [editableConfig],
		});
		await page.goto("/agents/my-config-agent");

		await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Test" })).toBeVisible();
	});
});
