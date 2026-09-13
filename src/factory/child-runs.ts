import type { FactoryReference } from "@ezcorp/factory-sdk";
import { factoryChildRunId } from "@ezcorp/factory-sdk/transport-types";
import { sql } from "drizzle-orm";
import type { FactoryDefinitionSource } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryCommandAuthority, FactoryAuthorizedChildCommand } from "./command-authority";
import type { FactoryRunLifecycle } from "./run-lifecycle";
import { assertFactoryIdentity, encodeFactoryPayload } from "./records";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

export interface FactoryChildRunRequest extends TrustedFactoryCommandReference {
  readonly factory: FactoryReference;
}

interface ChildBindingRow {
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

function bindingFact(row: Omit<ChildBindingRow, "binding_digest" | "state">): object {
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
    parentExecutionEpoch: Number(row.parent_execution_epoch),
    parentCancellationEpoch: Number(row.parent_cancellation_epoch),
    parentGrantRevision: Number(row.parent_grant_revision),
    deadlineAtMs: Number(row.deadline_ms),
  };
}

/** Durable child receipt. Parent command authority admits once; retries return its sealed source. */
export class FactoryChildRuns {
  constructor(private readonly database: TransactionalDb, readonly tenantId: string, private readonly authority: FactoryCommandAuthority, private readonly lifecycle: FactoryRunLifecycle) {
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
      parentExecutionEpoch: context.fence.executionEpoch,
      parentCancellationEpoch: context.fence.cancellationEpoch,
      parentGrantRevision: context.fence.grantRevision,
      deadlineAtMs: receipt.deadlineAtMs,
    };
    const digest = `sha256:${digestObject(fact)}`;
    await transaction.execute(sql`INSERT INTO factory_child_runs (tenant_id,project_id,parent_run_id,parent_interpreter_id,parent_command_id,parent_source_sequence,parent_command_digest,child_run_id,parent_envelope_id,child_envelope_id,child_factory_id,child_factory_version,child_definition_digest,definition_json,parent_execution_epoch,parent_cancellation_epoch,parent_grant_revision,deadline_ms,binding_digest,state) VALUES (${this.tenantId},${input.projectId},${input.logicalRunId},${input.interpreterId},${input.commandId},${context.sourceSequence},${context.commandDigest},${childRunId},${parentEnvelopeId},'root',${command.factory.id},${command.factory.version},${receipt.definitionDigest},${encodeFactoryPayload(source)},${context.fence.executionEpoch},${context.fence.cancellationEpoch},${context.fence.grantRevision},${receipt.deadlineAtMs},${digest},'open')`);
    return source;
  }

  private async binding(transaction: MigrationDb, input: Pick<FactoryChildRunRequest, "projectId" | "logicalRunId" | "interpreterId" | "commandId">, lock: boolean): Promise<ChildBindingRow | null> {
    const result = rows<ChildBindingRow>(await transaction.execute(sql`SELECT parent_run_id,parent_interpreter_id,parent_command_id,parent_source_sequence,parent_command_digest,child_run_id,parent_envelope_id,child_envelope_id,child_factory_id,child_factory_version,child_definition_digest,definition_json,parent_execution_epoch,parent_cancellation_epoch,parent_grant_revision,deadline_ms,binding_digest,state FROM factory_child_runs WHERE tenant_id=${this.tenantId} AND project_id=${input.projectId} AND parent_run_id=${input.logicalRunId} AND parent_interpreter_id=${input.interpreterId} AND parent_command_id=${input.commandId} ${lock ? sql`FOR UPDATE` : sql``}`));
    return result[0] ?? null;
  }

  private receipt(row: ChildBindingRow, expected: FactoryReference): FactoryDefinitionSource {
    try {
      assertFactoryIdentity(row.parent_run_id, row.parent_interpreter_id, row.parent_command_id, row.child_run_id, row.parent_envelope_id, row.child_envelope_id, row.child_factory_id, row.child_factory_version);
      if (!Number.isSafeInteger(Number(row.parent_source_sequence)) || Number(row.parent_source_sequence) < 1 || !/^sha256:[a-f0-9]{64}$/.test(row.parent_command_digest) || !/^sha256:[a-f0-9]{64}$/.test(row.child_definition_digest) || !Number.isSafeInteger(Number(row.parent_execution_epoch)) || Number(row.parent_execution_epoch) < 1 || !Number.isSafeInteger(Number(row.parent_cancellation_epoch)) || Number(row.parent_cancellation_epoch) < 0 || !Number.isSafeInteger(Number(row.parent_grant_revision)) || Number(row.parent_grant_revision) < 1 || !Number.isSafeInteger(Number(row.deadline_ms)) || Number(row.deadline_ms) < 1) throw new Error("invalid binding");
      const source = definition(JSON.parse(row.definition_json));
      if (row.child_factory_id !== expected.id || row.child_factory_version !== expected.version || row.child_definition_digest !== expected.digest || source.definitionDigest !== expected.digest || `sha256:${digestObject(bindingFact(row))}` !== row.binding_digest) throw new Error("binding mismatch");
      return source;
    } catch { throw new FactoryChildRunError("factory_child_corrupt"); }
  }
}
