import type {
  AgentEvents,
  AgentResult,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepRun,
} from "../types";
import type { AgentExecutor } from "./executor";
import type { EventBus } from "./events";
import {
  resolveMapping,
  resolveOutputMapping,
  type RefContext,
} from "./workflow-refs";
import { evaluateCondition } from "./workflow-condition";
import { clampMaxIterations, clampRetries, stepKind } from "./workflow-validator";

/** Sentinel thrown internally when a workflow is cancelled (external abort
 *  or a sibling-failure cancel cascaded onto a step's run) so the catch
 *  block terminalizes it as `cancelled` rather than `error`. */
class WorkflowAbortError extends Error {
  constructor() {
    super("workflow cancelled");
    this.name = "WorkflowAbortError";
  }
}

export class WorkflowExecutor {
  constructor(
    private agentExecutor: AgentExecutor,
    private bus: EventBus<AgentEvents>,
  ) {}

  async runWorkflow(
    workflow: WorkflowDefinition,
    input: Record<string, unknown>,
    projectId?: string,
    userId?: string,
    signal?: AbortSignal,
  ): Promise<WorkflowRun> {
    const workflowRun: WorkflowRun = {
      id: crypto.randomUUID(),
      workflowName: workflow.name,
      projectId,
      status: "running",
      startedAt: Date.now(),
      steps: [],
    };

    // `userId` scopes workflow:* SSE delivery to the initiating user
    // (fail-closed filter — see sse-conversation-filter.ts). CLI runs
    // have no user and are observed via stdout/DB, not SSE.
    this.bus.emit("workflow:start", { workflowRun, userId });

    const stepResults = new Map<string, AgentResult>();
    let prevResult: AgentResult | undefined;

    // ── Cancellation plumbing (durability) ───────────────────────────
    //
    // Only `agent` steps mint a real AgentRun; capture each such run id
    // from its `run:start` event and drop it on the matching terminal
    // event, so `cancelInFlight()` can cascade a cancel down every live
    // child. Scoped to this workflow's step agents + its own
    // subscribe/unsubscribe window so a shared bus's unrelated runs are
    // never touched. Transform / gate steps have no run to cancel.
    const stepAgents = new Set(
      workflow.steps.map((s) => s.agent).filter((a): a is string => Boolean(a)),
    );
    const inFlightRunIds = new Set<string>();
    const drop = (id: string): void => {
      inFlightRunIds.delete(id);
    };
    const unsubs: Array<() => void> = [
      this.bus.on("run:start", ({ run, runId }) => {
        if (stepAgents.has(run.agentName)) inFlightRunIds.add(runId);
      }),
      this.bus.on("run:complete", ({ run }) => drop(run.id)),
      this.bus.on("run:error", ({ run }) => drop(run.id)),
      this.bus.on("run:cancel", ({ run }) => drop(run.id)),
    ];
    const cancelInFlight = (): void => {
      for (const id of [...inFlightRunIds]) this.agentExecutor.cancelRun(id);
    };

    let externallyAborted = signal?.aborted ?? false;
    const onAbort = (): void => {
      externallyAborted = true;
      cancelInFlight();
    };
    if (signal && !signal.aborted) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      if (externallyAborted) throw new WorkflowAbortError();

      const batches = this.resolveExecutionOrder(workflow.steps);

      for (const batch of batches) {
        if (externallyAborted) throw new WorkflowAbortError();

        // Run every step in the batch concurrently. The FIRST failure
        // records `batchError` and immediately cancels the still-running
        // siblings. Each step promise swallows its own rejection so
        // `Promise.all` waits for the whole batch to unwind before we
        // surface the first error.
        let batchError: Error | undefined;
        const fail = (err: unknown): void => {
          if (batchError) return;
          batchError = err instanceof Error ? err : new Error(String(err));
          cancelInFlight();
        };

        const promises = batch.map(async (step) => {
          const stepRun: WorkflowStepRun = {
            stepName: step.name,
            runId: "",
            status: "running",
          };
          workflowRun.steps.push(stepRun);
          this.bus.emit("workflow:step", { workflowRun, step: stepRun, userId });

          try {
            const result = await this.runStep(
              step,
              input,
              stepResults,
              prevResult,
              stepRun,
              projectId,
              userId,
              () => externallyAborted,
              () => this.bus.emit("workflow:step", { workflowRun, step: stepRun, userId }),
            );
            stepResults.set(step.name, result);
            stepRun.status = "success";
            return result;
          } catch (err) {
            // Only agent steps mirror their AgentRun's terminal status onto
            // the step run; a gate/transform/loop/ref-resolution failure
            // throws with the step still "running" — and a looped agent step
            // stamps each successful iteration's "success" onto the step run,
            // so a later loop failure (until-exhaustion, iter≥2 strict-ref)
            // would leave a stale "success" on a failed step. This catch only
            // runs when the step failed: overwrite any non-failure status —
            // `cancelled` when the run is being aborted, `error` otherwise.
            // (Kept on one line so the line-coverage gate sees it hit by
            // either branch.)
            const aborting = externallyAborted || err instanceof WorkflowAbortError;
            if (stepRun.status === "running" || stepRun.status === "success") stepRun.status = aborting ? "cancelled" : "error";
            fail(err);
            return undefined;
          }
        });

        const results = await Promise.all(promises);

        if (externallyAborted) throw new WorkflowAbortError();
        if (batchError) throw batchError;

        // Last SUCCESSFUL result in this batch feeds `$prev` of the next.
        prevResult = results[results.length - 1];
      }

      workflowRun.status = "success";
      workflowRun.finishedAt = Date.now();
      workflowRun.result = prevResult ?? { success: true, output: null };
      this.bus.emit("workflow:complete", { workflowRun, userId });
    } catch (err) {
      cancelInFlight();
      if (externallyAborted || err instanceof WorkflowAbortError) {
        workflowRun.status = "cancelled";
        workflowRun.finishedAt = Date.now();
        workflowRun.result = {
          success: false,
          output: null,
          error: { code: "cancelled", message: "workflow cancelled" },
        };
        this.bus.emit("workflow:error", {
          workflowRun,
          error: "workflow cancelled",
          userId,
        });
      } else {
        const error = err instanceof Error ? err.message : String(err);
        workflowRun.status = "error";
        workflowRun.finishedAt = Date.now();
        workflowRun.result = { success: false, output: null, error };
        this.bus.emit("workflow:error", { workflowRun, error, userId });
      }
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      for (const unsub of unsubs) unsub();
    }

    return workflowRun;
  }

  /**
   * Dispatch one step by kind, delegating to the loop runner when the step
   * declares one. Throws (terminal for the batch) on any failure.
   */
  private async runStep(
    step: WorkflowStep,
    input: Record<string, unknown>,
    stepResults: Map<string, AgentResult>,
    prevResult: AgentResult | undefined,
    stepRun: WorkflowStepRun,
    projectId: string | undefined,
    userId: string | undefined,
    isAborted: () => boolean,
    emitStep: () => void,
  ): Promise<AgentResult> {
    if (step.loop) {
      return this.runLoop(
        step,
        input,
        stepResults,
        prevResult,
        stepRun,
        projectId,
        userId,
        isAborted,
        emitStep,
      );
    }

    const kind = stepKind(step);
    const baseCtx: RefContext = { input, stepResults, prevResult };

    if (kind === "transform") {
      return runTransform(step, baseCtx);
    }
    if (kind === "gate") {
      return runGate(step, baseCtx);
    }
    return this.runAgentStep(
      step,
      input,
      stepResults,
      prevResult,
      stepRun,
      projectId,
      userId,
      isAborted,
    );
  }

  /**
   * Run one `agent` step with its retry budget. Resolves the step's input
   * once (a strict-ref failure is terminal — never retried), then runs the
   * agent up to `1 + clampRetries(step.retries)` times, returning the first
   * successful result. A *cancelled* run is never retried. Throws a
   * descriptive error when the budget is exhausted or the run was cancelled.
   */
  private async runAgentStep(
    step: WorkflowStep,
    input: Record<string, unknown>,
    stepResults: Map<string, AgentResult>,
    prevResult: AgentResult | undefined,
    stepRun: WorkflowStepRun,
    projectId: string | undefined,
    userId: string | undefined,
    isAborted: () => boolean,
  ): Promise<AgentResult> {
    const resolvedInput = resolveMapping(step.input ?? {}, {
      input,
      stepResults,
      prevResult,
    });

    const maxAttempts = 1 + clampRetries(step.retries);
    let lastError = `Step "${step.name}" failed: unknown error`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isAborted()) throw new WorkflowAbortError();

      const { result, cancelled } = await this.runAgentAttempt(
        step,
        resolvedInput,
        stepRun,
        projectId,
        userId,
      );
      if (result.success) return result;

      lastError = `Step "${step.name}" failed: ${errorText(result)}`;
      if (cancelled || isAborted()) throw new WorkflowAbortError();
    }

    throw new Error(lastError);
  }

  /** Run a single agent invocation, copying its id/status onto the step run. */
  private async runAgentAttempt(
    step: WorkflowStep,
    resolvedInput: Record<string, unknown>,
    stepRun: WorkflowStepRun,
    projectId: string | undefined,
    userId: string | undefined,
  ): Promise<{ result: AgentResult; cancelled: boolean }> {
    const agentRun = await this.agentExecutor.runAgent(
      step.agent as string,
      resolvedInput,
      projectId,
      userId,
    );
    stepRun.runId = agentRun.id;
    stepRun.status = agentRun.status;
    const result = agentRun.result ?? {
      success: false,
      output: null,
      error: "No result",
    };
    return { result, cancelled: agentRun.status === "cancelled" };
  }

  /**
   * Run a looped `agent` / `transform` step: repeat up to
   * `clampMaxIterations(loop.maxIterations)` times, evaluating `until`
   * AFTER each iteration. `until` satisfied ⇒ success. Budget exhausted
   * with `until` unmet obeys `onExhausted` (default `"fail"` throws). No
   * `until` ⇒ a fixed-count loop that always succeeds. Abort is checked
   * between iterations.
   */
  private async runLoop(
    step: WorkflowStep,
    input: Record<string, unknown>,
    stepResults: Map<string, AgentResult>,
    prevResult: AgentResult | undefined,
    stepRun: WorkflowStepRun,
    projectId: string | undefined,
    userId: string | undefined,
    isAborted: () => boolean,
    emitStep: () => void,
  ): Promise<AgentResult> {
    const loop = step.loop!;
    const maxIterations = clampMaxIterations(loop.maxIterations);
    const kind = stepKind(step);
    let last: AgentResult | undefined;
    let result: AgentResult = { success: true, output: null };

    for (let i = 1; i <= maxIterations; i++) {
      if (isAborted()) throw new WorkflowAbortError();

      const loopCtx = { iteration: i, last };
      if (kind === "transform") {
        result = runTransform(step, { input, stepResults, prevResult, loop: loopCtx });
      } else {
        const resolvedInput = resolveMapping(step.input ?? {}, {
          input,
          stepResults,
          prevResult,
          loop: loopCtx,
        });
        const attempt = await this.runAgentAttempt(
          step,
          resolvedInput,
          stepRun,
          projectId,
          userId,
        );
        if (!attempt.result.success) {
          if (attempt.cancelled || isAborted()) throw new WorkflowAbortError();
          throw new Error(`Step "${step.name}" failed: ${errorText(attempt.result)}`);
        }
        result = attempt.result;
      }

      stepRun.iterations = i;
      emitStep();
      last = result;

      if (loop.until) {
        const untilCtx: RefContext = {
          input,
          stepResults,
          prevResult,
          result,
          iteration: i,
        };
        if (evaluateCondition(loop.until, untilCtx).passed) return result;
      }
    }

    // Budget exhausted.
    if (!loop.until) return result; // fixed-count loop always passes
    if ((loop.onExhausted ?? "fail") === "pass") return result;
    throw new Error(
      `Step "${step.name}" exhausted ${maxIterations} iterations without meeting its until-condition`,
    );
  }

  resolveExecutionOrder(steps: WorkflowStep[]): WorkflowStep[][] {
    const hasDeps = steps.some((s) => s.dependsOn && s.dependsOn.length > 0);

    if (!hasDeps) {
      // No dependsOn anywhere — run sequentially.
      return steps.map((s) => [s]);
    }

    // Topological sort into parallel batches.
    const resolved = new Set<string>();
    const batches: WorkflowStep[][] = [];

    while (resolved.size < steps.length) {
      const batch: WorkflowStep[] = [];

      for (const step of steps) {
        if (resolved.has(step.name)) continue;
        const deps = step.dependsOn ?? [];
        if (deps.every((d) => resolved.has(d))) {
          batch.push(step);
        }
      }

      if (batch.length === 0) {
        const unresolved = steps
          .filter((s) => !resolved.has(s.name))
          .map((s) => s.name);
        throw new Error(
          `Circular dependency detected among steps: ${unresolved.join(", ")}`,
        );
      }

      batches.push(batch);
      for (const step of batch) resolved.add(step.name);
    }

    return batches;
  }

  /**
   * Resolve a step's input mapping. Thin wrapper over the shared
   * {@link resolveMapping}, retained on the executor as the historical
   * public surface (unit-tested directly).
   */
  resolveStepInput(
    mapping: Record<string, string>,
    workflowInput: Record<string, unknown>,
    stepResults: Map<string, AgentResult>,
    prevResult?: AgentResult,
  ): Record<string, unknown> {
    return resolveMapping(mapping, { input: workflowInput, stepResults, prevResult });
  }
}

/** Resolve a `transform` step's declarative output mapping into an
 *  `AgentResult`-shaped value. Pure — no LLM, no I/O, no clock. */
function runTransform(step: WorkflowStep, ctx: RefContext): AgentResult {
  const output = resolveOutputMapping(step.output ?? {}, ctx);
  return { success: true, output };
}

/** Evaluate a `gate` step's condition; throw with a descriptive message on
 *  failure (fail-fast like a failed agent step). */
function runGate(step: WorkflowStep, ctx: RefContext): AgentResult {
  const res = evaluateCondition(step.condition!, ctx);
  if (!res.passed) {
    throw new Error(`Gate "${step.name}" failed: ${res.reason}`);
  }
  return { success: true, output: { passed: true } };
}

/** Extract a human-readable error string from an unsuccessful result. */
function errorText(result: AgentResult): string {
  if (typeof result.error === "string") return result.error;
  if (result.error) return result.error.message;
  return "unknown error";
}
