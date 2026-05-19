import { test, expect } from "./fixtures/test-base.js";
import { makeAgent } from "./fixtures/data.js";

test.describe("Agents List Page", () => {
	test("shows heading and New Agent button", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents");

		await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
		await expect(page.getByRole("link", { name: "+ New Agent" })).toBeVisible();
	});

	test("shows empty state when no agents", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents");

		await expect(page.getByText("No agents configured")).toBeVisible();
	});

	test("no category chips when agents lack categories", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "basic-agent", source: "file", category: null }),
			],
		});
		await page.goto("/agents");

		await expect(page.getByText("basic-agent")).toBeVisible();
		// "All" chip only appears when categories exist
		await expect(page.getByRole("button", { name: "All categories" })).not.toBeVisible();
	});

	test("config agent shows Chat and Run buttons", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({
					name: "chat-agent",
					source: "config",
					id: "cfg-1",
					prompt: "You are helpful.",
					description: "A chatty agent",
				}),
			],
		});
		await page.goto("/agents");

		await expect(page.getByText("chat-agent")).toBeVisible();
		await expect(page.getByText("Config", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Chat" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Run" })).toBeVisible();
	});

	test("file agent shows only Run button (no Chat)", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "file-agent", source: "file", id: null, prompt: null }),
			],
		});
		await page.goto("/agents");

		await expect(page.getByText("file-agent")).toBeVisible();
		await expect(page.getByText("File", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Chat" })).not.toBeVisible();
		await expect(page.getByRole("link", { name: "Run" })).toBeVisible();
	});

	test("category chips appear and filter agents", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "finance-bot", source: "config", id: "c1", prompt: "p", category: "Finance" }),
				makeAgent({ name: "eng-bot", source: "config", id: "c2", prompt: "p", category: "Engineering" }),
				makeAgent({ name: "general-bot", source: "file", category: null }),
			],
		});
		await page.goto("/agents");

		// All three agents visible initially
		await expect(page.getByText("finance-bot")).toBeVisible();
		await expect(page.getByText("eng-bot")).toBeVisible();
		await expect(page.getByText("general-bot")).toBeVisible();

		// Category chips visible
		const allBtn = page.getByRole("button", { name: "All categories" });
		const financeBtn = page.getByRole("button", { name: "Finance" });
		const engBtn = page.getByRole("button", { name: "Engineering" });
		await expect(allBtn).toBeVisible();
		await expect(financeBtn).toBeVisible();
		await expect(engBtn).toBeVisible();

		// Click Finance filter
		await financeBtn.click();
		await expect(page.getByText("finance-bot")).toBeVisible();
		await expect(page.getByText("eng-bot")).not.toBeVisible();
		// general-bot has no category, so it's also filtered out
		await expect(page.getByText("general-bot")).not.toBeVisible();

		// Click Finance again to deselect
		await financeBtn.click();
		await expect(page.getByText("finance-bot")).toBeVisible();
		await expect(page.getByText("eng-bot")).toBeVisible();
		await expect(page.getByText("general-bot")).toBeVisible();

		// Click All chip resets filter
		await engBtn.click();
		await expect(page.getByText("eng-bot")).toBeVisible();
		await expect(page.getByText("finance-bot")).not.toBeVisible();
		await allBtn.click();
		await expect(page.getByText("finance-bot")).toBeVisible();
		await expect(page.getByText("eng-bot")).toBeVisible();
	});

	test("+ New Agent link navigates to /agents/new", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/agents");

		await page.getByRole("link", { name: "+ New Agent" }).click();
		await expect(page).toHaveURL("/agents/new");
	});

	test("config agent shows Edit button", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "editable-agent", source: "config", id: "cfg-1", prompt: "test prompt" }),
			],
		});
		await page.goto("/agents");

		await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
	});

	test("file-based agent does NOT show Edit button", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "file-agent", source: "file", id: null, prompt: null }),
			],
		});
		await page.goto("/agents");

		await expect(page.getByRole("button", { name: "Edit" })).not.toBeVisible();
	});

	test("shared read-only agent does NOT show Edit button", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "readonly-agent", source: "config", id: "cfg-ro", prompt: "p", shared: true, permission: "read" }),
			],
		});
		await page.goto("/agents");

		await expect(page.getByRole("button", { name: "Edit" })).not.toBeVisible();
	});

	test("Edit button navigates to agent detail page", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "nav-agent", source: "config", id: "cfg-nav", prompt: "test prompt" }),
			],
		});
		await page.goto("/agents");

		await page.getByRole("button", { name: "Edit" }).click();
		await expect(page).toHaveURL("/agents/nav-agent");
	});
});
