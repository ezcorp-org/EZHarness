import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";

/**
 * The approvals inbox — the surface a human uses to unblock a parked run.
 *
 * The routes underneath are unit-tested; what only an e2e can show is that
 * a parked decision is REACHABLE and answerable, and that the consent gate
 * is visible before the click rather than reported after it.
 */

const PLAIN = {
	id: "ap-plain",
	workflowRunId: "run-1",
	workflowName: "ship-it",
	stepName: "confirm",
	prompt: "Publish the release notes?",
	choices: ["approve", "reject"],
	requireItemConsent: false,
	itemIds: [],
	formSchema: null,
	expiresAt: null,
	createdAt: "2026-07-30T09:00:00.000Z",
};

const CONSENT = {
	...PLAIN,
	id: "ap-consent",
	workflowRunId: "run-2",
	workflowName: "delete-stale",
	stepName: "confirm-deletes",
	prompt: "Delete these files?",
	requireItemConsent: true,
	itemIds: ["a.ts", "b.ts"],
};

async function inbox(page: import("@playwright/test").Page, approvals: unknown[]) {
	await page.route("**/api/workflows/approvals", (route) =>
		route.fulfill({ json: { approvals } }),
	);
	await page.goto("/workflows/approvals");
	await expect(page.getByTestId("approvals-inbox")).toBeVisible();
}

test.describe("Workflow approvals inbox", () => {
	test("@evidence lists a parked decision and answers it", async ({ page, mockApi }, testInfo) => {
		await mockApi({});
		await inbox(page, [PLAIN]);

		await expect(page.getByTestId("approval-workflow")).toHaveText("ship-it");
		await expect(page.getByTestId("approval-step")).toHaveText("confirm");
		await expect(page.getByTestId("approval-prompt")).toHaveText("Publish the release notes?");

		let answered: Record<string, unknown> | null = null;
		await page.route(`**/api/workflows/approvals/${PLAIN.id}`, (route) => {
			answered = route.request().postDataJSON();
			return route.fulfill({ json: { run: { id: "run-1", status: "success" } } });
		});

		await captureEvidence(page, testInfo, "workflow-approvals-inbox", { fullPage: true });
		await page.getByTestId("approval-choice").first().click();

		// The row leaves the list — it is no longer an OPEN question — and
		// the outcome reports the RUN's fate, not merely a 200.
		await expect(page.getByTestId("approval-card")).toHaveCount(0);
		await expect(page.getByTestId("approval-outcome")).toContainText("completed");
		expect(answered).toEqual({ choice: "approve" });
	});

	test("@evidence an item-consent approval cannot be answered until items are ticked", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({});
		await inbox(page, [CONSENT]);

		// The gate is visible BEFORE the click: a disabled button explains
		// itself, a refused request after the fact does not.
		const choice = page.getByTestId("approval-choice").first();
		await expect(page.getByTestId("approval-consent-note")).toBeVisible();
		await expect(choice).toBeDisabled();

		let answered: Record<string, unknown> | null = null;
		await page.route(`**/api/workflows/approvals/${CONSENT.id}`, (route) => {
			answered = route.request().postDataJSON();
			return route.fulfill({ json: { run: { id: "run-2", status: "suspended" } } });
		});

		await page.getByTestId("approval-item").first().check();
		await expect(choice).toBeEnabled();
		await captureEvidence(page, testInfo, "workflow-approvals-item-consent", { fullPage: true });
		await choice.click();

		// EXACTLY the ticked item — never the full offered list, which would
		// turn "consent to this one" into "consent to everything asked".
		expect(answered).toEqual({ choice: "approve", itemIds: ["a.ts"] });
		// `suspended` after an answer is the NEXT approval, i.e. progress.
		await expect(page.getByTestId("approval-outcome")).toContainText("next approval");
	});

	test("an empty inbox says so rather than rendering nothing", async ({ page, mockApi }) => {
		await mockApi({});
		await inbox(page, []);
		await expect(page.getByTestId("approvals-empty")).toBeVisible();
		await expect(page.getByTestId("approval-card")).toHaveCount(0);
	});

	test("a failed answer keeps the row and never claims it was not recorded", async ({
		page,
		mockApi,
	}) => {
		await mockApi({});
		await inbox(page, [PLAIN]);

		// `resume-failed` means the answer WAS recorded and the run then did
		// not continue. Telling the user "not answered" would send them to
		// answer it again, which the CAS would refuse.
		await page.route(`**/api/workflows/approvals/${PLAIN.id}`, (route) =>
			route.fulfill({
				status: 409,
				json: { error: "Your answer was recorded, but run run-1 could not continue: drift" },
			}),
		);

		await page.getByTestId("approval-choice").first().click();

		await expect(page.getByTestId("approval-outcome")).toContainText("was recorded");
		await expect(page.getByTestId("approval-card")).toHaveCount(1);
	});

	test("a failing inbox load reports the error instead of an empty state", async ({
		page,
		mockApi,
	}) => {
		await mockApi({});
		// An empty state here would read as "nothing is waiting on you",
		// which is the opposite of what an unreachable inbox means.
		await page.route("**/api/workflows/approvals", (route) => route.fulfill({ status: 500 }));
		await page.goto("/workflows/approvals");

		await expect(page.getByTestId("approvals-error")).toBeVisible();
		await expect(page.getByTestId("approvals-empty")).toHaveCount(0);
	});
});
