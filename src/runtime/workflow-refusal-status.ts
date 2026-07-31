/**
 * Refusal code → HTTP status. ONE table, for every workflow surface.
 *
 * ## Why this is a module and not a `const` in each route
 *
 * `answerApproval` and `resumeParkedRun`/`cancelParkedRun` return TYPED
 * refusal codes rather than throwing, precisely so a surface can render
 * them in its own conventions. That is a good contract, and it grew a bad
 * habit: four surfaces — the two run-control routes, the approvals route,
 * and the Hub tab — each hand-wrote the same code→status object.
 *
 * Four copies of one mapping is a mapping that is wrong in at least one
 * of them, and the wrong one is the one nobody re-reads. Worse, the
 * copies were SILENTLY partial: every one of them ended in `?? 400`, so a
 * code a surface forgot did not fail loudly — it degraded to "bad
 * request" and blamed the caller for the server's omission.
 *
 * This is the same reasoning that gives `workflow-answer-approval.ts` its
 * single export: a rule that exists in one place cannot drift, and there
 * is nothing left to reimplement it out of.
 *
 * ## Why it lives in `src/runtime/`
 *
 * `workflow-approvals-hub-page.ts` is backend code and cannot import from
 * `web/`; `web/` CAN import from here via the `$server` alias. `src/` is
 * therefore the only place both reach. It sits beside the two modules that
 * DEFINE the codes, and imports them `import type` only — the types are
 * erased at compile time, so no runtime import cycle is created.
 */
import type { AnswerApprovalRefusal } from "./workflow-answer-approval";
import type { RunControlCode } from "./workflow-run-control";

/** Every typed refusal any workflow surface can be handed. */
export type WorkflowRefusalCode = AnswerApprovalRefusal | RunControlCode;

/**
 * The mapping, total over the union.
 *
 * The `Record<WorkflowRefusalCode, number>` annotation is the point: it is
 * an exhaustiveness check the COMPILER performs. Add a code to either
 * union and this object stops type-checking until it is given a status —
 * which is the outcome the old per-surface copies could not produce,
 * because a missing key there was indistinguishable from a deliberate 400.
 *
 * The two overlapping codes agreed across all four copies, so adopting one
 * table changes no status any surface returns today.
 */
export const WORKFLOW_REFUSAL_STATUS: Record<WorkflowRefusalCode, number> = {
  "not-found": 404,
  forbidden: 403,
  "not-pending": 409,
  "lost-race": 409,
  "run-unavailable": 409,
  // The answer landed; the run did not continue. 409, not a 200 carrying
  // a dead run.
  "resume-failed": 409,
  "not-resumable": 409,
  "already-terminal": 409,
  "invalid-answer": 400,
};

/**
 * Lookup view of the table above.
 *
 * A `Map`, not the object itself, because the object literal inherits
 * `Object.prototype`: indexing it with `"toString"` or `"constructor"`
 * yields a FUNCTION, which the `?? 400` in each old copy would have
 * happily passed through as an HTTP status. Unreachable from the typed
 * callers, and cheap to make impossible rather than merely unlikely.
 */
const LOOKUP = new Map<string, number>(Object.entries(WORKFLOW_REFUSAL_STATUS));

/**
 * Status for a refusal, degrading to 400 rather than throwing.
 *
 * Callers pass a typed code, so the fallback is unreachable through the
 * type system — but a refusal that crosses an untyped boundary (a stored
 * code, a payload, a surface compiled against an older union) must still
 * produce a response rather than an exception, exactly as the `?? 400` in
 * each old copy did.
 */
export function workflowRefusalStatus(code: WorkflowRefusalCode): number {
  return LOOKUP.get(code) ?? 400;
}
