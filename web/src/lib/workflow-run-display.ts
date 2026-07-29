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
import type { Workflow, WorkflowModelOverride, WorkflowRun, WorkflowStep, WorkflowStepKind } from "./api.js";

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

/**
 * One-line summary of a DECLARED model binding, for the step list on the
 * definition card — e.g. `anthropic/claude-haiku-4-5 · 8000 tok · high`.
 *
 * Renders only the fields the author actually set, so a binding that names
 * a model alone does not sprout invented defaults, and returns `""` for
 * "nothing declared" so the caller can skip the element entirely rather
 * than render an empty chip. Values may be refs (`$input.tier`) — they are
 * shown verbatim, because the ref IS what the definition says.
 */
export function modelBindingLabel(binding: WorkflowModelOverride | undefined): string {
  if (!binding) return "";
  const parts: string[] = [];
  const id = [binding.provider, binding.model].filter(Boolean).join("/");
  if (id) parts.push(id);
  if (binding.temperature !== undefined) parts.push(`temp ${binding.temperature}`);
  if (binding.maxTokens !== undefined) parts.push(`${binding.maxTokens} tok`);
  return parts.join(" · ");
}

/**
 * The binding a step will actually run on: its own, else the definition's
 * `defaultModel`. Whole-bundle fallback, mirroring the server's
 * `effectiveModelOverride` — the page must not invent a merge the executor
 * does not perform, or it would advertise a model the run never uses.
 */
export function stepModelBinding(
  step: Pick<WorkflowStep, "model">,
  workflow: Pick<Workflow, "defaultModel"> | undefined,
): WorkflowModelOverride | undefined {
  return step.model ?? workflow?.defaultModel;
}

/**
 * The model a COMPLETED step ran on, for the run-history line — e.g.
 * `anthropic/claude-haiku-4-5`. Distinct from {@link modelBindingLabel}:
 * that one shows what the definition asked for (possibly a ref), this one
 * shows what the provider actually served. Empty when the step ran no LLM
 * (transform / gate / tool), which is the common case and must render
 * nothing at all rather than a dangling separator.
 */
export function resolvedModelLabel(
  step: Pick<WorkflowRun["steps"][number], "provider" | "model">,
): string {
  return [step.provider, step.model].filter(Boolean).join("/");
}
