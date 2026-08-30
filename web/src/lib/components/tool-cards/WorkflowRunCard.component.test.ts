/**
 * DOM tests for WorkflowRunCard.svelte.
 *
 * The component is template-only (all derivation lives in
 * workflow-run-card-logic.ts), so these tests assert what a user can SEE —
 * which is where the failure this card exists to prevent lives: the same
 * deterministic run result must render identically every time, so
 *   - the `result` renders as an exact `JSON.stringify(result, null, 2)`
 *     block, never a truncated preview;
 *   - the result panel is OPEN by default on a successful run;
 *   - a run that did not succeed always shows an error message, even one
 *     the logic module had to synthesize;
 *   - a step's loop iteration count only appears when the step actually
 *     carries one.
 */
import { cleanup, render } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import "@testing-library/jest-dom/vitest";
import WorkflowRunCard from "./WorkflowRunCard.svelte";
import {
	buildWorkflowRunView,
	NO_ERROR_REPORTED,
	RESULT_UNDISPLAYABLE,
	type WorkflowRunView,
} from "./workflow-run-card-logic.js";

afterEach(() => cleanup());

function viewFor(output: unknown): WorkflowRunView {
	const view = buildWorkflowRunView(output);
	expect(view).not.toBeNull();
	return view as WorkflowRunView;
}

function renderCard(output: unknown) {
	return render(WorkflowRunCard, { view: viewFor(output) });
}

const SUCCESS_PROJECTION = {
	runId: "wr-det-9999",
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

describe("WorkflowRunCard — a successful run", () => {
	test("renders the workflow name, runId and terminal status", () => {
		const { getByTestId } = renderCard(SUCCESS_PROJECTION);
		expect(getByTestId("workflow-run-name")).toHaveTextContent("demo-deterministic");
		expect(getByTestId("workflow-run-id")).toHaveTextContent("wr-det-9999");
		const status = getByTestId("workflow-run-status");
		expect(status).toHaveTextContent("success");
		expect(status).toHaveAttribute("data-status", "success");
	});

	test("renders every step's name and status", () => {
		const { getAllByTestId } = renderCard(SUCCESS_PROJECTION);
		const steps = getAllByTestId("workflow-run-step");
		expect(steps).toHaveLength(3);
		expect(steps.map((s) => s.getAttribute("data-step-status"))).toEqual([
			"success",
			"success",
			"success",
		]);
		expect(steps[0]).toHaveTextContent("compose");
		expect(steps[2]).toHaveTextContent("publish");
	});

	test("renders the result verbatim, pretty-printed and EXPANDED by default", () => {
		const { getByTestId } = renderCard(SUCCESS_PROJECTION);
		const resultBody = getByTestId("workflow-run-result-body");
		expect(resultBody).toHaveTextContent('"headline": "Report on workflows"');
		expect(resultBody.textContent).toBe(
			JSON.stringify({ headline: "Report on workflows" }, null, 2),
		);
		const details = getByTestId("workflow-run-result") as HTMLDetailsElement;
		expect(details.open).toBe(true);
	});

	test("shows no error panel on success", () => {
		const { queryByTestId } = renderCard(SUCCESS_PROJECTION);
		expect(queryByTestId("workflow-run-error")).toBeNull();
	});

	test("a step with no iterations field shows no iteration badge", () => {
		const { queryByTestId } = renderCard(SUCCESS_PROJECTION);
		expect(queryByTestId("workflow-run-step-iterations")).toBeNull();
	});

	test("a run with no runId omits the id element rather than showing it blank", () => {
		const { queryByTestId } = renderCard({ workflowName: "demo", status: "success" });
		expect(queryByTestId("workflow-run-id")).toBeNull();
	});

	test("a run with no steps renders no steps list", () => {
		const { queryByTestId } = renderCard({ workflowName: "demo", status: "success", steps: [] });
		expect(queryByTestId("workflow-run-steps")).toBeNull();
	});

	test("a result nested past V8's JSON.stringify stack limit renders without crashing the card, on any engine", () => {
		// Same crash this card exists to guard against, exercised through the
		// real render path (not just the pure logic function): a `result` this
		// deep used to throw a RangeError out of the component's $derived,
		// which nothing on the page catches (no <svelte:boundary> in web/src).
		//
		// This test does NOT assert the result body shows RESULT_UNDISPLAYABLE
		// — whether JSON.stringify throws at this depth depends on the JS
		// engine's call-stack size, not on this code. Measured: V8 (node,
		// `npx vitest` locally) throws at depth 6000; Bun (CI's "Web tests"
		// shard, `bunx --bun vitest`) has a deeper stack and does not throw at
		// depth 6000 or even 10000, so on Bun this fixture renders the real
		// JSON instead. A prior version asserted the placeholder here and
		// passed locally under V8 while failing in CI under Bun — don't
		// reintroduce that by tightening this assertion. The
		// engine-independent guard is the circular-reference test below.
		const depth = 6000;
		const nestedJson = `${'{"a":'.repeat(depth)}null${"}".repeat(depth)}`;
		const deeplyNestedResult: unknown = JSON.parse(nestedJson);

		const { getByTestId } = renderCard({
			workflowName: "demo-deep-result",
			status: "success",
			result: deeplyNestedResult,
		});
		// The card renders at all (no thrown RangeError) and the rest of it —
		// name and status — is unaffected regardless of what the result body
		// ends up showing.
		expect(getByTestId("workflow-run-name")).toHaveTextContent("demo-deep-result");
		expect(getByTestId("workflow-run-status")).toHaveTextContent("success");
	});

	test("a circular result renders the placeholder instead of crashing the card (engine-independent)", () => {
		// Unlike depth, a circular reference makes JSON.stringify throw
		// `TypeError: Converting circular structure to JSON` on every engine
		// per spec — so this is the render-path assertion that actually
		// proves the guard degrades to RESULT_UNDISPLAYABLE, portably (not
		// just under whichever engine happens to run the test).
		const circular: Record<string, unknown> = { name: "self-referencing" };
		circular.self = circular;

		const { getByTestId } = renderCard({
			workflowName: "demo-circular-result",
			status: "success",
			result: circular,
		});
		expect(getByTestId("workflow-run-result-body")).toHaveTextContent(RESULT_UNDISPLAYABLE);
		expect(getByTestId("workflow-run-name")).toHaveTextContent("demo-circular-result");
		expect(getByTestId("workflow-run-status")).toHaveTextContent("success");
	});
});

describe("WorkflowRunCard — loop iterations", () => {
	test("a step that looped 3 times shows the count", () => {
		const { getByTestId } = renderCard({
			workflowName: "demo-loop-counter",
			status: "success",
			steps: [{ name: "count", status: "success", iterations: 3 }],
		});
		expect(getByTestId("workflow-run-step-iterations")).toHaveTextContent("(3 iterations)");
	});

	test("a step that looped ZERO times still shows the count (not treated as absent)", () => {
		const { getByTestId } = renderCard({
			workflowName: "demo-loop-counter",
			status: "success",
			steps: [{ name: "count", status: "success", iterations: 0 }],
		});
		expect(getByTestId("workflow-run-step-iterations")).toHaveTextContent("(0 iterations)");
	});
});

describe("WorkflowRunCard — a run that did not succeed", () => {
	test("an error run shows the failed styling, a visible error message, and a collapsed result", () => {
		const { getByTestId } = renderCard({
			workflowName: "demo-loop-counter",
			status: "error",
			steps: [{ name: "count", status: "error", iterations: 5 }],
			result: null,
			error: 'Step "count" exhausted 5 iterations without meeting its until-condition',
		});
		expect(getByTestId("workflow-run-card")).toHaveClass("failed");
		const status = getByTestId("workflow-run-status");
		expect(status).toHaveAttribute("data-status", "error");
		expect(getByTestId("workflow-run-error-message")).toHaveTextContent(
			'Step "count" exhausted 5 iterations without meeting its until-condition',
		);
		const details = getByTestId("workflow-run-result") as HTMLDetailsElement;
		expect(details.open).toBe(false);
	});

	test("an awaiting_approval run surfaces the {code,message} error's message", () => {
		const { getByTestId } = renderCard({
			workflowName: "demo-loop-counter",
			status: "awaiting_approval",
			steps: [
				{ name: "prep", status: "success" },
				{ name: "install", status: "awaiting_approval" },
			],
			error: {
				code: "awaiting_approval",
				message:
					'Step "install" requires interactive approval for capability fs.write and cannot run in a workflow',
			},
		});
		expect(getByTestId("workflow-run-status")).toHaveTextContent("awaiting_approval");
		expect(getByTestId("workflow-run-error-message")).toHaveTextContent(
			'Step "install" requires interactive approval for capability fs.write and cannot run in a workflow',
		);
	});

	test("a failed run with no error reported still shows an honest reason, never a blank panel", () => {
		const { getByTestId } = renderCard({ workflowName: "demo", status: "cancelled" });
		expect(getByTestId("workflow-run-error-message")).toHaveTextContent(NO_ERROR_REPORTED);
	});
});
