import { createHash } from "node:crypto";
import type { AgentRun } from "../../types";
import type { FactoryArtifactReference, FactoryCheckpointReference, FactoryRunnerOperationResult, FactoryRunnerRequest, FactoryRunnerResult, FactoryUsage } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { AgentExecutor, FactoryAttemptExecutionRequest } from "../../runtime/executor";
import type { FactoryExecutionContext } from "../../runtime/factory-execution";

export interface NativeFactoryJournal {
  operations(request: FactoryRunnerRequest): Promise<readonly FactoryRunnerOperationResult[]>;
  journalCursor(request: FactoryRunnerRequest): Promise<number>;
}

export interface NativeFactoryArtifacts {
  output(request: FactoryRunnerRequest, run: AgentRun): Promise<FactoryArtifactReference>;
  checkpoint(request: FactoryRunnerRequest, run: AgentRun): Promise<FactoryCheckpointReference>;
}

export interface NativeFactoryRunnerOptions {
  executor: Pick<AgentExecutor, "executeFactoryAttempt">;
  execution(request: FactoryRunnerRequest): FactoryExecutionContext;
  journal: NativeFactoryJournal;
  artifacts: NativeFactoryArtifacts;
  conversation(request: FactoryRunnerRequest): Pick<FactoryAttemptExecutionRequest, "conversationId" | "userMessage" | "options">;
}

function requireValid(result: { ok: boolean; issues?: readonly { code: string; message: string }[] }, name: string): void {
  if (!result.ok) throw new Error(`${name} is invalid: ${result.issues?.[0]?.code ?? "unknown"}.`);
}

/**
 * The Bun native entrypoint. It accepts only the generated C02 wire request,
 * then gives the shared executor factory transport rather than a host key.
 */
export async function runNativeFactoryRunner(value: unknown, options: NativeFactoryRunnerOptions): Promise<FactoryRunnerResult> {
  requireValid(validateFactoryRunnerRequest(value), "Factory runner request");
  const request = value as FactoryRunnerRequest;
  const execution = options.execution(request);
  if (execution.attempt.attemptToken !== request.broker.attemptToken
    || execution.attempt.runId !== request.authority.runId
    || execution.attempt.nodeInstanceId !== request.authority.nodeInstanceId
    || execution.attempt.candidateGeneration !== request.authority.candidateGeneration
    || execution.attempt.nextOperationIndex !== request.authority.nextOperationIndex
    || request.model !== undefined && (execution.model.provider !== request.model.provider || execution.model.id !== request.model.model)) {
    throw new Error("Factory execution does not match the signed runner request.");
  }
  const run = await options.executor.executeFactoryAttempt({ ...options.conversation(request), execution });
  const journalCursor = await options.journal.journalCursor(request);
  if (run.status === "cancelled") return { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor, operations: [] };
  if (run.status !== "success") {
    const error = typeof run.result?.error === "string" ? run.result.error : run.result?.error?.message ?? "Factory agent did not complete.";
    const result: FactoryRunnerResult = { schemaVersion: "factory.runner.result.v1", status: "failed", journalCursor, operations: [], resultDigest: digest({ error }), error: { code: "FACTORY_AGENT_FAILED", message: error, retryable: false }, usage: { kind: "unknown", reason: "agent failed before measured usage was available", heldCostMicros: "1" } };
    requireValid(validateFactoryRunnerResult(result), "Factory runner result");
    return result;
  }
  const [operations, output, workspaceCheckpoint] = await Promise.all([
    options.journal.operations(request), options.artifacts.output(request, run), options.artifacts.checkpoint(request, run),
  ]);
  const usage: FactoryUsage = { kind: "measured", inputTokens: run.inputTokens ?? 0, outputTokens: run.outputTokens ?? 0, computeMs: Math.max(0, (run.finishedAt ?? Date.now()) - run.startedAt), costMicros: "0" };
  const result: FactoryRunnerResult = {
    schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor,
    operations: [...operations], resultDigest: digest(run.result?.output ?? null), output, usage, workspaceCheckpoint,
  };
  requireValid(validateFactoryRunnerResult(result), "Factory runner result");
  return result;
}

export type { FactoryUsage };

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
