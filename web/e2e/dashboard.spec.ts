import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeRun, makeProject } from "./fixtures/data.js";

test.describe("Dashboard", () => {
	test("shows agent cards when agents exist", async ({ page, mockApi }) => {
		await mockApi({
			agents: [
				makeAgent({ name: "summarizer", description: "Summarizes text" }),
				makeAgent({ name: "coder", description: "Writes code" }),
			],
		});
		await page.goto("/");

		await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
		await expect(page.getByText("summarizer")).toBeVisible();
		await expect(page.getByText("coder")).toBeVisible();
	});

	test("shows empty state when no agents", async ({ page, mockApi }) => {
		await mockApi({ agents: [] });
		await page.goto("/");

		await expect(page.getByText("No agents available.")).toBeVisible();
	});

	test("shows recent runs", async ({ page, mockApi }) => {
		await mockApi({
			runs: [
				makeRun({ id: "run-1", agentName: "summarizer", status: "success" }),
				makeRun({ id: "run-2", agentName: "coder", status: "error" }),
			],
		});
		await page.goto("/");

		await expect(page.getByText("Recent Runs")).toBeVisible();
	});

	test("shows empty state when no runs", async ({ page, mockApi }) => {
		await mockApi({ runs: [] });
		await page.goto("/");

		await expect(page.getByText("No runs yet.")).toBeVisible();
	});

	test("project dashboard shows project-filtered content", async ({ page, mockApi }) => {
		const proj = makeProject({ id: "proj-1", name: "My Project" });
		await mockApi({
			projects: [proj],
			agents: [makeAgent({ name: "agent-1" })],
			runs: [makeRun({ id: "run-1", projectId: "proj-1" })],
		});
		await page.goto(`/project/${proj.id}`);

		await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Recent Runs" })).toBeVisible();
	});
});
