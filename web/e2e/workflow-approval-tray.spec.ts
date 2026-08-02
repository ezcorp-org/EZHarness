import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import type { Page } from "@playwright/test";
import { makeProject } from "./fixtures/data.js";

/**
 * The pending-decisions tray — the third answer surface for a workflow run
 * parked on an `approval` step.
 *
 * The routes and the pure logic are unit-tested. What only an e2e can show
 * is that a run parking somewhere else entirely REACHES the person who has
 * to decide: the notice arrives over the real SSE runtime-events stream, on
 * no conversation the client can map, typically minutes after whatever
 * started the run. So this drives the same path production does rather than
 * seeding the store directly.
 */

const APPROVAL = {
	approvalId: "ap-e2e-1",
	workflowRunId: "run-e2e-1",
	workflowName: "publish-docs",
	stepName: "publish-gate",
	prompt: "Publish the release notes?",
	choices: ["approve", "reject"],
	requireItemConsent: false,
	itemIds: [] as string[],
	expiresAt: null as string | null,
};

/** Capture the answer POST so a click resolves cleanly. */
async function installAnswerMock(page: Page, approvalId: string, runStatus = "success") {
	const posts: unknown[] = [];
	await page.route(`**/api/workflows/approvals/${approvalId}`, (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		posts.push(route.request().postDataJSON());
		return route.fulfill({ json: { run: { id: APPROVAL.workflowRunId, status: runStatus } } });
	});
	return posts;
}

/** Wait for the store's SSE stream, then push one parked-approval notice. */
async function park(
	page: Page,
	emitSse: (e: { type: string; data: unknown }, urlMatch?: string) => Promise<void>,
	overrides: Partial<typeof APPROVAL> = {},
) {
	await page.waitForFunction(() => {
		const es = (window as unknown as { __fakeEventSources?: unknown[] }).__fakeEventSources;
		return Array.isArray(es) && es.length > 0;
	});
	await emitSse(
		{ type: "workflow:approval_request", data: { ...APPROVAL, ...overrides } },
		"runtime-events",
	);
}

test.describe("Workflow approval tray", () => {
	const proj = makeProject({ id: "proj-1" });

	test("@evidence a parked run reaches the user and is answerable in place", async ({
		page,
		mockApi,
		emitSse,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		const posts = await installAnswerMock(page, APPROVAL.approvalId);

		await page.goto("/extensions");
		// Nothing to decide yet — the tray must not be a permanently-present
		// empty box in the corner of every route.
		await expect(page.getByTestId("pending-decisions-tray")).toHaveCount(0);

		await park(page, emitSse);

		await expect(page.getByTestId("pending-decisions-tray")).toBeVisible();
		await expect(page.getByTestId("pending-approval-prompt")).toHaveText(
			"Publish the release notes?",
		);
		await expect(page.getByTestId("pending-approval-source")).toContainText("publish-docs");
		await expect(page.getByTestId("pending-approval-source")).toContainText("publish-gate");

		await captureEvidence(page, testInfo, "workflow-approval-tray", { fullPage: true });
		await page.getByTestId("pending-approval-choice").first().click();

		// Answered through the ONE answer route — the same `answerApproval`
		// chokepoint the inbox and the Hub action clear — and the card then
		// leaves, because this is no longer an open question.
		expect(posts).toEqual([{ choice: "approve" }]);
		await expect(page.getByTestId("pending-approval-card")).toHaveCount(0);
	});

	test("@evidence a consent gate sends exactly what was ticked", async ({
		page,
		mockApi,
		emitSse,
	}, testInfo) => {
		await mockApi({ projects: [proj] });
		const posts = await installAnswerMock(page, "ap-e2e-2", "suspended");

		await page.goto("/extensions");
		await park(page, emitSse, {
			approvalId: "ap-e2e-2",
			requireItemConsent: true,
			itemIds: ["a.ts", "b.ts"],
		});

		// The gate is visible BEFORE the click: a disabled button explains
		// itself, a refused request after the fact does not.
		const choice = page.getByTestId("pending-approval-choice").first();
		await expect(page.getByTestId("pending-approval-consent-note")).toBeVisible();
		await expect(choice).toBeDisabled();

		await page.getByTestId("pending-approval-item").first().check();
		await expect(choice).toBeEnabled();
		await captureEvidence(page, testInfo, "workflow-approval-tray-consent", { fullPage: true });
		await choice.click();

		// EXACTLY the ticked item — never the full offered list, which would
		// turn "consent to this one" into "consent to everything you were
		// asked about".
		expect(posts).toEqual([{ choice: "approve", itemIds: ["a.ts"] }]);
	});

	test("a list too long to read sends the user to the inbox instead of taking the decision", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await mockApi({ projects: [proj] });
		await page.goto("/extensions");
		await park(page, emitSse, {
			approvalId: "ap-e2e-3",
			requireItemConsent: true,
			itemIds: Array.from({ length: 40 }, (_, i) => `file-${i}.ts`),
		});

		await expect(page.getByTestId("pending-approval-too-many")).toContainText("40 items");
		// No answer buttons at all: a truncated list cannot produce informed
		// consent, so the surface declines rather than taking one.
		await expect(page.getByTestId("pending-approval-choice")).toHaveCount(0);
		await expect(page.getByTestId("pending-approval-inbox-link")).toHaveAttribute(
			"href",
			"/workflows/approvals",
		);
	});

	test("a replayed notice does not stack a second card for one decision", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		// SSE resume replays every buffered event after the client's cursor,
		// so a reconnect re-delivers this one.
		await mockApi({ projects: [proj] });
		await page.goto("/extensions");
		await park(page, emitSse);
		await expect(page.getByTestId("pending-approval-card")).toHaveCount(1);
		await park(page, emitSse);
		await expect(page.getByTestId("pending-approval-card")).toHaveCount(1);
	});
});
