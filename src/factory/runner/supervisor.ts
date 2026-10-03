import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "@ezcorp/extension-contract";
import type { Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { executionLimits } from "@ezcorp/extension-runner";
import type { FactoryCheckpointReference } from "@ezcorp/factory-sdk";
import type { FactoryExecutionJournal, FactoryAttemptAuthority, FactoryJournalOperation } from "../executions";
import { FACTORY_GUEST_TOOL_METHOD, factoryGuestFrameInput } from "./guest-frames";

/**
 * Writes one workspace checkpoint and returns the durable reference the journal
 * records. `operationIndex` is supplied so an implementer never has to parse it
 * back out of `operationId`: a completed operation's checkpoint cursor must
 * equal its index, which the SDK result validator enforces.
 */
export interface FactoryWorkspaceCheckpoint {
  checkpoint(input: { operationId: string; operationIndex: number; attempt: FactoryAttemptAuthority; result: JsonValue }): Promise<FactoryCheckpointReference>;
}

/** Internal single-tool adapter. The C02 runner wire is FactoryRunnerRequest in factory-sdk. */
export interface FactoryToolInvocation {
  authority: FactoryAttemptAuthority;
  artifactDigest: string;
  operationIndex: number;
  toolName: string;
  toolInput: JsonValue;
  workspace: FactoryWorkspaceCheckpoint;
  /**
   * Exactly the devices the held allocation authorized for this invocation.
   * Absent means none: a factory start never inherits the host's global device
   * list, whatever that host configures.
   */
  devices?: readonly string[];
}

export interface FactoryRunnerSupervisorOptions {
  runner: Runner;
  journal: FactoryExecutionJournal;
  authorizeAttempt(authority: FactoryAttemptAuthority): Promise<void>;
  /** The gateway owns this broker callback; the supervisor never owns tenant credentials. */
  invokeTool(input: JsonValue): Promise<JsonValue>;
  /** Injected so a tool operation records real elapsed compute rather than a constant. */
  now?(): number;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function operation(input: FactoryToolInvocation): FactoryJournalOperation {
  const { authority } = input;
  return { operationId: `${authority.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:${input.operationIndex}`, operationIndex: input.operationIndex, kind: "tool", requestDigest: digest({ artifactDigest: input.artifactDigest, toolName: input.toolName, toolInput: input.toolInput }) };
}

function context(input: FactoryToolInvocation) {
  const workerId = `factory_${digest(`${input.authority.attemptId}:${input.operationIndex}`).slice(0, 48)}`;
  const invocationId = `factory_${digest(`${input.authority.attemptId}:${input.operationIndex}:invocation`).slice(0, 48)}`;
  return { workerId, invocationId, releaseId: input.artifactDigest, principalId: input.authority.tenantId, scopeId: input.authority.projectId, token: `factory-runner:${input.authority.attemptId}`, deadline: input.authority.deadlineAt.getTime() };
}

/**
 * Runs a v4 artifact through its existing immutable recipe and Podman runner.
 * The artifact receives only an opaque local context token; it never receives
 * a tenant service credential or a provider API key.
 */
export class FactoryRunnerSupervisor {
  private readonly active = new Map<string, RunnerExecution>();
  private readonly now: () => number;

  constructor(private readonly options: FactoryRunnerSupervisorOptions) { this.now = options.now ? () => options.now!() : Date.now; }

  async invoke(input: FactoryToolInvocation): Promise<{ claimed: boolean; result?: JsonValue }> {
    if (!Number.isSafeInteger(input.operationIndex) || input.operationIndex < 0 || !input.toolName) throw new Error("Factory runner request is malformed.");
    await this.options.authorizeAttempt(input.authority);
    const operationEntry = operation(input);
    await this.options.journal.prepare(input.authority, operationEntry);
    const invocation = context(input);
    const previous = await this.options.journal.operation(input.authority, operationEntry.operationId);
    if (previous.state === "completed") return { claimed: false, result: previous.result };
    if (previous.state === "dispatched" || previous.state === "uncertain") throw new Error("Factory effect outcome is uncertain and requires reconciliation.");
    if (previous.state === "failed") throw new Error("Factory effect previously failed.");
    let worker: RunnerExecution | undefined;
    let effectClaimed = false;
    try {
      worker = await this.worker(input, invocation, this.reverse(input, invocation, operationEntry, () => { effectClaimed = true; }));
      this.active.set(input.authority.attemptId, worker);
      const startedAtMs = this.now();
      const result = await worker.request("extension/invoke", { name: input.toolName, input: input.toolInput, context: invocation }) as JsonValue;
      if (!effectClaimed) throw new Error("Factory runner returned before its tool effect dispatched.");
      const checkpoint = await input.workspace.checkpoint({ operationId: operationEntry.operationId, operationIndex: operationEntry.operationIndex, attempt: input.authority, result });
      // A local tool consumes no provider tokens and carries no provider cost,
      // so its measured usage is its real elapsed compute and an explicit zero.
      const usage = { kind: "measured" as const, inputTokens: 0, outputTokens: 0, computeMs: Math.max(0, this.now() - startedAtMs), costMicros: "0" };
      await this.options.journal.settle(input.authority, operationEntry.operationId, "completed", { resultDigest: digest(result), result, usage, workspaceCheckpoint: checkpoint });
      return { claimed: true, result };
    } finally {
      this.active.delete(input.authority.attemptId);
      await worker?.close();
    }
  }

  private async worker(input: FactoryToolInvocation, invocation: ReturnType<typeof context>, reverse: (method: string, raw: unknown) => Promise<unknown>): Promise<RunnerExecution> {
    const inspection = await this.options.runner.inspect(invocation.workerId);
    if (inspection.state === "running") {
      if (!this.options.runner.attach) throw new Error("Factory runner cannot reattach to a surviving worker.");
      return this.options.runner.attach({ workerId: invocation.workerId, artifactDigest: input.artifactDigest, context: invocation, limits: executionLimits, devices: input.devices ?? [] }, reverse);
    }
    if (inspection.state !== "unknown") throw new Error("Factory worker is stopped and cannot be restarted by recovery.");
    return this.options.runner.start({ workerId: invocation.workerId, artifactDigest: input.artifactDigest, context: invocation, limits: executionLimits, devices: input.devices ?? [] }, reverse);
  }

  private reverse(input: FactoryToolInvocation, invocation: ReturnType<typeof context>, operationEntry: FactoryJournalOperation, onClaim: () => void): (method: string, raw: unknown) => Promise<unknown> {
    return async (method, raw) => {
      const authorizedInput = factoryGuestFrameInput(method, raw, invocation, FACTORY_GUEST_TOOL_METHOD);
      if (canonicalJson(authorizedInput) !== canonicalJson(input.toolInput)) throw new Error("Factory runner tool input does not match its prepared operation.");
      await this.options.authorizeAttempt(input.authority);
      const claim = await this.options.journal.dispatch(input.authority, operationEntry.operationId);
      if (!claim.claimed) {
        const previous = await this.options.journal.operation(input.authority, operationEntry.operationId);
        if (previous.state === "completed") return previous.result;
        throw new Error("Factory effect outcome is uncertain and requires reconciliation.");
      }
      onClaim();
      try {
        const result = await this.options.invokeTool(authorizedInput);
        return result;
      } catch (error) {
        const result = { code: "factory_tool_failed", message: error instanceof Error ? error.message.slice(0, 4096) : "Factory tool failed." } as const;
        try {
          await this.options.journal.settle(input.authority, operationEntry.operationId, "failed", { resultDigest: digest(result), result });
        } catch (settlementError) {
          throw new AggregateError([error, settlementError], "Factory tool failed and its durable settlement failed.");
        }
        throw error;
      }
    };
  }

  async stop(attemptId: string): Promise<void> {
    await this.active.get(attemptId)?.close();
  }
}
