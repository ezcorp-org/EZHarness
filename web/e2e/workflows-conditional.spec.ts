import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeWorkflow } from "./fixtures/data.js";

/**
 * C7 — conditional skip and sub-workflow steps, on the surface a human
 * actually reads.
 *
 * The routes and the executor are unit-tested. What only an e2e can show is
 * that a SKIPPED step is visually distinguishable from a FAILED one: they
 * are both "did not produce a result", and rendering them alike is how an
 * operator ends up hunting a problem that is not there. So these assertions
 * are about the rendering, not about the status string.
 */

const CONDITIONAL = makeWorkflow({
	name: "conditional",
	steps: [
		{ name: "seed", kind: "transform", output: { v: "$input.v" } },
		{
			name: "draft",
			agent: "writer",
			dependsOn: ["seed"],
			when: { ref: "$input.publish", op: "truthy" },
		},
		{ name: "publish", agent: "shipper", dependsOn: ["draft"] },
		{
			name: "verify",
			kind: "workflow",
			workflow: "verify-suite",
			dependsOn: ["seed"],
			skipDependents: false,
		},
	],
});

/** A run in which `draft`'s guard was not met, so `draft` and its dependent
 *  `publish` were skipped — and the run still SUCCEEDED. */
const SKIPPED_RUN = {
	id: "run-skipped-1234",
	workflowName: "conditional",
	status: "success",
	startedAt: 1_760_000_000_000,
	finishedAt: 1_760_000_001_000,
	steps: [
		{ stepName: "seed", runId: "", status: "success" },
		{
			stepName: "draft",
			runId: "",
			status: "skipped",
			skippedReason: 'its "when" was not met: $input.publish is not truthy',
		},
		{
			stepName: "publish",
			runId: "",
			status: "skipped",
			skippedReason: 'step "draft" was skipped',
		},
		{ stepName: "verify", runId: "", status: "success" },
	],
	result: { success: true, output: { v: "hello" } },
};

async function openDetail(page: import("@playwright/test").Page) {
	await page.goto("/workflows/conditional");
	await expect(page.getByRole("heading", { name: "conditional" })).toBeVisible();
}

test.describe("Workflows — conditional steps and sub-workflows", () => {
	test("@evidence a skipped step reads as skipped, never as failed", async ({
		page,
		mockApi,
		emitSse,
	}, testInfo) => {
		await mockApi({ workflows: [CONDITIONAL] });
		await openDetail(page);

		// The definition side: a guarded step is labelled before it ever runs,
		// so an author can see which branches are conditional.
		await expect(page.getByTestId("step-when")).toHaveCount(2);
		await expect(page.getByTestId("step-when").first()).toHaveText("conditional");
		// The opt-out is called out rather than silently identical.
		await expect(page.getByTestId("step-when").nth(1)).toContainText("dependents still run");

		// A sub-workflow step names — and links to — the graph it runs. A bare
		// `workflow` badge would say nothing on a workflow's own page.
		const nested = page.getByTestId("step-nested-workflow");
		await expect(nested).toHaveText("verify-suite");
		await expect(nested).toHaveAttribute("href", "/workflows/verify-suite");

		await emitSse({ type: "workflow:complete", data: { workflowRun: SKIPPED_RUN } });

		await expect(page.getByRole("heading", { name: "Run History" })).toBeVisible();
		// THE property: the run succeeded even though two steps never ran.
		// Rendering the run as failed here is the whole bug class C7 exists to
		// avoid, and it is invisible in a status-string unit test.
		await expect(page.getByText("success", { exact: true }).first()).toBeVisible();
		await expect(page.getByTestId("run-error")).toHaveCount(0);

		const skipped = page.getByTestId("run-step-skipped");
		await expect(skipped).toHaveCount(2);
		// Muted, not red: a skipped step must not look alarming.
		await expect(skipped.first().locator("span.text-\\[var\\(--color-text-muted\\)\\]").first()).toBeVisible();
		// And it explains itself — its own guard, then the dependency.
		await expect(page.getByTestId("step-skipped-reason").first()).toContainText(
			'"when" was not met',
		);
		await expect(page.getByTestId("step-skipped-reason").nth(1)).toContainText(
			'step "draft" was skipped',
		);

		await captureEvidence(page, testInfo, "workflow-conditional-skipped-steps", {
			fullPage: true,
		});
	});

	test("a failed step still reads as failed — the two are not collapsed", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// The negative control for the test above. If `skipped` were rendered
		// through the same path as an error, the first test would still pass;
		// what proves they are distinct is that an error keeps its own
		// treatment and its own explanation line.
		await mockApi({ workflows: [CONDITIONAL] });
		await openDetail(page);

		await emitSse({
			type: "workflow:error",
			data: {
				workflowRun: {
					...SKIPPED_RUN,
					id: "run-failed-9876",
					status: "error",
					steps: [{ stepName: "seed", runId: "", status: "error" }],
					result: { success: false, output: null, error: 'Step "seed" failed: boom' },
				},
			},
		});

		await expect(page.getByTestId("run-error")).toContainText('Step "seed" failed: boom');
		await expect(page.getByTestId("run-step-skipped")).toHaveCount(0);
		await expect(page.getByTestId("step-skipped-reason")).toHaveCount(0);
	});
});
