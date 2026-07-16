/**
 * ez-code-factory gates UI (M2) — parked-gate triage e2e (mockApi, no Docker).
 *
 * Proves the M2 user-visible contract against mocked Hub API routes:
 *   - the ez-code-factory tab renders the runs table AND an inline triage
 *     section for a PARKED run (pipeline step list, findings table, risk line,
 *     controls) from the extension's `definePage` tree,
 *   - clicking a finding row opens the host fix-instruction prompt and POSTs a
 *     `respond` fix payload (runId/step/action/findingId/instruction),
 *   - the Skip control POSTs a `respond` skip (via the host confirm dialog),
 *   - the Approve control POSTs a `respond` approve, and the content-free
 *     `ext:page-state` SSE signal re-pulls the render → the run flips to
 *     completed and the triage section disappears.
 *
 * The extension's server-side triage logic (parseRespondPayload / respondToGate
 * / the yolo autopilot / buildRunDetail) is covered by the bun suite under
 * docs/extensions/examples/ez-code-factory/. Here the mocks return
 * already-rendered trees, mirroring web/e2e/ez-code-factory-hub.spec.ts — the
 * e2e proves the CLIENT renders these node shapes and dispatches the right
 * events. The `@evidence` test satisfies the Visual evidence gate.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-1" });
const EXT_ID = "ext:ez-code-factory:dashboard";

const listing = {
	pages: [{ id: EXT_ID, title: "ez-code-factory", kind: "ext" }],
};

const RUN_ID = "run-parked";

/** Shared markdown + stats header for both trees. */
function header(active: string, completed: string) {
	return [
		{ type: "markdown", content: "Runs created by `git push gate <branch>`." },
		{
			type: "stats",
			items: [
				{ label: "Total runs", value: "1" },
				{ label: "Active", value: active },
				{ label: "Completed", value: completed },
				{ label: "Failed", value: "0" },
			],
		},
	];
}

/** A respond action descriptor for the parked review step. */
function respond(action: string, extra: Record<string, string> = {}) {
	return { event: "ez-code-factory:respond", payload: { runId: RUN_ID, step: "review", action, ...extra } };
}

/** The dashboard tree with the run PARKED at the review gate + inline triage. */
function parkedTree() {
	return {
		title: "ez-code-factory",
		nodes: [
			...header("1", "0"),
			{
				type: "table",
				columns: ["Run", "Branch", "Head", "Status", "Updated"],
				rows: [{ cells: [RUN_ID, "feat/x", "abcdef01", "⏸ awaiting approval", "2026-07-16 05:00"] }],
			},
			{
				type: "section",
				title: `Run ${RUN_ID} · feat/x`,
				nodes: [
					{
						type: "stats",
						items: [
							{ label: "Status", value: "⏸ awaiting approval" },
							{ label: "Head", value: "abcdef01" },
							{ label: "Intent", value: "explicit", hint: "ship the fix" },
						],
					},
					{
						type: "table",
						columns: ["Step", "Status", "Rounds"],
						rows: [
							{ cells: ["intent", "✓ completed", "1"] },
							{ cells: ["rebase", "✓ completed", "1"] },
							{ cells: ["review", "⏸ awaiting approval", "1"] },
						],
					},
					{ type: "heading", level: 3, text: "Gate: review (⏸ awaiting approval)" },
					{ type: "stats", items: [{ label: "Risk", value: "medium", hint: "touches auth" }] },
					{
						type: "table",
						columns: ["Severity", "File", "Description", "Action"],
						rows: [
							{
								cells: ["⛔ error", "src/auth.ts", "possible null deref", "ask-user"],
								action: {
									...respond("fix", { findingId: "f1" }),
									prompt: {
										label: "Fix instruction (optional)",
										field: "instruction",
										submitLabel: "Request fix",
										maxLength: 500,
									},
								},
							},
						],
					},
					{ type: "table", columns: ["Field", "Detail"], rows: [{ cells: ["Summary", "1 error"] }] },
					{ type: "button", label: "Approve step", action: respond("approve"), style: "primary" },
					{
						type: "button",
						label: "Skip step",
						action: { ...respond("skip"), confirm: `Skip the "review" step for run ${RUN_ID}?` },
						style: "secondary",
					},
					{
						type: "button",
						label: "Yolo — auto-approve remaining gates",
						action: {
							event: "ez-code-factory:yolo",
							payload: { runId: RUN_ID, step: "review" },
							confirm: `Yolo: auto-approve every remaining gate for run ${RUN_ID}?`,
						},
						style: "secondary",
					},
					{
						type: "button",
						label: "Abort run",
						action: { ...respond("abort"), confirm: `Abort run ${RUN_ID}?` },
						style: "danger",
					},
				],
			},
		],
	};
}

/** The dashboard AFTER approval: the run completed, no triage section. */
function approvedTree() {
	return {
		title: "ez-code-factory",
		nodes: [
			...header("0", "1"),
			{
				type: "table",
				columns: ["Run", "Branch", "Head", "Status", "Updated"],
				rows: [{ cells: [RUN_ID, "feat/x", "abcdef01", "✓ completed", "2026-07-16 05:01"] }],
			},
		],
	};
}

test.describe("ez-code-factory gates triage", () => {
	test("triage a parked gate — fix, skip, approve, and live SSE refresh @evidence", async ({
		page,
		mockApi,
		emitSse,
	}, testInfo) => {
		await mockApi({ projects: [proj] });

		const respondBodies: Array<Record<string, unknown>> = [];
		let phase: "parked" | "approved" = "parked";
		let renders = 0;

		await page.route("**/api/hub/pages", (route) => route.fulfill({ json: listing }));
		await page.route(`**/api/hub/pages/${encodeURIComponent(EXT_ID)}`, (route) => {
			renders++;
			return route.fulfill({
				json: { page: phase === "approved" ? approvedTree() : parkedTree(), renderedAt: Date.now() },
			});
		});
		// Extension page actions POST to the generic extension events route.
		await page.route("**/api/extensions/ez-code-factory/events/respond", async (route) => {
			const body = route.request().postDataJSON() as Record<string, unknown>;
			respondBodies.push(body);
			const payload = body.payload as { action?: string } | undefined;
			if (payload?.action === "approve") phase = "approved";
			return route.fulfill({ json: { ok: true } });
		});

		await page.goto(`/hub/${encodeURIComponent(EXT_ID)}`);

		// The runs table + the inline triage section (findings) both render.
		await expect(page.getByTestId("hub-node-table").filter({ hasText: RUN_ID })).toBeVisible();
		const findingsTable = page.getByTestId("hub-node-table").filter({ hasText: "possible null deref" });
		await expect(findingsTable).toContainText("src/auth.ts");
		await expect(findingsTable).toContainText("ask-user");
		await expect(page.getByText("Gate: review", { exact: false })).toBeVisible();
		await captureEvidence(page, testInfo, "ez-code-factory-gates-parked");

		// ── FIX: click the finding row → host prompt → type instruction → submit.
		await findingsTable.getByTestId("hub-table-row").first().click();
		await expect(page.getByTestId("hub-prompt-dialog")).toBeVisible();
		await captureEvidence(page, testInfo, "ez-code-factory-gates-fix-prompt");
		await page.getByTestId("hub-prompt-input").fill("prefer a guard clause");
		await page.getByTestId("hub-prompt-submit").click();
		await expect
			.poll(() => respondBodies.at(-1))
			.toEqual({
				source: "hub",
				pageId: "dashboard",
				payload: { runId: RUN_ID, step: "review", action: "fix", findingId: "f1", instruction: "prefer a guard clause" },
			});

		// ── SKIP: click Skip → host confirm dialog → confirm → POST a skip.
		await page.getByRole("button", { name: "Skip step" }).click();
		await expect(page.getByTestId("hub-confirm-dialog")).toContainText("Skip the");
		await page.getByTestId("hub-confirm-ok").click();
		await expect
			.poll(() => respondBodies.at(-1))
			.toEqual({
				source: "hub",
				pageId: "dashboard",
				payload: { runId: RUN_ID, step: "review", action: "skip" },
			});

		// ── APPROVE: click Approve → POST an approve (no prompt/confirm).
		await page.getByRole("button", { name: "Approve step" }).click();
		await expect
			.poll(() => respondBodies.at(-1))
			.toEqual({
				source: "hub",
				pageId: "dashboard",
				payload: { runId: RUN_ID, step: "review", action: "approve" },
			});

		// The server pushed a fresh (completed) tree; the content-free SSE signal
		// re-pulls the render and the triage section disappears.
		const before = renders;
		await emitSse({
			type: "ext:page-state",
			data: { extensionId: "ext-ez-code-factory", extensionName: "ez-code-factory", pageId: "dashboard", timestamp: Date.now() },
		});
		await expect(page.getByTestId("hub-node-table").filter({ hasText: RUN_ID })).toContainText("completed");
		await expect(page.getByText("Gate: review", { exact: false })).toHaveCount(0);
		expect(renders).toBeGreaterThan(before);
		await captureEvidence(page, testInfo, "ez-code-factory-gates-approved");
	});
});
