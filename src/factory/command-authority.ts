import { nodeFor } from "@ezcorp/factory-sdk/kernel";
import type { ApprovalNode, CompiledFactory, FactoryNode, KernelAttempt, KernelCommand, KernelState, SubfactoryNode, TaskNode } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryPrincipal } from "./grants";
import { assertFactoryIdentity } from "./records";
import type { FactoryRunFence, FactoryRunLifecycle } from "./run-lifecycle";
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

export type FactoryCurrentApprovalFence = Readonly<{
  nodeInstanceId: string;
  candidateGeneration: number;
  attempt: number;
  definitionDigest: string;
  executionEpoch: number;
  cancellationEpoch: number;
  initiator: { kind: FactoryPrincipal["kind"]; id: string };
  actorScope: ApprovalNode["actorScope"];
  choices: readonly string[];
  context: import("@ezcorp/factory-sdk").JsonValue;
  deadlineAtMs: number;
}>;

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

  /** Checks a stored human approval against the current waiting attempt, even if unrelated transitions advanced the interpreter head. */
  assertCurrentApprovalInTransaction(transaction: MigrationDb, service: TrustedFactoryServiceIdentity, value: TrustedFactoryCommandReference, expected: FactoryCurrentApprovalFence): Promise<void> {
    return this.withCurrentApprovalInTransaction(transaction, service, value, async (_database, current) => {
      const actual: FactoryCurrentApprovalFence = {
        nodeInstanceId: current.command.nodeId,
        candidateGeneration: current.attempt.candidateGeneration,
        attempt: current.attempt.attempt,
        definitionDigest: current.compiled.digest,
        executionEpoch: current.fence.executionEpoch,
        cancellationEpoch: current.fence.cancellationEpoch,
        initiator: { kind: current.initiator.kind, id: current.initiator.id },
        actorScope: current.command.actorScope,
        choices: current.command.choices,
        context: current.command.context,
        deadlineAtMs: current.command.deadlineAtMs,
      };
      if (digestObject(actual) !== digestObject(expected)) throw new FactoryCommandAuthorityError("factory_command_stale");
    });
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
    const command = await this.transitions.loadStoredCommand(reference, suppliedTransaction);
    if (!accepts(command)) throw new FactoryCommandAuthorityError("factory_command_forbidden");
    const head = await this.head(suppliedTransaction ?? this.database, reference);
    const transition = await this.transitions.loadCommittedTransition(reference, Number(head.source_sequence), suppliedTransaction);
    // Transition reads finish before the transaction. The run lock and exact head
    // comparison below close the race with a concurrently committed transition.
    const apply = async (transaction: MigrationDb): Promise<Result> => {
      const { fence, compiled, initiator } = await this.lifecycle.readExecutionPlanInTransaction(transaction, { projectId: reference.projectId, runId: reference.logicalRunId });
      const current = await this.head(transaction, reference);
      if (Number(current.source_sequence) !== Number(head.source_sequence) || current.digest !== head.digest) throw new FactoryCommandAuthorityError("factory_command_stale");
      const state = transition.nextState;
      if (state.logicalRunId !== reference.logicalRunId || state.definitionDigest !== fence.definitionDigest || state.runDeadlineAtMs !== fence.deadlineAtMs || state.cancellationEpoch !== fence.cancellationEpoch || !["running", "waiting"].includes(state.status)) throw new FactoryCommandAuthorityError("factory_command_stale");
      return work(transaction, { command, compiled, state, fence, initiator });
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

  private async head(database: MigrationDb, reference: TrustedFactoryCommandReference): Promise<Head> {
    const result = rows<Head>(await database.execute(sql`SELECT source_sequence,digest FROM factory_audit_batches WHERE tenant_id=${this.tenantId} AND project_id=${reference.projectId} AND run_id=${reference.logicalRunId} AND interpreter_id=${reference.interpreterId} ORDER BY source_sequence DESC LIMIT 1`))[0];
    if (!result || !Number.isSafeInteger(Number(result.source_sequence)) || Number(result.source_sequence) < 1 || !/^[a-f0-9]{64}$/.test(result.digest)) throw new FactoryCommandAuthorityError("factory_command_corrupt");
    return result;
  }
}
