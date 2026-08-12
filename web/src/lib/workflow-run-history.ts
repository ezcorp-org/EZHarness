/**
 * The workflow detail page's run history, assembled from its TWO sources.
 *
 * The page had only one of them. `store.workflowRuns` is written from live
 * `workflow:*` SSE frames and from nothing else, so "Run History" showed
 * the runs that happened while the tab was open and emptied itself on
 * every reload — with a persisted `workflow_runs` table sitting behind
 * `GET /api/workflows/runs` the page never called.
 *
 * The two sources describe the same rows in different shapes, which is the
 * whole reason this is a module and not three lines in a template:
 *
 * | | persisted (`WorkflowRunSummary`) | live (`WorkflowRun`) |
 * |---|---|---|
 * | `startedAt` | ISO string | epoch milliseconds |
 * | `steps` | absent — the list projection carries none | present |
 * | `result` | absent — same reason | present |
 *
 * Sorting a mix of those two by `startedAt` without reconciling them puts
 * every live run at the top of the list and every persisted one at the
 * bottom, in an order that looks plausible and is not chronological.
 */
import type { WorkflowRun, WorkflowRunSummary } from "./api.js";

/** One row of the merged history. `startedAt` is normalized to epoch
 *  milliseconds — the one representation both sources can be compared in. */
export interface RunHistoryRow {
  id: string;
  workflowName: string;
  status: string;
  startedAt: number;
  /**
   * The step lines the row renders, or `[]` for a row that exists only in
   * persisted history. Empty because the list projection genuinely has no
   * steps — NOT because the run had none — so the template must render
   * nothing there rather than "0 steps", which would be a claim.
   */
  steps: WorkflowRun["steps"];
  /**
   * The run's `AgentResult`, on a live row only — the list projection
   * carries none. `undefined` therefore means "this row does not know",
   * not "the run produced nothing", and the page fills it from the run's
   * trace when the reader opens one.
   */
  result?: unknown;
}

/** Epoch ms from either wire format, and 0 for a timestamp that does not
 *  parse. `NaN` would make the comparator non-transitive and scramble the
 *  whole list rather than misplace the one bad row. */
function startedAtMs(value: string | number): number {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Persisted history plus whatever the live stream has, newest first.
 *
 * **The live row wins a collision, unconditionally.** A run that started
 * while this page was open appears in both sources, and the SSE frame is
 * the one that is still being updated — it carries the steps and the
 * result the summary projection does not have, and it is never staler than
 * the page load. Preferring the persisted row would freeze a running run
 * at whatever status the initial fetch caught it in.
 */
export function mergeRunHistory(
  persisted: readonly WorkflowRunSummary[],
  live: readonly WorkflowRun[],
): RunHistoryRow[] {
  const byId = new Map<string, RunHistoryRow>();
  for (const run of persisted) {
    byId.set(run.id, {
      id: run.id,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: startedAtMs(run.startedAt),
      steps: [],
    });
  }
  for (const run of live) {
    byId.set(run.id, {
      id: run.id,
      workflowName: run.workflowName,
      status: run.status,
      startedAt: startedAtMs(run.startedAt),
      steps: run.steps ?? [],
      ...(run.result !== undefined ? { result: run.result } : {}),
    });
  }
  // Newest first, tie-broken on id so two runs minted in the same
  // millisecond — which every fixture and every fast transform graph
  // produces — hold a stable order instead of shuffling on each render.
  return [...byId.values()].sort(
    (a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id),
  );
}
