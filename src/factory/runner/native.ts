import { createHash } from "node:crypto";
import type { AgentRun } from "../../types";
import type { FactoryArtifactReference, FactoryCheckpointReference, FactoryRunnerOperationResult, FactoryRunnerRequest, FactoryRunnerResult, FactoryUsage } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { AgentExecutor, FactoryAttemptExecutionRequest } from "../../runtime/executor";
import type { FactoryExecutionContext } from "../../runtime/factory-execution";
import type { FactoryExecutionJournal, FactoryAttemptAuthority } from "../executions";

export interface NativeFactoryJournal {
  operations(request: FactoryRunnerRequest): Promise<readonly FactoryRunnerOperationResult[]>;
  journalCursor(request: FactoryRunnerRequest): Promise<number>;
  usage(request: FactoryRunnerRequest): Promise<FactoryUsage>;
}

export interface NativeFactoryArtifacts {
  output(request: FactoryRunnerRequest, run: AgentRun): Promise<FactoryArtifactReference>;
  checkpoint(request: FactoryRunnerRequest, run: AgentRun): Promise<FactoryCheckpointReference>;
}

/** Bind the native entrypoint to the read-only durable C02 journal. */
export function nativeFactoryJournal(journal: FactoryExecutionJournal): NativeFactoryJournal {
  const authority = (request: FactoryRunnerRequest): FactoryAttemptAuthority => ({
    attemptId: request.authority.attemptId,
    tenantId: request.authority.tenantId,
    projectId: request.authority.projectId,
    runId: request.authority.runId,
    nodeInstanceId: request.authority.nodeInstanceId,
    candidateGeneration: request.authority.candidateGeneration,
    attemptNumber: request.authority.attemptNumber,
    grantRevision: request.authority.grantRevision,
    reservationGeneration: request.authority.reservationGeneration,
    executionEpoch: request.authority.executionEpoch,
    deadlineAt: new Date(request.authority.deadlineAtMs),
  });
  return {
    async operations(request) { return (await journal.operations(authority(request))) as FactoryRunnerOperationResult[]; },
    async journalCursor(request) { return (await journal.status(authority(request))).journalCursor; },
    async usage(request) { return operationUsage(await journal.operations(authority(request))); },
  };
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
  const [journalCursor, operations, usage] = await Promise.all([options.journal.journalCursor(request), options.journal.operations(request), options.journal.usage(request)]);
  if (run.status === "cancelled") {
    const result: FactoryRunnerResult = { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor, operations: [...operations] };
    requireValid(validateFactoryRunnerResult(result), "Factory runner result");
    return result;
  }
  if (run.status !== "success") {
    const error = typeof run.result?.error === "string" ? run.result.error : run.result?.error?.message ?? "Factory agent did not complete.";
    const result: FactoryRunnerResult = { schemaVersion: "factory.runner.result.v1", status: "failed", journalCursor, operations: [...operations], resultDigest: digest({ error }), error: { code: "FACTORY_AGENT_FAILED", message: error, retryable: false }, usage };
    requireValid(validateFactoryRunnerResult(result), "Factory runner result");
    return result;
  }
  const [output, workspaceCheckpoint] = await Promise.all([options.artifacts.output(request, run), options.artifacts.checkpoint(request, run)]);
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

function operationUsage(operations: readonly FactoryRunnerOperationResult[]): FactoryUsage {
  const usage = operations.map(operation => operation.usage).filter((value): value is FactoryUsage => value !== undefined);
  if (usage.length !== operations.length || usage.length === 0) throw new Error("Durable operation usage is unavailable.");
  const held = usage.reduce((total, value) => total + BigInt(value.kind === "measured" ? value.costMicros : value.heldCostMicros), 0n).toString();
  if (usage.some(value => value.kind === "unknown")) return { kind: "unknown", reason: "durable operation usage is incomplete", heldCostMicros: held };
  const measured = usage as Extract<FactoryUsage, { kind: "measured" }>[];
  return { kind: "measured", inputTokens: measured.reduce((total, value) => total + value.inputTokens, 0), outputTokens: measured.reduce((total, value) => total + value.outputTokens, 0), computeMs: measured.reduce((total, value) => total + value.computeMs, 0), costMicros: held };
}
