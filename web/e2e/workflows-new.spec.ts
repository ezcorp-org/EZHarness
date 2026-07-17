import { test, expect } from "./fixtures/test-base.js";
import { makeAgent } from "./fixtures/data.js";

// /workflows/new is the New Workflow form. The page itself has no server load,
// so it loads under the (app) route group when the auth gate is bypassed (which
// happens in the e2e webServer because PI_SKIP_INIT=1 makes hooks.server.ts
// skip the unauthenticated redirect when the DB is not initialized). The form
// is rendered by WorkflowBuilder.svelte and posts to /api/workflows on submit.
//
// We mock the agents endpoint so the agent <select> has options, mock POST
// /api/workflows for the success and error cases, and exercise client-side
// validation by submitting an empty name.

test.describe("New Workflow Page", () => {
	test("renders the form with name, description, and a step row", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer", description: "Summarises text" })],
			workflows: [],
		});

		const response = await page.goto("/workflows/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/workflows/new", "auth gate redirected away from /workflows/new in this environment");

		await expect(page.getByRole("heading", { name: "New Workflow" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByLabel("Workflow Name")).toBeVisible();
		await expect(page.getByLabel("Description")).toBeVisible();
		await expect(page.getByRole("heading", { name: "Steps" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Save Workflow" })).toBeVisible();
		// Initial step row provided by the builder.
		await expect(page.getByLabel("Step Name")).toBeVisible();
		await expect(page.getByLabel("Agent")).toBeVisible();
	});

	test("client-side validation: empty workflow name shows an error", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
			workflows: [],
		});

		const response = await page.goto("/workflows/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/workflows/new", "auth gate redirected away from /workflows/new in this environment");

		// Pick an agent so the step is otherwise valid; leave the workflow name blank.
		await page.getByLabel("Agent").selectOption("summarizer");
		await page.getByRole("button", { name: "Save Workflow" }).click();

		await expect(page.getByText("Workflow name is required")).toBeVisible({ timeout: 3000 });
	});

	test("successful submit redirects to the workflows list", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
			workflows: [],
		});

		// Capture the POST to confirm the form actually submitted, and respond
		// with a successful payload so the page calls goto("/workflows").
		let postCount = 0;
		await page.route("**/api/workflows", (route) => {
			if (route.request().method() === "POST") {
				postCount += 1;
				return route.fulfill({
					json: { name: "demo", description: "demo desc", steps: [{ name: "step-1", agent: "summarizer" }] },
				});
			}
			return route.fulfill({ json: [] });
		});

		const response = await page.goto("/workflows/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/workflows/new", "auth gate redirected away from /workflows/new in this environment");

		await page.getByLabel("Workflow Name").fill("demo");
		await page.getByLabel("Description").fill("demo desc");
		await page.getByLabel("Agent").selectOption("summarizer");
		await page.getByRole("button", { name: "Save Workflow" }).click();

		await expect(page).toHaveURL(/\/workflows$/, { timeout: 5000 });
		expect(postCount).toBeGreaterThan(0);
	});

	test("server error displays the error message and stays on the form", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
			workflows: [],
		});

		await page.route("**/api/workflows", (route) => {
			if (route.request().method() === "POST") {
				return route.fulfill({
					status: 400,
					json: { error: "Workflow name already exists" },
				});
			}
			return route.fulfill({ json: [] });
		});

		const response = await page.goto("/workflows/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/workflows/new", "auth gate redirected away from /workflows/new in this environment");

		await page.getByLabel("Workflow Name").fill("demo");
		await page.getByLabel("Agent").selectOption("summarizer");
		await page.getByRole("button", { name: "Save Workflow" }).click();

		await expect(page.getByText("Workflow name already exists")).toBeVisible({ timeout: 5000 });
		await expect(page).toHaveURL(/\/workflows\/new$/);
	});
});
