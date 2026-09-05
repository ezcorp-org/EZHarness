/**
 * workflow/runtime-registry.ts — the indirection that lets backend
 * workflow code (the `ezcorp/workflows` reverse-RPC handler in
 * `src/extensions/workflows-handler.ts`) reach the LIVE
 * `WorkflowExecutor` + the merged workflow cache that are constructed in
 * the web layer (`$lib/server/context`'s `ensureInitialized()`).
 *
 * The import direction forbids `src/` from importing
 * `web/src/lib/server/context.ts` directly, so the web layer REGISTERS
 * them here at init — the exact pattern established by
 * `preview-bus-registry.ts`, `briefing/runtime-registry.ts` and
 * `integrations/github-projects/bus-registry.ts`. When nothing has
 * registered (a backend-only boot, a CLI run, or before web init),
 * `getWorkflowRuntime()` returns null and the handler degrades to a
 * typed soft-fail (fail-safe) — never a crash.
 *
 * `getWorkflows` is deliberately a THUNK, not a snapshot array.
 * `context.ts` REPLACES its module-level `workflows` array on every CRUD
 * write (`reloadWorkflows()`), so registering the array by value would
 * freeze a stale list the moment anyone created, edited or deleted a
 * workflow. The thunk always reads the live binding.
 */
import type { AgentDefinition, WorkflowDefinition } from "../../types";
import type { WorkflowExecutor } from "../workflow-executor";
import { systemCachedWorkflow, type CachedWorkflow } from "../workflow-scope";

/** The slice of `WorkflowExecutor` this registry's consumers use.
 *  Narrowed so tests can stub it without standing up the full executor
 *  (which needs an AgentExecutor + a bus).
 *
 *  `resumeWorkflow` joined `runWorkflow` because answering an approval
 *  continues a parked run, and the answer path lives in `src/` — it
 *  cannot reach the web layer's executor any other way. This registry is
 *  the only legal seam for it. */
export type WorkflowRuntimeExecutor = Pick<
  WorkflowExecutor,
  "runWorkflow" | "resumeWorkflow"
>;

export interface WorkflowRuntime {
  workflowExecutor: WorkflowRuntimeExecutor;
  /** Live read of the merged (extension + YAML + DB) workflow cache.
   *  MUST be a thunk — see the module doc. */
  getWorkflows: () => WorkflowDefinition[];
  /**
   * The same cache, with the provenance authorization needs.
   *
   * Separate from {@link getWorkflows} rather than replacing it: a bare
   * `WorkflowDefinition` is what the mention expander and the RPC handler
   * want, and it carries no owner to authorize against. Anything deciding
   * whether a principal may RUN a workflow must read this one, so the chat
   * path asks the same ladder the REST path does.
   *
   * Also a thunk, for the same reason `getWorkflows` is.
   *
   * OPTIONAL, and every consumer must fail CLOSED when it is absent — a
   * registration that cannot answer "who owns this?" has not earned a
   * permissive default. It is optional only because the many registrations
   * that never authorize a run (the approval, resume and RPC paths, which
   * hold an already-authorized workflow) would otherwise have to supply a
   * reader they never call.
   */
  getCachedWorkflows?: () => CachedWorkflow[];
  /**
   * The live agent list, for C3's fire-time consent recompute.
   *
   * The consent hash marks an `agent` step whose agent the registry cannot
   * REACH with `agent:unreachable`, which is a different value from the
   * one an agent with no declared capabilities produces
   * (`workflow-capability-hash.ts` — T11). That distinction is only
   * meaningful against the same list the consent route saw, and the list
   * lives on the web layer's `AgentExecutor`, which `src/` cannot import.
   *
   * OPTIONAL and FAIL CLOSED, exactly like {@link getCachedWorkflows} and
   * for a sharper reason: an absent reader would make every agent look
   * unreachable, which hashes to a value no stored consent can match — so
   * a permissive default here would not merely under-check, it would
   * silently stale every delegation on the instance. The delegated fire
   * path refuses when this is absent rather than recomputing without it.
   *
   * Also a thunk: agents are reloaded on config CRUD, so a snapshot array
   * would freeze a stale list.
   */
  listAgents?: () => AgentDefinition[];
}

let registered: WorkflowRuntime | null = null;

export function workflowResumeEntry(
  runtime: WorkflowRuntime,
  name: string,
): CachedWorkflow | undefined {
  if (runtime.getCachedWorkflows) {
    return runtime.getCachedWorkflows().find((entry) => entry.definition.name === name);
  }
  const definition = runtime.getWorkflows().find((entry) => entry.name === name);
  return definition && systemCachedWorkflow(definition, name.includes(":") ? "extension" : "yaml");
}

/** Register the live workflow executor + cache reader. Called once by the
 *  web layer's `ensureInitialized()` right after the executor is
 *  constructed. Idempotent. */
export function registerWorkflowRuntime(runtime: WorkflowRuntime): void {
  registered = runtime;
}

/** Read the registered runtime, or null when none is registered yet. */
export function getWorkflowRuntime(): WorkflowRuntime | null {
  return registered;
}

/** Test-only: clear the registration. */
export function _resetWorkflowRuntimeForTests(): void {
  registered = null;
}
