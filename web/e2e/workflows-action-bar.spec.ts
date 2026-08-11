import { test, expect } from "./fixtures/test-base.js";
import { makeWorkflow } from "./fixtures/data.js";
import { captureEvidence } from "./fixtures/evidence.js";

// The workflow detail page carries FOUR affordances in one row — Edit steps,
// Full editor, Duplicate, Delete. It was FIVE: Fork and Duplicate were two
// copy affordances differing only in where the copy was made, and the product
// owner ruled one verb. Existing specs prove each button EXISTS; this one pins
// how the row reads: the two editors are distinguishable, there is exactly one
// copy affordance, and the destructive control is separated from the benign
// ones instead of sitting flush against Duplicate.
test.describe("Workflows — detail action bar @evidence", () => {
	test("an editable workflow shows a grouped, self-describing action row", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			workflows: [
				makeWorkflow({
					name: "deploy-release-candidate",
					description: "Build, test and publish a release candidate to staging.",
					canEdit: true,
					steps: [{ name: "build", agent: "summarizer" }],
				}),
			],
		});

		await page.goto("/workflows/deploy-release-candidate");
		await expect(page.getByRole("heading", { name: "Run Workflow" })).toBeVisible();

		// The inline editor no longer says a bare "Edit" beside "Full editor",
		// which gave the user two same-weight labels and no way to tell which
		// one stayed on the page.
		const inlineEdit = page.getByTestId("workflow-edit");
		await expect(inlineEdit).toHaveText("Edit steps");
		await expect(inlineEdit).toHaveAttribute("title", /inline/i);
		await expect(page.getByTestId("edit-workflow")).toHaveAttribute("title", /standalone/i);

		// ONE copy affordance, and its title says what the click does — which
		// is to ask, not to write. The retired Fork is gone from the row.
		await expect(page.getByTestId("fork-workflow")).toHaveCount(0);
		await expect(page.getByTestId("workflow-duplicate")).toHaveAttribute(
			"title",
			/before it is created/i,
		);

		// Delete is fenced off behind a divider rather than flush against the
		// benign pill next to it.
		const divider = page.getByTestId("workflow-actions-divider");
		await expect(divider).toBeAttached();
		const dividerBox = await divider.boundingBox();
		const deleteBox = await page.getByTestId("workflow-delete").boundingBox();
		const duplicateBox = await page.getByTestId("workflow-duplicate").boundingBox();
		expect(deleteBox).not.toBeNull();
		expect(duplicateBox).not.toBeNull();
		// Everywhere: the destructive control comes LAST in reading order, so
		// it is never the pill a thumb lands on by accident.
		expect(deleteBox!.y > duplicateBox!.y || deleteBox!.x > duplicateBox!.x).toBe(true);

		// The divider itself is `hidden … sm:block` — a hairline rule is
		// noise on a narrow, wrapping row — so BELOW `sm` it is attached with
		// no box, and geometry over it would be geometry over nothing. This
		// used to assert the box unconditionally and was therefore red on
		// mobile-chromium against the page as designed.
		if (dividerBox !== null) {
			// The divider sits between them on the x axis.
			expect(dividerBox.x).toBeGreaterThan(duplicateBox!.x + duplicateBox!.width);
			expect(deleteBox!.x).toBeGreaterThan(dividerBox.x);
			// And the resulting gap is wider than the plain 8px inter-pill gap.
			expect(deleteBox!.x - (duplicateBox!.x + duplicateBox!.width)).toBeGreaterThan(8);
		}

		await captureEvidence(page, testInfo, "workflow-action-bar-editable");
	});

	test("a read-only workflow shows only the copy affordance", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			workflows: [
				makeWorkflow({
					name: "demo-yaml-flow",
					description: "A read-only YAML demo shipped with the install.",
					canEdit: false,
					source: "yaml",
					steps: [{ name: "build", agent: "summarizer" }],
				}),
			],
		});

		await page.goto("/workflows/demo-yaml-flow");
		await expect(page.getByRole("heading", { name: "Run Workflow" })).toBeVisible();

		// Every WRITE affordance is gated on the server flag — painting Edit or
		// Delete on a YAML asset would produce a button whose only outcome is a
		// 404. The divider goes with them; there is nothing to fence off.
		await expect(page.getByTestId("workflow-edit")).toHaveCount(0);
		await expect(page.getByTestId("edit-workflow")).toHaveCount(0);
		await expect(page.getByTestId("workflow-delete")).toHaveCount(0);
		await expect(page.getByTestId("workflow-actions-divider")).toHaveCount(0);

		// Duplicate survives the gate on purpose: copying something you can
		// read is exactly what it is for, and on a file-on-disk demo it is
		// the ONLY action that does anything. Removing it would dead-end the
		// page — that property is load-bearing, not incidental.
		await expect(page.getByTestId("workflow-duplicate")).toBeVisible();
		await expect(page.getByTestId("fork-workflow")).toHaveCount(0);

		await captureEvidence(page, testInfo, "workflow-action-bar-read-only");
	});
});
