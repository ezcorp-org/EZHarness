import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, type JsonValue } from "@ezcorp/extension-contract";
import type { Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { executionLimits } from "@ezcorp/extension-runner";
import type { FactoryExecutionJournal, FactoryAttemptAuthority, FactoryJournalOperation } from "../executions";

export interface FactoryWorkspaceCheckpoint {
  checkpoint(input: { operationId: string; result: JsonValue }): Promise<JsonValue>;
}

export interface FactoryRunnerRequest {
  authority: FactoryAttemptAuthority;
  artifactDigest: string;
  operationIndex: number;
  toolName: string;
  toolInput: JsonValue;
  workspace: FactoryWorkspaceCheckpoint;
}

export interface FactoryRunnerSupervisorOptions {
  runner: Runner;
  journal: FactoryExecutionJournal;
  authorizeAttempt(authority: FactoryAttemptAuthority): Promise<void>;
  /** The gateway owns this broker callback; the supervisor never owns tenant credentials. */
  invokeTool(input: JsonValue): Promise<JsonValue>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function operation(input: FactoryRunnerRequest): FactoryJournalOperation {
  const { authority } = input;
  return { operationId: `${authority.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:${input.operationIndex}`, operationIndex: input.operationIndex, kind: "tool", requestDigest: digest({ artifactDigest: input.artifactDigest, toolName: input.toolName, toolInput: input.toolInput }) };
}

function context(input: FactoryRunnerRequest) {
  const workerId = `factory_${digest(`${input.authority.attemptId}:${input.operationIndex}`).slice(0, 48)}`;
  return { workerId, invocationId: randomUUID(), releaseId: input.artifactDigest, principalId: input.authority.tenantId, scopeId: input.authority.projectId, token: `factory-runner:${input.authority.attemptId}`, deadline: input.authority.deadlineAt.getTime() };
}

function reverseEnvelope(value: unknown, expected: ReturnType<typeof context>): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Factory runner sent an invalid tool envelope.");
  const envelope = value as { context?: unknown; input?: unknown };
  if (canonicalJson(envelope.context) !== canonicalJson(expected) || envelope.input === undefined) throw new Error("Factory runner tool context does not match its attempt.");
  return envelope.input as JsonValue;
}

/**
 * Runs a v4 artifact through its existing immutable recipe and Podman runner.
 * The artifact receives only an opaque local context token; it never receives
 * a tenant service credential or a provider API key.
 */
export class FactoryRunnerSupervisor {
  private readonly active = new Map<string, RunnerExecution>();

  constructor(private readonly options: FactoryRunnerSupervisorOptions) {}

  async invoke(input: FactoryRunnerRequest): Promise<{ claimed: boolean; result?: JsonValue }> {
    if (!Number.isSafeInteger(input.operationIndex) || input.operationIndex < 0 || !input.toolName) throw new Error("Factory runner request is malformed.");
    await this.options.authorizeAttempt(input.authority);
    const operationEntry = operation(input);
    await this.options.journal.admit({ ...input.authority, request: { artifactDigest: input.artifactDigest, toolName: input.toolName, toolInput: input.toolInput } });
    await this.options.journal.prepare(input.authority, operationEntry);
    const claim = await this.options.journal.dispatch(input.authority, operationEntry.operationId);
    if (!claim.claimed) return claim;
    const invocation = context(input);
    let worker: RunnerExecution | undefined;
    try {
      worker = await this.options.runner.start({ workerId: invocation.workerId, artifactDigest: input.artifactDigest, context: invocation, limits: executionLimits }, async (method, raw) => {
        if (method !== "factory.tool") throw new Error("Factory runner capability is denied.");
        return this.options.invokeTool(reverseEnvelope(raw, invocation));
      });
      this.active.set(input.authority.attemptId, worker);
      const result = await worker.request("extension/invoke", { name: input.toolName, input: input.toolInput, context: invocation }) as JsonValue;
      const checkpoint = await input.workspace.checkpoint({ operationId: operationEntry.operationId, result });
      await this.options.journal.settle(input.authority, operationEntry.operationId, "completed", { resultDigest: digest(result), usage: {}, workspaceCheckpoint: checkpoint });
      return { claimed: true, result };
    } catch (error) {
      await this.options.journal.settle(input.authority, operationEntry.operationId, "failed", { resultDigest: digest(error instanceof Error ? { name: error.name, message: error.message } : String(error)) }).catch(() => undefined);
      throw error;
    } finally {
      this.active.delete(input.authority.attemptId);
      await worker?.close();
    }
  }

  async stop(attemptId: string): Promise<void> {
    await this.active.get(attemptId)?.close();
  }
}
