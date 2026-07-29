import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeWorkflow } from "./fixtures/data.js";
import { captureEvidence } from "./fixtures/evidence.js";

// Fork clones a workflow the caller can READ into an editable copy they
// own. Two properties are visible from the browser and worth pinning:
//
//  1. The fork's NAME is decided server-side. `workflow_definitions.name`
//     is globally unique — ownership authorizes a workflow, it never
//     namespaces one — so a fork of a taken name is auto-suffixed and the
//     UI must navigate to whatever it actually ended up called, not to
//     the name it asked for.
//  2. A namespaced `<ext>:<name>` source cannot keep its name at all:
//     ':' is illegal in a declared workflow name, which is what makes
//     extension namespacing structural.

const WORKFLOW = makeWorkflow({
	name: "docs-factory",
	description: "writes the docs",
	steps: [{ name: "step-1", agent: "summarizer" }],
});

test.describe("Fork a workflow", () => {
	test.beforeEach(async ({ mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer" })],
			workflows: [WORKFLOW],
		});
	});

	async function openDetail(page: import("@playwright/test").Page) {
		const response = await page.goto(`/workflows/${WORKFLOW.name}`);
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(
			!finalUrl.startsWith("/workflows/"),
			"auth gate redirected away from the workflow page in this environment",
		);
		await expect(page.getByRole("heading", { name: WORKFLOW.name })).toBeVisible({ timeout: 5000 });
	}

	test("@evidence the detail page offers Edit and Fork alongside Delete", async ({
		page,
	}, testInfo) => {
		await openDetail(page);

		await expect(page.getByTestId("edit-workflow")).toBeVisible();
		await expect(page.getByTestId("fork-workflow")).toBeVisible();
		await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();

		await captureEvidence(page, testInfo, "workflow-detail-fork-actions", { fullPage: true });
	});

	test("forking navigates to the editor for the name the SERVER chose", async ({ page }) => {
		let forkCalls = 0;
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) => {
			forkCalls += 1;
			// The server suffixed because the bare name was already taken.
			return route.fulfill({
				status: 201,
				json: { name: "docs-factory-2", id: "wf-fork-1", forkedFrom: WORKFLOW.name },
			});
		});

		await openDetail(page);
		await page.getByTestId("fork-workflow").click();

		await expect(page).toHaveURL(/\/workflows\/docs-factory-2\/edit$/, { timeout: 5000 });
		expect(forkCalls).toBe(1);
	});

	test("a failed fork surfaces the error instead of navigating", async ({ page }) => {
		await page.route(`**/api/workflows/${WORKFLOW.name}/fork`, (route) =>
			route.fulfill({ status: 409, json: { error: 'A workflow named "docs-factory" already exists' } }),
		);

		await openDetail(page);
		await page.getByTestId("fork-workflow").click();

		await expect(page.getByTestId("fork-error")).toBeVisible({ timeout: 3000 });
		await expect(page).toHaveURL(new RegExp(`/workflows/${WORKFLOW.name}$`));
	});

	test("a fork of an extension workflow drops the namespace", async ({ page, mockApi }) => {
		const namespaced = makeWorkflow({
			name: "ez-factory:docs-factory",
			description: "shipped by an extension",
			steps: [{ name: "step-1", agent: "summarizer" }],
		});
		await mockApi({ agents: [makeAgent({ name: "summarizer" })], workflows: [namespaced] });

		const response = await page.goto(`/workflows/${encodeURIComponent(namespaced.name)}`);
		const finalUrl = response ? new URL(response.url()).pathname : "";
		test.skip(
			!finalUrl.startsWith("/workflows/"),
			"auth gate redirected away from the workflow page in this environment",
		);
		await expect(page.getByRole("heading", { name: namespaced.name })).toBeVisible({ timeout: 5000 });

		await page.getByTestId("fork-workflow").click();
		// The default mock suffixes the BARE half — ':' cannot appear in a
		// declared workflow name, so the fork could never keep its source name.
		await expect(page).toHaveURL(/\/workflows\/docs-factory-2\/edit$/, { timeout: 5000 });
	});
});
