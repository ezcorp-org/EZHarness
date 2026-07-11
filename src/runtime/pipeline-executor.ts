import type {
  AgentEvents,
  AgentResult,
  PipelineDefinition,
  PipelineRun,
  PipelineStep,
  PipelineStepRun,
} from "../types";
import type { AgentExecutor } from "./executor";
import type { EventBus } from "./events";

/** Clamp a step's declared retry budget to the supported 0..2 range.
 *  Absent / non-integer / negative ⇒ 0 (no retry). */
function clampRetries(retries: number | undefined): number {
  if (typeof retries !== "number" || !Number.isFinite(retries)) return 0;
  const n = Math.floor(retries);
  if (n < 0) return 0;
  return n > 2 ? 2 : n;
}

export class PipelineExecutor {
  constructor(
    private agentExecutor: AgentExecutor,
    private bus: EventBus<AgentEvents>,
  ) {}

  async runPipeline(
    pipeline: PipelineDefinition,
    input: Record<string, unknown>,
    projectId?: string,
    userId?: string,
    signal?: AbortSignal,
  ): Promise<PipelineRun> {
    const pipelineRun: PipelineRun = {
      id: crypto.randomUUID(),
      pipelineName: pipeline.name,
      projectId,
      status: "running",
      startedAt: Date.now(),
      steps: [],
    };

    // `userId` scopes pipeline:* SSE delivery to the initiating user
    // (fail-closed filter — see sse-conversation-filter.ts). CLI runs
    // have no user and are observed via stdout/DB, not SSE.
    this.bus.emit("pipeline:start", { pipelineRun, userId });

    const stepResults = new Map<string, AgentResult>();
    let prevResult: AgentResult | undefined;

    // ── Cancellation plumbing (durability, Phase C1) ─────────────────
    //
    // A pipeline step's agent run is only observable *after* runAgent
    // resolves, but a cancel (external abort OR a sibling failing) must
    // stop the OTHER in-flight runs *while they are still running*. We
    // capture each step run's id from its `run:start` event and drop it
    // on the matching terminal event, so `cancelInFlight()` can cascade a
    // cancel down every live child (executor.cancelRun aborts the run's
    // controller — and its whole spawn subtree). Scoped to this pipeline's
    // step agents + its own subscribe/unsubscribe window so a shared bus's
    // unrelated runs are never touched.
    const stepAgents = new Set(pipeline.steps.map((s) => s.agent));
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
      if (externallyAborted) throw new PipelineAbortError();

      const batches = this.resolveExecutionOrder(pipeline.steps);

      for (const batch of batches) {
        if (externallyAborted) throw new PipelineAbortError();

        // Run every step in the batch concurrently. The FIRST failure (a
        // genuine unsuccessful result or a thrown ref-resolution error)
        // records `batchError` and immediately cancels the still-running
        // siblings, instead of letting them stream on unsupervised. Each
        // step promise swallows its own rejection so `Promise.all` waits
        // for the whole batch to unwind (the cancelled siblings resolve
        // fast) before we surface the first error.
        let batchError: Error | undefined;
        const fail = (err: unknown): void => {
          if (batchError) return;
          batchError = err instanceof Error ? err : new Error(String(err));
          cancelInFlight();
        };

        const promises = batch.map(async (step) => {
          const stepRun: PipelineStepRun = {
            stepName: step.name,
            runId: "",
            status: "running",
          };
          pipelineRun.steps.push(stepRun);
          this.bus.emit("pipeline:step", { pipelineRun, step: stepRun, userId });

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
            );
            stepResults.set(step.name, result);
            return result;
          } catch (err) {
            fail(err);
            return undefined;
          }
        });

        const results = await Promise.all(promises);

        if (externallyAborted) throw new PipelineAbortError();
        if (batchError) throw batchError;

        // Last SUCCESSFUL result in this batch feeds `$prev` of the next.
        prevResult = results[results.length - 1];
      }

      pipelineRun.status = "success";
      pipelineRun.finishedAt = Date.now();
      pipelineRun.result = prevResult ?? { success: true, output: null };
      this.bus.emit("pipeline:complete", { pipelineRun, userId });
    } catch (err) {
      // A cancel (external abort OR a sibling-cancel that abort-cascaded
      // into this step) terminalizes the pipeline as `cancelled`, distinct
      // from a genuine `error`. There is no `pipeline:cancel` bus event, so
      // the terminal `pipeline:error` still fires (the SSE/UI needs a
      // terminal signal) but `pipelineRun.status` carries the real
      // discriminator.
      cancelInFlight();
      if (externallyAborted || err instanceof PipelineAbortError) {
        pipelineRun.status = "cancelled";
        pipelineRun.finishedAt = Date.now();
        pipelineRun.result = {
          success: false,
          output: null,
          error: { code: "cancelled", message: "pipeline cancelled" },
        };
        this.bus.emit("pipeline:error", {
          pipelineRun,
          error: "pipeline cancelled",
          userId,
        });
      } else {
        const error = err instanceof Error ? err.message : String(err);
        pipelineRun.status = "error";
        pipelineRun.finishedAt = Date.now();
        pipelineRun.result = { success: false, output: null, error };
        this.bus.emit("pipeline:error", { pipelineRun, error, userId });
      }
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      for (const unsub of unsubs) unsub();
    }

    return pipelineRun;
  }

  /**
   * Run one step with its retry budget. Resolves the step's input once
   * (a strict-ref failure is terminal — never retried), then runs the
   * agent up to `1 + clampRetries(step.retries)` times, returning the
   * first successful result. A genuine failure is retried; a *cancelled*
   * run (pipeline abort / sibling cancel) is not. Throws a descriptive
   * error when the budget is exhausted or the run was cancelled.
   */
  private async runStep(
    step: PipelineStep,
    pipelineInput: Record<string, unknown>,
    stepResults: Map<string, AgentResult>,
    prevResult: AgentResult | undefined,
    stepRun: PipelineStepRun,
    projectId: string | undefined,
    userId: string | undefined,
    isAborted: () => boolean,
  ): Promise<AgentResult> {
    // Strict-ref resolution: a missing `$steps.X` / `$prev` reference throws
    // here (see resolveStepInput) — terminal, not retried.
    const resolvedInput = this.resolveStepInput(
      step.input ?? {},
      pipelineInput,
      stepResults,
      prevResult,
    );

    const maxAttempts = 1 + clampRetries(step.retries);
    let lastError = `Step "${step.name}" failed: unknown error`;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isAborted()) {
        throw new PipelineAbortError();
      }

      const agentRun = await this.agentExecutor.runAgent(
        step.agent,
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

      if (result.success) return result;

      // Single-line statements on purpose: a multi-line template
      // interpolation makes Bun attribute the closing line's hit
      // inconsistently across merged coverage shards (spurious 0-hit).
      let errText = "unknown error";
      if (typeof result.error === "string") errText = result.error;
      else if (result.error) errText = result.error.message;
      lastError = `Step "${step.name}" failed: ${errText}`;

      // A cancelled run (external abort / sibling cancel cascaded onto this
      // run) is never retried — the pipeline is already unwinding.
      if (agentRun.status === "cancelled" || isAborted()) {
        throw new PipelineAbortError();
      }
    }

    throw new Error(lastError);
  }

  resolveExecutionOrder(steps: PipelineStep[]): PipelineStep[][] {
    const hasDeps = steps.some((s) => s.dependsOn && s.dependsOn.length > 0);

    if (!hasDeps) {
      // No dependsOn anywhere — run sequentially
      return steps.map((s) => [s]);
    }

    // Topological sort into parallel batches
    const resolved = new Set<string>();
    const batches: PipelineStep[][] = [];

    while (resolved.size < steps.length) {
      const batch: PipelineStep[] = [];

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
   * Resolve a step's input mapping against the pipeline input, the previous
   * batch's result (`$prev`), and prior steps' results (`$steps.NAME[.field]`).
   *
   * Strict (durability, Phase C1): a `$prev` / `$steps.X` reference to a
   * step that hasn't produced a result, or to a field missing on that
   * result, THROWS a descriptive error rather than silently passing
   * `undefined` downstream. `$input.field` stays lenient (optional user
   * input may legitimately be absent), and a bare literal passes through.
   */
  resolveStepInput(
    mapping: Record<string, string>,
    pipelineInput: Record<string, unknown>,
    stepResults: Map<string, AgentResult>,
    prevResult?: AgentResult,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, ref] of Object.entries(mapping)) {
      if (ref.startsWith("$input.")) {
        const field = ref.slice("$input.".length);
        resolved[key] = pipelineInput[field];
      } else if (ref.startsWith("$prev.")) {
        const field = ref.slice("$prev.".length);
        if (prevResult === undefined) {
          throw new Error(
            `Cannot resolve "${ref}" for step input "${key}": no previous step has produced a result yet.`,
          );
        }
        const value = getNestedValue(prevResult, field);
        if (value === undefined) {
          throw new Error(
            `Cannot resolve "${ref}" for step input "${key}": field "${field}" is missing on the previous step's result.`,
          );
        }
        resolved[key] = value;
      } else if (ref.startsWith("$steps.")) {
        const rest = ref.slice("$steps.".length);
        const dotIdx = rest.indexOf(".");
        const stepName = dotIdx === -1 ? rest : rest.slice(0, dotIdx);
        if (!stepResults.has(stepName)) {
          throw new Error(
            `Cannot resolve "${ref}" for step input "${key}": step "${stepName}" has not produced a result (unknown step or it has not run yet).`,
          );
        }
        if (dotIdx === -1) {
          resolved[key] = stepResults.get(stepName);
        } else {
          const field = rest.slice(dotIdx + 1);
          const value = getNestedValue(stepResults.get(stepName), field);
          if (value === undefined) {
            throw new Error(
              `Cannot resolve "${ref}" for step input "${key}": field "${field}" is missing on step "${stepName}"'s result.`,
            );
          }
          resolved[key] = value;
        }
      } else {
        // Literal value
        resolved[key] = ref;
      }
    }

    return resolved;
  }
}

/** Sentinel thrown internally when a pipeline is cancelled (external abort
 *  or a sibling-failure cancel cascaded onto a step's run) so the catch
 *  block terminalizes it as `cancelled` rather than `error`. */
class PipelineAbortError extends Error {
  constructor() {
    super("pipeline cancelled");
    this.name = "PipelineAbortError";
  }
}

function getNestedValue(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
