import { test, expect } from "./fixtures/test-base.js";
import { makePipeline } from "./fixtures/data.js";

test.describe("Pipelines", () => {
	test("pipeline list shows pipelines with names and descriptions", async ({ page, mockApi }) => {
		await mockApi({
			pipelines: [
				makePipeline({ name: "data-pipeline", description: "Processes raw data" }),
				makePipeline({ name: "deploy-pipeline", description: "Deploys to production" }),
			],
		});
		await page.goto("/pipelines");

		await expect(page.getByRole("heading", { name: "Pipelines" })).toBeVisible();
		await expect(page.getByText("data-pipeline")).toBeVisible();
		await expect(page.getByText("Processes raw data")).toBeVisible();
		await expect(page.getByText("deploy-pipeline")).toBeVisible();
		await expect(page.getByText("Deploys to production")).toBeVisible();
	});

	test("shows step count for each pipeline", async ({ page, mockApi }) => {
		await mockApi({
			pipelines: [
				makePipeline({
					name: "multi-step",
					steps: [
						{ name: "step-1", agent: "agent-a" },
						{ name: "step-2", agent: "agent-b" },
						{ name: "step-3", agent: "agent-c" },
					],
				}),
			],
		});
		await page.goto("/pipelines");

		await expect(page.getByText("3 steps")).toBeVisible();
	});

	test("empty state when no pipelines", async ({ page, mockApi }) => {
		await mockApi({ pipelines: [] });
		await page.goto("/pipelines");

		await expect(page.getByText("No pipelines defined yet.")).toBeVisible();
	});

	test("clicking a pipeline navigates to detail page", async ({ page, mockApi }) => {
		await mockApi({
			pipelines: [makePipeline({ name: "my-pipeline" })],
		});
		await page.goto("/pipelines");

		await page.getByText("my-pipeline").click();
		await expect(page).toHaveURL(/\/pipelines\/my-pipeline/);
	});

	test("pipeline detail shows name and description", async ({ page, mockApi }) => {
		await mockApi({
			pipelines: [makePipeline({ name: "my-pipeline", description: "Does things" })],
		});
		await page.goto("/pipelines/my-pipeline");

		await expect(page.getByRole("heading", { name: "my-pipeline" })).toBeVisible();
		await expect(page.getByText("Does things")).toBeVisible();
	});

	test("pipeline detail shows steps with agent names", async ({ page, mockApi }) => {
		await mockApi({
			pipelines: [
				makePipeline({
					name: "my-pipeline",
					steps: [
						{ name: "extract", agent: "extractor" },
						{ name: "transform", agent: "transformer" },
					],
				}),
			],
		});
		await page.goto("/pipelines/my-pipeline");

		await expect(page.getByText("Steps")).toBeVisible();
		await expect(page.getByText("extract", { exact: true })).toBeVisible();
		await expect(page.getByText("extractor")).toBeVisible();
		await expect(page.getByText("transform", { exact: true })).toBeVisible();
		await expect(page.getByText("transformer")).toBeVisible();
	});

	test("pipeline detail shows run pipeline section", async ({ page, mockApi }) => {
		await mockApi({
			pipelines: [makePipeline({ name: "my-pipeline" })],
		});
		await page.goto("/pipelines/my-pipeline");

		await expect(page.getByRole("heading", { name: "Run Pipeline" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Run Pipeline" })).toBeVisible();
		await expect(page.getByLabel("JSON Input")).toBeVisible();
	});

	test("pipeline not found", async ({ page, mockApi }) => {
		await mockApi({ pipelines: [] });
		await page.goto("/pipelines/nonexistent");

		await expect(page.getByText(/not found/i)).toBeVisible();
	});

	test("back link navigates to pipelines list", async ({ page, mockApi }) => {
		await mockApi({
			pipelines: [makePipeline({ name: "my-pipeline" })],
		});
		await page.goto("/pipelines/my-pipeline");

		await page.getByText("Pipelines").first().click();
		await expect(page).toHaveURL(/\/pipelines$/);
	});
});
