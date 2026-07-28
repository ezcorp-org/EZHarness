/**
 * Tell tool-call failures apart WITHOUT expanding the card.
 *
 * A failed extension-author install rendered as a red ✗, the tool name,
 * and nothing else: `extractInputSummary` did not know the tool's input
 * keys so the header summary was undefined, and `outputPreview` was
 * gated on `status === 'complete'` so the error never reached the
 * header either. The machine-readable `code` the host works hard to
 * produce was visible only after a click.
 *
 * Five failure classes have to be distinguishable at a glance, because
 * each has a different next step for the user:
 *   load     — the draft/manifest could not be read → fix the files
 *   permission — a gate said no → grant it (or an admin must)
 *   execution  — it ran and failed → read the detail, fix, retry
 *   response   — the host answered in a shape we cannot trust → the
 *                state is UNKNOWN, check before retrying
 *   render     — the result arrived but no card could display it
 *
 * Pure module: no Svelte runes, no DOM — the mapping is unit-tested
 * without a renderer (same pattern as `utils.ts`'s helpers).
 */

export type ToolFailureClass =
	| "load"
	| "permission"
	| "execution"
	| "response"
	| "render";

/**
 * Failure code → class. Codes come from the host's typed errors
 * (`AuthorInstallErrorCode`, `ReopenErrorCode`), the drafts reverse-RPC
 * gates, and the extension's own response validation.
 */
export const FAILURE_CLASS_BY_CODE: Readonly<Record<string, ToolFailureClass>> = {
	// ── load ──
	DRAFT_NOT_FOUND: "load",
	DRAFT_DIR_MISSING: "load",
	NOT_EXTENSION_DRAFT: "load",
	MANIFEST_INVALID: "load",
	// A declared `bundled`/`local` dependency isn't installed: the draft
	// as written is not installable, nothing ran — same "fix the files
	// (or install the dependency) and retry" next step as MANIFEST_INVALID.
	DEPENDENCY_UNSATISFIED: "load",
	NO_INSTALL_PATH: "load",
	NO_FILES: "load",
	UNREADABLE_FILE: "load",
	// ── permission ──
	NOT_ALLOWLISTED: "permission",
	PERMISSION_NOT_GRANTED: "permission",
	PERMISSION_DENIED: "permission",
	NOT_FOUND_OR_NOT_MODIFIABLE: "permission",
	ENV_KEY_LEAK: "permission",
	// ── execution ──
	VERIFY_FAILED: "execution",
	INSTALL_FAILED: "execution",
	NAME_COLLISION: "execution",
	ROLLBACK_FAILED: "execution",
	ENABLE_FAILED: "execution",
	REGISTRY_RELOAD_FAILED: "execution",
	DRAFT_FAILED: "execution",
	// ── response ──
	BAD_HOST_RESPONSE: "response",
};

/** Short, human label per class — what the header chip shows. */
export const FAILURE_CLASS_LABEL: Readonly<Record<ToolFailureClass, string>> = {
	load: "Load failed",
	permission: "Not permitted",
	execution: "Run failed",
	response: "Bad response",
	render: "Cannot display",
};

export interface ToolFailureSummary {
	/** The machine code, when the payload carried one. */
	code?: string;
	failureClass: ToolFailureClass;
	/** `<class label> · <CODE>` — or just the label when there is no code. */
	label: string;
	/** One-line human message, already truncated for the header. */
	message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pull `{ code?, error?/message? }` out of a tool failure payload. Tool
 * bodies emit a JSON string; some hosts hand back the object directly.
 */
function extractPayload(value: unknown): Record<string, unknown> | null {
	if (value == null) return null;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
	return isRecord(value) ? value : null;
}

function truncate(s: string, maxLen: number): string {
	return s.length > maxLen ? `${s.slice(0, maxLen - 3)}...` : s;
}

/**
 * Summarize a failed tool call for the collapsed card header.
 *
 * `error` is `toolCall.error`, `output` is `toolCall.output`; either may
 * carry the structured payload, so both are considered (error first).
 * Returns `null` when there is nothing at all to say — the caller then
 * renders its existing bare treatment.
 */
export function summarizeToolFailure(
	error: unknown,
	output: unknown,
	maxLen: number = 80,
): ToolFailureSummary | null {
	const payload = extractPayload(error) ?? extractPayload(output);
	const rawCode = payload?.code;
	const code = typeof rawCode === "string" && rawCode.length > 0 ? rawCode : undefined;

	// When a structured payload exists, its `error`/`message` is the
	// message — never the raw JSON. Echoing `{"code":"VERIFY_FAILED"}`
	// into the header is strictly worse than the class label.
	const message = payload
		? ([payload.error, payload.message].find(
				(v) => typeof v === "string" && v.length > 0,
			) as string | undefined)
		: ([error, output].find((v) => typeof v === "string" && v.length > 0) as
				| string
				| undefined);

	if (code === undefined && message === undefined) return null;

	// No code → the failure is real but unclassified. "execution" is the
	// honest default: it ran and something went wrong.
	const failureClass: ToolFailureClass =
		(code !== undefined ? FAILURE_CLASS_BY_CODE[code] : undefined) ?? "execution";
	const classLabel = FAILURE_CLASS_LABEL[failureClass];

	return {
		...(code !== undefined ? { code } : {}),
		failureClass,
		label: code !== undefined ? `${classLabel} · ${code}` : classLabel,
		message: truncate(message ?? classLabel, maxLen),
	};
}
