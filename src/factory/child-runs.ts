import type { FactoryReference } from "@ezcorp/factory-sdk";
import { factoryChildRunId } from "@ezcorp/factory-sdk/transport-types";
import { sql } from "drizzle-orm";
import type { FactoryDefinitionSource, FactoryIdentity } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryCommandAuthority, FactoryAuthorizedChildCommand } from "./command-authority";
import type { FactoryRunLifecycle } from "./run-lifecycle";
import type { FactoryTransitionArtifacts } from "./transition-artifacts";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

export interface FactoryChildRunRequest extends TrustedFactoryCommandReference {
  readonly factory: FactoryReference;
}

export interface FactoryChildBindingRow {
  parent_run_id: string;
  parent_interpreter_id: string;
  parent_command_id: string;
  parent_source_sequence: number | string;
  parent_command_digest: string;
  child_run_id: string;
  parent_envelope_id: string;
  child_envelope_id: string;
  child_factory_id: string;
  child_factory_version: string;
  child_definition_digest: string;
  definition_json: string;
  started_ms: number | string;
  parent_execution_epoch: number | string;
  parent_cancellation_epoch: number | string;
  parent_grant_revision: number | string;
  deadline_ms: number | string;
  binding_digest: string;
  state: "open" | "uncertain" | "settled";
}

export class FactoryChildRunError extends Error {
  constructor(readonly code: "factory_child_forbidden" | "factory_child_not_found" | "factory_child_corrupt" | "factory_child_conflict") {
    super(code); this.name = "FactoryChildRunError";
  }
}

function definition(value: unknown): FactoryDefinitionSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FactoryChildRunError("factory_child_corrupt");
  const source = value as FactoryDefinitionSource;
  if (!/^sha256:[a-f0-9]{64}$/.test(source.definitionDigest) || !Number.isSafeInteger(source.definitionEncodedBytes) || source.definitionEncodedBytes < 1 || !source.manifest || typeof source.manifest.objectId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(source.manifest.digest) || !Number.isSafeInteger(source.manifest.encodedBytes) || source.manifest.encodedBytes < 1) throw new FactoryChildRunError("factory_child_corrupt");
  return source;
}

function envelopeId(parentRunId: string, interpreterId: string, commandId: string): string {
  return `child-envelope:${digestObject({ parentRunId, interpreterId, commandId }).slice("sha256:".length)}`;
}

function bindingFact(row: Omit<FactoryChildBindingRow, "binding_digest" | "state">): object {
  return {
    parentRunId: row.parent_run_id,
    parentInterpreterId: row.parent_interpreter_id,
    parentCommandId: row.parent_command_id,
    parentSourceSequence: Number(row.parent_source_sequence),
    parentCommandDigest: row.parent_command_digest,
    childRunId: row.child_run_id,
    parentEnvelopeId: row.parent_envelope_id,
    childEnvelopeId: row.child_envelope_id,
    childFactoryId: row.child_factory_id,
    childFactoryVersion: row.child_factory_version,
    childDefinitionDigest: row.child_definition_digest,
    definition: JSON.parse(row.definition_json),
    startedAtMs: Number(row.started_ms),
    parentExecutionEpoch: Number(row.parent_execution_epoch),
    parentCancellationEpoch: Number(row.parent_cancellation_epoch),
    parentGrantRevision: Number(row.parent_grant_revision),
    deadlineAtMs: Number(row.deadline_ms),
  };
}

/** Verifies every sealed child binding fact before any consumer trusts its inherited clock or definition. */
export function verifyFactoryChildBinding(row: FactoryChildBindingRow): { readonly definition: FactoryDefinitionSource; readonly startedAtMs: number } {
  try {
    assertFactoryIdentity(row.parent_run_id, row.parent_interpreter_id, row.parent_command_id, row.child_run_id, row.parent_envelope_id, row.child_envelope_id, row.child_factory_id, row.child_factory_version);
    const startedAtMs = Number(row.started_ms);
    if (!Number.isSafeInteger(Number(row.parent_source_sequence)) || Number(row.parent_source_sequence) < 1 || !/^sha256:[a-f0-9]{64}$/.test(row.parent_command_digest) || !/^sha256:[a-f0-9]{64}$/.test(row.child_definition_digest) || !Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || !Number.isSafeInteger(Number(row.parent_execution_epoch)) || Number(row.parent_execution_epoch) < 1 || !Number.isSafeInteger(Number(row.parent_cancellation_epoch)) || Number(row.parent_cancellation_epoch) < 0 || !Number.isSafeInteger(Number(row.parent_grant_revision)) || Number(row.parent_grant_revision) < 1 || !Number.isSafeInteger(Number(row.deadline_ms)) || Number(row.deadline_ms) < 1) throw new Error("invalid binding");
    const source = definition(JSON.parse(row.definition_json));
    if (source.definitionDigest !== row.child_definition_digest || `sha256:${digestObject(bindingFact(row))}` !== row.binding_digest) throw new Error("binding mismatch");
    return { definition: source, startedAtMs };
  } catch { throw new FactoryChildRunError("factory_child_corrupt"); }
}

/** Durable child receipt. Parent command authority admits once; retries return its sealed source. */
export class FactoryChildRuns {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly authority: FactoryCommandAuthority, private readonly lifecycle: FactoryRunLifecycle, private readonly transitions?: FactoryTransitionArtifacts) {
    assertFactoryIdentity(tenantId);
    if (authority.tenantId !== tenantId || lifecycle.tenantId !== tenantId) throw new FactoryChildRunError("factory_child_forbidden");
  }

  async resolve(service: TrustedFactoryServiceIdentity, value: FactoryChildRunRequest): Promise<FactoryDefinitionSource> {
    const input = JSON.parse(encodeFactoryPayload(value)) as FactoryChildRunRequest;
    assertFactoryIdentity(input.tenantId, input.projectId, input.logicalRunId, input.interpreterId, input.commandId, input.factory.id, input.factory.version, input.factory.digest);
    if (input.tenantId !== this.tenantId) throw new FactoryChildRunError("factory_child_forbidden");
    this.authority.assertService(service);
    const existing = await this.database.transaction(transaction => this.binding(transaction, input, true));
    if (existing) return this.receipt(existing, input.factory);
    return this.authority.withCurrentChild(service, input, async (transaction, context) => {
      const prior = await this.binding(transaction, input, true);
      if (prior) return this.receipt(prior, input.factory);
      return this.create(transaction, input, context);
    });
  }

  /** Settles only a verified terminal child transition; callers never provide spend totals. */
  async settle(service: TrustedFactoryServiceIdentity, keyValue: { readonly projectId: string; readonly childRunId: string }): Promise<void> {
    const key = JSON.parse(encodeFactoryPayload(keyValue)) as { projectId: string; childRunId: string };
    assertFactoryIdentity(key.projectId, key.childRunId);
    this.authority.assertService(service);
    if (!this.transitions) throw new FactoryChildRunError("factory_child_forbidden");
    await this.database.transaction(async transaction => {
      // Read-only discovery must precede the budget's root-to-leaf locks.
      const initial = await this.bindingByChild(transaction, key.projectId, key.childRunId, false);
      if (!initial) throw new FactoryChildRunError("factory_child_not_found");
      this.receipt(initial, { id: initial.child_factory_id, version: initial.child_factory_version, digest: initial.child_definition_digest });
      if (initial.state === "settled") return;
      const lifecycle = rows<{ status: string }>(await transaction.execute(sql`SELECT status FROM factory_run_lifecycle WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.childRunId}`))[0];
      if (!lifecycle || !["succeeded", "failed", "cancelled"].includes(lifecycle.status)) throw new FactoryChildRunError("factory_child_conflict");
      const head = rows<{ source_sequence: number | string }>(await transaction.execute(sql`SELECT source_sequence FROM factory_audit_batches WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.childRunId} AND interpreter_id='root' ORDER BY source_sequence DESC LIMIT 1`))[0];
      if (!head || !Number.isSafeInteger(Number(head.source_sequence)) || Number(head.source_sequence) < 1) throw new FactoryChildRunError("factory_child_corrupt");
      const identity: FactoryIdentity = { tenantId: this.tenantId, projectId: key.projectId, logicalRunId: key.childRunId, interpreterId: "root" };
      const transition = await this.transitions!.loadCommittedTransition(identity, Number(head.source_sequence), transaction);
      const terminal = transition.commands.find(command => command.kind === "complete-run" || command.kind === "fail-run" || command.kind === "cancel-run");
      const expected = lifecycle.status === "succeeded" ? "complete-run" : lifecycle.status === "failed" ? "fail-run" : "cancel-run";
      if (!terminal || terminal.kind !== expected) throw new FactoryChildRunError("factory_child_corrupt");
      const settlementDigest = `sha256:${digestObject({ bindingDigest: initial.binding_digest, childRunId: key.childRunId, sourceSequence: Number(head.source_sequence), terminal })}`;
      await this.lifecycle.budgets.settleChildDelegationInTransaction(transaction, { parent: { projectId: key.projectId, runId: initial.parent_run_id }, child: { projectId: key.projectId, runId: key.childRunId }, parentEnvelopeId: initial.parent_envelope_id, childEnvelopeId: initial.child_envelope_id, deadlineAtMs: Number(initial.deadline_ms) }, settlementDigest);
      const binding = await this.bindingByChild(transaction, key.projectId, key.childRunId, true);
      if (!binding || binding.binding_digest !== initial.binding_digest) throw new FactoryChildRunError("factory_child_conflict");
      // A concurrent caller may have settled the same verified terminal receipt while this caller waited on budget locks.
      if (binding.state === "settled") return;
      if (binding.state !== "open") throw new FactoryChildRunError("factory_child_conflict");
      await transaction.execute(sql`UPDATE factory_child_runs SET state='settled',settlement_digest=${settlementDigest},updated_at=NOW() WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND child_run_id=${key.childRunId} AND state='open'`);
    });
  }

  private async create(transaction: MigrationDb, input: FactoryChildRunRequest, context: FactoryAuthorizedChildCommand): Promise<FactoryDefinitionSource> {
    const command = context.command;
    if (command.factory.id !== input.factory.id || command.factory.version !== input.factory.version || command.factory.digest !== input.factory.digest) throw new FactoryChildRunError("factory_child_conflict");
    const childRunId = factoryChildRunId(input.logicalRunId, command);
    const parentEnvelopeId = envelopeId(input.logicalRunId, input.interpreterId, input.commandId);
    const startedAtMs = await this.lifecycle.readWorkflowStartedAtInTransaction(transaction, { projectId: input.projectId, runId: input.logicalRunId });
    const receipt = await this.lifecycle.createChildInTransaction(transaction, {
      parent: context.fence,
      parentInterpreterId: input.interpreterId,
      parentCommandId: input.commandId,
      childRunId,
      parentEnvelopeId,
      factory: command.factory,
      input: command.input,
      ...(command.durableInput === undefined ? {} : { durableInput: command.durableInput }),
      startedAtMs,
      deadlineAtMs: command.deadlineAtMs,
      initiator: context.initiator,
    });
    const source = definition(receipt.definition);
    const fact = {
      parentRunId: input.logicalRunId,
      parentInterpreterId: input.interpreterId,
      parentCommandId: input.commandId,
      parentSourceSequence: context.sourceSequence,
      parentCommandDigest: context.commandDigest,
      childRunId,
      parentEnvelopeId,
      childEnvelopeId: receipt.childEnvelopeId,
      childFactoryId: command.factory.id,
      childFactoryVersion: command.factory.version,
      childDefinitionDigest: receipt.definitionDigest,
      definition: source,
      startedAtMs,
      parentExecutionEpoch: context.fence.executionEpoch,
      parentCancellationEpoch: context.fence.cancellationEpoch,
      parentGrantRevision: context.fence.grantRevision,
      deadlineAtMs: receipt.deadlineAtMs,
    };
    const digest = `sha256:${digestObject(fact)}`;
    await transaction.execute(sql`INSERT INTO factory_child_runs (tenant_id,project_id,parent_run_id,parent_interpreter_id,parent_command_id,parent_source_sequence,parent_command_digest,child_run_id,parent_envelope_id,child_envelope_id,child_factory_id,child_factory_version,child_definition_digest,definition_json,started_ms,parent_execution_epoch,parent_cancellation_epoch,parent_grant_revision,deadline_ms,binding_digest,state) VALUES (${this.tenantId},${input.projectId},${input.logicalRunId},${input.interpreterId},${input.commandId},${context.sourceSequence},${context.commandDigest},${childRunId},${parentEnvelopeId},'root',${command.factory.id},${command.factory.version},${receipt.definitionDigest},${encodeFactoryPayload(source)},${startedAtMs},${context.fence.executionEpoch},${context.fence.cancellationEpoch},${context.fence.grantRevision},${receipt.deadlineAtMs},${digest},'open')`);
    return source;
  }

  private async binding(transaction: MigrationDb, input: Pick<FactoryChildRunRequest, "projectId" | "logicalRunId" | "interpreterId" | "commandId">, lock: boolean): Promise<FactoryChildBindingRow | null> {
    const result = rows<FactoryChildBindingRow>(await transaction.execute(sql`SELECT parent_run_id,parent_interpreter_id,parent_command_id,parent_source_sequence,parent_command_digest,child_run_id,parent_envelope_id,child_envelope_id,child_factory_id,child_factory_version,child_definition_digest,definition_json,started_ms,parent_execution_epoch,parent_cancellation_epoch,parent_grant_revision,deadline_ms,binding_digest,state FROM factory_child_runs WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND parent_run_id=${input.logicalRunId} AND parent_interpreter_id=${input.interpreterId} AND parent_command_id=${input.commandId} ${lock ? sql`FOR UPDATE` : sql``}`));
    return result[0] ?? null;
  }

  private async bindingByChild(transaction: MigrationDb, projectId: string, childRunId: string, lock: boolean): Promise<FactoryChildBindingRow | null> {
    const found = rows<FactoryChildBindingRow>(await transaction.execute(sql`SELECT parent_run_id,parent_interpreter_id,parent_command_id,parent_source_sequence,parent_command_digest,child_run_id,parent_envelope_id,child_envelope_id,child_factory_id,child_factory_version,child_definition_digest,definition_json,started_ms,parent_execution_epoch,parent_cancellation_epoch,parent_grant_revision,deadline_ms,binding_digest,state FROM factory_child_runs WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND child_run_id=${childRunId} ${lock ? sql`FOR UPDATE` : sql``}`));
    return found[0] ?? null;
  }

  private receipt(row: FactoryChildBindingRow, expected: FactoryReference): FactoryDefinitionSource {
    const verified = verifyFactoryChildBinding(row);
    if (row.child_factory_id !== expected.id || row.child_factory_version !== expected.version || row.child_definition_digest !== expected.digest || verified.definition.definitionDigest !== expected.digest) throw new FactoryChildRunError("factory_child_corrupt");
    return verified.definition;
  }
}
