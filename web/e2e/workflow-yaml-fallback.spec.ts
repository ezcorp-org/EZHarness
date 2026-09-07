import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeWorkflow } from "./fixtures/data.js";

const workflow = makeWorkflow({
	name: "approval-flow",
	description: "A workflow that requires a human decision.",
	inputSchema: { request: { type: "string" } },
	steps: [
		{ name: "approve", kind: "approval" },
		{ name: "run-child", kind: "workflow", workflow: "child-flow" },
	],
});

test.describe("@evidence workflow YAML fallback", () => {
	test("unsupported server fields open in YAML before the form can save", async ({ page, mockApi }, testInfo) => {
		await mockApi({ workflows: [workflow] });
		await page.goto(`/workflows/${workflow.name}/edit`);
		await expect(page.getByTestId("workflow-editor")).toBeVisible();

		const fallback = page.getByTestId("workflow-yaml-fallback");
		await expect(fallback).toContainText("inputSchema");
		await expect(fallback).toContainText("approve.kind");
		await expect(page.getByLabel("Workflow Name")).toHaveCount(0);
		await captureEvidence(page, testInfo, "workflow-yaml-fallback", { fullPage: true });

		await page.getByTestId("workflow-open-yaml").click();
		const yaml = page.getByTestId("yaml-editor");
		await expect(yaml).toHaveValue(/kind: approval/);
		await expect(yaml).toHaveValue(/workflow: child-flow/);

		await page.goto(`/workflows/${workflow.name}`);
		await page.getByTestId("workflow-edit").click();
		await expect(page.getByTestId("workflow-yaml-fallback")).toContainText("approve.kind");
		await page.getByTestId("workflow-open-yaml").click();
		await expect(page).toHaveURL(new RegExp(`/workflows/${workflow.name}/edit\\?tab=yaml$`));
		await expect(page.getByTestId("yaml-editor")).toHaveValue(/kind: approval/);
		await expect(page.getByTestId("yaml-editor")).toHaveValue(/workflow: child-flow/);
	});
});
