import { canonicalJson } from "@ezcorp/extension-contract";
import { digestObject as digest } from "../../extensions/v4/blobs";
import type { AgentRun } from "../../types";
import type { FactoryArtifactReference, FactoryCheckpointReference, FactoryRunnerOperationResult, FactoryRunnerRequest, FactoryRunnerResult, FactoryUsage, JsonValue } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { AgentExecutor, FactoryAttemptExecutionRequest } from "../../runtime/executor";
import type { FactoryExecutionContext } from "../../runtime/factory-execution";
import { artifactJson } from "../artifacts";
import type { FactoryWorkspaceCheckpoints } from "../artifact-materials";
import type { FactoryExecutionJournal, FactoryAttemptAuthority } from "../executions";
import { factoryRunnerRequestAuthority } from "./attempt-authority";

export interface NativeFactoryJournal {
  snapshot(request: FactoryRunnerRequest): Promise<{ readonly operations: readonly FactoryRunnerOperationResult[]; readonly journalCursor: number; readonly usage?: FactoryUsage }>;
}

export interface NativeFactoryArtifacts {
  output(request: FactoryRunnerRequest, run: AgentRun): Promise<FactoryArtifactReference>;
  checkpoint(request: FactoryRunnerRequest, run: AgentRun): Promise<FactoryCheckpointReference>;
}

export { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";

/** Bind the native entrypoint to the read-only durable C02 journal. */
export function nativeFactoryJournal(journal: FactoryExecutionJournal): NativeFactoryJournal {
  return {
    async snapshot(request) {
      const evidence = await journal.evidence(factoryRunnerRequestAuthority(request));
      const operations = evidence.operations as FactoryRunnerOperationResult[];
      requireValid(validateFactoryRunnerResult({ schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: evidence.journalCursor, operations }), "Durable runner operations");
      const usage = operationUsage(operations);
      return { operations, journalCursor: evidence.journalCursor, ...(usage ? { usage } : {}) };
    },
  };
}

/**
 * The canonical wire form of one agent run's output.
 *
 * `runNativeFactoryRunner` digests this value and the artifact writer stages
 * its canonical bytes, and `verifyCompletedEvidence` later requires
 * `output.digest` to equal `sha256:${resultDigest}`. Both sides therefore read
 * the value from here rather than each normalizing the run's own object, which
 * is the only way the two cannot disagree.
 */
export function nativeFactoryOutputValue(run: AgentRun): JsonValue {
  // Agent output carries optional undefined fields; its wire form omits them.
  return JSON.parse(JSON.stringify(run.result?.output ?? null)) as JsonValue;
}

export interface NativeFactoryArtifactsOptions {
  /** The same candidate-output writer the guest broker promotes through. */
  readonly output: (authority: FactoryAttemptAuthority, content: Uint8Array) => Promise<FactoryArtifactReference>;
  /** W04's production copy-on-write checkpoint writer, under the `workspace/` prefix. */
  readonly checkpoints: Pick<FactoryWorkspaceCheckpoints, "checkpoint">;
}

/**
 * The production implementation of the native runner's artifact seam.
 *
 * It exists over exactly the services the sandboxed path uses: one
 * candidate-output writer and W04's workspace-checkpoint material writer. An
 * in-process attempt and a guest in a container therefore produce the same two
 * durable artifacts by the same rules, which is the point of the seam — a
 * second implementation here would be a second answer to "what is a candidate
 * output", and the validators read only one.
 *
 * The checkpoint's cursor is the attempt's next operation index, because
 * `validateFactoryRunnerResult` requires a completed operation's checkpoint to
 * equal its operation index exactly.
 */
export function createNativeFactoryArtifacts(options: NativeFactoryArtifactsOptions): NativeFactoryArtifacts {
  return Object.freeze({
    async output(request: FactoryRunnerRequest, run: AgentRun): Promise<FactoryArtifactReference> {
      return options.output(factoryRunnerRequestAuthority(request), artifactJson.canonical(nativeFactoryOutputValue(run)));
    },
    async checkpoint(request: FactoryRunnerRequest, run: AgentRun): Promise<FactoryCheckpointReference> {
      const attempt = factoryRunnerRequestAuthority(request);
      const operationIndex = request.authority.nextOperationIndex;
      return options.checkpoints.checkpoint({
        operationId: `${attempt.runId}:${attempt.nodeInstanceId}:${attempt.candidateGeneration}:${operationIndex}`,
        operationIndex,
        attempt,
        result: { schemaVersion: "factory.native-checkpoint.v1", runId: run.id, output: nativeFactoryOutputValue(run) } as JsonValue,
      });
    },
  });
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
  const request = JSON.parse(canonicalJson(value)) as FactoryRunnerRequest;
  const execution = options.execution(request);
  if (execution.attempt.requestDigest !== factoryRunnerRequestDigest(request)
    || execution.attempt.attemptToken !== request.broker.attemptToken
    || execution.attempt.runId !== request.authority.runId
    || execution.attempt.nodeInstanceId !== request.authority.nodeInstanceId
    || execution.attempt.candidateGeneration !== request.authority.candidateGeneration
    || execution.attempt.cancellationEpoch !== request.authority.cancellationEpoch
    || execution.attempt.nextOperationIndex !== request.authority.nextOperationIndex
    || request.model !== undefined && (execution.model.provider !== request.model.provider || execution.model.id !== request.model.model)) {
    throw new Error("Factory execution does not match the signed runner request.");
  }
  const run = await options.executor.executeFactoryAttempt({ ...options.conversation(request), execution });
  const { journalCursor, operations, usage } = await options.journal.snapshot(request);
  if (run.status === "cancelled") {
    const result: FactoryRunnerResult = { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor, operations: [...operations], ...(usage ? { usage } : {}) };
    requireValid(validateFactoryRunnerResult(result), "Factory runner result");
    return result;
  }
  if (run.status !== "success") {
    const error = typeof run.result?.error === "string" ? run.result.error : run.result?.error?.message ?? "Factory agent did not complete.";
    const result: FactoryRunnerResult = { schemaVersion: "factory.runner.result.v1", status: "failed", journalCursor, operations: [...operations], resultDigest: digest({ error }), error: { code: "FACTORY_AGENT_FAILED", message: error, retryable: false }, ...(usage ? { usage } : {}) };
    requireValid(validateFactoryRunnerResult(result), "Factory runner result");
    return result;
  }
  if (usage?.kind !== "measured") throw new Error("A completed native runner needs durable measured usage.");
  const [output, workspaceCheckpoint] = await Promise.all([options.artifacts.output(request, run), options.artifacts.checkpoint(request, run)]);
  const outputValue = nativeFactoryOutputValue(run);
  const result: FactoryRunnerResult = {
    schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor,
    operations: [...operations], resultDigest: digest(outputValue), output, usage, workspaceCheckpoint,
  };
  requireValid(validateFactoryRunnerResult(result), "Factory runner result");
  return result;
}

export type { FactoryUsage };

function operationUsage(operations: readonly FactoryRunnerOperationResult[]): FactoryUsage | undefined {
  if (operations.length === 0) return undefined;
  const usage = operations.map(operation => operation.usage).filter((value): value is FactoryUsage => value !== undefined);
  if (usage.length !== operations.length) throw new Error("Durable operation usage is unavailable.");
  const held = usage.reduce((total, value) => total + BigInt(value.kind === "measured" ? value.costMicros : value.heldCostMicros), 0n).toString();
  if (usage.some(value => value.kind === "unknown")) return { kind: "unknown", reason: "durable operation usage is incomplete", heldCostMicros: held };
  const measured = usage as Extract<FactoryUsage, { kind: "measured" }>[];
  return { kind: "measured", inputTokens: measured.reduce((total, value) => total + value.inputTokens, 0), outputTokens: measured.reduce((total, value) => total + value.outputTokens, 0), computeMs: measured.reduce((total, value) => total + value.computeMs, 0), costMicros: held };
}
