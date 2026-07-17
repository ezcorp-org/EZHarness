import { test, expect } from "./fixtures/test-base.js";
import { makeWorkflow } from "./fixtures/data.js";

test.describe("Workflows", () => {
	test("workflow list shows workflows with names and descriptions", async ({ page, mockApi }) => {
		await mockApi({
			workflows: [
				makeWorkflow({ name: "data-workflow", description: "Processes raw data" }),
				makeWorkflow({ name: "deploy-workflow", description: "Deploys to production" }),
			],
		});
		await page.goto("/workflows");

		await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
		await expect(page.getByText("data-workflow")).toBeVisible();
		await expect(page.getByText("Processes raw data")).toBeVisible();
		await expect(page.getByText("deploy-workflow")).toBeVisible();
		await expect(page.getByText("Deploys to production")).toBeVisible();
	});

	test("shows step count for each workflow", async ({ page, mockApi }) => {
		await mockApi({
			workflows: [
				makeWorkflow({
					name: "multi-step",
					steps: [
						{ name: "step-1", agent: "agent-a" },
						{ name: "step-2", agent: "agent-b" },
						{ name: "step-3", agent: "agent-c" },
					],
				}),
			],
		});
		await page.goto("/workflows");

		await expect(page.getByText("3 steps")).toBeVisible();
	});

	test("empty state when no workflows", async ({ page, mockApi }) => {
		await mockApi({ workflows: [] });
		await page.goto("/workflows");

		await expect(page.getByText("No workflows defined yet.")).toBeVisible();
	});

	test("clicking a workflow navigates to detail page", async ({ page, mockApi }) => {
		await mockApi({
			workflows: [makeWorkflow({ name: "my-workflow" })],
		});
		await page.goto("/workflows");

		await page.getByText("my-workflow").click();
		await expect(page).toHaveURL(/\/workflows\/my-workflow/);
	});

	test("workflow detail shows name and description", async ({ page, mockApi }) => {
		await mockApi({
			workflows: [makeWorkflow({ name: "my-workflow", description: "Does things" })],
		});
		await page.goto("/workflows/my-workflow");

		await expect(page.getByRole("heading", { name: "my-workflow" })).toBeVisible();
		await expect(page.getByText("Does things")).toBeVisible();
	});

	test("workflow detail shows steps with agent names", async ({ page, mockApi }) => {
		await mockApi({
			workflows: [
				makeWorkflow({
					name: "my-workflow",
					steps: [
						{ name: "extract", agent: "extractor" },
						{ name: "transform", agent: "transformer" },
					],
				}),
			],
		});
		await page.goto("/workflows/my-workflow");

		await expect(page.getByText("Steps")).toBeVisible();
		await expect(page.getByText("extract", { exact: true })).toBeVisible();
		await expect(page.getByText("extractor")).toBeVisible();
		await expect(page.getByText("transform", { exact: true })).toBeVisible();
		await expect(page.getByText("transformer")).toBeVisible();
	});

	test("workflow detail shows run workflow section", async ({ page, mockApi }) => {
		await mockApi({
			workflows: [makeWorkflow({ name: "my-workflow" })],
		});
		await page.goto("/workflows/my-workflow");

		await expect(page.getByRole("heading", { name: "Run Workflow" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Run Workflow" })).toBeVisible();
		await expect(page.getByLabel("JSON Input")).toBeVisible();
	});

	test("workflow not found", async ({ page, mockApi }) => {
		await mockApi({ workflows: [] });
		await page.goto("/workflows/nonexistent");

		await expect(page.getByText(/not found/i)).toBeVisible();
	});

	test("back link navigates to workflows list", async ({ page, mockApi }) => {
		await mockApi({
			workflows: [makeWorkflow({ name: "my-workflow" })],
		});
		await page.goto("/workflows/my-workflow");

		await page.getByText("Workflows").first().click();
		await expect(page).toHaveURL(/\/workflows$/);
	});

	test("/pipelines permanently redirects to /workflows (one-release compat)", async ({ page, mockApi }) => {
		await mockApi({ workflows: [makeWorkflow({ name: "kept" })] });
		await page.goto("/pipelines");
		await expect(page).toHaveURL(/\/workflows$/);
		await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
	});
});
