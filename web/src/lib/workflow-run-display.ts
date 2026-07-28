/**
 * Framework-free display logic for workflow runs.
 *
 * Extracted from `routes/(app)/workflows/[name]/+page.svelte` so the
 * status/kind mappings are unit-testable: they are the surfaces that
 * silently drift when a new step kind or run status is added on the
 * server (both happened — a `tool` step rendered a blank kind badge, and
 * an `awaiting_approval` run rendered no explanation at all).
 *
 * Same role as `workflow-builder-logic.ts` plays for the create form.
 */
import type { WorkflowRun, WorkflowStepKind } from "./api.js";

/** Tailwind text colour per run/step status. */
const STATUS_COLOR: Record<string, string> = {
  success: "text-green-400",
  error: "text-red-400",
  cancelled: "text-[var(--color-text-muted)]",
  // Blocked on a human, not failed and not running — amber, distinct
  // from the yellow used for the in-progress fallback below.
  awaiting_approval: "text-amber-400",
};

/** Colour for a run/step status; unknown statuses read as in-progress. */
export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? "text-yellow-400";
}

const KIND_LABEL: Record<WorkflowStepKind, string> = {
  agent: "agent",
  transform: "transform",
  gate: "gate",
  tool: "tool",
};

/**
 * Badge label for a step kind. Falls back to the raw value rather than
 * rendering an EMPTY badge: the previous `Record` lookup with no fallback
 * meant every `kind: "tool"` step showed a blank chip.
 */
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as WorkflowStepKind] ?? kind;
}

/**
 * Statuses whose run carries an explanation worth showing. Everything
 * that is not a success has one — including `awaiting_approval`, whose
 * message names the step and capability the operator has to approve.
 * That is the single most actionable string the page can render, and the
 * previous `status !== "error" && status !== "cancelled"` test dropped it
 * on the floor.
 */
export function isExplainableStatus(status: string): boolean {
  return status !== "success" && status !== "running" && status !== "idle";
}

/**
 * A non-successful run's loud message (e.g. `Gate "x" failed: …`,
 * `exhausted N iterations…`, `Step "y" requires interactive approval…`).
 * The backend emits either a plain string or a `{ code, message }` object
 * (cancellation, awaiting-approval) — tolerate both, and never render
 * anything for a run that is fine or still going.
 */
export function runErrorText(run: Pick<WorkflowRun, "status" | "result">): string {
  if (!isExplainableStatus(run.status)) return "";
  const err: unknown = run.result?.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "";
}
