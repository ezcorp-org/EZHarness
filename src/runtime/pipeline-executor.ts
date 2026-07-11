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

    try {
      const batches = this.resolveExecutionOrder(pipeline.steps);

      for (const batch of batches) {
        const promises = batch.map(async (step) => {
          const stepRun: PipelineStepRun = {
            stepName: step.name,
            runId: "",
            status: "running",
          };
          pipelineRun.steps.push(stepRun);
          this.bus.emit("pipeline:step", { pipelineRun, step: stepRun, userId });

          const resolvedInput = this.resolveStepInput(
            step.input ?? {},
            input,
            stepResults,
            prevResult,
          );

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

          if (!result.success) {
            throw new Error(
              `Step "${step.name}" failed: ${result.error ?? "unknown error"}`,
            );
          }

          stepResults.set(step.name, result);
          return result;
        });

        const results = await Promise.all(promises);
        // Set prevResult to the last result in this batch
        prevResult = results[results.length - 1];
      }

      pipelineRun.status = "success";
      pipelineRun.finishedAt = Date.now();
      pipelineRun.result = prevResult ?? { success: true, output: null };
      this.bus.emit("pipeline:complete", { pipelineRun, userId });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      pipelineRun.status = "error";
      pipelineRun.finishedAt = Date.now();
      pipelineRun.result = { success: false, output: null, error };
      this.bus.emit("pipeline:error", { pipelineRun, error, userId });
    }

    return pipelineRun;
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
        resolved[key] = getNestedValue(prevResult, field);
      } else if (ref.startsWith("$steps.")) {
        const rest = ref.slice("$steps.".length);
        const dotIdx = rest.indexOf(".");
        if (dotIdx === -1) {
          resolved[key] = stepResults.get(rest);
        } else {
          const stepName = rest.slice(0, dotIdx);
          const field = rest.slice(dotIdx + 1);
          resolved[key] = getNestedValue(stepResults.get(stepName), field);
        }
      } else {
        // Literal value
        resolved[key] = ref;
      }
    }

    return resolved;
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
