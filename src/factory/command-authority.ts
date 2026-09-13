import { nodeFor } from "@ezcorp/factory-sdk/kernel";
import type { ApprovalNode, CompiledFactory, FactoryNode, KernelAttempt, KernelCommand, KernelState, SubfactoryNode, TaskNode } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryPrincipal } from "./grants";
import { assertFactoryIdentity } from "./records";
import type { FactoryRunFence, FactoryRunLifecycle } from "./run-lifecycle";
import { verifyFactoryChildBinding, type FactoryChildBindingRow } from "./child-runs";
import type { FactoryTransitionArtifacts } from "./transition-artifacts";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

type ExecutionCommand = Extract<KernelCommand, { kind: "request-admission" | "dispatch-node" }>;
type ChildCommand = Extract<KernelCommand, { kind: "run-child" }>;
type InputCommand = Extract<KernelCommand, { kind: "read-input-value" | "read-input-page" }>;
type ApprovalCommand = Extract<KernelCommand, { kind: "request-approval" }>;
type ApprovalWork<Result> = (transaction: MigrationDb, context: FactoryAuthorizedApprovalCommand) => Promise<Result>;
interface Head { source_sequence: number | string; digest: string }
interface CommittedCommand<Command extends KernelCommand> {
  readonly command: Command;
  readonly sourceSequence: number;
  readonly commandDigest: string;
  readonly compiled: CompiledFactory;
  readonly state: KernelState;
  readonly fence: FactoryRunFence;
  readonly initiator: FactoryPrincipal;
}

export interface FactoryAuthorizedCommand extends CommittedCommand<ExecutionCommand> {
  readonly node: TaskNode;
}

export interface FactoryAuthorizedChildCommand extends Omit<FactoryAuthorizedCommand, "command" | "node"> {
  readonly command: ChildCommand;
  readonly node: SubfactoryNode;
}

export interface FactoryAuthorizedInputCommand extends Omit<FactoryAuthorizedCommand, "command" | "node"> {
  readonly command: InputCommand;
}

export interface FactoryAuthorizedApprovalCommand extends Omit<FactoryAuthorizedCommand, "command" | "node"> {
  readonly command: ApprovalCommand;
  readonly node: ApprovalNode;
  readonly attempt: KernelAttempt;
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

  /** Receipt recovery checks service identity without admitting a superseded command again. */
  assertService(service: TrustedFactoryServiceIdentity): void {
    assertFactoryIdentity(service.tenantId, service.subject);
    if (service.tenantId !== this.tenantId || !this.subjects.has(service.subject)) throw new FactoryCommandAuthorityError("factory_command_forbidden");
  }

  async withCurrent<Result>(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, work: (transaction: MigrationDb, context: FactoryAuthorizedCommand) => Promise<Result>): Promise<Result> {
    return this.withCommitted(service, value, (command): command is ExecutionCommand => command.kind === "request-admission" || command.kind === "dispatch-node", async (transaction, context) => {
      const node = this.attemptNode(context, "task");
      return work(transaction, { ...context, node });
    });
  }

  async withCurrentChild<Result>(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, work: (transaction: MigrationDb, context: FactoryAuthorizedChildCommand) => Promise<Result>): Promise<Result> {
    return this.withCommitted(service, value, (command): command is ChildCommand => command.kind === "run-child", async (transaction, context) => {
      const node = this.attemptNode(context, "subfactory");
      const expected = node.factory;
      const actual = context.command.factory;
      if (actual.id !== expected.id || actual.version !== expected.version || actual.digest !== expected.digest) throw new FactoryCommandAuthorityError("factory_command_stale");
      return work(transaction, { ...context, node });
    });
  }

  async withCurrentInput<Result>(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, work: (transaction: MigrationDb, context: FactoryAuthorizedInputCommand) => Promise<Result>): Promise<Result> {
    return this.withCommitted(service, value, (command): command is InputCommand => command.kind === "read-input-value" || command.kind === "read-input-page", async (transaction, context) => {
      const { command, compiled, state, fence } = context;
      const runtime = Object.hasOwn(state.nodes, command.nodeId) ? state.nodes[command.nodeId] : undefined;
      const entries = state.lazyInput?.pending;
      const pending = entries && Object.hasOwn(entries, command.id) ? entries[command.id] : undefined;
      const { id: _id, kind, ...coordinates } = command;
      const expected = { ...coordinates, kind: kind === "read-input-value" ? "value" : "page" };
      if (!nodeFor(compiled, command.nodeId) || !runtime || runtime.status !== "waiting" || runtime.waitingReason !== "external_reconciliation" || runtime.candidateGeneration !== command.candidateGeneration || command.cancellationEpoch !== fence.cancellationEpoch || fence.deadlineAtMs <= this.now() || !pending || digestObject(pending) !== digestObject(expected)) throw new FactoryCommandAuthorityError("factory_command_stale");
      return work(transaction, context);
    });
  }

  withCurrentApproval<Result>(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, work: ApprovalWork<Result>): Promise<Result> {
    return this.approval(service, value, work);
  }

  withCurrentApprovalInTransaction<Result>(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, work: ApprovalWork<Result>): Promise<Result> {
    return this.approval(service, value, work, transaction);
  }

  private approval<Result>(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, work: ApprovalWork<Result>, transaction?: MigrationDb): Promise<Result> {
    return this.withCommitted(service, value, (command): command is ApprovalCommand => command.kind === "request-approval", async (database, context) => {
      const node = this.attemptNode(context, "approval");
      const runtime = context.state.nodes[context.command.nodeId]!;
      const attempt = runtime.attempts.at(-1)!;
      if (runtime.waitingReason !== "approval" || runtime.waitingDeadlineAtMs !== context.command.deadlineAtMs || node.actorScope !== context.command.actorScope || digestObject(node.choices) !== digestObject(context.command.choices) || context.command.deadlineAtMs > attempt.startedAtMs + Math.min(node.expiresInMs, 24 * 60 * 60 * 1_000)) throw new FactoryCommandAuthorityError("factory_command_stale");
      return work(database, { ...context, node, attempt });
    }, transaction);
  }

  private async withCommitted<Command extends KernelCommand, Result>(service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, accepts: (command: KernelCommand) => command is Command, work: (transaction: MigrationDb, context: CommittedCommand<Command>) => Promise<Result>, suppliedTransaction?: MigrationDb): Promise<Result> {
    const reference = Object.freeze({ tenantId: value.tenantId, projectId: value.projectId, logicalRunId: value.logicalRunId, interpreterId: value.interpreterId, commandId: value.commandId });
    assertFactoryIdentity(...Object.values(reference));
    this.assertService(service);
    if (reference.tenantId !== this.tenantId) throw new FactoryCommandAuthorityError("factory_command_forbidden");
    const stored = await this.transitions.loadStoredCommandEntry(reference, suppliedTransaction);
    const command = stored.command;
    if (!accepts(command)) throw new FactoryCommandAuthorityError("factory_command_forbidden");
    const head = await this.head(suppliedTransaction ?? this.database, reference);
    const transition = await this.transitions.loadCommittedTransition(reference, Number(head.source_sequence), suppliedTransaction);
    // Transition reads finish before the transaction. The run lock and exact head
    // comparison below close the race with a concurrently committed transition.
    const apply = async (transaction: MigrationDb): Promise<Result> => {
      const { fence, compiled, initiator } = await this.lifecycle.readExecutionPlanInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId });
      await this.assertLiveAncestors(transaction, reference.projectId, reference.logicalRunId, new Set());
      const current = await this.head(transaction, reference);
      if (Number(current.source_sequence) !== Number(head.source_sequence) || current.digest !== head.digest) throw new FactoryCommandAuthorityError("factory_command_stale");
      const state = transition.nextState;
      if (state.logicalRunId !== reference.logicalRunId || state.definitionDigest !== fence.definitionDigest || state.runDeadlineAtMs !== fence.deadlineAtMs || state.cancellationEpoch !== fence.cancellationEpoch || !["running", "waiting"].includes(state.status)) throw new FactoryCommandAuthorityError("factory_command_stale");
      return work(transaction, { command, sourceSequence: stored.sourceSequence, commandDigest: stored.commandDigest, compiled, state, fence, initiator });
    };
    return suppliedTransaction ? apply(suppliedTransaction) : this.database.transaction(apply);
  }

  private attemptNode<Kind extends "task" | "subfactory" | "approval">({ command, compiled, state, fence }: CommittedCommand<ExecutionCommand | ChildCommand | ApprovalCommand>, kind: Kind): Extract<FactoryNode, { kind: Kind }> {
    const node = nodeFor(compiled, command.nodeId);
    const runtime = Object.hasOwn(state.nodes, command.nodeId) ? state.nodes[command.nodeId] : undefined;
    const attempt = runtime?.attempts.at(-1);
    const generation = "candidateGeneration" in command ? command.candidateGeneration : runtime?.candidateGeneration;
    const expectedStatus = command.kind === "request-admission" ? "reserved" : command.kind === "dispatch-node" ? "running" : "waiting";
    if (node?.kind !== kind || !runtime || !attempt || !Number.isSafeInteger(generation) || runtime.candidateGeneration !== generation || attempt.candidateGeneration !== generation || attempt.commandId !== command.id || attempt.stopped || attempt.uncertain || attempt.deadlineAtMs !== command.deadlineAtMs || !Number.isSafeInteger(command.deadlineAtMs) || command.deadlineAtMs <= this.now() || command.deadlineAtMs > fence.deadlineAtMs || runtime.status !== expectedStatus || (command.kind === "dispatch-node" && (command.attempt !== attempt.attempt || command.cancellationEpoch !== fence.cancellationEpoch))) throw new FactoryCommandAuthorityError("factory_command_stale");
    return node as Extract<FactoryNode, { kind: Kind }>;
  }

  /** A child command remains live only while every sealed parent attempt remains current. */
  private async assertLiveAncestors(transaction: MigrationDb, projectId: string, runId: string, visited: Set<string>): Promise<void> {
    if (visited.size >= 16 || visited.has(runId)) throw new FactoryCommandAuthorityError("factory_command_corrupt");
    visited.add(runId);
    const binding = rows<FactoryChildBindingRow>(await transaction.execute(sql`SELECT parent_run_id,parent_interpreter_id,parent_command_id,parent_source_sequence,parent_command_digest,child_run_id,parent_envelope_id,child_envelope_id,child_factory_id,child_factory_version,child_definition_digest,definition_json,started_ms,parent_execution_epoch,parent_cancellation_epoch,parent_grant_revision,deadline_ms,binding_digest,state FROM factory_child_runs WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND child_run_id=${runId}`))[0];
    if (!binding) return;
    try { verifyFactoryChildBinding(binding); }
    catch { throw new FactoryCommandAuthorityError("factory_command_corrupt"); }
    const parent = { tenantId: this.tenantId, projectId, logicalRunId: binding.parent_run_id, interpreterId: binding.parent_interpreter_id, commandId: binding.parent_command_id };
    const [stored, plan] = await Promise.all([
      this.transitions.loadStoredCommandEntry(parent, transaction),
      this.lifecycle.readExecutionPlanInTransaction(transaction, { projectId, runId: binding.parent_run_id }),
    ]);
    if (stored.sourceSequence !== Number(binding.parent_source_sequence) || stored.commandDigest !== binding.parent_command_digest || stored.command.kind !== "run-child") throw new FactoryCommandAuthorityError("factory_command_stale");
    const before = await this.head(transaction, parent);
    const transition = await this.transitions.loadCommittedTransition(parent, Number(before.source_sequence), transaction);
    const current = await this.head(transaction, parent);
    if (current.digest !== before.digest || Number(current.source_sequence) !== Number(before.source_sequence)) throw new FactoryCommandAuthorityError("factory_command_stale");
    const state = transition.nextState;
    if (state.logicalRunId !== parent.logicalRunId || state.definitionDigest !== plan.fence.definitionDigest || state.runDeadlineAtMs !== plan.fence.deadlineAtMs || state.cancellationEpoch !== plan.fence.cancellationEpoch || !["running", "waiting"].includes(state.status)) throw new FactoryCommandAuthorityError("factory_command_stale");
    const node = this.attemptNode({ command: stored.command, sourceSequence: stored.sourceSequence, commandDigest: stored.commandDigest, compiled: plan.compiled, state, fence: plan.fence, initiator: plan.initiator }, "subfactory");
    if (node.factory.id !== stored.command.factory.id || node.factory.version !== stored.command.factory.version || node.factory.digest !== stored.command.factory.digest) throw new FactoryCommandAuthorityError("factory_command_stale");
    await this.assertLiveAncestors(transaction, projectId, binding.parent_run_id, visited);
  }

  private async head(database: MigrationDb, reference: TrustedFactoryCommandReference): Promise<Head> {
    const result = rows<Head>(await database.execute(sql`SELECT source_sequence,digest FROM factory_audit_batches WHERE tenant_id=${this.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} ORDER BY source_sequence DESC LIMIT 1`))[0];
    if (!result || !Number.isSafeInteger(Number(result.source_sequence)) || Number(result.source_sequence) < 1 || !/^[a-f0-9]{64}$/.test(result.digest)) throw new FactoryCommandAuthorityError("factory_command_corrupt");
    return result;
  }
}
