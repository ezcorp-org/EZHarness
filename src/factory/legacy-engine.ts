/**
 * The product's own workflow engine, behind the seam W13's adapter names.
 *
 * W13 wrote `FactoryLegacyWorkflows` against a `FactoryLegacyEngine`
 * interface and deliberately did not import the engine: the adapter has to
 * stay opaque about the engine's internal steps (C10), the key lookup has to
 * be provably incapable of creating a run, and the crash between journal and
 * start has to be reproducible without killing a process. This file is the
 * one implementation of that interface over the real engine, and it adds
 * nothing to it — three calls, each to a function that already exists.
 *
 * **`start` returns when the durable row is confirmed, not when the run
 * ends.** `WorkflowExecutor.runWorkflow` awaits the whole graph, which can be
 * minutes; the factory needs the run's identity immediately so the journal can
 * record it before anything else observes the attempt. `onRunCreated` is the
 * engine's own name for that boundary — "called after a new durable row is
 * confirmed, or an existing keyed run is found" — and it is the same boundary
 * the async HTTP run route answers its 202 from. So the run itself is left
 * unawaited and polled through `facts`, exactly as C10 describes.
 *
 * **A start that never confirms a row refuses rather than inventing an id.**
 * `runWorkflow` has refusal paths that return a `WorkflowRun` whose durable
 * record was never written (`run-persistence-failed`). Reading an id off one
 * of those would put a legacy run id in the journal that names nothing, and
 * every later `facts` call would read `null` and be indistinguishable from a
 * deleted run. If the engine settles without having confirmed a row, this
 * raises by name.
 */
import { findWorkflowRunByIdempotencyKey, getWorkflowRunRow, listWorkflowStepRunRows } from "../db/queries/workflow-runs";
import type { WorkflowDefinition, WorkflowRun, WorkflowRunResult } from "../types";
import type { FactoryLegacyEngine } from "./legacy-workflow/adapter";
import type { LegacyWorkflowRunFacts } from "./legacy-workflow/status";

export class FactoryLegacyEngineError extends Error {
  constructor(readonly code: "factory_legacy_engine_unknown_workflow" | "factory_legacy_engine_unconfirmed", message: string) {
    super(message);
    this.name = "FactoryLegacyEngineError";
  }
}

/**
 * The engine call this adapter makes, named structurally.
 *
 * `WorkflowExecutor` is a class with a large surface and a large construction
 * cost; naming the one method keeps a test able to drive this adapter without
 * standing up a runtime, and keeps a reader able to see that the adapter uses
 * nothing else.
 */
export interface FactoryLegacyWorkflowEngine {
  runWorkflow(
    workflow: WorkflowDefinition,
    input: Record<string, unknown>,
    projectId?: string,
    userId?: string,
    signal?: AbortSignal,
    options?: { readonly idempotencyKey?: string; readonly onRunCreated?: (run: WorkflowRun) => void },
  ): Promise<WorkflowRun>;
}

export interface FactoryLegacyEngineOptions {
  readonly executor: FactoryLegacyWorkflowEngine;
  /**
   * Resolves the pinned definition by name.
   *
   * Injected because the product assembles its workflows from two sources
   * (`loadYamlWorkflows` over the agents directory and `loadDbWorkflows`), and
   * which sources an installation has is a deployment fact rather than
   * something this adapter can decide. A name it cannot resolve is refused by
   * name; it never substitutes a similar definition.
   */
  readonly resolve: (workflowName: string) => Promise<WorkflowDefinition | undefined>;
}

/** The running step names, in a stable order the row order does not provide. */
function inFlightStepNames(rows: readonly { stepName: string; status: string }[]): readonly string[] {
  return Object.freeze(rows.filter(row => row.status === "running").map(row => row.stepName).sort());
}

function resultError(result: WorkflowRunResult | null): { code: string | null; message: string | null } {
  const error = result?.error;
  if (typeof error === "string") return { code: null, message: error };
  if (error && typeof error === "object") return { code: error.code, message: error.message };
  return { code: null, message: null };
}

export function createFactoryLegacyEngine(options: FactoryLegacyEngineOptions): FactoryLegacyEngine {
  return Object.freeze({
    async start(request: { readonly workflowName: string; readonly idempotencyKey: string; readonly input: Record<string, unknown>; readonly projectId: string; readonly userId?: string }): Promise<{ readonly legacyRunId: string }> {
      const definition = await options.resolve(request.workflowName);
      if (!definition) throw new FactoryLegacyEngineError("factory_legacy_engine_unknown_workflow", `This installation has no workflow named ${request.workflowName}.`);
      let confirmed: WorkflowRun | undefined;
      let settle: (run: WorkflowRun) => void = () => undefined;
      let refuse: (error: unknown) => void = () => undefined;
      const created = new Promise<WorkflowRun>((resolve, reject) => { settle = resolve; refuse = reject; });
      const finished = options.executor.runWorkflow(
        definition,
        request.input,
        request.projectId,
        request.userId,
        undefined,
        {
          idempotencyKey: request.idempotencyKey,
          onRunCreated: run => { confirmed = run; settle(run); },
        },
      );
      finished.then(
        () => { if (!confirmed) refuse(new FactoryLegacyEngineError("factory_legacy_engine_unconfirmed", "The legacy engine finished without confirming a durable run record.")); },
        error => { if (!confirmed) refuse(error); },
      );
      // The run is polled through `facts`, never awaited here, so its eventual
      // rejection must not surface as an unhandled one in the meantime.
      finished.catch(() => undefined);
      return Object.freeze({ legacyRunId: (await created).id });
    },

    /**
     * A read, and only a read.
     *
     * `findWorkflowRunByIdempotencyKey` is a single `SELECT` served by the
     * partial unique index on `(workflow_name, idempotency_key)`. Nothing on
     * this path inserts, and nothing on it can: that is what lets the journal
     * distinguish "the engine already started this" from "start it now" after
     * a crash, without the lookup itself being the second start.
     */
    async lookup(workflowName: string, idempotencyKey: string): Promise<{ readonly legacyRunId: string } | null> {
      const row = await findWorkflowRunByIdempotencyKey(workflowName, idempotencyKey);
      return row ? Object.freeze({ legacyRunId: row.id }) : null;
    },

    async facts(legacyRunId: string, observedAtMs: number): Promise<LegacyWorkflowRunFacts | null> {
      const row = await getWorkflowRunRow(legacyRunId);
      if (!row) return null;
      const steps = await listWorkflowStepRunRows(legacyRunId);
      const result = (row.result ?? null) as WorkflowRunResult | null;
      const error = resultError(result);
      return Object.freeze({
        status: row.status,
        runPhase: row.runPhase,
        suspendedReason: row.suspendedReason,
        resumable: row.resumable,
        // Epoch milliseconds, because the mapper compares it against
        // `observedAtMs` and a `Date` would compare as a string.
        leaseExpiresAtMs: row.leaseExpiresAt === null ? null : row.leaseExpiresAt.getTime(),
        cursorBatchIndex: typeof row.cursor?.batchIndex === "number" ? row.cursor.batchIndex : null,
        inFlightStepNames: inFlightStepNames(steps),
        resultErrorCode: error.code,
        resultErrorMessage: error.message,
        // `undefined` for a run with no result at all, which is not the same
        // fact as a run whose output was `null`.
        resultOutput: result ? result.output : undefined,
        // Passed through rather than read here: the caller decides which
        // instant a lease is judged against, and two facts read at two
        // instants must not both claim "now".
        observedAtMs,
      });
    },
  });
}
