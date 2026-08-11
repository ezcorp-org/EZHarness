/**
 * Framework-free display logic for the run trace
 * (`routes/(app)/workflows/runs/[id]/+page.svelte`).
 *
 * Same role `workflow-run-display.ts` plays for the workflow detail page,
 * and split out for the same reason: these are the mappings that silently
 * drift when a new status or column lands on the server, and a Svelte
 * template is where a silent drift is least visible.
 *
 * **The governing rule here is that "not reported" must never render as a
 * number.** Every telemetry column is nullable and NULL means the fact was
 * not measured — a provider that omitted usage, a step that ran no LLM, a
 * cost nothing can compute yet. Rendering those as `0` would turn a gap
 * into a measurement, and the person reading the trace would have no way
 * to tell. So every formatter below maps null to a dash, and none of them
 * defaults to zero.
 */
/** Run/step status as the API reports it. Kept as a widened string
 *  rather than imported from the server union: the trace must render a
 *  status this build has never heard of (an older server, a newer one)
 *  as ITSELF, not crash or blank. `statusLabel` handles the fallback. */
type WorkflowRunStatus = string;

/** What the UI shows where a value was never reported. */
export const NOT_REPORTED = "—";

export interface TraceIteration {
  iteration: number;
  attempt: number;
  status: WorkflowRunStatus;
  runId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  durationMs: number | null;
  errorCode: string | null;
}

export interface TraceStep {
  stepName: string;
  status: WorkflowRunStatus;
  runId: string | null;
  provider: string | null;
  model: string | null;
  attempt: number | null;
  iterations: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  durationMs: number | null;
  errorCode: string | null;
  skippedReason: string | null;
  resolvedInput: unknown;
  output: unknown;
  startedAt: string;
  updatedAt: string;
  iterationRows: TraceIteration[];
}

export interface RunTrace {
  run: {
    id: string;
    workflowName: string;
    status: WorkflowRunStatus;
    projectId: string | null;
    userId: string | null;
    startedAt: string;
    finishedAt: string | null;
    suspendedReason: string | null;
    resumable: boolean;
    jobRef: string | null;
    definitionHash: string | null;
    definitionVersionId: string | null;
    runPhase: string;
    idempotencyKey: string | null;
    result: unknown;
  };
  steps: TraceStep[];
  totals: {
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    steps: number;
  };
}

/** A whole number with thousands separators, or the dash. */
export function formatTokens(value: number | null): string {
  return value === null ? NOT_REPORTED : value.toLocaleString("en-US");
}

/**
 * A duration in the largest unit that stays readable.
 *
 * Sub-second stays in ms (a 40 ms transform reading "0.0s" hides the
 * difference between fast and instant), minutes appear past 60s.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return NOT_REPORTED;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * A cost, or the dash.
 *
 * The dash means the cost could not be MEASURED — never that the step was
 * free. Three things produce it: a step that ran no LLM (`tool` /
 * `transform` / `gate`), a provider that reported no usage, and an
 * unpriced model (an OAuth subscription is rate-limited rather than billed
 * per token). A step that really did cost nothing arrives as `"0.000000"`
 * and renders as `$0.0000`, which is why the two must not be collapsed.
 */
export function formatCost(costUsd: string | null): string {
  if (costUsd === null) return NOT_REPORTED;
  const n = Number(costUsd);
  return Number.isFinite(n) ? `$${n.toFixed(4)}` : NOT_REPORTED;
}

/** Why a cost cell can be empty, shown as a tooltip rather than silently.
 *  Deliberately says "not measured" rather than "free" — a tool step's
 *  real cost is unknown here, not zero. */
export const COST_UNAVAILABLE_HINT =
  "A dash means the cost could not be measured — a step that ran no model, a provider that reported no usage, or a subscription model with no per-token price. It does not mean the step was free.";

/**
 * The tooltip for ONE cost cell: the hint on a dash, nothing on a figure.
 *
 * Now that real costs land in this column, hanging "a dash means…" off a
 * cell reading `$0.1235` would describe a state that cell is not in. The
 * column header keeps the hint unconditionally, which is where a reader
 * looks for what the column means.
 */
export function costCellHint(costUsd: string | null): string | undefined {
  return formatCost(costUsd) === NOT_REPORTED ? COST_UNAVAILABLE_HINT : undefined;
}

/**
 * Whether a run is still going, in any sense.
 *
 * `suspended` counts: a parked run is alive and answerable, and the trace
 * must not present it as an ending. `awaiting_approval` likewise — the
 * graph ran everything it could and then hit a step that needs a human,
 * which is neither success nor failure.
 */
export function isLiveRun(status: string): boolean {
  return status === "running" || status === "suspended" || status === "awaiting_approval";
}

/** Human label for a run status, so the UI never shows a raw enum. */
const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  success: "Succeeded",
  error: "Failed",
  cancelled: "Cancelled",
  suspended: "Paused",
  awaiting_approval: "Waiting for approval",
  idle: "Idle",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/**
 * How to render `suspended_reason`, if at all.
 *
 * The column SURVIVES a resume by design — it is documented as "free text
 * for the trace, never branched on", so it records that a run was parked
 * once, not that it is parked now. Rendering it unconditionally in the
 * present tense therefore labels a finished run "paused: approval", which
 * is a live-sounding claim about a run that ended.
 *
 * Returns null when there is nothing to say, so the template renders no
 * empty element.
 */
export function pauseNote(
  run: Pick<RunTrace["run"], "status" | "suspendedReason">,
): string | null {
  if (run.suspendedReason === null) return null;
  return run.status === "suspended"
    ? `paused: ${run.suspendedReason}`
    : `was paused: ${run.suspendedReason}`;
}

/**
 * Whether "Retry from here" can be offered for a step.
 *
 * The button re-enters the run at its cursor, which is only meaningful
 * when the run is PARKED: `status === "suspended"`. A `running` run is
 * already being driven and retrying it would execute a batch twice; a
 * terminal run has no cursor to resume from.
 *
 * ## `resumable` is deliberately NOT consulted
 *
 * It reads like the obvious second condition and it is the wrong one.
 * `resumable` is the recovery SWEEP's verdict on a **crashed** run; a
 * deliberately parked run never carries it, because `suspendWorkflowRun`
 * pointedly does not set it and the column defaults to `false`
 * (`src/db/queries/workflow-runs.ts` — "a deliberate park is resumable by
 * construction and does not need a column to say so").
 *
 * So requiring it hides the button on every approval-parked run — which
 * is the entire population it exists to serve. That is the same mistake
 * `listClaimableWorkflowRuns` warns against in its own docblock, and this
 * code made it: the mocked e2e fixture set `resumable: true`, a value a
 * real approval-parked run never has, so nothing caught it until a real
 * parked run was driven through the trace.
 *
 * The authority is `resumeParkedRun`, which gates on `status ===
 * "suspended"` alone and never reads `resumable`. This matches it exactly
 * — a UI predicate stricter than the mechanism it drives is a button that
 * lies about what the platform can do.
 */
export function canRetryFrom(
  run: Pick<RunTrace["run"], "status">,
  step: Pick<TraceStep, "status">,
): boolean {
  if (run.status !== "suspended") return false;
  // A step that already succeeded is served from its persisted output on
  // resume rather than re-run, so "retry from here" would be a lie.
  return step.status !== "success";
}

/**
 * Is this value the truncation sentinel rather than real content?
 *
 * The stored shape is `{ __truncated: true, bytes }` for both
 * `resolved_input` and `output`, so a reader has one case to handle.
 */
export function isTruncated(value: unknown): value is { __truncated: true; bytes: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { __truncated?: unknown }).__truncated === true
  );
}

/**
 * How a payload cell should render: prose, a JSON block, the truncation
 * notice, or nothing at all.
 *
 * Returned as a tagged union rather than a pre-rendered string so the
 * template can style the cases differently — and so the truncation case
 * cannot be mistaken for a payload that happens to contain the word
 * "truncated".
 */
export type PayloadView =
  | { kind: "absent" }
  | { kind: "truncated"; bytes: number }
  | { kind: "text"; text: string }
  | { kind: "json"; text: string };

/**
 * **A string payload is shown VERBATIM, never JSON-encoded.** The commonest
 * payload on this surface is an agent step's answer, which is prose: run it
 * through `JSON.stringify` and it arrives as one quoted line with every
 * newline as a literal `\n` and every quote backslashed — the exact value
 * the reader opened the panel for, made unreadable. Everything else keeps
 * the indented JSON block, including a bare number or boolean, whose type
 * is the interesting part.
 */
export function payloadView(value: unknown): PayloadView {
  if (value === null || value === undefined) return { kind: "absent" };
  if (isTruncated(value)) return { kind: "truncated", bytes: value.bytes };
  if (typeof value === "string") return { kind: "text", text: value };
  return { kind: "json", text: JSON.stringify(value, null, 2) };
}

/**
 * Timeline geometry: each step's offset and width as a percentage of the
 * run's total elapsed time.
 *
 * Computed from `startedAt` + `durationMs` rather than from
 * `startedAt`/`updatedAt`, because `updatedAt` moves on every status
 * write and a step whose row was re-written after it finished would
 * render wider than it ran.
 *
 * Steps with no duration get a zero-width marker at their start offset —
 * visible as a tick, so an unmeasured step is not silently absent from
 * the timeline.
 */
export interface TimelineBar {
  stepName: string;
  status: WorkflowRunStatus;
  /** Percent from the left edge, 0..100. */
  offsetPct: number;
  /** Percent of the total width, 0..100. Floored at a visible minimum. */
  widthPct: number;
}

export function timelineBars(trace: RunTrace): TimelineBar[] {
  const runStart = Date.parse(trace.run.startedAt);
  const ends = trace.steps.map(
    (s) => Date.parse(s.startedAt) + (s.durationMs ?? 0),
  );
  const runEnd = trace.run.finishedAt !== null ? Date.parse(trace.run.finishedAt) : Math.max(runStart, ...ends);
  // A run whose steps all landed in the same millisecond (every test
  // fixture, and any all-transform workflow) would divide by zero.
  const span = Math.max(runEnd - runStart, 1);

  return trace.steps.map((s) => {
    const start = Date.parse(s.startedAt);
    const offsetPct = Math.min(Math.max(((start - runStart) / span) * 100, 0), 100);
    const raw = ((s.durationMs ?? 0) / span) * 100;
    return {
      stepName: s.stepName,
      status: s.status,
      offsetPct,
      // Clamped so a bar cannot run off the right edge, and floored at a
      // sliver so a fast step is still findable.
      widthPct: Math.min(Math.max(raw, 0.75), 100 - offsetPct),
    };
  });
}

/**
 * The DAG's edges, inferred from execution order.
 *
 * The trace deliberately does NOT re-read the workflow definition to draw
 * this: the definition may have been edited or deleted since the run, and
 * a graph drawn from today's steps over yesterday's run would be a
 * confident lie. Execution order is what actually happened.
 *
 * Steps that started at the same instant ran CONCURRENTLY (the executor
 * dispatches a batch with `Promise.all`), so they share a rank rather
 * than chaining.
 */
export function dagRanks(steps: TraceStep[]): TraceStep[][] {
  const byStart = new Map<number, TraceStep[]>();
  for (const step of steps) {
    const t = Date.parse(step.startedAt);
    byStart.set(t, [...(byStart.get(t) ?? []), step]);
  }
  return [...byStart.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, group]) => group);
}
