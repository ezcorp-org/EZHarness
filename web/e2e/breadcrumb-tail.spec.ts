/**
 * E2E — the Command Deck strip names the subject of a detail route, whichever
 * of the three sources supplies it (frontend-visual change ⇒ `@evidence` per
 * the feature contract).
 *
 * One resolver (`$lib/breadcrumb-tail.svelte.ts`) serves every route, so what
 * needs proving end to end is that each SOURCE actually reaches the strip in a
 * real browser:
 *
 *   - the route-param table, which runs with no page-side code at all
 *     (`/workflows/<name>`);
 *   - the runtime tail a client-fetching page publishes once its subject
 *     lands (`/runs/<id>`, keyed by uuid, named by its agent);
 *   - and the same for a run trace (`/workflows/runs/<id>`).
 *
 * The negative case matters as much: a route whose only identifier is an
 * opaque id and whose page names no subject must render TWO crumbs, not a uuid
 * in the chrome. The agent route's own spec is `agent-detail-breadcrumb.spec.ts`.
 */
import { test, expect } from "./fixtures/test-base.js";
import { captureEvidence } from "./fixtures/evidence.js";
import { makeProject, makeRun, makeWorkflow } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-breadcrumb-tail", name: "Tail Workspace" });
const publishNotes = makeWorkflow({ name: "publish-notes", description: "Publishes release notes" });
const nightlyRun = makeRun({ id: "run-tail-1", agentName: "nightly-digest", status: "success" });

const TRACE = {
	run: {
		id: "wfrun-tail-1",
		workflowName: "publish-notes",
		status: "success",
		projectId: null,
		userId: "u1",
		startedAt: "2026-07-30T09:00:00.000Z",
		finishedAt: "2026-07-30T09:00:10.000Z",
		suspendedReason: null,
		resumable: false,
		jobRef: null,
		definitionHash: "abc123",
		definitionVersionId: null,
		runPhase: "boundary",
		idempotencyKey: null,
		result: { success: true, output: "published" },
	},
	steps: [
		{
			stepName: "draft",
			status: "success",
			runId: null,
			provider: null,
			model: null,
			attempt: null,
			iterations: null,
			inputTokens: null,
			outputTokens: null,
			costUsd: null,
			durationMs: 4200,
			errorCode: null,
			skippedReason: null,
			resolvedInput: null,
			output: null,
			iterationRows: [],
			startedAt: "2026-07-30T09:00:00.000Z",
			updatedAt: "2026-07-30T09:00:04.200Z",
		},
	],
	totals: { inputTokens: null, outputTokens: null, durationMs: 4200, steps: 1 },
};

/** The strip is the page's only breadcrumb and its last crumb is `tail`. */
async function expectTail(page: import("@playwright/test").Page, tail: string) {
	const strip = page.getByTestId("deck-breadcrumb");
	await expect(strip).toHaveCount(1);
	await expect(strip).toBeVisible();
	await expect(strip.getByTestId("deck-breadcrumb-tail")).toHaveText(tail);
	// No page-level breadcrumb anywhere — that component is gone.
	await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveCount(0);
}

test.describe("Command Deck breadcrumb tail", () => {
	test.describe("desktop", () => {
		test.use({ viewport: { width: 1280, height: 800 } });

		test("names a workflow from the route param, with no page-side code @evidence", async ({ page, mockApi }, testInfo) => {
			await mockApi({ projects: [proj], workflows: [publishNotes] });
			await page.goto("/workflows/publish-notes");

			await expectTail(page, "publish-notes");
			await captureEvidence(page, testInfo, "breadcrumb-tail-param-desktop");
		});

		test("names a run by its agent once the fetch lands @evidence", async ({ page, mockApi }, testInfo) => {
			// The route param is `run-tail-1`; the crumb must be the agent.
			await mockApi({ projects: [proj], runs: [nightlyRun] });
			await page.goto("/runs/run-tail-1");

			await expectTail(page, "nightly-digest");
			await expect(page.getByTestId("deck-breadcrumb-tail")).not.toHaveText("run-tail-1");
			await captureEvidence(page, testInfo, "breadcrumb-tail-runtime-desktop");
		});

		test("names a workflow run by its workflow", async ({ page, mockApi }) => {
			await mockApi({
				projects: [proj],
				workflows: [publishNotes],
				workflowRuns: [{ id: "wfrun-tail-1", workflowName: "publish-notes", status: "success", startedAt: "2026-07-30T09:00:00.000Z", trace: TRACE }],
			});
			await page.goto("/workflows/runs/wfrun-tail-1");

			await expect(page.getByTestId("run-trace")).toBeVisible();
			await expectTail(page, "publish-notes");
		});

		test("shows no tail at all for a run it cannot name", async ({ page, mockApi }) => {
			// A uuid in the chrome tells a reader less than nothing. The strip
			// must fall back to two crumbs rather than echo the param.
			await mockApi({ projects: [proj], runs: [] });
			await page.goto("/runs/run-does-not-exist");

			const strip = page.getByTestId("deck-breadcrumb");
			await expect(strip).toBeVisible();
			await expect(strip.getByTestId("deck-breadcrumb-tail")).toHaveCount(0);
			await expect(strip).not.toContainText("run-does-not-exist");
		});

		test("drops the previous subject when navigating between detail routes", async ({ page, mockApi }) => {
			// The runtime tail is tagged with the path that published it, so a
			// stale fetch can never label the page the user moved on to.
			await mockApi({ projects: [proj], runs: [nightlyRun], workflows: [publishNotes] });
			await page.goto("/runs/run-tail-1");
			await expectTail(page, "nightly-digest");

			await page.goto("/workflows/publish-notes");
			await expectTail(page, "publish-notes");
		});
	});

	test.describe("mobile", () => {
		test.use({ viewport: { width: 390, height: 844 } });

		test("shows the same single strip on a phone @evidence", async ({ page, mockApi }, testInfo) => {
			await mockApi({ projects: [proj], runs: [nightlyRun] });
			await page.goto("/runs/run-tail-1");

			await expectTail(page, "nightly-digest");
			await captureEvidence(page, testInfo, "breadcrumb-tail-runtime-mobile");
		});
	});
});
