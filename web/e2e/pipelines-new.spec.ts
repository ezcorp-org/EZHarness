import { test, expect } from "./fixtures/test-base.js";
import { makeAgent } from "./fixtures/data.js";

// /pipelines/new is the New Pipeline form. The page itself has no server load,
// so it loads under the (app) route group when the auth gate is bypassed (which
// happens in the e2e webServer because PI_SKIP_INIT=1 makes hooks.server.ts
// skip the unauthenticated redirect when the DB is not initialized). The form
// is rendered by PipelineBuilder.svelte and posts to /api/pipelines on submit.
//
// We mock the agents endpoint so the agent <select> has options, mock POST
// /api/pipelines for the success and error cases, and exercise client-side
// validation by submitting an empty name.

test.describe("New Pipeline Page", () => {
	test("renders the form with name, description, and a step row", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer", description: "Summarises text" })],
			pipelines: [],
		});

		const response = await page.goto("/pipelines/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/pipelines/new", "auth gate redirected away from /pipelines/new in this environment");

		await expect(page.getByRole("heading", { name: "New Pipeline" })).toBeVisible({ timeout: 5000 });
		await expect(page.getByLabel("Pipeline Name")).toBeVisible();
		await expect(page.getByLabel("Description")).toBeVisible();
		await expect(page.getByRole("heading", { name: "Steps" })).toBeVisible();
		await expect(page.getByRole("button", { name: "Save Pipeline" })).toBeVisible();
		// Initial step row provided by the builder.
		await expect(page.getByLabel("Step Name")).toBeVisible();
		await expect(page.getByLabel("Agent")).toBeVisible();
	});

	test("client-side validation: empty pipeline name shows an error", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
			pipelines: [],
		});

		const response = await page.goto("/pipelines/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/pipelines/new", "auth gate redirected away from /pipelines/new in this environment");

		// Pick an agent so the step is otherwise valid; leave the pipeline name blank.
		await page.getByLabel("Agent").selectOption("summarizer");
		await page.getByRole("button", { name: "Save Pipeline" }).click();

		await expect(page.getByText("Pipeline name is required")).toBeVisible({ timeout: 3000 });
	});

	test("successful submit redirects to the pipelines list", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
			pipelines: [],
		});

		// Capture the POST to confirm the form actually submitted, and respond
		// with a successful payload so the page calls goto("/pipelines").
		let postCount = 0;
		await page.route("**/api/pipelines", (route) => {
			if (route.request().method() === "POST") {
				postCount += 1;
				return route.fulfill({
					json: { name: "demo", description: "demo desc", steps: [{ name: "step-1", agent: "summarizer" }] },
				});
			}
			return route.fulfill({ json: [] });
		});

		const response = await page.goto("/pipelines/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/pipelines/new", "auth gate redirected away from /pipelines/new in this environment");

		await page.getByLabel("Pipeline Name").fill("demo");
		await page.getByLabel("Description").fill("demo desc");
		await page.getByLabel("Agent").selectOption("summarizer");
		await page.getByRole("button", { name: "Save Pipeline" }).click();

		await expect(page).toHaveURL(/\/pipelines$/, { timeout: 5000 });
		expect(postCount).toBeGreaterThan(0);
	});

	test("server error displays the error message and stays on the form", async ({ page, mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
			pipelines: [],
		});

		await page.route("**/api/pipelines", (route) => {
			if (route.request().method() === "POST") {
				return route.fulfill({
					status: 400,
					json: { error: "Pipeline name already exists" },
				});
			}
			return route.fulfill({ json: [] });
		});

		const response = await page.goto("/pipelines/new");
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(finalUrl !== "/pipelines/new", "auth gate redirected away from /pipelines/new in this environment");

		await page.getByLabel("Pipeline Name").fill("demo");
		await page.getByLabel("Agent").selectOption("summarizer");
		await page.getByRole("button", { name: "Save Pipeline" }).click();

		await expect(page.getByText("Pipeline name already exists")).toBeVisible({ timeout: 5000 });
		await expect(page).toHaveURL(/\/pipelines\/new$/);
	});
});
