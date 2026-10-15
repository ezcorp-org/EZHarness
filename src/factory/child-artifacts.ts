import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { canonicalJson } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { digestObject } from "../extensions/v4/blobs";
import type { FactoryArtifacts } from "./artifacts";
import type { FactoryAssurance } from "./assurance";
import { verifyFactoryChildBinding, type FactoryChildBindingRow } from "./child-runs";
import { assertFactoryIdentity } from "./records";
import type { FactoryRunFence } from "./run-lifecycle";

/** The exact parent attempt that may consume one child's accepted artifact. */
export interface FactoryParentAttemptKey {
  readonly runId: string;
  readonly interpreterId: string;
  readonly commandId: string;
  readonly nodeInstanceId: string;
  readonly candidateGeneration: number;
  readonly attemptId: string;
}

export interface FactoryChildArtifactRequest {
  readonly projectId: string;
  readonly parent: FactoryParentAttemptKey;
  readonly childRunId: string;
  readonly childDecisionId: string;
  readonly artifact: FactoryArtifactReference;
}

export interface FactoryChildArtifactAlias extends FactoryChildArtifactRequest {
  readonly aliasId: string;
  readonly childNodeInstanceId: string;
  readonly childCandidateGeneration: number;
  readonly childCandidateDigest: string;
  readonly parentExecutionEpoch: number;
  readonly parentCancellationEpoch: number;
  readonly childExecutionEpoch: number;
  readonly aliasDigest: string;
}

/** Reads one run's live fence. The composition owner holds the project and run locks. */
export interface FactoryAncestryFenceReader {
  readonly tenantId: string;
  readCurrentFenceInTransaction(transaction: MigrationDb, projectId: string, runId: string): Promise<FactoryRunFence>;
}

export class FactoryChildArtifactError extends Error {
  constructor(readonly code: "factory_child_artifact_invalid" | "factory_child_artifact_scope" | "factory_child_artifact_foreign" | "factory_child_artifact_stale" | "factory_child_artifact_conflict" | "factory_child_artifact_corrupt") {
    super(code);
    this.name = "FactoryChildArtifactError";
  }
}

type AliasRow = {
  alias_id: string; parent_run_id: string; parent_interpreter_id: string; parent_command_id: string;
  parent_node_instance_id: string; parent_candidate_generation: number | string; parent_attempt_id: string;
  parent_execution_epoch: number | string; parent_cancellation_epoch: number | string;
  child_run_id: string; child_decision_id: string; child_node_instance_id: string; child_candidate_generation: number | string;
  child_candidate_digest: string; child_execution_epoch: number | string;
  artifact_id: string; artifact_digest: string; artifact_bytes: number | string; alias_digest: string;
};

const hash = (value: unknown): string => `sha256:${digestObject(value)}`;
const snapshot = <Value>(value: Value): Value => JSON.parse(canonicalJson(value)) as Value;

function invalid(): never {
  throw new FactoryChildArtifactError("factory_child_artifact_invalid");
}

function counter(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) invalid();
}

function digest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) invalid();
}

/** The alias identity, and the seal every read recomputes. */
function aliasFact(tenantId: string, alias: Omit<FactoryChildArtifactAlias, "aliasId" | "aliasDigest">): object {
  return { schemaVersion: "factory.child-artifact-alias.v1", tenantId, ...alias };
}

/**
 * Binds a child run's accepted artifact to the exact parent attempt that may consume it.
 *
 * An alias is not an acceptance. It proves five separate facts at once and refuses if any one of
 * them moves: the parent's own child binding, the exact parent attempt, the child's sealed
 * acceptance decision, the artifact the decision accepted, and both runs' live ancestry fences.
 * The parent's own acceptance decision is a different table and is never implied here.
 */
export class FactoryChildArtifacts {
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly assurance: FactoryAssurance,
    private readonly artifacts: FactoryArtifacts,
    private readonly fences: FactoryAncestryFenceReader,
  ) {
    assertFactoryIdentity(tenantId);
    if (assurance.tenantId !== tenantId || artifacts.database !== database || fences.tenantId !== tenantId) throw new FactoryChildArtifactError("factory_child_artifact_scope");
  }

  async bind(request: FactoryChildArtifactRequest): Promise<FactoryChildArtifactAlias> {
    return this.database.transaction(transaction => this.bindInTransaction(transaction, request));
  }

  async bindInTransaction(transaction: MigrationDb, value: FactoryChildArtifactRequest): Promise<FactoryChildArtifactAlias> {
    const request = this.validate(value);
    const binding = await this.binding(transaction, request);
    const parentFence = await this.liveFence(transaction, request.projectId, request.parent.runId);
    if (parentFence.executionEpoch !== Number(binding.parent_execution_epoch) || parentFence.cancellationEpoch !== Number(binding.parent_cancellation_epoch)) throw new FactoryChildArtifactError("factory_child_artifact_stale");
    await this.assertParentAttempt(transaction, request, parentFence);

    const childFence = await this.liveFence(transaction, request.projectId, request.childRunId);
    const decision = await this.assurance.readSealedDecisionInTransaction(transaction, request.projectId, request.childDecisionId);
    if (decision.runId !== request.childRunId || decision.executionEpoch !== childFence.executionEpoch || decision.cancellationEpoch !== childFence.cancellationEpoch) throw new FactoryChildArtifactError("factory_child_artifact_stale");
    if (decision.candidateDigest !== request.artifact.digest) throw new FactoryChildArtifactError("factory_child_artifact_foreign");

    // Recheck the bytes: a client-supplied digest is not evidence that the artifact still matches.
    const loaded = await this.artifacts.loadInTransaction(transaction, { tenantId: this.tenantId, projectId: request.projectId, logicalRunId: request.childRunId }, { objectId: request.artifact.artifactId, digest: request.artifact.digest, encodedBytes: request.artifact.encodedBytes }, ["candidate_output"]);
    if (loaded.candidateNodeInstanceId !== decision.nodeInstanceId || loaded.candidateGeneration !== decision.candidateGeneration) throw new FactoryChildArtifactError("factory_child_artifact_foreign");

    const body = {
      ...request,
      childNodeInstanceId: decision.nodeInstanceId,
      childCandidateGeneration: decision.candidateGeneration,
      childCandidateDigest: decision.candidateDigest,
      parentExecutionEpoch: parentFence.executionEpoch,
      parentCancellationEpoch: parentFence.cancellationEpoch,
      childExecutionEpoch: childFence.executionEpoch,
    };
    const aliasDigest = hash(aliasFact(this.tenantId, body));
    const aliasId = `factory-child-alias:${aliasDigest.slice("sha256:".length)}`;
    await transaction.execute(sql`INSERT INTO factory_child_artifact_aliases (tenant_id,project_id,alias_id,parent_run_id,parent_interpreter_id,parent_command_id,parent_node_instance_id,parent_candidate_generation,parent_attempt_id,parent_execution_epoch,parent_cancellation_epoch,child_run_id,child_decision_id,child_node_instance_id,child_candidate_generation,child_candidate_digest,child_execution_epoch,artifact_id,artifact_digest,artifact_bytes,alias_digest) VALUES (${this.tenantId},${request.projectId},${aliasId},${request.parent.runId},${request.parent.interpreterId},${request.parent.commandId},${request.parent.nodeInstanceId},${request.parent.candidateGeneration},${request.parent.attemptId},${body.parentExecutionEpoch},${body.parentCancellationEpoch},${request.childRunId},${request.childDecisionId},${body.childNodeInstanceId},${body.childCandidateGeneration},${body.childCandidateDigest},${body.childExecutionEpoch},${request.artifact.artifactId},${request.artifact.digest},${request.artifact.encodedBytes},${aliasDigest}) ON CONFLICT DO NOTHING`);
    const saved = await this.row(transaction, request.projectId, request.parent);
    if (!saved || saved.alias_id !== aliasId || saved.alias_digest !== aliasDigest) throw new FactoryChildArtifactError("factory_child_artifact_conflict");
    return this.fromRow(request.projectId, saved);
  }

  /**
   * Returns the bound artifact only while every ancestry fact still holds.
   *
   * The seal is recomputed from the stored row, and both fences are reread, so a cancelled parent
   * or a restored installation cannot keep feeding a child's artifact into new parent work.
   */
  async resolveInTransaction(transaction: MigrationDb, projectId: string, parent: FactoryParentAttemptKey): Promise<FactoryChildArtifactAlias> {
    assertFactoryIdentity(projectId);
    const key = this.validateParent(parent);
    const saved = await this.row(transaction, projectId, key);
    if (!saved) throw new FactoryChildArtifactError("factory_child_artifact_foreign");
    const alias = this.fromRow(projectId, saved);
    const parentFence = await this.liveFence(transaction, projectId, key.runId);
    const childFence = await this.liveFence(transaction, projectId, alias.childRunId);
    if (parentFence.executionEpoch !== alias.parentExecutionEpoch || parentFence.cancellationEpoch !== alias.parentCancellationEpoch || childFence.executionEpoch !== alias.childExecutionEpoch) throw new FactoryChildArtifactError("factory_child_artifact_stale");
    const binding = await this.binding(transaction, { projectId, parent: key, childRunId: alias.childRunId, childDecisionId: alias.childDecisionId, artifact: alias.artifact });
    if (Number(binding.parent_execution_epoch) !== alias.parentExecutionEpoch) throw new FactoryChildArtifactError("factory_child_artifact_stale");
    return alias;
  }

  private validate(value: FactoryChildArtifactRequest): FactoryChildArtifactRequest {
    const request = snapshot(value);
    assertFactoryIdentity(request.projectId, request.childRunId, request.childDecisionId, request.artifact.artifactId);
    digest(request.artifact.digest);
    counter(request.artifact.encodedBytes, 1);
    return { ...request, parent: this.validateParent(request.parent) };
  }

  private validateParent(value: FactoryParentAttemptKey): FactoryParentAttemptKey {
    const parent = snapshot(value);
    assertFactoryIdentity(parent.runId, parent.interpreterId, parent.commandId, parent.nodeInstanceId, parent.attemptId);
    counter(parent.candidateGeneration, 0);
    return parent;
  }

  private async liveFence(transaction: MigrationDb, projectId: string, runId: string): Promise<FactoryRunFence> {
    const fence = await this.fences.readCurrentFenceInTransaction(transaction, projectId, runId);
    if (fence.tenantId !== this.tenantId || fence.projectId !== projectId || fence.runId !== runId) throw new FactoryChildArtifactError("factory_child_artifact_scope");
    if (!Number.isSafeInteger(fence.executionEpoch) || fence.executionEpoch < 1 || !Number.isSafeInteger(fence.cancellationEpoch) || fence.cancellationEpoch < 0) throw new FactoryChildArtifactError("factory_child_artifact_corrupt");
    return fence;
  }

  /** The parent's own binding for this child. A child bound to another parent is foreign. */
  private async binding(transaction: MigrationDb, request: FactoryChildArtifactRequest): Promise<FactoryChildBindingRow> {
    const row = rows<FactoryChildBindingRow>(await transaction.execute(sql`SELECT binding.parent_run_id,binding.parent_interpreter_id,binding.parent_command_id,binding.parent_source_sequence,binding.parent_command_digest,binding.child_run_id,binding.parent_envelope_id,binding.child_envelope_id,binding.child_factory_id,binding.child_factory_version,binding.child_definition_digest,binding.definition_json,binding.started_ms,binding.parent_execution_epoch,binding.parent_cancellation_epoch,binding.parent_grant_revision,binding.deadline_ms,binding.binding_digest,binding.state FROM factory_child_runs binding WHERE binding.tenant_id=${this.tenantId} AND binding.project_id=${request.projectId} AND binding.parent_run_id=${request.parent.runId} AND binding.parent_interpreter_id=${request.parent.interpreterId} AND binding.parent_command_id=${request.parent.commandId} FOR SHARE`))[0];
    if (!row || row.child_run_id !== request.childRunId) throw new FactoryChildArtifactError("factory_child_artifact_foreign");
    try { verifyFactoryChildBinding(row); }
    catch { throw new FactoryChildArtifactError("factory_child_artifact_corrupt"); }
    if (row.state === "uncertain") throw new FactoryChildArtifactError("factory_child_artifact_stale");
    return row;
  }

  /** The exact parent attempt, still admitted to this run at this node and generation. */
  private async assertParentAttempt(transaction: MigrationDb, request: FactoryChildArtifactRequest, fence: FactoryRunFence): Promise<void> {
    const attempt = rows<{ node_instance_id: string; candidate_generation: number | string; execution_epoch: number | string; cancellation_epoch: number | string; status: string }>(await transaction.execute(sql`SELECT node_instance_id,candidate_generation,execution_epoch,cancellation_epoch,status FROM factory_executions WHERE attempt_id=${request.parent.attemptId} AND tenant_id=${this.tenantId} AND project_id=${request.projectId} AND run_id=${request.parent.runId} FOR SHARE`))[0];
    if (!attempt) throw new FactoryChildArtifactError("factory_child_artifact_foreign");
    if (attempt.node_instance_id !== request.parent.nodeInstanceId || Number(attempt.candidate_generation) !== request.parent.candidateGeneration) throw new FactoryChildArtifactError("factory_child_artifact_foreign");
    if (Number(attempt.execution_epoch) !== fence.executionEpoch || Number(attempt.cancellation_epoch) !== fence.cancellationEpoch) throw new FactoryChildArtifactError("factory_child_artifact_stale");
  }

  private async row(transaction: MigrationDb, projectId: string, parent: FactoryParentAttemptKey): Promise<AliasRow | undefined> {
    return rows<AliasRow>(await transaction.execute(sql`SELECT alias_id,parent_run_id,parent_interpreter_id,parent_command_id,parent_node_instance_id,parent_candidate_generation,parent_attempt_id,parent_execution_epoch,parent_cancellation_epoch,child_run_id,child_decision_id,child_node_instance_id,child_candidate_generation,child_candidate_digest,child_execution_epoch,artifact_id,artifact_digest,artifact_bytes,alias_digest FROM factory_child_artifact_aliases WHERE tenant_id=${this.tenantId} AND project_id=${projectId} AND parent_run_id=${parent.runId} AND parent_interpreter_id=${parent.interpreterId} AND parent_command_id=${parent.commandId} AND parent_attempt_id=${parent.attemptId} FOR SHARE`))[0];
  }

  private fromRow(projectId: string, row: AliasRow): FactoryChildArtifactAlias {
    const alias: FactoryChildArtifactAlias = {
      aliasId: row.alias_id, projectId,
      parent: { runId: row.parent_run_id, interpreterId: row.parent_interpreter_id, commandId: row.parent_command_id, nodeInstanceId: row.parent_node_instance_id, candidateGeneration: Number(row.parent_candidate_generation), attemptId: row.parent_attempt_id },
      childRunId: row.child_run_id, childDecisionId: row.child_decision_id,
      childNodeInstanceId: row.child_node_instance_id, childCandidateGeneration: Number(row.child_candidate_generation), childCandidateDigest: row.child_candidate_digest,
      parentExecutionEpoch: Number(row.parent_execution_epoch), parentCancellationEpoch: Number(row.parent_cancellation_epoch), childExecutionEpoch: Number(row.child_execution_epoch),
      artifact: { artifactId: row.artifact_id, digest: row.artifact_digest, encodedBytes: Number(row.artifact_bytes) },
      aliasDigest: row.alias_digest,
    };
    const { aliasId: _aliasId, aliasDigest: _aliasDigest, ...body } = alias;
    if (hash(aliasFact(this.tenantId, body)) !== row.alias_digest || `factory-child-alias:${row.alias_digest.slice("sha256:".length)}` !== row.alias_id) throw new FactoryChildArtifactError("factory_child_artifact_corrupt");
    return alias;
  }
}
