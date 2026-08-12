/**
 * Merging the workflow detail page's two run sources.
 *
 * The theme here is that the sources describe the SAME rows in different
 * shapes — an ISO `startedAt` against epoch milliseconds, a projection with
 * no steps against a live frame that has them — and that the page had only
 * ever seen one of them. Every test below is about a way the naive merge
 * (concatenate, sort by `startedAt`) gets it wrong.
 */
import { describe, expect, test } from "vitest";
import { mergeRunHistory } from "./workflow-run-history";
import type { WorkflowRun, WorkflowRunSummary } from "./api";

function persisted(over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
	return {
		id: "run-a",
		workflowName: "nightly",
		status: "success",
		projectId: null,
		userId: "u1",
		startedAt: "2026-07-01T00:00:00.000Z",
		finishedAt: "2026-07-01T00:00:10.000Z",
		suspendedReason: null,
		resumable: false,
		jobRef: null,
		...over,
	};
}

function live(over: Partial<WorkflowRun> = {}): WorkflowRun {
	return {
		id: "run-b",
		workflowName: "nightly",
		status: "running",
		startedAt: Date.parse("2026-07-01T00:00:05.000Z"),
		steps: [{ stepName: "draft", runId: "r1", status: "running" }],
		...over,
	};
}

describe("mergeRunHistory", () => {
	test("orders BOTH sources on one timeline, newest first", () => {
		// The bug this function exists to prevent. The two sources carry
		// `startedAt` in different formats, so a comparator that does not
		// normalize them sorts one group entirely above the other — an order
		// that looks plausible and is not chronological.
		const rows = mergeRunHistory(
			[
				persisted({ id: "old", startedAt: "2026-07-01T00:00:00.000Z" }),
				persisted({ id: "newest", startedAt: "2026-07-01T00:00:09.000Z" }),
			],
			[live({ id: "middle", startedAt: Date.parse("2026-07-01T00:00:05.000Z") })],
		);
		expect(rows.map((r) => r.id)).toEqual(["newest", "middle", "old"]);
	});

	test("normalizes an ISO timestamp to the epoch milliseconds the live frame uses", () => {
		const [row] = mergeRunHistory([persisted({ startedAt: "2026-07-01T00:00:00.000Z" })], []);
		expect(row!.startedAt).toBe(Date.parse("2026-07-01T00:00:00.000Z"));
	});

	test("a run in BOTH sources appears once, and the live row wins", () => {
		// A run started while the page was open is in the fetch AND in the
		// stream. The stream is the copy still being updated — it carries the
		// steps and the result the projection does not have, and it is never
		// staler than the page load.
		const rows = mergeRunHistory(
			[persisted({ id: "same", status: "running" })],
			[
				live({
					id: "same",
					status: "success",
					steps: [{ stepName: "draft", runId: "r1", status: "success" }],
					result: { success: true, output: "done" },
				}),
			],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("success");
		expect(rows[0]!.steps).toHaveLength(1);
		expect(rows[0]!.result).toEqual({ success: true, output: "done" });
	});

	test("a persisted-only row reports NO steps and NO result", () => {
		// Both are genuinely absent from the list projection — the server
		// omits them on purpose. The row must not invent an empty result,
		// which would render as "the run produced nothing".
		const [row] = mergeRunHistory([persisted()], []);
		expect(row!.steps).toEqual([]);
		expect(row!.result).toBeUndefined();
		expect("result" in row!).toBe(false);
	});

	test("a live row with no result yet carries none, rather than an explicit undefined", () => {
		// A `running` frame has no `result` field at all. Copying one in as
		// `undefined` would be harmless here but makes `"result" in row` lie,
		// and that predicate is how a caller tells "not known" from "known to
		// be nothing".
		const [row] = mergeRunHistory([], [live()]);
		expect("result" in row!).toBe(false);
	});

	test("a live frame that arrives without steps does not crash the row", () => {
		// Defensive: `steps` is required on the type, but the frame is
		// server-shaped JSON off a socket and the page renders `.length` on
		// it immediately.
		const [row] = mergeRunHistory(
			[],
			[{ id: "x", workflowName: "nightly", status: "running", startedAt: 1 } as WorkflowRun],
		);
		expect(row!.steps).toEqual([]);
	});

	test("an unparseable timestamp sinks the row instead of scrambling the list", () => {
		// `Date.parse` gives NaN, and a NaN in the comparator makes it
		// non-transitive — the sort then returns an arbitrary order for the
		// WHOLE list, not just for the bad row.
		const rows = mergeRunHistory(
			[
				persisted({ id: "broken", startedAt: "not-a-date" }),
				persisted({ id: "early", startedAt: "2026-07-01T00:00:00.000Z" }),
				persisted({ id: "late", startedAt: "2026-07-01T00:00:09.000Z" }),
			],
			[],
		);
		expect(rows.map((r) => r.id)).toEqual(["late", "early", "broken"]);
	});

	test("two runs from the same millisecond hold a stable order", () => {
		// Every fixture and every all-transform graph produces these. An
		// unstable tie-break reshuffles the list on each render.
		const same = "2026-07-01T00:00:00.000Z";
		const first = mergeRunHistory(
			[persisted({ id: "aaa", startedAt: same }), persisted({ id: "bbb", startedAt: same })],
			[],
		);
		const second = mergeRunHistory(
			[persisted({ id: "bbb", startedAt: same }), persisted({ id: "aaa", startedAt: same })],
			[],
		);
		expect(first.map((r) => r.id)).toEqual(["bbb", "aaa"]);
		expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
	});

	test("no runs at all is an empty list, not a throw", () => {
		expect(mergeRunHistory([], [])).toEqual([]);
	});

	test("carries the fields the row renders from each source", () => {
		const [row] = mergeRunHistory([persisted({ id: "p", workflowName: "nightly" })], []);
		expect(row).toMatchObject({ id: "p", workflowName: "nightly", status: "success" });
	});
});
