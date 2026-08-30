/**
 * E2E — the `run_workflow` result card in the transcript
 * (frontend-visual change ⇒ `@evidence` per the feature contract).
 *
 * THE BUG THIS CARD FIXES: reference and execution are split by design
 * (`docs/features/orchestration/workflows.md`) — a `![workflow:name]`
 * mention only injects a note, and the model that later calls
 * `run_workflow` writes a free-form PROSE summary of the JSON it gets back.
 * A user ran `![workflow:demo-deterministic]` twice; both runs produced
 * byte-identical tool output, but the two chat replies LOOKED different —
 * one echoed a fenced ```json block, the other reformatted the same fields
 * as markdown bullets. `cardType: "default"` routed the result through
 * DefaultCard, a generic collapsed-by-default card with a 50-char truncated
 * preview — so the only thing rendering the canonical value consistently
 * was the model's sampled prose, which is not consistent by construction.
 *
 * What is pinned here is what a USER can see:
 *   1. The workflow name, terminal status, and per-step statuses render.
 *   2. A looped step's iteration count renders; a non-looped step's does not.
 *   3. THE CORE FIX: two tool calls carrying byte-identical `run_workflow`
 *      output render byte-identical result blocks, regardless of how
 *      differently the surrounding assistant prose describes them.
 *   4. A failed run shows the loud, readable error — not just a red mark.
 *   5. An infra-level tool failure (`Error: ...`, not JSON) degrades to
 *      DefaultCard rather than a blank or broken workflow-run card.
 *   6. A definition's `outputTemplate` renders as an author-controlled
 *      report ALONGSIDE the raw result — never instead of it — and a run
 *      with no template shows no such panel.
 *
 * `captureEvidence` is a hard no-op unless `EZCORP_E2E_EVIDENCE=1`.
 */
import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const PROJECT_ID = "proj-workflow-run-card";
const project = makeProject({ id: PROJECT_ID, name: "Workflow Run Card Project" });

/** The shape `projectWorkflowRun` produces (`run-workflow.ts:96-109`). */
const SUCCESS_PROJECTION = {
	runId: "wr-det-9001",
	workflowName: "demo-deterministic",
	status: "success",
	steps: [
		{ name: "compose", status: "success" },
		{ name: "assert-composed", status: "success" },
		{ name: "publish", status: "success" },
	],
	result: { headline: "Report on workflows" },
	error: null,
};

/** The shape a definition with `outputTemplate` produces — additive to
 *  the raw `result`, never a replacement for it. */
const TEMPLATED_PROJECTION = {
	runId: "wr-det-9002",
	workflowName: "demo-deterministic",
	status: "success",
	steps: [
		{ name: "compose", status: "success" },
		{ name: "assert-composed", status: "success" },
		{ name: "publish", status: "success" },
	],
	result: { slug: "workflows-report", headline: "Report on workflows" },
	error: null,
	renderedOutput: "Report on workflows (slug: workflows-report)",
};

const LOOP_PROJECTION = {
	runId: "wr-loop-42",
	workflowName: "demo-loop-counter",
	status: "success",
	steps: [{ name: "count", status: "success", iterations: 3 }],
	result: { n: 3 },
	error: null,
};

const FAILED_PROJECTION = {
	runId: "wr-loop-43",
	workflowName: "demo-loop-counter",
	status: "error",
	steps: [{ name: "count", status: "error", iterations: 5 }],
	result: null,
	error: 'Step "count" exhausted 5 iterations without meeting its until-condition',
};

/** A persisted `run_workflow` tool call in the shape `withToolCalls=true` returns. */
function persistedRunWorkflowCall(over: {
	id: string;
	output: string;
	messageId: string;
	status?: "success" | "error" | "interrupted";
}) {
	return {
		id: over.id,
		extensionId: "",
		toolName: "run_workflow",
		input: { name: "demo-deterministic" },
		outputSummary: over.output.slice(0, 120),
		fullOutput: over.output,
		success: (over.status ?? "success") === "success",
		durationMs: 480,
		status: over.status ?? "success",
		messageId: over.messageId,
		cardType: "workflow-run",
	};
}

function seedTurn(convId: string, assistantText: string) {
	return [
		makeMessage({
			id: `${convId}-u1`,
			conversationId: convId,
			role: "user",
			content: "run ![workflow:demo-deterministic] with topic workflows",
			parentMessageId: null,
			createdAt: "2026-08-30T10:00:00.000Z",
		}),
		makeMessage({
			id: `${convId}-a1`,
			conversationId: convId,
			role: "assistant",
			content: assistantText,
			parentMessageId: `${convId}-u1`,
			createdAt: "2026-08-30T10:00:01.000Z",
		}),
	];
}

async function seedRun(
	mockApi: (config: Record<string, unknown>) => Promise<void>,
	convId: string,
	assistantText: string,
	call: ReturnType<typeof persistedRunWorkflowCall>,
) {
	await mockApi({
		projects: [project],
		conversations: [makeConversation({ id: convId, projectId: PROJECT_ID, title: "Workflow run" })],
		messages: seedTurn(convId, assistantText),
		messageToolCalls: { [`${convId}-a1`]: [call] },
	});
}

test.describe("run_workflow result card in the transcript", () => {
	test("renders the workflow name, per-step statuses and the result verbatim @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		const convId = "conv-workflow-run-success";
		await seedRun(
			mockApi,
			convId,
			"Here's a JSON summary:\n```json\n" + JSON.stringify(SUCCESS_PROJECTION.result) + "\n```",
			persistedRunWorkflowCall({
				id: "tc-wf-success",
				messageId: `${convId}-a1`,
				output: JSON.stringify(SUCCESS_PROJECTION),
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const card = page.getByTestId("workflow-run-card");
		await expect(card).toBeVisible({ timeout: 10_000 });

		await expect(page.getByTestId("workflow-run-name")).toHaveText("demo-deterministic");
		const status = page.getByTestId("workflow-run-status");
		await expect(status).toHaveText("success");
		await expect(status).toHaveAttribute("data-status", "success");

		const steps = page.getByTestId("workflow-run-step");
		await expect(steps).toHaveCount(3);
		await expect(steps.nth(0)).toContainText("compose");
		await expect(steps.nth(2)).toContainText("publish");

		// The RESULT — verbatim, pretty-printed, expanded by default.
		const resultBody = page.getByTestId("workflow-run-result-body");
		await expect(resultBody).toBeVisible();
		expect(await resultBody.textContent()).toBe(
			JSON.stringify(SUCCESS_PROJECTION.result, null, 2),
		);
		const detailsOpen = await page.getByTestId("workflow-run-result").evaluate(
			(el) => (el as HTMLDetailsElement).open,
		);
		expect(detailsOpen).toBe(true);

		// The surrounding prose still renders — the card doesn't replace it.
		await expect(page.locator(`[data-message-id="${convId}-a1"]`)).toContainText(
			"Here's a JSON summary",
		);

		await captureEvidence(page, testInfo, "workflow-run-card-success");
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "workflow-run-card-success" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "workflow-run-card-success")).toBe(
				false,
			);
		}
	});

	test("a workflow with an outputTemplate shows the rendered report ALONGSIDE the verbatim result @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		const convId = "conv-workflow-run-templated";
		await seedRun(
			mockApi,
			convId,
			"The workflow finished.",
			persistedRunWorkflowCall({
				id: "tc-wf-templated",
				messageId: `${convId}-a1`,
				output: JSON.stringify(TEMPLATED_PROJECTION),
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const card = page.getByTestId("workflow-run-card");
		await expect(card).toBeVisible({ timeout: 10_000 });

		// The rendered report — the deterministic, author-authored headline.
		const rendered = page.getByTestId("workflow-run-rendered-output-body");
		await expect(rendered).toHaveText("Report on workflows (slug: workflows-report)");

		// ADDITIVE, never a replacement: the verbatim JSON result is still
		// on screen, unmodified, exactly as it is on every other run.
		const resultBody = page.getByTestId("workflow-run-result-body");
		expect(await resultBody.textContent()).toBe(
			JSON.stringify(TEMPLATED_PROJECTION.result, null, 2),
		);

		await captureEvidence(page, testInfo, "workflow-run-card-templated");
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "workflow-run-card-templated" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "workflow-run-card-templated")).toBe(
				false,
			);
		}
	});

	test("a run with no outputTemplate shows no report panel", async ({ page, mockApi }) => {
		const convId = "conv-workflow-run-no-template";
		await seedRun(
			mockApi,
			convId,
			"Done.",
			persistedRunWorkflowCall({
				id: "tc-wf-no-template",
				messageId: `${convId}-a1`,
				output: JSON.stringify(SUCCESS_PROJECTION),
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);
		await expect(page.getByTestId("workflow-run-card")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("workflow-run-rendered-output")).toHaveCount(0);
	});

	test("a looped step reports its iteration count", async ({ page, mockApi }) => {
		const convId = "conv-workflow-run-loop";
		await seedRun(
			mockApi,
			convId,
			"The counter finished after 3 iterations.",
			persistedRunWorkflowCall({
				id: "tc-wf-loop",
				messageId: `${convId}-a1`,
				output: JSON.stringify(LOOP_PROJECTION),
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		await expect(page.getByTestId("workflow-run-card")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("workflow-run-step-iterations")).toHaveText("(3 iterations)");
	});

	test("the SAME deterministic run renders an identical card regardless of the assistant's prose", async ({
		page,
		mockApi,
	}) => {
		// This is the exact bug report: two runs of the same workflow on the
		// same input produced byte-identical tool output, but one reply
		// echoed a fenced JSON block and the other reformatted it as
		// markdown bullets. The CARD must not vary with the prose.
		const convIdA = "conv-workflow-run-prose-json";
		const convIdB = "conv-workflow-run-prose-bullets";
		const output = JSON.stringify(SUCCESS_PROJECTION);

		await seedRun(
			mockApi,
			convIdA,
			"```json\n" + JSON.stringify(SUCCESS_PROJECTION.result) + "\n```",
			persistedRunWorkflowCall({ id: "tc-wf-a", messageId: `${convIdA}-a1`, output }),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convIdA}`);
		await expect(page.getByTestId("workflow-run-card")).toBeVisible({ timeout: 10_000 });
		const resultA = await page.getByTestId("workflow-run-result-body").textContent();
		const statusA = await page.getByTestId("workflow-run-status").textContent();

		await seedRun(
			mockApi,
			convIdB,
			"- Headline: Report on workflows\n- All steps succeeded",
			persistedRunWorkflowCall({ id: "tc-wf-b", messageId: `${convIdB}-a1`, output }),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convIdB}`);
		await expect(page.getByTestId("workflow-run-card")).toBeVisible({ timeout: 10_000 });
		const resultB = await page.getByTestId("workflow-run-result-body").textContent();
		const statusB = await page.getByTestId("workflow-run-status").textContent();

		expect(resultA).toBe(resultB);
		expect(statusA).toBe(statusB);
		// The prose really did differ — the point is the CARD did not.
		await expect(page.locator(`[data-message-id="${convIdB}-a1"]`)).toContainText(
			"All steps succeeded",
		);
	});

	test("a failed run shows the loud error message, not just a red mark @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		const convId = "conv-workflow-run-failed";
		await seedRun(
			mockApi,
			convId,
			"The workflow did not finish successfully.",
			persistedRunWorkflowCall({
				id: "tc-wf-failed",
				messageId: `${convId}-a1`,
				output: JSON.stringify(FAILED_PROJECTION),
				status: "error",
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const card = page.getByTestId("workflow-run-card");
		await expect(card).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("workflow-run-status")).toHaveAttribute("data-status", "error");
		await expect(page.getByTestId("workflow-run-error-message")).toHaveText(
			'Step "count" exhausted 5 iterations without meeting its until-condition',
		);

		await captureEvidence(page, testInfo, "workflow-run-card-failed");
		if (process.env.EZCORP_E2E_EVIDENCE === "1") {
			expect(
				testInfo.attachments.some(
					(a) => a.name === "workflow-run-card-failed" && a.contentType === "image/png",
				),
			).toBe(true);
		} else {
			expect(testInfo.attachments.some((a) => a.name === "workflow-run-card-failed")).toBe(
				false,
			);
		}
	});

	test("an infra-level tool failure (non-JSON output) degrades to DefaultCard", async ({
		page,
		mockApi,
	}) => {
		// run_workflow's own tool-level errors (e.g. `toolError(...)`) return
		// plain text ("Error: ..."), not the JSON projection — cardType is
		// static per-tool metadata, so this text still arrives tagged
		// `workflow-run`. The card must degrade instead of throwing or
		// rendering blank.
		const convId = "conv-workflow-run-toolerror";
		await seedRun(
			mockApi,
			convId,
			"I couldn't run that workflow.",
			persistedRunWorkflowCall({
				id: "tc-wf-toolerror",
				messageId: `${convId}-a1`,
				output: 'Error: no workflow named "demo-deterministic"',
				status: "error",
			}),
		);
		await page.goto(`/project/${PROJECT_ID}/chat/${convId}`);

		const defaultCard = page.getByTestId("tool-card-default");
		await expect(defaultCard).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("workflow-run-card")).toHaveCount(0);
	});
});
