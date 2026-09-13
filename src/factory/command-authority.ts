import { nodeFor } from "@ezcorp/factory-sdk/kernel";
import type { KernelCommand, KernelState, TaskNode } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { assertFactoryIdentity } from "./records";
import type { FactoryRunFence, FactoryRunLifecycle } from "./run-lifecycle";
import type { FactoryTransitionArtifacts } from "./transition-artifacts";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

type ExecutionCommand = Extract<KernelCommand, { kind: "request-admission" | "dispatch-node" }>;
interface Head { source_sequence: number | string; digest: string }

export interface FactoryAuthorizedCommand {
  readonly command: ExecutionCommand;
  readonly node: TaskNode;
  readonly state: KernelState;
  readonly fence: FactoryRunFence;
}

export class FactoryCommandAuthorityError extends Error {
  constructor(readonly code: "factory_command_forbidden" | "factory_command_stale" | "factory_command_corrupt") { super(code); this.name = "FactoryCommandAuthorityError"; }
}

/** A transport reference can act only on the latest committed interpreter state. */
export class FactoryCommandAuthority {
  private readonly subjects: ReadonlySet<string>;

  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly lifecycle: FactoryRunLifecycle, private readonly transitions: FactoryTransitionArtifacts, subjects: Iterable<string>, private readonly now: () => number = Date.now) {
    assertFactoryIdentity(tenantId);
    const captured = new Set(subjects);
    if (captured.size === 0 || lifecycle.tenantId !== tenantId) throw new FactoryCommandAuthorityError("factory_command_forbidden");
    for (const subject of captured) assertFactoryIdentity(subject);
    this.subjects = captured;
  }

  async withCurrent<Result>(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, work: (transaction: MigrationDb, context: FactoryAuthorizedCommand) => Promise<Result>): Promise<Result> {
    const reference = Object.freeze({ tenantId: value.tenantId, projectId: value.projectId, logicalRunId: value.logicalRunId, interpreterId: value.interpreterId, commandId: value.commandId });
    assertFactoryIdentity(...Object.values(reference));
    if (service.tenantId !== this.tenantId || reference.tenantId !== this.tenantId || !this.subjects.has(service.subject)) throw new FactoryCommandAuthorityError("factory_command_forbidden");
    const command = await this.transitions.loadStoredCommand(reference);
    if (command.kind !== "request-admission" && command.kind !== "dispatch-node") throw new FactoryCommandAuthorityError("factory_command_forbidden");
    const head = await this.head(this.database, reference);
    const transition = await this.transitions.loadCommittedTransition(reference, Number(head.source_sequence));
    // Transition reads finish before the transaction. The run lock and exact head
    // comparison below close the race with a concurrently committed transition.
    return this.database.transaction(async transaction => {
      const { fence, compiled } = await this.lifecycle.readExecutionPlanInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId });
      const current = await this.head(transaction, reference);
      if (Number(current.source_sequence) !== Number(head.source_sequence) || current.digest !== head.digest) throw new FactoryCommandAuthorityError("factory_command_stale");
      const state = transition.nextState;
      if (state.logicalRunId !== reference.logicalRunId || state.definitionDigest !== fence.definitionDigest || state.runDeadlineAtMs !== fence.deadlineAtMs || state.cancellationEpoch !== fence.cancellationEpoch || !["running", "waiting"].includes(state.status)) throw new FactoryCommandAuthorityError("factory_command_stale");
      const node = nodeFor(compiled, command.nodeId);
      const runtime = Object.hasOwn(state.nodes, command.nodeId) ? state.nodes[command.nodeId] : undefined;
      const attempt = runtime?.attempts.at(-1);
      if (node?.kind !== "task" || !runtime || !attempt || runtime.candidateGeneration !== command.candidateGeneration || attempt.candidateGeneration !== command.candidateGeneration || attempt.commandId !== command.id || attempt.stopped || attempt.uncertain || attempt.deadlineAtMs !== command.deadlineAtMs || !Number.isSafeInteger(command.deadlineAtMs) || command.deadlineAtMs <= this.now() || command.deadlineAtMs > fence.deadlineAtMs || runtime.status !== (command.kind === "request-admission" ? "reserved" : "running") || (command.kind === "dispatch-node" && (command.attempt !== attempt.attempt || command.cancellationEpoch !== fence.cancellationEpoch))) throw new FactoryCommandAuthorityError("factory_command_stale");
      return work(transaction, { command, node, state, fence });
    });
  }

  private async head(database: MigrationDb, reference: TrustedFactoryCommandReference): Promise<Head> {
    const result = rows<Head>(await database.execute(sql`SELECT source_sequence,digest FROM factory_audit_batches WHERE tenant_id=${this.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} ORDER BY source_sequence DESC LIMIT 1`))[0];
    if (!result || !Number.isSafeInteger(Number(result.source_sequence)) || Number(result.source_sequence) < 1 || !/^[a-f0-9]{64}$/.test(result.digest)) throw new FactoryCommandAuthorityError("factory_command_corrupt");
    return result;
  }
}
