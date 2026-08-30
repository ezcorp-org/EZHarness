/**
 * Unit tests for workflow-run-card-logic.
 *
 * The card exists to stop a DETERMINISTIC tool result from being
 * re-rendered through a stochastic prose summary, so the assertions below
 * are weighted at that contract:
 *   - the SAME projection produces the SAME view every time (no field is
 *     re-derived from anything the model wrote);
 *   - the `result` is pretty-printed verbatim, never summarized/truncated;
 *   - a run that did not succeed always carries a visible reason, even when
 *     the projection's `error` was empty;
 *   - a step's absent `iterations` and a step that looped zero times are
 *     rendered differently (same honesty rule as city-conditions' grains);
 *   - an unusable envelope (unparseable / missing name or status) returns
 *     null so the router falls back to DefaultCard rather than throwing.
 */
import { describe, expect, test } from "vitest";
import {
	buildWorkflowRunView,
	extractWorkflowRunObject,
	NO_ERROR_REPORTED,
	type WorkflowRunView,
} from "./workflow-run-card-logic.js";

/** The shape run-workflow.ts's `projectWorkflowRun` produces. */
const SUCCESS_PROJECTION = {
	runId: "run-1",
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

describe("extractWorkflowRunObject", () => {
	test("null/undefined output is unusable", () => {
		expect(extractWorkflowRunObject(null)).toBeNull();
		expect(extractWorkflowRunObject(undefined)).toBeNull();
	});

	test("empty/whitespace string is unusable", () => {
		expect(extractWorkflowRunObject("")).toBeNull();
		expect(extractWorkflowRunObject("   ")).toBeNull();
	});

	test("a JSON string of the projection parses to the object", () => {
		expect(extractWorkflowRunObject(JSON.stringify(SUCCESS_PROJECTION))).toEqual(
			SUCCESS_PROJECTION,
		);
	});

	test("invalid JSON (e.g. truncated by getToolOutputLimit) is unusable", () => {
		expect(extractWorkflowRunObject('{"runId":"run-1","workflowN')).toBeNull();
	});

	test("a JSON array or primitive string is unusable (not a record)", () => {
		expect(extractWorkflowRunObject("[1,2,3]")).toBeNull();
		expect(extractWorkflowRunObject('"just a string"')).toBeNull();
		expect(extractWorkflowRunObject("42")).toBeNull();
	});

	test("a non-string, non-object output (number/boolean) is unusable", () => {
		expect(extractWorkflowRunObject(42)).toBeNull();
		expect(extractWorkflowRunObject(true)).toBeNull();
	});

	test("an already-parsed object (live SSE call) passes through", () => {
		expect(extractWorkflowRunObject(SUCCESS_PROJECTION)).toEqual(SUCCESS_PROJECTION);
	});

	test("an MCP {content:[{type:'text'}]} envelope unwraps to the JSON inside", () => {
		const envelope = {
			content: [{ type: "text", text: JSON.stringify(SUCCESS_PROJECTION) }],
		};
		expect(extractWorkflowRunObject(envelope)).toEqual(SUCCESS_PROJECTION);
	});

	test("an MCP envelope with multiple text parts concatenates them", () => {
		const json = JSON.stringify(SUCCESS_PROJECTION);
		const envelope = {
			content: [
				{ type: "text", text: json.slice(0, 10) },
				{ type: "text", text: json.slice(10) },
				{ type: "image", url: "ignored" },
			],
		};
		expect(extractWorkflowRunObject(envelope)).toEqual(SUCCESS_PROJECTION);
	});

	test("an envelope whose content array yields no text falls through to the raw object", () => {
		const envelope = { content: [] as unknown[] };
		expect(extractWorkflowRunObject(envelope)).toEqual(envelope);
	});

	test("an object whose content field is not an array passes through unchanged", () => {
		const obj = { content: "not-an-array", workflowName: "x" };
		expect(extractWorkflowRunObject(obj)).toEqual(obj);
	});
});

describe("buildWorkflowRunView — unusable envelopes return null", () => {
	test("unparseable output", () => {
		expect(buildWorkflowRunView("not json")).toBeNull();
	});

	test("missing workflowName", () => {
		expect(buildWorkflowRunView({ status: "success", steps: [] })).toBeNull();
	});

	test("blank workflowName", () => {
		expect(buildWorkflowRunView({ workflowName: "   ", status: "success" })).toBeNull();
	});

	test("missing status", () => {
		expect(buildWorkflowRunView({ workflowName: "demo" })).toBeNull();
	});

	test("blank status", () => {
		expect(buildWorkflowRunView({ workflowName: "demo", status: "" })).toBeNull();
	});
});

describe("buildWorkflowRunView — a successful run", () => {
	function view(): WorkflowRunView {
		const v = buildWorkflowRunView(SUCCESS_PROJECTION);
		expect(v).not.toBeNull();
		return v as WorkflowRunView;
	}

	test("carries the name, status and succeeded flag", () => {
		const v = view();
		expect(v.workflowName).toBe("demo-deterministic");
		expect(v.status).toBe("success");
		expect(v.succeeded).toBe(true);
	});

	test("carries the runId", () => {
		const v = view();
		expect(v.hasRunId).toBe(true);
		expect(v.runId).toBe("run-1");
	});

	test("maps every step's name and status", () => {
		const v = view();
		expect(v.steps).toHaveLength(3);
		expect(v.steps.map((s) => s.name)).toEqual(["compose", "assert-composed", "publish"]);
		expect(v.steps.every((s) => s.status === "success")).toBe(true);
		expect(v.steps.every((s) => s.hasIterations === false)).toBe(true);
	});

	test("pretty-prints the result verbatim", () => {
		const v = view();
		expect(v.resultText).toBe(JSON.stringify({ headline: "Report on workflows" }, null, 2));
	});

	test("carries no error on success", () => {
		const v = view();
		expect(v.hasError).toBe(false);
		expect(v.errorText).toBe("");
	});
});

describe("buildWorkflowRunView — result degradation", () => {
	test("a missing result field renders as literal null", () => {
		const v = buildWorkflowRunView({ workflowName: "demo", status: "success" });
		expect(v?.resultText).toBe("null");
	});

	test("an explicit null result renders as literal null", () => {
		const v = buildWorkflowRunView({ workflowName: "demo", status: "success", result: null });
		expect(v?.resultText).toBe("null");
	});

	test("a primitive result pretty-prints verbatim", () => {
		const v = buildWorkflowRunView({ workflowName: "demo", status: "success", result: 42 });
		expect(v?.resultText).toBe("42");
	});
});

describe("buildWorkflowRunView — steps degradation", () => {
	test("missing steps array degrades to an empty list", () => {
		const v = buildWorkflowRunView({ workflowName: "demo", status: "success" });
		expect(v?.steps).toEqual([]);
	});

	test("a non-array steps field degrades to an empty list", () => {
		const v = buildWorkflowRunView({ workflowName: "demo", status: "success", steps: "nope" });
		expect(v?.steps).toEqual([]);
	});

	test("a step with no name is labelled by its position, not dropped", () => {
		const v = buildWorkflowRunView({
			workflowName: "demo",
			status: "success",
			steps: [{ status: "success" }, { name: "second", status: "success" }],
		});
		expect(v?.steps[0]?.name).toBe("step 1");
		expect(v?.steps[1]?.name).toBe("second");
	});

	test("a step with no status reports 'unknown' rather than blank", () => {
		const v = buildWorkflowRunView({
			workflowName: "demo",
			status: "success",
			steps: [{ name: "count" }],
		});
		expect(v?.steps[0]?.status).toBe("unknown");
	});

	test("a non-record step entry degrades to a fully-fallback step", () => {
		const v = buildWorkflowRunView({
			workflowName: "demo",
			status: "success",
			steps: ["not-a-record"],
		});
		expect(v?.steps[0]).toEqual({
			name: "step 1",
			status: "unknown",
			hasIterations: false,
			iterations: 0,
		});
	});

	test("a step that looped 3 times reports the count", () => {
		const v = buildWorkflowRunView({
			workflowName: "demo-loop-counter",
			status: "success",
			steps: [{ name: "count", status: "success", iterations: 3 }],
		});
		expect(v?.steps[0]?.hasIterations).toBe(true);
		expect(v?.steps[0]?.iterations).toBe(3);
	});

	test("a step that looped ZERO times is distinct from one with no iterations field", () => {
		const v = buildWorkflowRunView({
			workflowName: "demo-loop-counter",
			status: "success",
			steps: [{ name: "count", status: "success", iterations: 0 }],
		});
		expect(v?.steps[0]?.hasIterations).toBe(true);
		expect(v?.steps[0]?.iterations).toBe(0);
	});

	test("a non-finite iterations value (NaN/Infinity/string) is treated as absent", () => {
		const v = buildWorkflowRunView({
			workflowName: "demo",
			status: "success",
			steps: [
				{ name: "a", status: "success", iterations: Number.NaN },
				{ name: "b", status: "success", iterations: Number.POSITIVE_INFINITY },
				{ name: "c", status: "success", iterations: "3" },
			],
		});
		expect(v?.steps.every((s) => s.hasIterations === false)).toBe(true);
	});
});

describe("buildWorkflowRunView — a run that did not succeed", () => {
	test("a plain-string error is shown verbatim", () => {
		const v = buildWorkflowRunView({
			workflowName: "demo-loop-counter",
			status: "error",
			steps: [{ name: "count", status: "error", iterations: 5 }],
			error: 'Step "count" exhausted 5 iterations without meeting its until-condition',
		});
		expect(v?.succeeded).toBe(false);
		expect(v?.hasError).toBe(true);
		expect(v?.errorText).toBe(
			'Step "count" exhausted 5 iterations without meeting its until-condition',
		);
	});

	test("a {code, message} error surfaces the message", () => {
		const v = buildWorkflowRunView({
			workflowName: "demo-loop-counter",
			status: "awaiting_approval",
			steps: [],
			error: {
				code: "awaiting_approval",
				message:
					'Step "install" requires interactive approval for capability fs.write and cannot run in a workflow',
			},
		});
		expect(v?.errorText).toBe(
			'Step "install" requires interactive approval for capability fs.write and cannot run in a workflow',
		);
	});

	test("a null error falls back to the honest 'no error reported' message", () => {
		const v = buildWorkflowRunView({ workflowName: "demo", status: "error", error: null });
		expect(v?.hasError).toBe(true);
		expect(v?.errorText).toBe(NO_ERROR_REPORTED);
	});

	test("a missing error field falls back to the same message", () => {
		const v = buildWorkflowRunView({ workflowName: "demo", status: "cancelled" });
		expect(v?.errorText).toBe(NO_ERROR_REPORTED);
	});

	test("an error object with no usable message falls back to the same message", () => {
		const v = buildWorkflowRunView({
			workflowName: "demo",
			status: "error",
			error: { code: "boom" },
		});
		expect(v?.errorText).toBe(NO_ERROR_REPORTED);
	});

	test("an error object whose message is blank falls back to the same message", () => {
		const v = buildWorkflowRunView({
			workflowName: "demo",
			status: "error",
			error: { message: "   " },
		});
		expect(v?.errorText).toBe(NO_ERROR_REPORTED);
	});

	test("a blank-string error falls back to the same message", () => {
		const v = buildWorkflowRunView({ workflowName: "demo", status: "error", error: "   " });
		expect(v?.errorText).toBe(NO_ERROR_REPORTED);
	});

	test("an error of an unrecognised shape (number/array) falls back to the same message", () => {
		const v = buildWorkflowRunView({ workflowName: "demo", status: "error", error: 42 });
		expect(v?.errorText).toBe(NO_ERROR_REPORTED);
	});
});

describe("buildWorkflowRunView — runId degradation", () => {
	test("a missing runId is reported as absent, not an empty label", () => {
		const v = buildWorkflowRunView({ workflowName: "demo", status: "success" });
		expect(v?.hasRunId).toBe(false);
		expect(v?.runId).toBe("");
	});
});
