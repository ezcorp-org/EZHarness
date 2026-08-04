import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeWorkflow } from "./fixtures/data.js";
import { captureEvidence } from "./fixtures/evidence.js";

// Duplicate is the platform's ONE copy verb. It used to be two — a
// client-side "Duplicate" that navigated to a prefilled create form, and a
// server-side "Fork" that wrote the row on click. The server one survived
// (it carries `forked_from` provenance and the global name-collision
// rule); what survived from Duplicate is that you decide BEFORE anything
// is written.
//
// Four properties are visible from the browser and worth pinning:
//
//  1. There is exactly ONE copy button. Two were the bug.
//  2. Clicking it commits nothing — it opens a panel with a name and an
//     audience. The old Fork POSTed on click and stamped `project`, which
//     on the read/run ladder is every account on the instance.
//  3. The default audience is "Only me". A copy is yours until you widen
//     it.
//  4. The copy's NAME is decided server-side. `workflow_definitions.name`
//     is globally unique — ownership authorizes a workflow, it never
//     namespaces one — so a taken name is auto-suffixed and the UI must
//     navigate to whatever it actually ended up called.

const WORKFLOW = makeWorkflow({
	name: "docs-factory",
	description: "writes the docs",
	steps: [{ name: "step-1", agent: "summarizer" }],
});

test.describe("Duplicate a workflow", () => {
	test.beforeEach(async ({ mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
			workflows: [WORKFLOW],
		});
	});

	async function openDetail(page: import("@playwright/test").Page, name = WORKFLOW.name) {
		const response = await page.goto(`/workflows/${encodeURIComponent(name)}`);
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(
			!finalUrl.startsWith("/workflows/"),
			"auth gate redirected away from the workflow page in this environment",
		);
		await expect(page.getByRole("heading", { name })).toBeVisible({ timeout: 5000 });
	}

	test("@evidence one copy affordance, and it asks before it writes", async ({
		page,
	}, testInfo) => {
		await openDetail(page);

		// Exactly one. The retired "Fork" button is gone, not renamed away
		// into a second pill that happens to say something else.
		await expect(page.getByTestId("workflow-duplicate")).toBeVisible();
		await expect(page.getByTestId("fork-workflow")).toHaveCount(0);
		await expect(page.getByTestId("edit-workflow")).toBeVisible();
		await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();

		// Nothing is written on click — a POST here would be the old bug.
		let posts = 0;
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) => {
			posts += 1;
			return route.fulfill({ status: 201, json: { name: "x", id: "x", forkedFrom: "x" } });
		});
		await page.getByTestId("workflow-duplicate").click();

		const panel = page.getByTestId("workflow-duplicate-panel");
		await expect(panel).toBeVisible();
		expect(posts).toBe(0);

		// The two decisions worth stopping for, both pre-filled with the safe
		// answer: a non-colliding name, and the narrowest audience.
		await expect(page.getByTestId("duplicate-name")).toHaveValue("docs-factory-copy");
		await expect(page.getByTestId("duplicate-visibility")).toHaveValue("private");
		await expect(page.getByTestId("duplicate-visibility-note")).toContainText(/only me|nobody else/i);

		await captureEvidence(page, testInfo, "workflow-duplicate-panel", { fullPage: true });
	});

	test("@evidence the wider tier says what it actually means", async ({ page }, testInfo) => {
		// "project" reads like "my team". It is not: the platform has no
		// membership model, so the tier admits every account on the instance.
		// The panel has to say so at the moment of choosing.
		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await page.getByTestId("duplicate-visibility").selectOption("project");

		await expect(page.getByTestId("duplicate-visibility-note")).toContainText(/every account/i);
		await captureEvidence(page, testInfo, "workflow-duplicate-wider-tier");
	});

	test("the copy is created with the name and tier the user chose", async ({ page }) => {
		let body: Record<string, unknown> | null = null;
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) => {
			body = route.request().postDataJSON();
			// The server suffixed because the chosen name was already taken.
			return route.fulfill({
				status: 201,
				json: {
					name: "my-docs-2",
					id: "wf-copy-1",
					forkedFrom: WORKFLOW.name,
					visibility: "project",
				},
			});
		});

		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await page.getByTestId("duplicate-name").fill("my-docs");
		await page.getByTestId("duplicate-visibility").selectOption("project");
		await page.getByTestId("duplicate-confirm").click();

		// Lands on the name the SERVER chose, not the one that was asked for.
		await expect(page).toHaveURL(/\/workflows\/my-docs-2\/edit$/, { timeout: 5000 });
		expect(body).toMatchObject({ name: "my-docs", visibility: "project" });
	});

	test("the default submit sends `private`, not the old `project`", async ({ page }) => {
		let body: Record<string, unknown> | null = null;
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) => {
			body = route.request().postDataJSON();
			return route.fulfill({
				status: 201,
				json: {
					name: "docs-factory-copy",
					id: "wf-copy-2",
					forkedFrom: WORKFLOW.name,
					visibility: "private",
				},
			});
		});

		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await page.getByTestId("duplicate-confirm").click();

		await expect(page).toHaveURL(/\/workflows\/docs-factory-copy\/edit$/, { timeout: 5000 });
		expect(body).toMatchObject({ name: "docs-factory-copy", visibility: "private" });
	});

	test("Cancel closes the panel and writes nothing", async ({ page }) => {
		let posts = 0;
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) => {
			posts += 1;
			return route.fulfill({ status: 201, json: { name: "x", id: "x", forkedFrom: "x" } });
		});

		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await expect(page.getByTestId("workflow-duplicate-panel")).toBeVisible();
		await page.getByTestId("duplicate-cancel").click();

		await expect(page.getByTestId("workflow-duplicate-panel")).toHaveCount(0);
		expect(posts).toBe(0);
		await expect(page).toHaveURL(new RegExp(`/workflows/${WORKFLOW.name}$`));
	});

	test("a failed copy surfaces the error and leaves the panel open", async ({ page }) => {
		// The user's chosen name and tier must survive the failure — the whole
		// point of deciding first is not being made to decide twice.
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) =>
			route.fulfill({
				status: 409,
				json: { error: 'A workflow named "docs-factory-copy" already exists' },
			}),
		);

		await openDetail(page);
		await page.getByTestId("workflow-duplicate").click();
		await page.getByTestId("duplicate-visibility").selectOption("project");
		await page.getByTestId("duplicate-confirm").click();

		await expect(page.getByTestId("duplicate-error")).toBeVisible({ timeout: 3000 });
		await expect(page.getByTestId("workflow-duplicate-panel")).toBeVisible();
		await expect(page.getByTestId("duplicate-visibility")).toHaveValue("project");
		await expect(page).toHaveURL(new RegExp(`/workflows/${WORKFLOW.name}$`));
	});

	test("a copy of an extension workflow drops the namespace", async ({ page, mockApi }) => {
		const namespaced = makeWorkflow({
			name: "ez-factory:docs-factory",
			description: "shipped by an extension",
			steps: [{ name: "step-1", agent: "summarizer" }],
		});
		await mockApi({ agents: [makeAgent({ name: "summarizer" })], workflows: [namespaced] });

		await openDetail(page, namespaced.name);
		await page.getByTestId("workflow-duplicate").click();

		// ':' cannot appear in a declared workflow name, so the copy could
		// never keep its source name — the prefill has already dropped it,
		// before the server ever sees the request.
		await expect(page.getByTestId("duplicate-name")).toHaveValue("docs-factory-copy");
	});
});
