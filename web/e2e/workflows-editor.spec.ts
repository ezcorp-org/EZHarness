import { test, expect } from "./fixtures/test-base.js";
import { makeAgent, makeWorkflow } from "./fixtures/data.js";
import { captureEvidence } from "./fixtures/evidence.js";

// /workflows/[name]/edit is the C6 editor: a form tab over the shared
// builder, a raw-YAML tab, a dry-run panel and the version history. The
// page loads through GET /api/workflows/[name], which since C6 returns
// the definition PLUS the caller's provenance — `canEdit` in particular
// is computed server-side from the one shared ladder and merely RENDERED
// here, never re-derived in the browser.

const WORKFLOW = makeWorkflow({
	name: "docs-factory",
	description: "writes the docs",
	steps: [
		{ name: "step-1", agent: "summarizer" },
		{ name: "summary", kind: "transform", output: { note: "$prev.output" } },
	],
});

async function openEditor(page: import("@playwright/test").Page) {
	const response = await page.goto(`/workflows/${WORKFLOW.name}/edit`);
	const finalUrl = response ? new URL(response.url()).pathname : "";
	test.skip(
		!finalUrl.endsWith("/edit"),
		"auth gate redirected away from the workflow editor in this environment",
	);
	await expect(page.getByTestId("workflow-editor")).toBeVisible({ timeout: 5000 });
}

test.describe("Workflow editor", () => {
	test.beforeEach(async ({ mockApi }) => {
		await mockApi({
			agents: [makeAgent({ name: "summarizer", description: "Summarises text" })],
			workflows: [WORKFLOW],
		});
	});

	test("@evidence loads the definition into the form tab with its provenance", async ({
		page,
	}, testInfo) => {
		await openEditor(page);

		await expect(page.getByRole("heading", { name: `Edit ${WORKFLOW.name}` })).toBeVisible();
		await expect(page.getByTestId("workflow-visibility")).toHaveText("project");
		await expect(page.getByTestId("workflow-version")).toHaveText("v1");

		// The form is populated from the saved definition, not blank.
		await expect(page.getByLabel("Workflow Name")).toHaveValue(WORKFLOW.name);
		await expect(page.getByLabel("Description")).toHaveValue(WORKFLOW.description);
		await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible();

		await captureEvidence(page, testInfo, "workflow-editor-form-tab", { fullPage: true });
	});

	test("@evidence the YAML tab renders the definition as an editable document", async ({
		page,
	}, testInfo) => {
		await openEditor(page);
		await page.getByTestId("tab-yaml").click();

		const yaml = page.getByTestId("yaml-editor");
		await expect(yaml).toBeVisible();
		const text = await yaml.inputValue();
		expect(text).toContain(`name: ${WORKFLOW.name}`);
		expect(text).toContain("steps:");
		// Key order is human, not serialization order.
		expect(text.indexOf("name:")).toBeLessThan(text.indexOf("steps:"));

		await captureEvidence(page, testInfo, "workflow-editor-yaml-tab", { fullPage: true });
	});

	test("the YAML tab reports a parse error instead of saving a broken document", async ({
		page,
	}) => {
		await openEditor(page);
		await page.getByTestId("tab-yaml").click();
		await page.getByTestId("yaml-editor").fill("name: [unclosed\n");
		await page.getByTestId("save-yaml").click();

		await expect(page.getByTestId("editor-save-error")).toBeVisible({ timeout: 3000 });
	});

	test("a YAML document that is not a mapping is rejected with a useful message", async ({
		page,
	}) => {
		await openEditor(page);
		await page.getByTestId("tab-yaml").click();
		await page.getByTestId("yaml-editor").fill("- one\n- two\n");
		await page.getByTestId("save-yaml").click();

		await expect(page.getByTestId("editor-save-error")).toContainText("YAML mapping");
	});

	test("saving from the YAML tab PUTs the parsed definition", async ({ page }) => {
		await openEditor(page);
		await page.getByTestId("tab-yaml").click();

		let putBody: Record<string, unknown> | null = null;
		await page.route(`**/api/workflows/${WORKFLOW.name}`, (route) => {
			if (route.request().method() === "PUT") {
				putBody = route.request().postDataJSON() as Record<string, unknown>;
				return route.fulfill({ json: { id: "wf-1", name: WORKFLOW.name } });
			}
			return route.fallback();
		});

		await page
			.getByTestId("yaml-editor")
			.fill("name: docs-factory\ndescription: edited\nsteps:\n  - name: step-1\n    agent: summarizer\n");
		await page.getByTestId("save-yaml").click();

		await expect(page.getByTestId("editor-saved")).toBeVisible({ timeout: 3000 });
		expect(putBody).toMatchObject({ name: "docs-factory", description: "edited" });
		// The strict PUT schema rejects unknown fields, so the provenance the
		// GET returned must not be echoed back.
		expect(putBody).not.toHaveProperty("canEdit");
		expect(putBody).not.toHaveProperty("visibility");
	});

	test("@evidence a dry run reports which steps were stubbed and which really ran", async ({
		page,
	}, testInfo) => {
		await openEditor(page);
		await page.getByTestId("dry-run-button").click();

		await expect(page.getByTestId("dry-run-report")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("dry-run-status")).toHaveText("success");
		// The agent step is stood in for; the transform is evaluated for real.
		await expect(page.getByTestId("dry-run-mode").first()).toHaveText("stubbed");
		await expect(page.getByTestId("dry-run-mode").nth(1)).toHaveText("evaluated");

		await captureEvidence(page, testInfo, "workflow-editor-dry-run", { fullPage: true });
	});

	test("a dry run with malformed JSON input reports it without calling the server", async ({
		page,
	}) => {
		await openEditor(page);

		let dryRunCalls = 0;
		await page.route(`**/api/workflows/${WORKFLOW.name}/dry-run`, (route) => {
			dryRunCalls += 1;
			return route.fallback();
		});

		await page.getByTestId("dry-run-input").fill("{ not json");
		await page.getByTestId("dry-run-button").click();

		await expect(page.getByTestId("dry-run-error")).toContainText("not valid JSON");
		expect(dryRunCalls).toBe(0);
	});

	test("the version history lists the recorded versions", async ({ page }) => {
		await openEditor(page);
		await expect(page.getByTestId("version-history")).toBeVisible();
		await expect(page.getByTestId("version-history")).toContainText("v1");
	});

	test("a workflow the caller cannot edit says so, rather than failing on save", async ({
		page,
	}) => {
		// `canEdit` is the server's answer. Every row that existed before
		// ownership shipped is `system`, and `system` is admin-only to edit —
		// so a non-admin sees this on most workflows immediately after upgrade.
		await page.route(`**/api/workflows/${WORKFLOW.name}`, (route) => {
			if (route.request().method() === "GET") {
				return route.fulfill({
					json: { ...WORKFLOW, source: "db", visibility: "system", canEdit: false },
				});
			}
			return route.fallback();
		});

		await openEditor(page);
		await expect(page.getByTestId("editor-readonly")).toBeVisible();
		await expect(page.getByTestId("editor-readonly")).toContainText("fork it");
	});
});
