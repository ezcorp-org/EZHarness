/**
 * Pure logic for WorkflowRunCard — parses `run_workflow`'s
 * `RunWorkflowToolResult` projection (`src/runtime/tools/run-workflow.ts:83-90`)
 * into the card's view model.
 *
 * WHY this card exists (the governing rule: a deterministic result must not
 * be re-rendered by a stochastic component). Reference and execution are
 * split by design (`docs/features/orchestration/workflows.md`) — a
 * `![workflow:name]` mention only injects a note describing the workflow,
 * and the model that later calls `run_workflow` writes a free-form PROSE
 * summary of the JSON it gets back. That summary is sampled: the SAME
 * deterministic run can read as a fenced ```json block one time and a
 * bullet list the next. The tool's own result is byte-identical every time
 * for identical input, so THIS card — never the prose above it — is the one
 * surface that must render it the same way twice. `cardType: "default"`
 * used to route the result through DefaultCard, whose preview line is a
 * 50-char truncated JSON blob that starts collapsed: a canonical value shown
 * through a component with no determinism contract of its own.
 *
 * Envelope: `run_workflow`'s persisted output is the JSON string
 * `JSON.stringify(projection)` it returns as `content[0].text`, or (for a
 * live, not-yet-persisted call) an already-parsed object, or an MCP
 * `{content:[{type:"text"}]}` envelope — the same three shapes every other
 * parser in this directory tolerates (see `extractCityConditionsObject` in
 * `city-conditions-card-logic.ts`).
 *
 * `buildWorkflowRunView` returns null for anything that does not carry a
 * usable `workflowName` + `status` — including a truncated/invalid JSON
 * string (`getToolOutputLimit` can cut the text mid-object) — so the router
 * degrades to DefaultCard exactly like the other parsers here rather than
 * throwing or rendering a blank-but-successful card. `steps`, `result`, and
 * `error` each degrade to their own honest fallback instead of failing the
 * whole card over one bad field.
 */

export interface WorkflowRunStepView {
	name: string;
	status: string;
	/** false ⇒ the step carried no `iterations` field (a non-loop step). */
	hasIterations: boolean;
	/** 0 when `hasIterations` is false — a loop that ran 0 times is a real,
	 *  distinct value from a step that never loops at all. */
	iterations: number;
}

export interface WorkflowRunView {
	runId: string;
	/** false ⇒ the projection carried no runId (never hidden as "" text). */
	hasRunId: boolean;
	workflowName: string;
	status: string;
	/** `status === "success"` — the only status that is not a failure of
	 *  some kind (error, cancelled, awaiting_approval, suspended, …). */
	succeeded: boolean;
	steps: WorkflowRunStepView[];
	/** `result`, pretty-printed verbatim (`JSON.stringify(result, null, 2)`).
	 *  Never truncated, never re-summarized — that is the entire point of
	 *  this card over DefaultCard's preview line. */
	resultText: string;
	/** Only true when the run did NOT succeed — a successful run's `error`
	 *  is never rendered (the projection carries it as `null`). */
	hasError: boolean;
	errorText: string;
}

/** Shown when the run failed but the projection's `error` was empty —
 *  never leave a failed run with no explanation on screen. */
export const NO_ERROR_REPORTED =
	"The workflow did not succeed, but no error was reported.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string {
	return typeof value === "string" && value.trim() !== "" ? value : "";
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Pull a plain object out of a tool `output` that may be a JSON string, an
 * already-parsed object, or an MCP `{content:[{text}]}` envelope. Mirrors
 * `extractCityConditionsObject` — same three shapes, same null-on-unusable
 * contract, so a truncated or malformed `run_workflow` payload degrades the
 * same way a truncated `city-conditions` payload does.
 */
export function extractWorkflowRunObject(output: unknown): Record<string, unknown> | null {
	if (output == null) return null;
	if (typeof output === "string") {
		const trimmed = output.trim();
		if (trimmed === "") return null;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	if (!isRecord(output)) return null;
	const content = output.content;
	if (Array.isArray(content)) {
		const text = content
			.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
			.join("");
		if (text !== "") return extractWorkflowRunObject(text);
	}
	return output;
}

/**
 * One step, degraded field-by-field rather than dropped whole — a step
 * whose name did not survive persistence still reports its status, and its
 * position labels it (`"step 2"`) instead of vanishing from the list.
 */
function buildStepView(raw: unknown, index: number): WorkflowRunStepView {
	const step = isRecord(raw) ? raw : {};
	const name = nonEmptyString(step.name);
	const status = nonEmptyString(step.status);
	const iterations = finiteOrNull(step.iterations);
	return {
		name: name === "" ? `step ${index + 1}` : name,
		status: status === "" ? "unknown" : status,
		hasIterations: iterations !== null,
		iterations: iterations ?? 0,
	};
}

/**
 * `error`'s two observed shapes (`run-workflow.ts` forwards whichever the
 * workflow executor produced): a plain string (a gate/loop failure message,
 * e.g. `Step "count" exhausted 5 iterations…`) or a `{code, message}` object
 * (cancellation, awaiting-approval). Anything else — `null`, a bare code
 * with no message, a shape that is neither — returns "" so the caller can
 * fall back to {@link NO_ERROR_REPORTED} instead of rendering blank or
 * `"[object Object]"`.
 */
function formatError(raw: unknown): string {
	if (typeof raw === "string") return raw.trim() === "" ? "" : raw;
	if (isRecord(raw) && typeof raw.message === "string" && raw.message.trim() !== "") {
		return raw.message;
	}
	return "";
}

/**
 * Build the card's view model from a tool call's `output`.
 *
 * Returns null ONLY when the envelope is unusable (unparseable, not an
 * object, or missing a non-empty `workflowName` or `status`) — the router
 * then renders DefaultCard, the same degradation every other parser in this
 * directory uses (`buildCityConditionsView`, `buildWebContextView`).
 */
export function buildWorkflowRunView(output: unknown): WorkflowRunView | null {
	const obj = extractWorkflowRunObject(output);
	if (!obj) return null;

	const workflowName = nonEmptyString(obj.workflowName);
	const status = nonEmptyString(obj.status);
	if (workflowName === "" || status === "") return null;

	const runId = nonEmptyString(obj.runId);
	const succeeded = status === "success";
	const steps = Array.isArray(obj.steps) ? obj.steps.map(buildStepView) : [];
	const resultText = JSON.stringify(obj.result ?? null, null, 2);

	let errorText = "";
	if (!succeeded) {
		const formatted = formatError(obj.error);
		errorText = formatted === "" ? NO_ERROR_REPORTED : formatted;
	}

	return {
		runId,
		hasRunId: runId !== "",
		workflowName,
		status,
		succeeded,
		steps,
		resultText,
		hasError: !succeeded,
		errorText,
	};
}
